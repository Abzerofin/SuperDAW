import { useSyncExternalStore } from 'react'
import type { TrackId } from '@core/model/types'

/** Which track's FX panel is open (ephemeral, per-user). */
class FxUiStore {
  trackId: TrackId | null = null

  private version = 0
  private listeners = new Set<() => void>()

  open(trackId: TrackId): void {
    this.trackId = trackId
    this.emit()
  }

  close(): void {
    if (this.trackId === null) return
    this.trackId = null
    this.emit()
  }

  toggle(trackId: TrackId): void {
    this.trackId = this.trackId === trackId ? null : trackId
    this.emit()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version

  private emit(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }
}

export const fxUi = new FxUiStore()

export function useFxUi(): FxUiStore {
  useSyncExternalStore(fxUi.subscribe, fxUi.getVersion)
  return fxUi
}
