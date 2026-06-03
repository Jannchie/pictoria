import type { UndoableCommand } from '@/shared/history'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearHistory, pushCommand } from '@/shared/history'
import { dismissUndoSnackbar, notifyDid, performRedo, performUndo, undoSnackbar } from '@/shared/undoSnackbar'

function fakeCommand(label: string): UndoableCommand {
  return { label, postIds: [], apply: async () => {}, revert: async () => {} }
}

describe('undo snackbar', () => {
  beforeEach(() => {
    clearHistory()
    dismissUndoSnackbar()
  })

  it('notifydid shows the label with an undo action', () => {
    notifyDid('评分 → 5')
    expect(undoSnackbar.value?.message).toBe('评分 → 5')
    expect(undoSnackbar.value?.action).toBe('undo')
  })

  it('performundo reverts and flips the snackbar to a redo action', async () => {
    pushCommand(fakeCommand('评分 → 5'))
    await performUndo()
    expect(undoSnackbar.value?.message).toContain('已撤销')
    expect(undoSnackbar.value?.action).toBe('redo')
  })

  it('performredo re-applies and flips the snackbar to an undo action', async () => {
    pushCommand(fakeCommand('评分 → 5'))
    await performUndo()
    await performRedo()
    expect(undoSnackbar.value?.message).toContain('已重做')
    expect(undoSnackbar.value?.action).toBe('undo')
  })

  it('performundo on empty history leaves the snackbar untouched', async () => {
    await performUndo()
    expect(undoSnackbar.value).toBeNull()
  })

  it('dismissundosnackbar clears it', () => {
    notifyDid('x')
    dismissUndoSnackbar()
    expect(undoSnackbar.value).toBeNull()
  })
})
