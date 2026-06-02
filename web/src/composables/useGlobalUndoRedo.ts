import { computed } from 'vue'
import { onKeyStroke, useActiveElement } from '@vueuse/core'
import { redo, undo } from '@/shared/history'
import { selectedPostIdSet } from '@/shared/state'
import { useToast } from '@/shared/toast'

/**
 * 全局 Ctrl/Cmd+Z 撤销、Ctrl+Y / Ctrl+Shift+Z 重做。
 * 输入框聚焦时不拦截，交给浏览器原生文本撤销。撤销/重做后弹 toast，
 * 并把受影响的 post 设为当前选中以便用户看到变化（选择本身不进历史栈）。
 */
export function useGlobalUndoRedo() {
  const { pushToast } = useToast()
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

    const result = isRedo ? await redo() : await undo()
    if (result.status === 'empty') {
      return
    }
    if (result.status === 'failed') {
      pushToast({
        type: 'error',
        message: `无法${isRedo ? '重做' : '撤销'}：${result.command.label}（帖子可能已被删除）`,
        duration: 4000,
        closeable: true,
      })
      return
    }
    // 高亮受影响的 post（不进历史栈，只是视觉聚焦）
    if (result.command.postIds.length > 0) {
      selectedPostIdSet.value = new Set(result.command.postIds)
    }
    const note = !isRedo && result.command.note ? `（${result.command.note}）` : ''
    pushToast({
      type: 'info',
      message: `${isRedo ? '已重做' : '已撤销'}：${result.command.label}${note}`,
      duration: 2500,
    })
  })
}
