import type { Clip, Note } from '@core/model/types'
import { notesOfClip } from '@core/model/types'
import { newId } from '@core/model/ids'
import { projectStore } from '@/state/projectStore'
import { selection } from '@/state/selection'
import { transport } from '@/state/transport'

/**
 * Clip clipboard + one-shot edit actions (copy/paste/duplicate/split).
 * The clipboard is an in-memory snapshot — ephemeral per-user state, not
 * the OS clipboard (clips are meaningless outside this app instance).
 */

let clipboard: { clip: Clip; notes: Note[] } | null = null

function snapshotSelected(): { clip: Clip; notes: Note[] } | null {
  const clipId = selection.selectedClipId
  if (!clipId) return null
  const clip = projectStore.state.clips[clipId]
  if (!clip) return null
  return { clip, notes: notesOfClip(projectStore.state, clipId) }
}

/** Create a copy of `source` at (trackId, start) with fresh ids; selects it. */
function createCopy(source: { clip: Clip; notes: Note[] }, trackId: string, start: number): void {
  const clip: Clip = { ...source.clip, id: newId('clp'), trackId, start: Math.max(0, start) }
  const notes: Note[] = source.notes.map((n) => ({ ...n, id: newId('not'), clipId: clip.id }))
  projectStore.dispatch({ type: 'clip/create', clip, notes })
  selection.select(clip.id)
}

export function copySelectedClip(): boolean {
  const snap = snapshotSelected()
  if (snap) clipboard = snap
  return snap !== null
}

export function cutSelectedClip(): void {
  const snap = snapshotSelected()
  if (!snap) return
  clipboard = snap
  selection.select(null)
  projectStore.dispatch({ type: 'clip/delete', clipId: snap.clip.id })
}

/** Paste at the playhead, on the copied clip's track (if it still exists). */
export function pasteClip(): void {
  if (!clipboard) return
  if (!projectStore.state.tracks[clipboard.clip.trackId]) return // track is gone
  createCopy(clipboard, clipboard.clip.trackId, Math.round(transport.positionTicks()))
}

/** Duplicate the selected clip immediately after itself. */
export function duplicateSelectedClip(): void {
  const snap = snapshotSelected()
  if (!snap) return
  createCopy(snap, snap.clip.trackId, snap.clip.start + snap.clip.duration)
}

/** True when the playhead sits strictly inside the clip (so a slice is possible). */
export function canSliceAtPlayhead(clipId: string): boolean {
  const clip = projectStore.state.clips[clipId]
  if (!clip) return false
  const at = Math.round(transport.positionTicks())
  return at > clip.start && at < clip.start + clip.duration
}

/** Slice a specific clip in two at the playhead. */
export function sliceClipAtPlayhead(clipId: string): void {
  if (!canSliceAtPlayhead(clipId)) return
  projectStore.dispatch({
    type: 'clip/split',
    clipId,
    at: Math.round(transport.positionTicks()),
    rightClipId: newId('clp')
  })
}

/** Split the selected clip at the playhead (must fall inside the clip). */
export function splitSelectedClipAtPlayhead(): void {
  if (selection.selectedClipId) sliceClipAtPlayhead(selection.selectedClipId)
}

/** Duplicate a specific clip immediately after itself. */
export function duplicateClip(clipId: string): void {
  const clip = projectStore.state.clips[clipId]
  if (!clip) return
  createCopy(
    { clip, notes: notesOfClip(projectStore.state, clipId) },
    clip.trackId,
    clip.start + clip.duration
  )
}
