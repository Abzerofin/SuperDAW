import { useSyncExternalStore } from 'react'
import type { ClipId } from '@core/model/types'
import { panels } from './panels'
import { projectStore } from './projectStore'
import { selection } from './selection'

/** Which MIDI clip the step sequencer is editing (ephemeral, per-user). */
class StepSeqUiStore {
  clipId: ClipId | null = null

  private version = 0
  private listeners = new Set<() => void>()

  constructor() {
    // The grid follows the track selection like the Effects dock and the
    // piano roll: click another track (or MIDI clip) and the steps program
    // THAT material. Only retargets while the panel is open, and never to
    // a track without MIDI to edit.
    selection.subscribe(() => this.followSelection())
  }

  private followSelection(): void {
    if (this.clipId === null || !panels.isOpen('steps')) return
    const trackId = selection.selectedTrackId
    if (trackId === null) return
    const state = projectStore.state
    const picked = selection.selectedClipId ? state.clips[selection.selectedClipId] : undefined
    // A clicked MIDI clip wins — the steps grid is a per-clip editor, so a
    // same-track clip switch retargets too (unlike the whole-track roll).
    const target =
      picked && picked.trackId === trackId && picked.assetId === null
        ? picked
        : state.clips[this.clipId]?.trackId === trackId
          ? undefined // still on the selected track: keep the current clip
          : Object.values(state.clips)
              .filter((c) => c.trackId === trackId && c.assetId === null)
              .sort((a, b) => a.start - b.start)[0]
    if (!target || target.id === this.clipId) return
    this.clipId = target.id
    this.emit()
  }

  open(clipId: ClipId): void {
    this.clipId = clipId
    panels.openPanel('steps')
    this.emit()
  }

  close(): void {
    if (this.clipId === null) return
    this.clipId = null
    panels.closePanel('steps')
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

export const stepSeqUi = new StepSeqUiStore()

export function useStepSeqUi(): StepSeqUiStore {
  useSyncExternalStore(stepSeqUi.subscribe, stepSeqUi.getVersion)
  return stepSeqUi
}
