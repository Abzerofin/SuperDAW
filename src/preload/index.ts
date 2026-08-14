import { contextBridge, ipcRenderer } from 'electron'

/** Mirrors main's ScanStatus (see src/main/pluginScan.ts). */
export interface PluginScanStatus {
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

/**
 * Minimal bridge between the sandboxed renderer and the main process.
 * The renderer must run without this (browser dev mode), so everything
 * exposed here is optional from the renderer's perspective.
 */
const api = {
  platform: process.platform,

  /** Write project bytes; dialog shown unless `path` given. Null = cancelled. */
  saveProjectFile: (args: {
    data: Uint8Array
    path: string | null
    defaultName: string
  }): Promise<string | null> => ipcRenderer.invoke('project:save', args),

  /** Pick and read a project file. Null = cancelled. */
  openProjectFile: (): Promise<{ path: string; name: string; data: Uint8Array } | null> =>
    ipcRenderer.invoke('project:open'),

  /** Read a project by known path (recent projects). Null = unreadable/gone. */
  openProjectPath: (path: string): Promise<{ path: string; name: string; data: Uint8Array } | null> =>
    ipcRenderer.invoke('project:open-path', path),

  /** App-level key/value storage in userData (settings, recents). */
  appDataGet: (key: string): Promise<unknown> => ipcRenderer.invoke('appdata:get', key),
  appDataSet: (key: string, value: unknown): Promise<void> =>
    ipcRenderer.invoke('appdata:set', key, value),

  /** Pick and read any single file (e.g. a track preset). Null = cancelled. */
  openFile: (args: {
    filterName: string
    ext: string
  }): Promise<{ path: string; name: string; data: Uint8Array } | null> =>
    ipcRenderer.invoke('file:open', args),

  /** Save arbitrary bytes via a dialog (e.g. WAV export). Null = cancelled. */
  exportFile: (args: {
    data: Uint8Array
    defaultName: string
    filterName: string
    ext: string
  }): Promise<string | null> => ipcRenderer.invoke('file:export', args),

  /** Keep the main process informed for the unsaved-changes close guard. */
  setDirty: (dirty: boolean): void => {
    ipcRenderer.send('project:set-dirty', dirty)
  },

  // ----- Crash recovery (see src/main/recovery.ts) -----

  /** Write/refresh the recovery snapshot's document + metadata. */
  recoveryWriteDoc: (args: { json: string; name: string; path: string | null }): Promise<void> =>
    ipcRenderer.invoke('recovery:write-doc', args),

  /** Persist one asset's bytes into the snapshot. False = already there. */
  recoveryWriteAsset: (args: { fileName: string; data: Uint8Array }): Promise<boolean> =>
    ipcRenderer.invoke('recovery:write-asset', args),

  /** Is there a snapshot to offer? Cheap — reads only the metadata. */
  recoveryPeek: (): Promise<{ name: string; path: string | null; savedAt: number } | null> =>
    ipcRenderer.invoke('recovery:peek'),

  /** The full snapshot: document JSON plus every persisted asset. */
  recoveryRead: (): Promise<{
    json: string
    path: string | null
    assets: { fileName: string; data: Uint8Array }[]
  } | null> => ipcRenderer.invoke('recovery:read'),

  recoveryClear: (): Promise<void> => ipcRenderer.invoke('recovery:clear'),

  /**
   * Close-guard handshake: main asks us to save before closing; we report
   * back whether the save completed (false = user cancelled the dialog).
   */
  onSaveRequest: (handler: () => Promise<boolean>): (() => void) => {
    const listener = (): void => {
      void handler().then((saved) => ipcRenderer.send('project:save-done', saved))
    }
    ipcRenderer.on('project:save-request', listener)
    return () => ipcRenderer.off('project:save-request', listener)
  },

  // ----- Hosting transport (see src/main/collabServer.ts) -----

  collabHostStart: (): Promise<{ host: string; port: number; token: string } | { error: string }> =>
    ipcRenderer.invoke('collab:host-start'),

  collabHostStop: (): Promise<void> => ipcRenderer.invoke('collab:host-stop'),

  collabSendToPeer: (connId: number, data: string): void => {
    ipcRenderer.send('collab:to-peer', { connId, data })
  },

  collabKickPeer: (connId: number): void => {
    ipcRenderer.send('collab:kick', { connId })
  },

  /** Subscribe to peer events. Returns an unsubscribe function. */
  onCollabEvent: (handlers: {
    connected(connId: number): void
    message(connId: number, data: string): void
    disconnected(connId: number): void
  }): (() => void) => {
    const onConnected = (_e: unknown, p: { connId: number }): void => handlers.connected(p.connId)
    const onMessage = (_e: unknown, p: { connId: number; data: string }): void =>
      handlers.message(p.connId, p.data)
    const onDisconnected = (_e: unknown, p: { connId: number }): void =>
      handlers.disconnected(p.connId)
    ipcRenderer.on('collab:peer-connected', onConnected)
    ipcRenderer.on('collab:peer-message', onMessage)
    ipcRenderer.on('collab:peer-disconnected', onDisconnected)
    return () => {
      ipcRenderer.off('collab:peer-connected', onConnected)
      ipcRenderer.off('collab:peer-message', onMessage)
      ipcRenderer.off('collab:peer-disconnected', onDisconnected)
    }
  },

  // ----- Plugin scanning (see src/main/pluginScan.ts) -----

  /** Discovered plugins, configured folders, and anything that failed. */
  pluginStatus: (): Promise<PluginScanStatus> => ipcRenderer.invoke('plugins:status'),

  /** Forced rescan: re-inspects everything and retries crashed plugins. */
  pluginRefresh: (): Promise<PluginScanStatus> => ipcRenderer.invoke('plugins:refresh'),

  pluginGetFolders: (): Promise<string[]> => ipcRenderer.invoke('plugins:get-folders'),

  pluginSetFolders: (folders: string[]): Promise<PluginScanStatus> =>
    ipcRenderer.invoke('plugins:set-folders', folders),

  pluginResetFolders: (): Promise<PluginScanStatus> => ipcRenderer.invoke('plugins:reset-folders'),

  /** Native folder picker. Null = cancelled. */
  pluginBrowseFolder: (): Promise<string | null> => ipcRenderer.invoke('plugins:browse-folder'),

  pluginClearQuarantine: (): Promise<PluginScanStatus> =>
    ipcRenderer.invoke('plugins:clear-quarantine'),

  /** Fires when a scan finishes, so open UI can refresh itself. */
  onPluginsChanged: (handler: () => void): (() => void) => {
    const listener = (): void => handler()
    ipcRenderer.on('plugins:changed', listener)
    return () => ipcRenderer.off('plugins:changed', listener)
  },

  /** Installed VST3 plugins, one entry per audio class. */
  vst3Scan: (): Promise<
    {
      path: string
      uid: string
      name: string
      vendor: string
      version: string
      subCategories: string
    }[]
  > => ipcRenderer.invoke('vst3:scan'),

  /**
   * Offline-process a buffer through one installed VST3. Whole-buffer, not
   * streaming — see native/README.md for why live playback needs more than
   * this. Identified by descriptor uid, never a path: paths are
   * machine-specific and never enter the document.
   */
  vst3Process: (args: {
    uid: string
    channels: Float32Array[]
    sampleRate: number
    params?: Record<string, number>
    stateBlob?: string | null
  }): Promise<{ channels?: Float32Array[]; error?: string }> =>
    ipcRenderer.invoke('vst3:process', args),

  /**
   * Open a PERSISTENT plugin instance for live playback. Its state carries
   * across processInstance calls, so chunk N+1 continues chunk N's reverb
   * tail. The caller must close what it opens.
   */
  vst3OpenInstance: (args: {
    uid: string
    sampleRate: number
    blockSize?: number
    channels?: number
    stateBlob?: string | null
  }): Promise<{ handle?: number; outputChannels?: number; error?: string }> =>
    ipcRenderer.invoke('vst3:open-instance', args),

  /** Open a plugin's own GUI in a floating window (one per insert). */
  vst3OpenEditor: (args: {
    instanceId: string
    uid: string
    stateBlob?: string | null
    title?: string
  }): Promise<{ opened?: boolean; error?: string }> =>
    ipcRenderer.invoke('vst3:open-editor', args),

  vst3CloseEditor: (instanceId: string): Promise<void> =>
    ipcRenderer.invoke('vst3:close-editor', instanceId),

  /** Push a param value into an open editor (collaborator edits arriving). */
  vst3SetEditorParam: (args: {
    instanceId: string
    paramId: number
    value: number
  }): Promise<{ error?: string }> => ipcRenderer.invoke('vst3:set-editor-param', args),

  /**
   * Dock a plugin's GUI over a reserved area of the app window (CSS
   * viewport coords). Call with rect: null to collapse — that captures
   * the plugin's state, exactly like closing a floating editor.
   */
  vst3DockEditor: (args: {
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
  }): Promise<{ width?: number; height?: number; error?: string }> =>
    ipcRenderer.invoke('vst3:dock-editor', args),

  /**
   * Events from open plugin editors: knob gestures
   * (kind begin/edit/end, paramId+value normalized 0..1) and the final
   * state chunk when an editor window closes (kind 'state').
   *
   * `params` is the plugin's full set of current normalized values,
   * captured when an editor opens (kind 'params') and again beside the
   * chunk on close. It exists because a plugin's own GUI can change many
   * parameters without one gesture event each — loading a preset being the
   * everyday case — which would otherwise leave the document, and every
   * collaborator reading it, showing factory defaults.
   */
  onVst3EditorEvent: (
    handler: (event: {
      instanceId: string
      kind: string
      paramId?: number
      value?: number
      stateBlob?: string
      params?: Record<string, number>
    }) => void
  ): (() => void) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]): void =>
      handler(payload)
    ipcRenderer.on('vst3:editor-event', listener)
    return () => ipcRenderer.off('vst3:editor-event', listener)
  },

  /** Capture a live instance's state as a document-ready blob. */
  vst3InstanceState: (handle: number): Promise<{ stateBlob?: string; error?: string }> =>
    ipcRenderer.invoke('vst3:instance-state', handle),

  vst3ProcessInstance: (args: {
    handle: number
    channels: Float32Array[]
    params?: Record<string, number>
  }): Promise<{ channels?: Float32Array[]; error?: string }> =>
    ipcRenderer.invoke('vst3:process-instance', args),

  vst3CloseInstance: (handle: number): Promise<{ closed: boolean }> =>
    ipcRenderer.invoke('vst3:close-instance', handle),

  // ----- Native audio backend (see src/main/audioHost.ts) -----

  /**
   * Spawn (or recycle) the audio utilityProcess and have main send this
   * window one end of a direct MessageChannel to it. The PORT cannot
   * cross the context bridge — it arrives via window.postMessage (see
   * the listener below); this call only triggers and reports errors.
   */
  audioHostAcquire: (): Promise<{ error?: string }> => ipcRenderer.invoke('audiohost:acquire'),

  audioHostRelease: (): Promise<void> => ipcRenderer.invoke('audiohost:release'),

  /** Fires when the audio process dies — the fall-back-to-Web-Audio signal. */
  onAudioHostExited: (handler: () => void): (() => void) => {
    const listener = (): void => handler()
    ipcRenderer.on('audiohost:exited', listener)
    return () => ipcRenderer.off('audiohost:exited', listener)
  },

  /** Automatable parameters of an installed VST3. Values are normalized 0..1. */
  vst3Parameters: (
    uid: string
  ): Promise<{
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
  }> => ipcRenderer.invoke('vst3:parameters', uid)
}

export type SuperDawApi = typeof api

contextBridge.exposeInMainWorld('superdaw', api)

// MessagePorts cannot cross the context bridge; the documented route into
// a sandboxed page is window.postMessage with a transfer. Main sends the
// audio-host port here after audioHostAcquire; the page listens for
// 'message' events whose data is 'audiohost:port'. (Declared locally:
// the preload compiles in the DOM-free node program but runs in a page.)
declare const window: {
  postMessage(message: unknown, targetOrigin: string, transfer?: unknown[]): void
}

ipcRenderer.on('audiohost:port', (event) => {
  const port = event.ports[0]
  if (port) window.postMessage('audiohost:port', '*', [port])
})
