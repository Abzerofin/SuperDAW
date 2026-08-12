/// <reference types="vite/client" />

/** The app version, injected at build time from package.json. */
declare const __APP_VERSION__: string

/** Result of a plugin scan (see src/main/pluginScan.ts). */
interface PluginScanStatus {
  plugins: {
    path: string
    uid: string
    name: string
    vendor: string
    version: string
    subCategories: string
  }[]
  folders: string[]
  failures: { path: string; reason: string; crashed: boolean }[]
  scanning: boolean
  lastScanMs: number | null
}

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
    recoveryWriteDoc(args: { json: string; name: string; path: string | null }): Promise<void>
    recoveryWriteAsset(args: { fileName: string; data: Uint8Array }): Promise<boolean>
    recoveryPeek(): Promise<{ name: string; path: string | null; savedAt: number } | null>
    recoveryRead(): Promise<{
      json: string
      path: string | null
      assets: { fileName: string; data: Uint8Array }[]
    } | null>
    recoveryClear(): Promise<void>
    collabHostStart(): Promise<{ host: string; port: number; token: string } | { error: string }>
    collabHostStop(): Promise<void>
    collabSendToPeer(connId: number, data: string): void
    collabKickPeer(connId: number): void
    onCollabEvent(handlers: {
      connected(connId: number): void
      message(connId: number, data: string): void
      disconnected(connId: number): void
    }): () => void
    /** Plugin scanning. Optional: absent in the browser build. */
    pluginStatus?(): Promise<PluginScanStatus>
    pluginRefresh?(): Promise<PluginScanStatus>
    pluginGetFolders?(): Promise<string[]>
    pluginSetFolders?(folders: string[]): Promise<PluginScanStatus>
    pluginResetFolders?(): Promise<PluginScanStatus>
    pluginBrowseFolder?(): Promise<string | null>
    pluginClearQuarantine?(): Promise<PluginScanStatus>
    onPluginsChanged?(handler: () => void): () => void
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
      params?: Record<string, number>
      stateBlob?: string | null
    }): Promise<{ channels?: Float32Array[]; error?: string }>
    vst3OpenInstance(args: {
      uid: string
      sampleRate: number
      blockSize?: number
      channels?: number
      stateBlob?: string | null
    }): Promise<{ handle?: number; outputChannels?: number; error?: string }>
    vst3InstanceState(handle: number): Promise<{ stateBlob?: string; error?: string }>
    vst3OpenEditor(args: {
      instanceId: string
      uid: string
      stateBlob?: string | null
      title?: string
    }): Promise<{ opened?: boolean; error?: string }>
    vst3CloseEditor(instanceId: string): Promise<void>
    vst3SetEditorParam(args: {
      instanceId: string
      paramId: number
      value: number
    }): Promise<{ error?: string }>
    vst3DockEditor(args: {
      instanceId: string
      uid: string
      stateBlob?: string | null
      rect: {
        x: number
        y: number
        clipLeft: number
        clipTop: number
        clipRight: number
        clipBottom: number
        visible: boolean
      } | null
    }): Promise<{ width?: number; height?: number; error?: string }>
    onVst3EditorEvent(
      handler: (event: {
        instanceId: string
        kind: string
        paramId?: number
        value?: number
        stateBlob?: string
        params?: Record<string, number>
      }) => void
    ): () => void
    vst3ProcessInstance(args: {
      handle: number
      channels: Float32Array[]
      params?: Record<string, number>
    }): Promise<{ channels?: Float32Array[]; error?: string }>
    vst3CloseInstance(handle: number): Promise<{ closed: boolean }>
    vst3Parameters(uid: string): Promise<{
      parameters?: {
        id: number
        title: string
        units: string
        defaultNormalized: number
        stepCount: number
        defaultDisplay: string
        isBypass: boolean
      }[]
      error?: string
    }>
  }
}
