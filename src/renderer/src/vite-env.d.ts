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
    openProjectPath(path: string): Promise<{ path: string; name: string; data: Uint8Array } | null>
    appDataGet(key: string): Promise<unknown>
    appDataSet(key: string, value: unknown): Promise<void>
    openFile(args: {
      filterName: string
      ext: string
    }): Promise<{ path: string; name: string; data: Uint8Array } | null>
    exportFile(args: {
      data: Uint8Array
      defaultName: string
      filterName: string
      ext: string
    }): Promise<string | null>
    setDirty(dirty: boolean): void
    onSaveRequest(handler: () => Promise<boolean>): () => void
    collabHostStart(): Promise<{ host: string; port: number; token: string } | { error: string }>
    collabHostStop(): Promise<void>
    collabSendToPeer(connId: number, data: string): void
    collabKickPeer(connId: number): void
    onCollabEvent(handlers: {
      connected(connId: number): void
      message(connId: number, data: string): void
      disconnected(connId: number): void
    }): () => void
    vst3Scan(): Promise<
      {
        path: string
        uid: string
        name: string
        vendor: string
        version: string
        subCategories: string
      }[]
    >
    vst3Process(args: {
      uid: string
      channels: Float32Array[]
      sampleRate: number
    }): Promise<{ channels?: Float32Array[]; error?: string }>
  }
}
