import { useSyncExternalStore } from 'react'
import type { ClipId, ProjectState } from '@core/model/types'
import { instrumentKindOf } from '@core/model/effects'
import { panels } from './panels'
import { projectStore } from './projectStore'
import { selection } from './selection'

/**
 * The clip editor: ONE panel that takes the form the track's instrument
 * calls for — a drum kit gets the step grid, anything melodic the piano
 * roll. Which clip is open and which form it wears are ephemeral per-user
 * state (never the document). The form follows the synth automatically;
 * the switch in the panel head overrides it for the current track, and the
 * override drops as soon as the editor retargets to another track so the
 * automatic behaviour comes back on its own.
 */

export type EditorForm = 'piano' | 'steps'

/** The form a track's instrument asks for. */
export function autoFormForTrack(state: ProjectState, trackId: string | null): EditorForm {
  const track = trackId ? state.tracks[trackId] : undefined
  return track && instrumentKindOf(track.synth) === 'drums' ? 'steps' : 'piano'
}

/** The form the editor shows for a clip: the override if one is pinned to that track. */
export function editorFormFor(state: ProjectState, clipId: ClipId | null): EditorForm {
  const trackId = clipId ? (state.clips[clipId]?.trackId ?? null) : null
  if (editorUi.overrideForm !== null && editorUi.overrideTrackId === trackId) {
    return editorUi.overrideForm
  }
  return autoFormForTrack(state, trackId)
}

class EditorUiStore {
  clipId: ClipId | null = null
  /** Form pinned by the user, and the track it is pinned to (null = automatic). */
  overrideForm: EditorForm | null = null
  overrideTrackId: string | null = null

  private version = 0
  private listeners = new Set<() => void>()

  constructor() {
    // The editor follows the selection like the Effects dock: click another
    // track (or MIDI clip) and it edits THAT material. Only retargets while
    // the panel is open, and never to a track without MIDI to edit —
    // clicking an audio track leaves the current clip up rather than
    // blanking the editor.
    selection.subscribe(() => this.followSelection())
  }

  private followSelection(): void {
    if (this.clipId === null || !panels.isOpen('editor')) return
    const trackId = selection.selectedTrackId
    if (trackId === null) return
    const state = projectStore.state
    // A clicked MIDI clip wins — the step grid is a per-clip editor and the
    // roll scrolls to the clip, so a same-track clip switch retargets too.
    const picked = selection.selectedClipId ? state.clips[selection.selectedClipId] : undefined
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
    this.dropStaleOverride()
    this.emit()
  }

  /** A pinned form only applies to the track it was pinned on. */
  private dropStaleOverride(): void {
    const trackId = this.clipId
      ? (projectStore.state.clips[this.clipId]?.trackId ?? null)
      : null
    if (this.overrideTrackId !== trackId) {
      this.overrideForm = null
      this.overrideTrackId = null
    }
  }

  open(clipId: ClipId, form?: EditorForm): void {
    this.clipId = clipId
    this.dropStaleOverride()
    if (form) this.setForm(form)
    panels.openPanel('editor')
    this.emit()
  }

  /** Pin a form for the open clip's track, or drop the pin (automatic again). */
  setForm(form: EditorForm | null): void {
    const trackId = this.clipId
      ? (projectStore.state.clips[this.clipId]?.trackId ?? null)
      : null
    this.overrideForm = form
    this.overrideTrackId = form === null ? null : trackId
    this.emit()
  }

  close(): void {
    if (this.clipId === null) return
    this.clipId = null
    this.overrideForm = null
    this.overrideTrackId = null
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
