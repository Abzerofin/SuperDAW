import { useSyncExternalStore } from 'react'
import { projectStore } from './projectStore'

/**
 * Where the current project lives on disk and whether it has unsaved
 * changes. Ephemeral per-user state — never part of the document.
 * Dirtiness is derived from the op stream: any committed op marks dirty.
 */
class SessionFileStore {
  private filePath: string | null = null
  private unsaved = false
  private listeners = new Set<() => void>()

  constructor() {
    projectStore.onOperation(() => this.setDirty(true))
  }

  get path(): string | null {
    return this.filePath
  }

  get dirty(): boolean {
    return this.unsaved
  }

  markSaved(path: string | null): void {
    this.filePath = path
    this.setDirty(false, true)
  }

  markLoaded(path: string | null): void {
    this.filePath = path
    this.setDirty(false, true)
  }

  private setDirty(dirty: boolean, force = false): void {
    if (this.unsaved === dirty && !force) return
    this.unsaved = dirty
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export const sessionFile = new SessionFileStore()

export function useSessionFile(): { path: string | null; dirty: boolean } {
  useSyncExternalStore(sessionFile.subscribe, () => `${sessionFile.path}|${sessionFile.dirty}`)
  return { path: sessionFile.path, dirty: sessionFile.dirty }
}
