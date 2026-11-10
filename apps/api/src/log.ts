/**
 * API 进程的日志：一行一条，`HH:MM:SS.mmm LEVEL [scope] 消息`。
 *
 * info 走 stdout，warn / error 走 stderr —— 正常事件（listening、调度启动、sync 完成）
 * 不该和真问题混在同一条流里。`PICTORIA_LOG_LEVEL`（`info` / `warn` / `error`，默认
 * `info`）按级别过滤，每次调用时读，测试里改环境变量即时生效。
 *
 * 需要注入日志的函数（`sync.ts`、`scheduler.ts`、`dedup.ts`）收的是 `Log`，默认值是
 * 自己 scope 的 logger；测试传一个空实现静音。
 */
import process from 'node:process'

const LEVELS = { info: 0, warn: 1, error: 2 } as const
type Level = keyof typeof LEVELS

export interface Logger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

/** 可注入日志的最小形状。`console` 也满足它。 */
export type Log = Pick<Logger, 'info' | 'warn'>

function threshold(): number {
  const raw = process.env.PICTORIA_LOG_LEVEL?.toLowerCase()
  return raw && raw in LEVELS ? LEVELS[raw as Level] : LEVELS.info
}

function clock(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

export function createLogger(scope: string): Logger {
  const emit = (level: Level) => (...args: unknown[]) => {
    if (LEVELS[level] < threshold())
      return
    const head = `${clock(new Date())} ${level.toUpperCase().padEnd(5)} [${scope}]`
    // 交给 console 而不是 stream.write：额外参数里的 Error 照样带堆栈展开。
    ;(level === 'info' ? console.log : console.error)(head, ...args)
  }
  return { info: emit('info'), warn: emit('warn'), error: emit('error') }
}
