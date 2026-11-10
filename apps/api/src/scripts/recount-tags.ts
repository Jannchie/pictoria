/**
 * 一次性维护：把 `tags.post_count` 和 `post_has_tag` 对一遍账（`recountTagPostCounts`）。
 *
 * 不在启动路径上、也不是迁移：整库 GROUP BY 是十几秒，而且触发器在正常写路径下不会
 * 漂移（漂移的来历见 `packages/db/src/repositories/tag-counts.ts`）。
 *
 *   pnpm --filter @pictoria/api exec tsx src/scripts/recount-tags.ts           # 只看
 *   pnpm --filter @pictoria/api exec tsx src/scripts/recount-tags.ts --apply   # 改
 *
 * 库路径和 API 一样：`DB_PATH`，缺省 `<PICTORIA_TARGET_DIR>/.pictoria/pictoria.sqlite`。
 * 不跑迁移 —— 先让 API 起过一次。整库扫描约半分钟（只读）；写锁只在最后改那几行时
 * 占几毫秒，但稳妥起见在 API 停着的时候跑。
 */
import process from 'node:process'
import { createDb, recountTagPostCounts, tagPostCountDrift } from '@pictoria/db'
import { createLogger } from '../log.js'
import { dbPath } from '../paths.js'

const log = createLogger('recount-tags')
const apply = process.argv.includes('--apply')
const path = dbPath()

const { sqlite } = createDb({ path })
try {
  log.info(`${path}：${apply ? '对账并修正' : '只读检查（加 --apply 才写）'}`)
  const t0 = Date.now()
  const drift = apply ? recountTagPostCounts(sqlite) : tagPostCountDrift(sqlite)
  const seconds = ((Date.now() - t0) / 1000).toFixed(1)
  if (!drift.length) {
    log.info(`没有漂移（${seconds}s）`)
  }
  else {
    const net = drift.reduce((s, d) => s + d.actual - d.stored, 0)
    log.info(`${drift.length} 个 tag 对不上，合计差 ${net}（${seconds}s）${apply ? '，已改正' : ''}`)
    for (const d of drift.slice(0, 20))
      log.info(`  ${d.name}: ${d.stored} -> ${d.actual}`)
    if (drift.length > 20)
      log.info(`  ……另有 ${drift.length - 20} 个`)
  }
}
finally {
  sqlite.close()
}
