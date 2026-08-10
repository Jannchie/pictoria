/**
 * S3 预签名的对拍：手写的 SigV4 必须和 minio-py 逐字符相同。
 *
 *   pnpm parity:s3
 *
 * 签名把时间戳算进去，所以两边都钉死同一个 `X-Amz-Date`：Python 那侧用
 * `freeze` 过的 `datetime.now`，这边把 `now` 直接传进去。凭据不出现在输出里 ——
 * 比的是整条 URL，但失败时只打印**从哪个字符开始**分叉。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { presignGetObject, s3Configured } from '../src/s3.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')

if (!s3Configured()) {
  console.log('（这台机器没配 S3，跳过预签名对拍）')
  process.exit(0)
}

/** 固定时间戳。任何值都行，只要两侧一样。 */
const FIXED_ISO = '2026-01-02T03:04:05.000Z'
const AMZ_DATE = '20260102T030405Z'

const OBJECTS = [
  'danbooru/wlop/8135809.jpg',
  'a b/c+d.png', // 空格和 + 必须被编码，且两侧编码方式一致
  '日本語/画像.webp', // 非 ASCII 走 UTF-8 百分号编码
  'dir/sub/deep/name.with.dots.jpeg',
]

function pythonPresign(objects: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('uv', ['run', 'python', 'scripts/s3_presign_direct.py'], {
      cwd: path.resolve(ROOT, 'server'),
      shell: true,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('close', (code) => {
      if (code !== 0)
        return reject(new Error(`minio 预签名失败 (${code}): ${err.slice(-600)}`))
      try {
        resolve(JSON.parse(out))
      }
      catch {
        reject(new Error(`输出不是 JSON: ${out.slice(0, 300)}
${err.slice(-400)}`))
      }
    })
    child.stdin.end(JSON.stringify({ amzDate: AMZ_DATE, objects }))
  })
}

const theirs = await pythonPresign(OBJECTS)
const fails: string[] = []
let pass = 0

for (const [i, name] of OBJECTS.entries()) {
  const mine = presignGetObject(name, new Date(FIXED_ISO))!
  const want = theirs[i]!
  if (mine === want) {
    pass++
    continue
  }
  let at = 0
  while (at < mine.length && at < want.length && mine[at] === want[at]) at++
  fails.push(
    `${name}\n   第 ${at} 个字符起分叉\n   TS  …${mine.slice(Math.max(0, at - 30), at + 40)}\n   PY  …${want.slice(Math.max(0, at - 30), at + 40)}`,
  )
}

for (const f of fails) console.log(`❌ ${f}`)
console.log(`\n${fails.length === 0 ? '✅' : '💥'} ${pass}/${OBJECTS.length} 条预签名 URL 与 minio-py 逐字符相同`)
process.exit(fails.length === 0 ? 0 : 1)
