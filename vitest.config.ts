import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve('src/core'),
      '@audio': resolve('src/audio'),
      '@': resolve('src/renderer/src')
    }
  }
})
