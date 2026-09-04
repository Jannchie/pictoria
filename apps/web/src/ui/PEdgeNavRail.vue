<script setup lang="ts">
defineProps<{
  /** 贴哪一侧。 */
  side: 'left' | 'right'
  /** 是否浮出来。平时该隐身，由调用方按指针是否贴近该侧来决定（见 useEdgeProximity）。 */
  shown?: boolean
}>()
</script>

<template>
  <button
    type="button"
    class="p-edge-nav-rail"
    :class="[`p-edge-nav-rail--${side}`, { 'p-edge-nav-rail--shown': shown }]"
    @pointerdown.stop
    @dblclick.stop
  >
    <i
      :class="side === 'left' ? 'i-tabler-chevron-left' : 'i-tabler-chevron-right'"
      class="text-2xl"
      aria-hidden="true"
    />
  </button>
</template>

<style scoped>
/*
 * 与所在容器等高、贴在左右内侧的一条。图片高矮不一，等高的条比一颗浮在中间的
 * 按钮好瞄，热区也大得多。
 *
 * 用原生 button 而不是 PButton：PButton 的高度、内边距和
 * `:active { transform: translateY(1px) }` 全都要覆盖掉，而那条 active 规则特异性
 * 还更高，会把用来居中的 translate 整个换掉，按下去就往下跳。
 */
.p-edge-nav-rail {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 3rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  padding: 0;
  z-index: 1;
  opacity: 0;
  pointer-events: none;
  cursor: pointer;
  /* 图片可以是任何颜色，所以垫一层半透明底 + 模糊，浅色画面上也分得出来，
     又不像实心块那样压着画面。 */
  background: color-mix(in oklab, var(--p-surface-2) 70%, transparent);
  backdrop-filter: blur(8px);
  color: var(--p-fg);
  transition:
    opacity var(--p-transition-fast),
    background-color var(--p-transition-fast);
}
.p-edge-nav-rail--left { left: 0; }
.p-edge-nav-rail--right { right: 0; }
.p-edge-nav-rail--shown,
.p-edge-nav-rail:focus-visible {
  opacity: 1;
  pointer-events: auto;
}
.p-edge-nav-rail:hover {
  background: color-mix(in oklab, var(--p-surface-3) 88%, transparent);
}
/* 焦点环本身走全局 :focus-visible 规则；这条只是把它收进条内侧，
   否则贴边的条会把环画到容器外被裁掉。 */
.p-edge-nav-rail:focus-visible {
  outline-offset: -2px;
}
@media (prefers-reduced-motion: reduce) {
  .p-edge-nav-rail { transition: none; }
}
</style>
