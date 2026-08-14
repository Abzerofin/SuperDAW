import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { version } from './package.json'

export default defineConfig({
  // ws stays a runtime require: bundling it trips on its optional native deps.
  // The plugin scanner and the audio host are SEPARATE entries, not part of
  // index: each is forked as a utilityProcess, so each has to exist as its
  // own file on disk.
  main: {
    build: {
      rollupOptions: {
        external: ['ws'],
        input: {
          index: resolve('src/main/index.ts'),
          pluginScanWorker: resolve('src/main/pluginScanWorker.ts'),
          audioHostWorker: resolve('src/main/audioHostWorker.ts')
        }
      }
    }
  },
  preload: {},
  renderer: {
    // The app version is a build-time constant: the renderer shows it under
    // the brand and must not read package.json at runtime (browser build).
    define: { __APP_VERSION__: JSON.stringify(version) },
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
