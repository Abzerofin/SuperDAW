import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {},
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
