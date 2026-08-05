import { useSyncExternalStore } from 'react'
import type { ClipId } from '@core/model/types'
import { panels } from './panels'

/** Which MIDI clip the piano roll is editing (ephemeral, per-user). */
class PianoRollUiStore {
  clipId: ClipId | null = null

  private version = 0
  private listeners = new Set<() => void>()

  open(clipId: ClipId): void {
    this.clipId = clipId
    panels.setBottom('pianoroll')
    this.emit()
  }

  close(): void {
    if (this.clipId === null) return
    this.clipId = null
    if (panels.bottomPanel === 'pianoroll') panels.setBottom(null)
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

export const pianoRollUi = new PianoRollUiStore()

export function usePianoRollUi(): PianoRollUiStore {
  useSyncExternalStore(pianoRollUi.subscribe, pianoRollUi.getVersion)
  return pianoRollUi
}
