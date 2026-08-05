/// <reference types="vite/client" />

/** API exposed by the Electron preload script (src/preload/index.ts).
 * Declared structurally here so the renderer stays compilable without
 * Electron (browser dev mode). */
interface Window {
  superdaw?: {
    platform: string
    saveProjectFile(args: {
      data: Uint8Array
      path: string | null
      defaultName: string
    }): Promise<string | null>
    openProjectFile(): Promise<{ path: string; name: string; data: Uint8Array } | null>
  }
}
