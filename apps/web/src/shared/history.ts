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

/**
 * 历史栈此刻在做什么。
 *
 * 撤销/重做都要等一次网络请求，原来两个栈之外没有任何状态，于是：
 * - 连按两下 Ctrl+Z，两次 revert 并发发出 —— 同一张图"评 3 → 评 5"两步撤销，请求
 *   乱序落地就停在 3 而不是原样；
 * - 撤销还在飞的时候做了一次新操作（`pushCommand` 清空了重做栈），撤销回来后又把
 *   命令塞进重做栈 —— 新操作之后还能"重做"一条已经作废的分支。
 *
 * 所以撤销/重做排成一条链（`enqueue`），同一时刻至多一步在飞，记在这里；在飞期间
 * 推进来的新命令数记在 `pushedSince`，落地时据此决定命令去哪（见 `settle`）。对象
 * 身份也是凭证：`clearHistory` 换掉它之后，旧的那一步落地时什么都不写。
 */
type HistoryOp
  = | { kind: 'idle' }
    | { kind: 'undoing' | 'redoing', command: UndoableCommand, pushedSince: number }

let op: HistoryOp = { kind: 'idle' }
let tail: Promise<unknown> = Promise.resolve()

function enqueue(step: () => Promise<UndoResult>): Promise<UndoResult> {
  const run = tail.then(step)
  // 链本身不能因为一步失败而断（step 不会 reject，这里只是兜底）。
  tail = run.catch(() => {})
  return run
}

export function pushCommand(command: UndoableCommand): void {
  undoStack.value.push(command)
  if (undoStack.value.length > MAX_HISTORY_DEPTH) {
    undoStack.value.shift()
  }
  redoStack.value = []
  if (op.kind !== 'idle') {
    op.pushedSince += 1
  }
}

/**
 * 一步撤销/重做落地后，命令去哪。
 *
 * - 撤销成功：进重做栈 —— 除非期间有新操作，那时重做分支已经作废（同 `pushCommand`
 *   清空重做栈），命令直接丢掉。
 * - 重做成功：回撤销栈。期间推进来的新命令是在它**之后**发起的，所以它插在那些命令
 *   下面，下一次 Ctrl+Z 先撤销最新的那个。
 * - 失败：丢弃，不挪到另一个栈，让栈与真实持久化状态保持一致。
 */
function settle(current: HistoryOp & { kind: 'undoing' | 'redoing' }, ok: boolean): void {
  if (op !== current) {
    return // clearHistory 在这一步飞行期间清过栈
  }
  op = { kind: 'idle' }
  if (!ok) {
    return
  }
  if (current.kind === 'undoing') {
    if (current.pushedSince === 0) {
      redoStack.value.push(current.command)
    }
    return
  }
  const at = Math.max(0, undoStack.value.length - current.pushedSince)
  undoStack.value.splice(at, 0, current.command)
  if (undoStack.value.length > MAX_HISTORY_DEPTH) {
    undoStack.value.shift()
  }
}

function step(kind: 'undoing' | 'redoing'): Promise<UndoResult> {
  return enqueue(async () => {
    const command = (kind === 'undoing' ? undoStack : redoStack).value.pop()
    if (!command) {
      return { status: 'empty' }
    }
    const current = { kind, command, pushedSince: 0 }
    op = current
    try {
      await (kind === 'undoing' ? command.revert() : command.apply())
    }
    catch (error) {
      settle(current, false)
      return { status: 'failed', command, error }
    }
    settle(current, true)
    return { status: 'done', command }
  })
}

/** 撤销最近一步。连按时排队依次执行，不并发。 */
export function undo(): Promise<UndoResult> {
  return step('undoing')
}

/** 重做最近一次撤销。与 `undo` 共用同一条队列。 */
export function redo(): Promise<UndoResult> {
  return step('redoing')
}

export function clearHistory(): void {
  undoStack.value = []
  redoStack.value = []
  op = { kind: 'idle' }
}
