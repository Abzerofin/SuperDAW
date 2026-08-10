import type { NoteId } from '@core/model/types'
import { PPQ } from '@core/model/timebase'
import { projectStore } from '@/state/projectStore'

/**
 * Note timing edits (quantize / humanize). Both dispatch one absolute
 * note/moveMany, so a whole pass is one undo step, syncs like any edit and
 * stays idempotent — the randomness in humanize is resolved BEFORE the op
 * is built, never inside the reducer.
 *
 * Feel comes from the PROJECT's settings (swing, strength, humanize bound —
 * `ProjectState.settings`): groove is a property of the song every
 * collaborator shares, so a peer pressing Q gets the same pocket you would.
 */

/** Default quantize resolution when the snap grid is off/auto: a 16th. */
export const DEFAULT_QUANTIZE_TICKS = PPQ / 4

/** Fallback humanize bound (~15 ms at 120 BPM) if settings are absent. */
export const HUMANIZE_MAX_TICKS = PPQ / 32

/**
 * Snap each note's start toward the nearest grid line, with the project's
 * swing (off-beat grid positions delayed by swing% of half a step) and
 * strength (1 = land exactly on target, 0.5 = move halfway) applied.
 */
export function quantizeNotes(noteIds: Iterable<NoteId>, gridTicks: number): void {
  const grid = Math.max(1, Math.round(gridTicks))
  const { swingPercent, quantizeStrength } = projectStore.state.settings
  const swingTicks = Math.round((swingPercent / 100) * (grid / 2))
  const moves: { noteId: NoteId; pitch: number; start: number }[] = []
  for (const noteId of noteIds) {
    const note = projectStore.state.notes[noteId]
    if (!note) continue
    const index = Math.round(note.start / grid)
    // Odd grid indices are the off-beats; swing pushes them late.
    const target = Math.max(0, index * grid + (index % 2 === 1 ? swingTicks : 0))
    const start = Math.max(0, Math.round(note.start + (target - note.start) * quantizeStrength))
    if (start !== note.start) moves.push({ noteId, pitch: note.pitch, start })
  }
  if (moves.length === 0) return
  projectStore.dispatch({ type: 'note/moveMany', moves })
}

/** Nudge each note's start by a small random amount, loosening a rigid feel. */
export function humanizeNotes(noteIds: Iterable<NoteId>, maxTicks?: number): void {
  const bound = maxTicks ?? projectStore.state.settings.humanizeTicks ?? HUMANIZE_MAX_TICKS
  const moves: { noteId: NoteId; pitch: number; start: number }[] = []
  for (const noteId of noteIds) {
    const note = projectStore.state.notes[noteId]
    if (!note) continue
    const jitter = Math.round((Math.random() * 2 - 1) * bound)
    const start = Math.max(0, note.start + jitter)
    if (start !== note.start) moves.push({ noteId, pitch: note.pitch, start })
  }
  if (moves.length === 0) return
  projectStore.dispatch({ type: 'note/moveMany', moves })
}
