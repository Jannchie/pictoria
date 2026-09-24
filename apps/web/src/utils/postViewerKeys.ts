import { isWidgetTarget } from '@/utils/keyboard'

/**
 * 详情页 / 全屏查看器的按键判定（纯函数，节点环境可测）。
 *
 * ←→ / Escape 这类「页面级」热键默认在任何控件获得焦点时让位（见 `useHotkey`
 * 的 widget 守卫）。但这两个视图自己的工具按钮 —— 返回、翻页竖条、适应窗口、
 * 1:1、翻转 —— 都是普通按钮，本身不消费方向键：点一下「下一张」竖条之后焦点
 * 留在它身上，再按 → 理应继续翻页，而不是因为「焦点在按钮上」就失灵。
 *
 * 所以规则是：焦点在控件上时一律让位，**除非**它是本视图 chrome 里的普通按钮
 * （原生 `<button>`，没有被组合控件接管）。缩放滑块、评分单选组、缩略图
 * option、目录树等真正消费方向键的控件仍然让位。
 */

/** 把方向键 / Home / End 据为己有的组合控件角色。它们里面的按钮不算「普通按钮」。 */
const COMPOSITE_SELECTOR = [
  '[role=toolbar]',
  '[role=menu]',
  '[role=menubar]',
  '[role=listbox]',
  '[role=grid]',
  '[role=tree]',
  '[role=treegrid]',
  '[role=tablist]',
  '[role=radiogroup]',
].join(',')

/**
 * 原生 `<button>`（或无 role / role=button），且不在任何组合控件里 —— 即
 * 方向键对它没有意义的按钮。
 */
export function isPlainButton(el: EventTarget | Element | null | undefined): boolean {
  if (!el || typeof (el as Element).closest !== 'function') {
    return false
  }
  const element = el as Element
  if (element.tagName !== 'BUTTON') {
    return false
  }
  const role = element.getAttribute('role')
  if (role && role !== 'button') {
    return false
  }
  return element.closest(COMPOSITE_SELECTOR) === null
}

/**
 * `isWidgetTarget` 之外再算上 `role=button` / `role=link` 的非原生元素（例如
 * 画廊缩略图 `<div role="button">`）：它们自己处理 Enter / 空格，视图热键不能
 * 抢。
 */
export function isInteractiveTarget(el: EventTarget | Element | null | undefined): boolean {
  if (isWidgetTarget(el)) {
    return true
  }
  if (!el || typeof (el as Element).closest !== 'function') {
    return false
  }
  return (el as Element).closest('[role=button],[role=link]') !== null
}

/**
 * 视图级导航热键（←→、Shift+方向键平移、Escape 返回）此刻能否处理这次按键。
 * 配合 `useHotkey(…, { allowInWidgets: true, ignore: e => !allowsViewKeys(e.target, chrome) })`
 * 使用 —— 文本输入框仍由 `allowInTyping: false` 挡在外面。
 *
 * @param target 按键的目标（`e.target`）。
 * @param chrome 本视图自己的根元素；只有它里面的普通按钮可以放行。
 */
export function allowsViewKeys(
  target: EventTarget | Element | null | undefined,
  chrome: Element | null | undefined,
): boolean {
  if (!isInteractiveTarget(target)) {
    return true
  }
  return isPlainButton(target) && chrome != null && chrome.contains(target as Node)
}

/** 缩放范围，与滚轮 / 滑块一致。 */
export const MIN_SCALE = 0.1
export const MAX_SCALE = 8

/** 夹到缩放范围内并保留两位小数（滑块步长 0.01）。 */
export function clampScale(scale: number): number {
  const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale))
  return Math.round(clamped * 100) / 100
}

/** Shift+方向键平移画布；每次移动视口宽 / 高的这个比例。 */
export const PAN_RATIO = 0.1
/** 视口很小时的最小步长（px）。 */
export const MIN_PAN_STEP = 24

export const PAN_SHORTCUTS = ['Shift+ArrowLeft', 'Shift+ArrowRight', 'Shift+ArrowUp', 'Shift+ArrowDown'] as const

/**
 * Shift+方向键对应的图片位移（图片左上角 x/y 的增量）。语义是「把视口往箭头
 * 方向移」—— 看图片右边的部分，图片本身向左移，所以符号与箭头相反。
 * 非方向键返回 null。
 */
export function panOffset(key: string, viewportWidth: number, viewportHeight: number): { dx: number, dy: number } | null {
  const stepX = Math.max(MIN_PAN_STEP, viewportWidth * PAN_RATIO)
  const stepY = Math.max(MIN_PAN_STEP, viewportHeight * PAN_RATIO)
  switch (key) {
    case 'ArrowLeft': {
      return { dx: stepX, dy: 0 }
    }
    case 'ArrowRight': {
      return { dx: -stepX, dy: 0 }
    }
    case 'ArrowUp': {
      return { dx: 0, dy: stepY }
    }
    case 'ArrowDown': {
      return { dx: 0, dy: -stepY }
    }
    default: {
      return null
    }
  }
}
