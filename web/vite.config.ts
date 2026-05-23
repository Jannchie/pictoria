import path from 'node:path'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import UnoCSS from 'unocss/vite'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { defineConfig } from 'vite'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vueJsx(),
    UnoCSS(),
    Components({
      dirs: ['./src/components', './src/ui'],
      dts: './src/components.d.ts',
    }),
    AutoImport({
      imports: [
        'vue',
        '@vueuse/core',
      ],
      dirs: [
        './src/composables',
        './src/locale',
      ],
      dts: './src/auto-import.d.ts',
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split heavy third-party deps out of the entry chunk so the initial
        // payload only ships what the gallery shell needs. Route-level
        // dynamic imports already give each view its own chunk; this carves
        // off the vendor weight that they all share.
        manualChunks: {
          'vendor-vue': ['vue', 'vue-router'],
          'vendor-query': ['@tanstack/vue-query'],
          'vendor-color': ['culori'],
          'vendor-vueuse': ['@vueuse/core', '@vueuse/math'],
          'vendor-waterfall': ['vue-wf'],
        },
      },
    },
  },
})
