import type { ComputedRef } from 'vue'
import { useActiveElement, useMagicKeys, whenever } from '@vueuse/core'
import { logicAnd } from '@vueuse/math'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { focusedTreeFolder, isAnyDialogOpen, showPostDetail } from '@/shared'

/**
 * 单一事实来源，统一了此前散落在 5 个组件里逐字复制的键盘热键守卫。
 *
 * - `notUsingInput`：唯一的「当前焦点不在文本输入控件里」判定。
 * - `useKeyScope()` / `activeKeyScope`：把 MainSection 的 `canHandleGridKeys`
 *   与 Post.vue 的 `canHandlePageKeys`（两份逐字相同的条件）以及 PostDetail
 *   全屏覆盖层的存在，统一成一个显式互斥的作用域。方向键 / Enter / Escape /
 *   Delete 之类的导航热键只需问「当前作用域是不是我」。
 * - `useScoreHotkeys()`：1–5 数字键打分的唯一注册点，用作用域互斥取代了
 *   PostDetailPanel 里靠 `route.name` 检查来防止与 MainSection 双触发的做法。
 */

/** 当前焦点是否不在 <input> / <textarea> 里（唯一实现，只查这两种标签）。 */
const activeElement = useActiveElement()
export const notUsingInput: ComputedRef<boolean> = computed(() =>
  activeElement.value?.tagName !== 'INPUT'
  && activeElement.value?.tagName !== 'TEXTAREA',
)

/**
 * 导航热键的作用域。互斥四选一：
 * - `detailOverlay`：PostDetail 全屏覆盖层打开时（覆盖层接管，网格/页面让位）。
 * - `grid`：画廊路由，网格热键（方向键移动选中、Enter 进详情、Delete、Escape）。
 * - `postPage`：/post/:id 详情页热键（方向键切图、Enter/空格看大图、Delete）。
 * - `none`：焦点在输入框、对话框打开、或侧栏目录树行获得焦点时，全部让位。
 */
export type KeyScope = 'grid' | 'postPage' | 'detailOverlay' | 'none'

export interface KeyScopeInputs {
  /** 焦点是否落在 <input> / <textarea> 里。 */
  usingInput: boolean
  /** PostDetail 全屏覆盖层是否打开。 */
  detailOverlayOpen: boolean
  /** 是否有对话框（PDialog / POverlay）打开。 */
  dialogOpen: boolean
  /** 侧栏目录树是否有某一行获得键盘焦点。 */
  treeFocused: boolean
  /** 当前是否在 /post/:id 详情页路由（route.name === 'post'）。 */
  isPostRoute: boolean
}

/**
 * 纯函数版的作用域判定，供表驱动测试直接覆盖。判定顺序即优先级，逐条对齐
 * 原先的 `canHandleGridKeys` / `canHandlePageKeys`（notUsingInput &&
 * !showPostDetail && !isAnyDialogOpen && !focusedTreeFolder）与 PostDetail 覆盖层
 * 仅有的 `notUsingInput` 守卫。
 */
export function resolveKeyScope(inputs: KeyScopeInputs): KeyScope {
  // 输入框优先让位：覆盖层的方向键守卫此前也只看 notUsingInput。
  if (inputs.usingInput) {
    return 'none'
  }
  // 覆盖层一旦打开就接管：原覆盖层守卫不看对话框/目录树，故排在它们之前。
  if (inputs.detailOverlayOpen) {
    return 'detailOverlay'
  }
  // 对话框打开或目录树聚焦时，网格/页面热键让位（对齐两份 canHandle*Keys）。
  if (inputs.dialogOpen || inputs.treeFocused) {
    return 'none'
  }
  return inputs.isPostRoute ? 'postPage' : 'grid'
}

/** 打分热键的作用域。只区分网格 / 详情页 / 让位——不受覆盖层、对话框、目录树影响。 */
export type ScoreScope = 'grid' | 'postPage' | 'none'

/**
 * 纯函数版的打分作用域判定。数字键打分此前的两处实现都只由「不在输入框」+
 * 「在哪个路由」决定（MainSection 只有 notUsingInput 守卫；PostDetailPanel 是
 * notUsingInput && route.name === 'post'），对话框 / 覆盖层 / 目录树都不拦截，
 * 这里如实保留。
 */
export function resolveScoreScope(inputs: { usingInput: boolean, isPostRoute: boolean }): ScoreScope {
  if (inputs.usingInput) {
    return 'none'
  }
  return inputs.isPostRoute ? 'postPage' : 'grid'
}

/** 响应式的导航作用域。需在组件 setup 中调用（依赖 useRoute）。 */
export function useKeyScope(): ComputedRef<KeyScope> {
  const route = useRoute()
  return computed(() => resolveKeyScope({
    usingInput: !notUsingInput.value,
    detailOverlayOpen: showPostDetail.value != null,
    dialogOpen: isAnyDialogOpen.value,
    treeFocused: Boolean(focusedTreeFolder.value),
    isPostRoute: route.name === 'post',
  }))
}

/**
 * 1–5 数字键打分的唯一注册点。消费者声明自己所属的作用域，并传入实际的打分
 * 动作（继续走 `shared/mutations.ts` 的 `commitScore`，不在这里复制）。只有当
 * 当前打分作用域与声明的一致时才触发，凭此实现 MainSection（grid）与
 * PostDetailPanel（postPage）的互斥——取代原来的 route.name 检查。
 *
 * @param scope 消费者所属作用域：网格用 'grid'，详情页侧栏用 'postPage'。
 * @param applyScore 施加分数的动作，入参为 1–5。
 */
export function useScoreHotkeys(
  scope: Exclude<ScoreScope, 'none'>,
  applyScore: (score: number) => void | Promise<void>,
): void {
  const route = useRoute()
  const canScore = computed(() =>
    resolveScoreScope({
      usingInput: !notUsingInput.value,
      isPostRoute: route.name === 'post',
    }) === scope,
  )
  const { 1: one, 2: two, 3: three, 4: four, 5: five } = useMagicKeys()
  const digitRefs = [one, two, three, four, five]
  for (const [i, keyRef] of digitRefs.entries()) {
    whenever(logicAnd(keyRef, canScore), () => {
      void applyScore(i + 1)
    })
  }
}
