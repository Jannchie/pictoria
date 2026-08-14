import { computed, ref } from 'vue'

export interface UndoableCommand {
  /** toast 文案，如 "给 3 张图评分 5"。 */
  label: string
  /** 受影响的 post id，用于撤销后高亮定位。 */
  postIds: number[]
  /** 重做方向：把状态推回"操作之后"。 */
  apply: () => Promise<void>
  /** 撤销方向：把状态还原到"操作之前"。 */
  revert: () => Promise<void>
  /** 可选提示，撤销时附加到 toast（如批量中有未加载的 post 无法还原）。 */
  note?: string
}

export type UndoResult
  = | { status: 'empty' }
  | { status: 'done', command: UndoableCommand }
  | { status: 'failed', command: UndoableCommand, error: unknown }

const MAX_HISTORY_DEPTH = 100

const undoStack = ref<UndoableCommand[]>([])
const redoStack = ref<UndoableCommand[]>([])

export const canUndo = computed(() => undoStack.value.length > 0)
export const canRedo = computed(() => redoStack.value.length > 0)

export function pushCommand(command: UndoableCommand): void {
  undoStack.value.push(command)
  if (undoStack.value.length > MAX_HISTORY_DEPTH) {
    undoStack.value.shift()
  }
  redoStack.value = []
}

export async function undo(): Promise<UndoResult> {
  const command = undoStack.value.pop()
  if (!command) {
    return { status: 'empty' }
  }
  try {
    await command.revert()
  }
  catch (error) {
    // 丢弃该命令，不挪到 redo 栈，让栈与真实持久化状态保持一致。
    return { status: 'failed', command, error }
  }
  redoStack.value.push(command)
  return { status: 'done', command }
}

export async function redo(): Promise<UndoResult> {
  const command = redoStack.value.pop()
  if (!command) {
    return { status: 'empty' }
  }
  try {
    await command.apply()
  }
  catch (error) {
    return { status: 'failed', command, error }
  }
  undoStack.value.push(command)
  return { status: 'done', command }
}

export function clearHistory(): void {
  undoStack.value = []
  redoStack.value = []
}
