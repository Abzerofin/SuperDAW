// Browser-only dev server for the renderer. Used for UI development and
// visual testing without launching the Electron shell. The renderer must
// never hard-depend on Electron APIs (see docs/ARCHITECTURE.md).
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  resolve: {
    alias: {
      '@core': resolve('src/core'),
      '@': resolve('src/renderer/src')
    }
  },
  server: { port: 5180, strictPort: true }
})
