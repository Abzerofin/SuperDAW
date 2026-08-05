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
    ipcRenderer.invoke('project:open')
}

export type SuperDawApi = typeof api

contextBridge.exposeInMainWorld('superdaw', api)
