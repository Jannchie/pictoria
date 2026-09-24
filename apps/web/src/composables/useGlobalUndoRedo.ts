import { useHotkey } from '@/composables/useHotkey'
import { shortcuts } from '@/shared/shortcuts'
import { performRedo, performUndo } from '@/shared/undoSnackbar'

/**
 * 全局 Mod+Z 撤销、Mod+Shift+Z / Mod+Y 重做（键位见 `shared/shortcuts.ts`）。
 * 输入框聚焦时不拦截（useHotkey 默认跳过 typing target），交给浏览器原生文本
 * 撤销。按钮、缩略图等控件上照常生效。撤销/重做的反馈与 popup 内的按钮共用
 * performUndo/performRedo，统一走底部 snackbar。
 */
export function useGlobalUndoRedo() {
  useHotkey(shortcuts.global.undo.keys, () => void performUndo(), { allowInWidgets: true })
  useHotkey(shortcuts.global.redo.keys, () => void performRedo(), { allowInWidgets: true })
}
