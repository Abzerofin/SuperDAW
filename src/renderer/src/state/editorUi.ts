import { useSyncExternalStore } from 'react'
import type { ClipId, ProjectState } from '@core/model/types'
import { isNoteTrack, noteSourceOf, patternsOfTrack } from '@core/model/types'
import { panels } from './panels'
import { projectStore } from './projectStore'
import { selection } from './selection'

/**
 * The clip editor: ONE panel whose form is decided by the TRACK KIND, and
 * by nothing else. A drum track gets the step grid; a MIDI track gets the
 * piano roll. There is deliberately no switch between them — the two
 * surfaces are for two different jobs, and letting a drum track wear the
 * roll (or a melodic part wear the grid) only ever produced editors that
 * mismatched the material they were editing.
 *
 * Which clip is open is ephemeral per-user state, never the document.
 */

export type EditorForm = 'piano' | 'steps'

/** The form a track gets. Its KIND decides; nothing overrides it. */
export function autoFormForTrack(state: ProjectState, trackId: string | null): EditorForm {
  return trackId && state.tracks[trackId]?.kind === 'drum' ? 'steps' : 'piano'
}

/**
 * The form the editor shows for a clip — or, with no clip, for the track
 * the editor is pending on.
 */
export function editorFormFor(
  state: ProjectState,
  clipId: ClipId | null,
  fallbackTrackId: string | null = null
): EditorForm {
  const clipTrackId = clipId !== null ? (state.clips[clipId]?.trackId ?? null) : null
  return autoFormForTrack(state, clipTrackId ?? fallbackTrackId)
}

class EditorUiStore {
  clipId: ClipId | null = null
  /**
   * The track the editor is aimed at when there is no clip yet. The roll
   * and the step grid open EMPTY on it, and the first note or pattern
   * placed creates the clip and retargets here — so a new note track is
   * something you can start writing on, not something you have to make a
   * clip for first. Opening the editor alone writes nothing.
   */
  pendingTrackId: string | null = null

  private version = 0
  private listeners = new Set<() => void>()

  constructor() {
    // The editor follows the selection like the Effects dock: click another
    // track (or MIDI clip) and it edits THAT material. Only retargets while
    // the panel is open, and never to a track without MIDI to edit —
    // clicking an audio track leaves the current clip up rather than
    // blanking the editor.
    selection.subscribe(() => this.followSelection())
    projectStore.subscribe(() => this.reconcile())
  }

  /** The track of the clip last opened, so a vanished clip has a home. */
  private lastTrackId: string | null = null
  /**
   * The PATTERN behind the clip last opened. Deleting a stamp must land
   * the editor back on the material it was showing, not on whichever
   * pattern happens to sort first in the bank.
   */
  private lastPatternId: string | null = null

  /**
   * The open clip can vanish — deleted here, deleted by a peer, or undone.
   * If its track is still a note track the editor stays on the TRACK: you
   * keep the grid you were working in and can start the next pattern,
   * instead of the panel closing out from under you.
   */
  private reconcile(): void {
    if (this.clipId === null) return
    const state = projectStore.state
    const open = state.clips[this.clipId]
    if (open) {
      this.lastTrackId = open.trackId
      this.lastPatternId = noteSourceOf(state, open.id)
      return
    }
    const trackId = this.lastTrackId
    // The clip that vanished was probably a STAMP, and the pattern behind
    // it is still in the bank — go back to exactly that, since the material
    // being edited has not gone anywhere. Only if the pattern ITSELF was
    // deleted does the panel fall back to the rest of the bank.
    const pattern =
      (this.lastPatternId !== null ? state.clips[this.lastPatternId] : undefined) ??
      (trackId !== null ? patternsOfTrack(state, trackId)[0] : undefined)
    if (pattern) {
      this.clipId = pattern.id
      this.lastPatternId = pattern.id
      this.pendingTrackId = null
      this.emit()
      return
    }
    this.lastPatternId = null
    this.clipId = null
    this.pendingTrackId = trackId !== null && isNoteTrack(state, trackId) ? trackId : null
    if (this.pendingTrackId === null) panels.closePanel('editor')
    this.emit()
  }

  private followSelection(): void {
    if ((this.clipId === null && this.pendingTrackId === null) || !panels.isOpen('editor')) return
    const trackId = selection.selectedTrackId
    if (trackId === null) return
    const state = projectStore.state
    // Following onto a note track with nothing on it yet opens empty on it
    // rather than leaving the previous track's clip up.
    if (
      isNoteTrack(state, trackId) &&
      patternsOfTrack(state, trackId).length === 0
    ) {
      if (this.pendingTrackId === trackId) return
      this.clipId = null
      this.pendingTrackId = trackId
      this.emit()
      return
    }
    // A clicked MIDI clip wins — the step grid is a per-clip editor and the
    // roll scrolls to the clip, so a same-track clip switch retargets too.
    const picked = selection.selectedClipId ? state.clips[selection.selectedClipId] : undefined
    const target =
      picked && picked.trackId === trackId && picked.assetId === null
        ? picked
        : this.clipId !== null && state.clips[this.clipId]?.trackId === trackId
          ? undefined // still on the selected track: keep the current clip
          : patternsOfTrack(state, trackId)[0]
    if (!target || target.id === this.clipId) return
    this.clipId = target.id
    this.emit()
  }

  /** The track the editor is on, via its pattern, its clip, or pending. */
  get trackId(): string | null {
    if (this.clipId !== null) return projectStore.state.clips[this.clipId]?.trackId ?? null
    return this.pendingTrackId
  }

  open(clipId: ClipId): void {
    this.clipId = clipId
    this.pendingTrackId = null
    this.lastTrackId = projectStore.state.clips[clipId]?.trackId ?? null
    this.lastPatternId = projectStore.state.clips[clipId]
      ? noteSourceOf(projectStore.state, clipId)
      : null
    panels.openPanel('editor')
    this.emit()
  }

  /** Open empty on a note track that has nothing to edit yet. */
  openTrack(trackId: string): void {
    this.clipId = null
    this.pendingTrackId = trackId
    this.lastTrackId = trackId
    panels.openPanel('editor')
    this.emit()
  }

  close(): void {
    if (this.clipId === null && this.pendingTrackId === null) return
    this.clipId = null
    this.pendingTrackId = null
    panels.closePanel('editor')
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

export const editorUi = new EditorUiStore()

export function useEditorUi(): EditorUiStore {
  useSyncExternalStore(editorUi.subscribe, editorUi.getVersion)
  return editorUi
}
