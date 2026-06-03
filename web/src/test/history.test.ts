import type { UndoableCommand } from '@/shared/history'
import { beforeEach, describe, expect, it } from 'vitest'
import { canRedo, canUndo, clearHistory, pushCommand, redo, undo } from '@/shared/history'

function cmd(label: string, log: string[]): UndoableCommand {
  return {
    label,
    postIds: [],
    apply: async () => {
      log.push(`apply:${label}`)
    },
    revert: async () => {
      log.push(`revert:${label}`)
    },
  }
}

describe('history store', () => {
  beforeEach(() => clearHistory())

  it('undo runs revert and moves the command to the redo stack', async () => {
    const log: string[] = []
    pushCommand(cmd('a', log))
    expect(canUndo.value).toBe(true)
    const r = await undo()
    expect(r.status).toBe('done')
    expect(log).toEqual(['revert:a'])
    expect(canUndo.value).toBe(false)
    expect(canRedo.value).toBe(true)
  })

  it('redo re-applies and moves the command back to the undo stack', async () => {
    const log: string[] = []
    pushCommand(cmd('a', log))
    await undo()
    const r = await redo()
    expect(r.status).toBe('done')
    expect(log).toEqual(['revert:a', 'apply:a'])
    expect(canUndo.value).toBe(true)
    expect(canRedo.value).toBe(false)
  })

  it('pushing a new command clears the redo stack', async () => {
    const log: string[] = []
    pushCommand(cmd('a', log))
    await undo()
    expect(canRedo.value).toBe(true)
    pushCommand(cmd('b', log))
    expect(canRedo.value).toBe(false)
  })

  it('undo on an empty stack returns empty', async () => {
    const r = await undo()
    expect(r.status).toBe('empty')
  })

  it('a failing revert drops the command instead of moving it to redo', async () => {
    const failing: UndoableCommand = {
      label: 'boom',
      postIds: [],
      apply: async () => {},
      revert: async () => {
        throw new Error('gone')
      },
    }
    pushCommand(failing)
    const r = await undo()
    expect(r.status).toBe('failed')
    expect(canUndo.value).toBe(false)
    expect(canRedo.value).toBe(false)
  })

  it('caps history at 100 entries, dropping the oldest', async () => {
    const log: string[] = []
    for (let i = 0; i < 101; i++) {
      pushCommand(cmd(String(i), log))
    }
    const labels: string[] = []
    let r = await undo()
    while (r.status === 'done') {
      labels.push(r.command.label)
      r = await undo()
    }
    expect(labels.length).toBe(100)
    expect(labels.includes('0')).toBe(false)
    expect(labels[0]).toBe('100')
  })
})
