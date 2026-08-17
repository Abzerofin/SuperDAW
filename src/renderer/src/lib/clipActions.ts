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
  // A pasted/duplicated clip is new material at a new spot, not another
  // take of the source's region — membership never travels with a copy.
  const { takeGroupId: _tg, takeActive: _ta, ...rest } = source.clip
  const clip: Clip = { ...rest, id: newId('clp'), trackId, start: Math.max(0, start) }
  const notes: Note[] = source.notes.map((n) => ({ ...n, id: newId('not'), clipId: clip.id }))
  projectStore.dispatch({ type: 'clip/create', clip, notes })
  selection.select(clip.id, clip.trackId)
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

/** Paste at the edit point, on the copied clip's track (if it still exists). */
export function pasteClip(): void {
  if (!clipboard) return
  if (!projectStore.state.tracks[clipboard.clip.trackId]) return // track is gone
  createCopy(clipboard, clipboard.clip.trackId, Math.round(transport.editTicks()))
}

/** Duplicate the selected clip immediately after itself. */
export function duplicateSelectedClip(): void {
  const snap = snapshotSelected()
  if (!snap) return
  createCopy(snap, snap.clip.trackId, snap.clip.start + snap.clip.duration)
}

/**
 * True when the edit point sits strictly inside the clip (so a slice is
 * possible). The edit point is the pinned marker when there is one, else
 * the playhead — see Transport.editTicks.
 */
export function canSliceAtEditPoint(clipId: string): boolean {
  const clip = projectStore.state.clips[clipId]
  if (!clip) return false
  const at = Math.round(transport.editTicks())
  return at > clip.start && at < clip.start + clip.duration
}

/** Slice a specific clip in two at the edit point. */
export function sliceClipAtEditPoint(clipId: string): void {
  if (!canSliceAtEditPoint(clipId)) return
  projectStore.dispatch({
    type: 'clip/split',
    clipId,
    at: Math.round(transport.editTicks()),
    rightClipId: newId('clp')
  })
}

/**
 * Cut every selected clip the edit point passes through — one op, so a cut
 * across several tracks is one undo step. Clips the edit point misses are
 * left alone rather than blocking the whole gesture.
 */
export function splitSelectedClipAtEditPoint(): void {
  const at = Math.round(transport.editTicks())
  const slices = [...selection.selectedClipIds]
    .filter((id) => canSliceAtEditPoint(id))
    .map((clipId) => ({ clipId, at: [at], newClipIds: [newId('clp')] }))
  if (slices.length === 0) return
  projectStore.dispatch(
    slices.length === 1
      ? { type: 'clip/split', clipId: slices[0].clipId, at, rightClipId: slices[0].newClipIds[0] }
      : { type: 'clip/slice', slices }
  )
}

/** Number-key slicing supports 2..9 equal parts. */
export const MIN_EQUAL_PARTS = 2
export const MAX_EQUAL_PARTS = 9

/**
 * Cut each selected clip into `parts` equal pieces — the number-key
 * gesture. Cuts land on exact fractions of the clip's own length, so
 * clips of different lengths each divide evenly rather than sharing one
 * grid. Clips too short to divide are skipped.
 */
export function sliceSelectionIntoEqualParts(parts: number): void {
  const count = Math.round(parts)
  if (count < MIN_EQUAL_PARTS || count > MAX_EQUAL_PARTS) return
  const slices: Array<{ clipId: string; at: number[]; newClipIds: string[] }> = []
  for (const clipId of selection.selectedClipIds) {
    const clip = projectStore.state.clips[clipId]
    if (!clip) continue
    if (projectStore.state.tracks[clip.trackId]?.frozenAssetId) continue
    // Every piece must be at least one tick long, and each cut must be
    // strictly inside the clip, or the split reducer rejects it.
    if (clip.duration < count) continue
    const at: number[] = []
    for (let i = 1; i < count; i++) {
      const cut = clip.start + Math.round((clip.duration * i) / count)
      if (cut > clip.start && cut < clip.start + clip.duration && cut !== at[at.length - 1]) {
        at.push(cut)
      }
    }
    if (at.length === 0) continue
    slices.push({ clipId, at, newClipIds: at.map(() => newId('clp')) })
  }
  if (slices.length === 0) return
  projectStore.dispatch({ type: 'clip/slice', slices })
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
