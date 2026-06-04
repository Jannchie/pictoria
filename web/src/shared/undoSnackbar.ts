import { ref } from 'vue'
import { i18n } from '@/locale'
import { redo, undo } from './history'
import { selectedPostIdSet } from './state'

// Non-component module: go through the global composer.
const t = i18n.global.t

export interface UndoSnackbar {
  message: string
  /** 当前 popup 提供的按钮：撤销 / 重做 / 无（错误时）。 */
  action: 'undo' | 'redo' | null
  tone: 'normal' | 'error'
  /** 每次更新自增，组件据此重置自动消失计时。 */
  id: number
}

export const undoSnackbar = ref<UndoSnackbar | null>(null)
let counter = 0

function show(message: string, action: 'undo' | 'redo' | null, tone: 'normal' | 'error' = 'normal'): void {
  counter += 1
  undoSnackbar.value = { message, action, tone, id: counter }
}

export function dismissUndoSnackbar(): void {
  undoSnackbar.value = null
}

/** 执行一次可撤销操作后调用：弹出"刚做了 X" + 撤销按钮。 */
export function notifyDid(label: string): void {
  show(label, 'undo')
}

function highlight(postIds: number[]): void {
  // 把受影响的 post 设为当前选中，便于看到变化（选择不进历史栈）。
  if (postIds.length > 0) {
    selectedPostIdSet.value = new Set(postIds)
  }
}

/**
 * 撤销并刷新 popup。键盘快捷键和 popup 里的按钮都走这里，保证行为一致。
 */
export async function performUndo(): Promise<void> {
  const r = await undo()
  if (r.status === 'empty') {
    return
  }
  if (r.status === 'failed') {
    show(t('history.cannotUndo', { label: r.command.label }), null, 'error')
    return
  }
  highlight(r.command.postIds)
  const note = r.command.note ? t('history.noteSuffix', { note: r.command.note }) : ''
  show(t('history.undone', { label: r.command.label, note }), 'redo')
}

export async function performRedo(): Promise<void> {
  const r = await redo()
  if (r.status === 'empty') {
    return
  }
  if (r.status === 'failed') {
    show(t('history.cannotRedo', { label: r.command.label }), null, 'error')
    return
  }
  highlight(r.command.postIds)
  show(t('history.redone', { label: r.command.label }), 'undo')
}
