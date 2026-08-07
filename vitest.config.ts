import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve('src/core'),
      '@audio': resolve('src/audio'),
      '@': resolve('src/renderer/src')
    }
  },
  test: {
    // The asset-transfer suite pushes multi-megabyte payloads through real
    // base64 chunking; a couple of those cases sit within a few hundred ms
    // of the 5 s default and flake on a loaded machine. They are correct,
    // just genuinely slow — give them headroom instead of a coin flip.
    testTimeout: 20_000
  }
})
