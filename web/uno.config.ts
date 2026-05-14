import { defineConfig, presetIcons, presetWind3 } from 'unocss'

const color = (name: string) => `rgb(var(--p-${name}-rgb) / <alpha-value>)`

export default defineConfig({
  presets: [
    presetWind3(),
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
    borderRadius: {
      'xs': 'var(--p-radius-xs)',
      'sm': 'var(--p-radius-sm)',
      'DEFAULT': 'var(--p-radius-md)',
      'md': 'var(--p-radius-md)',
      'lg': 'var(--p-radius-lg)',
      'xl': 'var(--p-radius-xl)',
      '2xl': 'var(--p-radius-2xl)',
      'full': 'var(--p-radius-full)',
    },
    boxShadow: {
      sm: 'var(--p-shadow-sm)',
      DEFAULT: 'var(--p-shadow-md)',
      md: 'var(--p-shadow-md)',
      lg: 'var(--p-shadow-lg)',
    },
    fontFamily: {
      sans: 'var(--p-font-sans)',
      mono: 'var(--p-font-mono)',
    },
    // Pair every font-size with a non-unit line-height. presetWind3 defaults
    // bare `text-*` rules to `line-height: 1`, which clips descenders (j, g,
    // p, q, y) inside any element with `overflow: hidden` / `truncate`.
    fontSize: {
      'xs': ['var(--p-text-xs)', 'var(--p-leading-normal)'],
      'sm': ['var(--p-text-sm)', 'var(--p-leading-normal)'],
      'base': ['var(--p-text-base)', 'var(--p-leading-normal)'],
      'md': ['var(--p-text-md)', 'var(--p-leading-normal)'],
      'lg': ['var(--p-text-lg)', 'var(--p-leading-snug)'],
      'xl': ['var(--p-text-xl)', 'var(--p-leading-snug)'],
      '2xl': ['var(--p-text-2xl)', 'var(--p-leading-snug)'],
      '3xl': ['var(--p-text-3xl)', 'var(--p-leading-tight)'],
      '4xl': ['var(--p-text-4xl)', 'var(--p-leading-tight)'],
    },
  },
  shortcuts: {
    // Frequently-used semantic combinations.
    'p-border': 'border border-border-default',
    'p-divider': 'border-b border-border-subtle',
  },
})
