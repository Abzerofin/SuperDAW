import { contextBridge } from 'electron'

/**
 * Minimal bridge between the sandboxed renderer and the main process.
 * The renderer must run without this (browser dev mode), so everything
 * exposed here is optional from the renderer's perspective.
 */
const api = {
  platform: process.platform
}

export type SuperDawApi = typeof api

contextBridge.exposeInMainWorld('superdaw', api)
