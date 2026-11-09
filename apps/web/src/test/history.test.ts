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

/** A command whose revert/apply block until the test releases them. */
function gated(label: string, log: string[]) {
  const gates: Array<() => void> = []
  const wait = (what: string) => new Promise<void>((resolve) => {
    log.push(`${what}:${label}:start`)
    gates.push(() => {
      log.push(`${what}:${label}:end`)
      resolve()
    })
  })
  const command: UndoableCommand = { label, postIds: [], apply: () => wait('apply'), revert: () => wait('revert') }
  return { command, release: () => gates.shift()?.() }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('history store: overlapping steps', () => {
  beforeEach(() => clearHistory())

  it('runs rapid undos one after another, never concurrently', async () => {
    const log: string[] = []
    const a = gated('a', log)
    const b = gated('b', log)
    pushCommand(a.command)
    pushCommand(b.command)
    const first = undo()
    const second = undo()
    await flush()
    // Only the newest command's revert is in flight; the older one waits for it.
    expect(log).toEqual(['revert:b:start'])
    b.release()
    await flush()
    expect(log).toEqual(['revert:b:start', 'revert:b:end', 'revert:a:start'])
    a.release()
    await expect(first).resolves.toMatchObject({ status: 'done' })
    await expect(second).resolves.toMatchObject({ status: 'done' })
    expect(canUndo.value).toBe(false)
  })

  it('a command pushed while an undo is in flight voids that undo’s redo entry', async () => {
    const log: string[] = []
    const a = gated('a', log)
    pushCommand(a.command)
    const pending = undo()
    await flush()
    pushCommand(cmd('b', log))
    a.release()
    await expect(pending).resolves.toMatchObject({ status: 'done' })
    // A new action after an undo ends the redo branch, exactly as it does when the
    // undo had already finished.
    expect(canRedo.value).toBe(false)
    const r = await undo()
    expect(r.status === 'done' && r.command.label).toBe('b')
  })

  it('a redo that lands after a newer command sits beneath it', async () => {
    const log: string[] = []
    const a = gated('a', log)
    pushCommand(a.command)
    const undone = undo()
    await flush()
    a.release()
    await undone
    const redone = redo()
    await flush()
    pushCommand(cmd('b', log))
    a.release()
    await expect(redone).resolves.toMatchObject({ status: 'done' })

    const newest = await undo()
    expect(newest.status === 'done' && newest.command.label).toBe('b')
    const older = undo()
    await flush()
    a.release()
    const r = await older
    expect(r.status === 'done' && r.command.label).toBe('a')
  })

  it('clearhistory drops a step that is still in flight', async () => {
    const log: string[] = []
    const a = gated('a', log)
    pushCommand(a.command)
    const pending = undo()
    await flush()
    clearHistory()
    a.release()
    await pending
    expect(canUndo.value).toBe(false)
    expect(canRedo.value).toBe(false)
  })
})
