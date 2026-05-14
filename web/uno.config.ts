import { defineConfig, presetIcons, presetWind4 } from 'unocss'

// wind4 controls utility opacity via color-mix + --un-*-opacity, so theme
// colors must be plain valid CSS (no `<alpha-value>` placeholder — wind4
// doesn't substitute it and leaves the literal in the output, which makes
// the whole `color-mix(...)` invalid and the utility silently drops).
const color = (name: string) => `rgb(var(--p-${name}-rgb))`

export default defineConfig({
  presets: [
    presetWind4(),
    presetIcons({
      scale: 1.1,
      extraProperties: {
        'display': 'inline-block',
        'vertical-align': 'middle',
      },
    }),
  ],
  theme: {
    colors: {
      // Semantic surface scale
      'bg': color('bg'),
      'surface': color('surface'),
      'surface-1': color('surface-1'),
      'surface-2': color('surface-2'),
      'surface-3': color('surface-3'),

      // Foreground / text
      'fg': color('fg'),
      'fg-muted': color('fg-muted'),
      'fg-subtle': color('fg-subtle'),
      'fg-disabled': color('fg-disabled'),

      // Borders
      'border-default': color('border'),
      'border-strong': color('border-strong'),
      'border-subtle': color('border-subtle'),

      // Brand
      'primary': {
        DEFAULT: color('primary'),
        hover: color('primary-hover'),
        active: color('primary-active'),
      },
      'on-primary': color('on-primary'),

      // Status
      'success': color('success'),
      'warning': color('warning'),
      'danger': color('danger'),
      'info': color('info'),
    },
    radius: {
      'xs': 'var(--p-radius-xs)',
      'sm': 'var(--p-radius-sm)',
      'DEFAULT': 'var(--p-radius-md)',
      'md': 'var(--p-radius-md)',
      'lg': 'var(--p-radius-lg)',
      'xl': 'var(--p-radius-xl)',
      '2xl': 'var(--p-radius-2xl)',
      'full': 'var(--p-radius-full)',
    },
    shadow: {
      'sm': 'var(--p-shadow-sm)',
      'DEFAULT': 'var(--p-shadow-md)',
      'md': 'var(--p-shadow-md)',
      'lg': 'var(--p-shadow-lg)',
    },
    font: {
      sans: 'var(--p-font-sans)',
      mono: 'var(--p-font-mono)',
    },
    // wind4 reads `text.<size>.{fontSize, lineHeight, letterSpacing}` directly
    // (see preset-wind4 rules.handleText) — both keys must be provided here
    // to avoid the bare `line-height: 1` that clips descenders.
    text: {
      'xs': { fontSize: 'var(--p-text-xs)', lineHeight: 'var(--p-leading-normal)' },
      'sm': { fontSize: 'var(--p-text-sm)', lineHeight: 'var(--p-leading-normal)' },
      'base': { fontSize: 'var(--p-text-base)', lineHeight: 'var(--p-leading-normal)' },
      'md': { fontSize: 'var(--p-text-md)', lineHeight: 'var(--p-leading-normal)' },
      'lg': { fontSize: 'var(--p-text-lg)', lineHeight: 'var(--p-leading-snug)' },
      'xl': { fontSize: 'var(--p-text-xl)', lineHeight: 'var(--p-leading-snug)' },
      '2xl': { fontSize: 'var(--p-text-2xl)', lineHeight: 'var(--p-leading-snug)' },
      '3xl': { fontSize: 'var(--p-text-3xl)', lineHeight: 'var(--p-leading-tight)' },
      '4xl': { fontSize: 'var(--p-text-4xl)', lineHeight: 'var(--p-leading-tight)' },
    },
  },
  shortcuts: {
    // Frequently-used semantic combinations.
    'p-border': 'border border-border-default',
    'p-divider': 'border-b border-border-subtle',
  },
})
