import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  // ws stays a runtime require: bundling it trips on its optional native deps.
  main: { build: { rollupOptions: { external: ['ws'] } } },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@core': resolve('src/core'),
        '@audio': resolve('src/audio'),
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
