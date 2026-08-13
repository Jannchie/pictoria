/**
 * S3 预签名 URL —— `GET /v2/images/original/id/{post_id}` 的兜底。
 *
 * 本地文件不在了的时候（外置盘没挂、库刚从别处拷来），这条路径去对象存储取一份。
 * 形状承自已删除的 `services/s3.py::presigned_get_object_from_s3`；凭据仍读同一个 `server/.env`。
 *
 * 为什么手写 SigV4 而不是拉 AWS SDK：签名本身是四十行 HMAC 链，而 `@aws-sdk/client-s3`
 * 加 presigner 是几十个包。真正的风险是**签错**，而那个风险靠对拍消掉 ——
 * `scripts/s3-presign-parity.mts` 用同一个时间戳分别跑 minio-py 和这里，比到
 * 签名逐字符相同为止。
 */
import { Buffer } from 'node:buffer'
import { createHash, createHmac } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { repoRoot } from './paths.js'

/** minio 的 `presigned_get_object` 默认有效期：7 天（也是 SigV4 的上限）。 */
const DEFAULT_EXPIRES_SECONDS = 604800

export interface S3Config {
  endpoint: string
  accessKey: string
  secretKey: string
  bucket: string
  baseDir: string
  region: string
}

let config: S3Config | null | undefined

/**
 * 从 `server/.env` 读配置，一次。
 *
 * 读的是 Python 侧那同一个文件而不是复制一份 —— 凭据只有一处真相。缺任何一项
 * 都返回 `null`，调用方据此把兜底当作"没配"而不是"失败"。
 */
function load(): S3Config | null {
  if (config !== undefined)
    return config

  const env: Record<string, string> = {}
  try {
    const raw = fs.readFileSync(path.resolve(repoRoot(), 'server/.env'), 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
      if (!m)
        continue
      // 引号是 dotenv 的语法而不是值的一部分（.env 里 S3_BASE_DIR 就带引号）
      env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '')
    }
  }
  catch {
    // 没有 .env 也不是错 —— 这台机器就是没配 S3
  }

  const pick = (k: string) => process.env[k] ?? env[k] ?? ''
  const endpoint = pick('S3_ENDPOINT')
  const accessKey = pick('S3_ACCESS_KEY')
  const secretKey = pick('S3_SECRET_KEY')
  if (!endpoint || !accessKey || !secretKey) {
    config = null
    return config
  }

  config = {
    endpoint,
    accessKey,
    secretKey,
    bucket: pick('S3_BUCKET') || 'pictoria',
    baseDir: pick('S3_BASE_DIR') || 'collections',
    // minio-py 会向服务端问 bucket 所在区域；对 `s3.<region>.<host>` 这种形式的
    // 端点直接从主机名里读出来是同一个答案，且不用多一次网络往返。
    region: pick('S3_REGION') || regionFromEndpoint(endpoint),
  }
  return config
}

function regionFromEndpoint(endpoint: string): string {
  const m = /^s3\.([a-z0-9-]+)\./.exec(endpoint)
  return m ? m[1]! : 'us-east-1'
}

/** RFC 3986 的 URI 编码 —— `encodeURIComponent` 漏掉的那几个也要编。 */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** 路径要逐段编码：`/` 是分隔符，必须留着。 */
function encodePath(objectPath: string): string {
  return objectPath.split('/').map(uriEncode).join('/')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

/** S3 配好了没有 —— 调用方据此决定报"没配"还是去取。 */
export function s3Configured(): boolean {
  return load() !== null
}

/**
 * `<base_dir>/<objectName>` 的预签名 GET URL，没配 S3 时返回 `null`。
 *
 * 路径风格（`https://host/bucket/key`）而不是虚拟主机风格 —— 和 minio-py 对
 * 非 AWS 端点的选择一致，b2 正是这种。
 *
 * `now` 只为对拍存在：签名把时间戳算进去，不能钉住时间就没法和 Python 逐字符比。
 */
export function presignGetObject(objectName: string, now: Date = new Date()): string | null {
  const cfg = load()
  if (!cfg)
    return null

  const amzDate = `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`
  const dateStamp = amzDate.slice(0, 8)
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`
  const canonicalUri = `/${encodePath(`${cfg.bucket}/${cfg.baseDir}/${objectName}`)}`

  // 查询参数必须按**编码后**的键排序；这五个的字典序恰好就是声明顺序。
  const query = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${cfg.accessKey}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(DEFAULT_EXPIRES_SECONDS)],
    ['X-Amz-SignedHeaders', 'host'],
  ] as const
  const canonicalQuery = query.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&')

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery,
    `host:${cfg.endpoint}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')

  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${cfg.secretKey}`, dateStamp), cfg.region), 's3'), 'aws4_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')

  return `https://${cfg.endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`
}
