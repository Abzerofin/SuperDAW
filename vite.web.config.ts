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
      '@audio': resolve('src/audio'),
      '@': resolve('src/renderer/src')
    }
  },
  // host: true exposes the web client on the LAN so another device can open
  // http://<this-pc-ip>:5180 and join a session with zero install.
  server: { port: 5180, strictPort: true, host: true }
})
