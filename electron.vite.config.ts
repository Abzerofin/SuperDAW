import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  // ws stays a runtime require: bundling it trips on its optional native deps.
  // The plugin scanner is a SECOND entry, not part of index: it is forked as
  // a utilityProcess, so it has to exist as its own file on disk.
  main: {
    build: {
      rollupOptions: {
        external: ['ws'],
        input: {
          index: resolve('src/main/index.ts'),
          pluginScanWorker: resolve('src/main/pluginScanWorker.ts')
        }
      }
    }
  },
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
