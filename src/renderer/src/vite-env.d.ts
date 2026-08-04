/// <reference types="vite/client" />

/** API exposed by the Electron preload script (src/preload/index.ts).
 * Declared structurally here so the renderer stays compilable without
 * Electron (browser dev mode). */
interface Window {
  superdaw?: {
    platform: string
  }
}
