import { onKeyStroke, useActiveElement } from '@vueuse/core'
import { computed } from 'vue'
import { performRedo, performUndo } from '@/shared/undoSnackbar'

/**
 * 全局 Ctrl/Cmd+Z 撤销、Ctrl+Y / Ctrl+Shift+Z 重做。
 * 输入框聚焦时不拦截，交给浏览器原生文本撤销。撤销/重做的反馈与 popup 内的
 * 按钮共用 performUndo/performRedo，统一走底部 snackbar。
 */
export function useGlobalUndoRedo() {
  const activeElement = useActiveElement()
  const notUsingInput = computed(() =>
    activeElement.value?.tagName !== 'INPUT'
    && activeElement.value?.tagName !== 'TEXTAREA',
  )

  onKeyStroke(['z', 'Z', 'y', 'Y'], async (e) => {
    if (!notUsingInput.value) {
      return
    }
    const ctrl = e.ctrlKey || e.metaKey
    if (!ctrl) {
      return
    }
    const key = e.key.toLowerCase()
    const isRedo = key === 'y' || (key === 'z' && e.shiftKey)
    const isUndo = key === 'z' && !e.shiftKey
    if (!isUndo && !isRedo) {
      return
    }
    e.preventDefault()
    await (isRedo ? performRedo() : performUndo())
  })
}
