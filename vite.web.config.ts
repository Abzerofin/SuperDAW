// Browser-only dev server for the renderer. Used for UI development and
// visual testing without launching the Electron shell. The renderer must
// never hard-depend on Electron APIs (see docs/ARCHITECTURE.md).
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { version } from './package.json'

export default defineConfig({
  root: 'src/renderer',
  define: { __APP_VERSION__: JSON.stringify(version) },
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
  // PORT override lets tooling run a second instance beside the default one.
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5180,
    strictPort: true,
    host: true
  }
})
