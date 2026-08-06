import { useSyncExternalStore } from 'react'

/**
 * How tall track rows are drawn. Compact mode shrinks every lane and hides
 * the header's controls (pan, volume, FX, toggles), leaving just the name —
 * for when you want to see many tracks at once rather than mix them.
 * Ephemeral per-user view state, like zoom.
 */
class TrackViewUiStore {
  compact = false

  private version = 0
  private listeners = new Set<() => void>()

  toggleCompact(): void {
    this.compact = !this.compact
    this.version++
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version
}

export const trackViewUi = new TrackViewUiStore()

export function useTrackViewUi(): TrackViewUiStore {
  useSyncExternalStore(trackViewUi.subscribe, trackViewUi.getVersion)
  return trackViewUi
}
