import { useSyncExternalStore } from 'react'
import type { ClipId } from '@core/model/types'
import { panels } from './panels'
import { projectStore } from './projectStore'
import { selection } from './selection'

/** Which MIDI clip the piano roll is editing (ephemeral, per-user). */
class PianoRollUiStore {
  clipId: ClipId | null = null

  private version = 0
  private listeners = new Set<() => void>()

  constructor() {
    // The roll follows the track selection the way the Effects dock does:
    // click another track and the keys show ITS notes, no reopening. It
    // only ever retargets while the roll is open, and only to a track that
    // actually has MIDI to edit — clicking an audio track leaves the
    // current clip up rather than blanking the editor.
    selection.subscribe(() => this.followSelection())
  }

  private followSelection(): void {
    if (this.clipId === null || !panels.isOpen('pianoroll')) return
    const trackId = selection.selectedTrackId
    if (trackId === null) return
    const state = projectStore.state
    if (state.clips[this.clipId]?.trackId === trackId) return
    // The selected clip when it is a MIDI clip on that track (the user
    // pointed at it), otherwise the track's first MIDI clip. The roll is a
    // whole-track editor, so any of the track's clips brings all of them up.
    const picked = selection.selectedClipId ? state.clips[selection.selectedClipId] : undefined
    const target =
      picked && picked.trackId === trackId && picked.assetId === null
        ? picked
        : Object.values(state.clips)
            .filter((c) => c.trackId === trackId && c.assetId === null)
            .sort((a, b) => a.start - b.start)[0]
    if (!target || target.id === this.clipId) return
    this.clipId = target.id
    this.emit()
  }

  open(clipId: ClipId): void {
    this.clipId = clipId
    panels.openPanel('pianoroll')
    this.emit()
  }

  close(): void {
    if (this.clipId === null) return
    this.clipId = null
    panels.closePanel('pianoroll')
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
