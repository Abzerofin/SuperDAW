import type { NoteId } from '@core/model/types'
import { PPQ } from '@core/model/timebase'
import { projectStore } from '@/state/projectStore'

/**
 * Note timing edits (quantize / humanize). Both dispatch one absolute
 * note/moveMany, so a whole pass is one undo step, syncs like any edit and
 * stays idempotent — the randomness in humanize is resolved BEFORE the op
 * is built, never inside the reducer.
 */

/** Default quantize resolution when the snap grid is off/auto: a 16th. */
export const DEFAULT_QUANTIZE_TICKS = PPQ / 4

/** Humanize nudges each note by up to ±this many ticks (~15 ms at 120 BPM). */
export const HUMANIZE_MAX_TICKS = PPQ / 32

/** Snap each note's start to the nearest grid line. */
export function quantizeNotes(noteIds: Iterable<NoteId>, gridTicks: number): void {
  const grid = Math.max(1, Math.round(gridTicks))
  const moves: { noteId: NoteId; pitch: number; start: number }[] = []
  for (const noteId of noteIds) {
    const note = projectStore.state.notes[noteId]
    if (!note) continue
    const start = Math.max(0, Math.round(note.start / grid) * grid)
    if (start !== note.start) moves.push({ noteId, pitch: note.pitch, start })
  }
  if (moves.length === 0) return
  projectStore.dispatch({ type: 'note/moveMany', moves })
}

/** Nudge each note's start by a small random amount, loosening a rigid feel. */
export function humanizeNotes(
  noteIds: Iterable<NoteId>,
  maxTicks: number = HUMANIZE_MAX_TICKS
): void {
  const moves: { noteId: NoteId; pitch: number; start: number }[] = []
  for (const noteId of noteIds) {
    const note = projectStore.state.notes[noteId]
    if (!note) continue
    const jitter = Math.round((Math.random() * 2 - 1) * maxTicks)
    const start = Math.max(0, note.start + jitter)
    if (start !== note.start) moves.push({ noteId, pitch: note.pitch, start })
  }
  if (moves.length === 0) return
  projectStore.dispatch({ type: 'note/moveMany', moves })
}
