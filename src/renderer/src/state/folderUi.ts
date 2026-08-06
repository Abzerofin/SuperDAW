import { useSyncExternalStore } from 'react'
import type { TrackId } from '@core/model/types'

/** Which folder tracks are collapsed — ephemeral, per-user view state. */
class FolderUiStore {
  private collapsed = new Set<TrackId>()
  private version = 0
  private listeners = new Set<() => void>()

  isCollapsed(trackId: TrackId): boolean {
    return this.collapsed.has(trackId)
  }

  toggle(trackId: TrackId): void {
    if (!this.collapsed.delete(trackId)) this.collapsed.add(trackId)
    this.version++
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version
}

export const folderUi = new FolderUiStore()

export function useFolderUi(): FolderUiStore {
  useSyncExternalStore(folderUi.subscribe, folderUi.getVersion)
  return folderUi
}
