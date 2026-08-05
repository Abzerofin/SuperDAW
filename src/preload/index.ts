import { contextBridge, ipcRenderer } from 'electron'

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
  }
}

export type SuperDawApi = typeof api

contextBridge.exposeInMainWorld('superdaw', api)
