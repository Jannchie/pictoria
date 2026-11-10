import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from './log.js'

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.PICTORIA_LOG_LEVEL
})

describe('createLogger', () => {
  it('info 走 stdout，warn / error 走 stderr，行首是时间、级别、scope', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = createLogger('sync')
    log.info('完成', 3)
    log.warn('跳过')
    log.error('失败')
    expect(out).toHaveBeenCalledTimes(1)
    expect(out.mock.calls[0]![0]).toMatch(/^\d\d:\d\d:\d\d\.\d{3} INFO {2}\[sync\]$/)
    expect(out.mock.calls[0]!.slice(1)).toEqual(['完成', 3])
    expect(err.mock.calls.map(c => String(c[0]).slice(13))).toEqual(['WARN  [sync]', 'ERROR [sync]'])
  })

  it('PICTORIA_LOG_LEVEL 过滤掉更低的级别，认不出的值退回 info', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = createLogger('x')
    process.env.PICTORIA_LOG_LEVEL = 'warn'
    log.info('a')
    log.warn('b')
    process.env.PICTORIA_LOG_LEVEL = 'ERROR'
    log.warn('c')
    log.error('d')
    process.env.PICTORIA_LOG_LEVEL = 'verbose'
    log.info('e')
    expect(out.mock.calls.map(c => c[1])).toEqual(['e'])
    expect(err.mock.calls.map(c => c[1])).toEqual(['b', 'd'])
  })
})
