import { readFileSync } from 'node:fs'
import { rokuPreset } from '@roku-ui/preset'

import { defineConfig } from 'unocss'

const file = readFileSync('node_modules/@roku-ui/vue/dist/index.js', 'utf8')

export default defineConfig({
  presets: [
    rokuPreset(),
  ],
  content: {
    inline: [file],
  },
})
