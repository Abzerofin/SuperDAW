import { useSyncExternalStore } from 'react'

/**
 * Timeline ruler mode — pure display preference, ephemeral per-user.
 * Bars/beats for music, minutes:seconds and samples for post work
 * (frames reserved for a future video milestone).
 */
export type RulerMode = 'bars' | 'time' | 'samples'

export const RULER_MODES: Array<{ value: RulerMode; label: string }> = [
  { value: 'bars', label: 'Bars' },
  { value: 'time', label: 'Min:Sec' },
  { value: 'samples', label: 'Samples' }
]

class RulerUiStore {
  mode: RulerMode = 'bars'

  private version = 0
  private listeners = new Set<() => void>()

  set(mode: RulerMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.version++
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version
}

export const rulerUi = new RulerUiStore()

export function useRulerMode(): RulerMode {
  useSyncExternalStore(rulerUi.subscribe, rulerUi.getVersion)
  return rulerUi.mode
}
