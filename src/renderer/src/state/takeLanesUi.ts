import { useSyncExternalStore } from 'react'
import type { TrackId } from '@core/model/types'

/**
 * Which tracks show their EXPANDED take lanes — each take of a group in
 * its own sub-lane under the track row. Ephemeral and per-user, exactly
 * like automation-lane visibility (state/automationUi): whose takes are
 * unfolded is a viewing choice, never document state.
 */
class TakeLanesUiStore {
  private open = new Set<TrackId>()
  private version = 0
  private listeners = new Set<() => void>()

  isOpen(trackId: TrackId): boolean {
    return this.open.has(trackId)
  }

  toggle(trackId: TrackId): void {
    if (!this.open.delete(trackId)) this.open.add(trackId)
    this.version++
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version
}

export const takeLanesUi = new TakeLanesUiStore()

export function useTakeLanesUi(): TakeLanesUiStore {
  useSyncExternalStore(takeLanesUi.subscribe, takeLanesUi.getVersion)
  return takeLanesUi
}
