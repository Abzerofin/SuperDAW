import type { Clip, Note, ProjectState, TrackId } from '../model/types'
import { clipsOfTrack } from '../model/types'
import { ticksPerBar } from '../model/timebase'
import { newId } from '../model/ids'
import type { Operation } from './operations'

/**
 * One note captured live from a MIDI input, in ABSOLUTE timeline ticks
 * (the recorder converts clock seconds to ticks; this module never sees a
 * clock). `endTicks: null` = the key was still down when recording stopped.
 */
export interface CapturedMidiNote {
  readonly pitch: number
  /** MIDI velocity 1..127 (0 is a note-off and never reaches here). */
  readonly velocity: number
  readonly startTicks: number
  /** null = still held at stop — closed at the take's end. */
  readonly endTicks: number | null
}

/** Everything one armed MIDI track captured between roll and stop. */
export interface MidiTake {
  readonly trackId: TrackId
  /** Absolute tick the take began (the clip lands here). */
  readonly startTicks: number
  /** Absolute tick recording stopped — where held notes close. */
  readonly endTicks: number
  readonly notes: readonly CapturedMidiNote[]
}

/**
 * Builds the operation that commits recorded MIDI takes — the MIDI sibling
 * of the audio path in state/recording, and deliberately NOT a new op
 * type: a take is a plain `clip/create { clip, notes }` (or ONE
 * `clip/createMany` when several tracks stop together), so undo, invert,
 * describe, idempotent re-delivery and sync all apply unchanged, and one
 * Ctrl+Z removes the whole take (clip/delete cascades its notes).
 *
 * Ids are minted HERE, client-side, before dispatch — the same reason
 * buildDuplicateTrackOp materializes ids: every peer must apply identical
 * data. Captured absolute ticks are rebased to clip-relative (clamped at
 * the clip start — latency compensation can pull a note slightly before
 * the roll); held notes close at the take end; the clip rounds UP to whole
 * bars (min one bar), like a MIDI import. Takes with no notes, on missing
 * tracks or on non-MIDI tracks build nothing; all empty = null (no
 * dispatch at all).
 */
export function buildMidiTakeOp(
  state: ProjectState,
  takes: readonly MidiTake[]
): Operation | null {
  const bar = ticksPerBar(state.timeSignature)
  const clips: Clip[] = []
  const notes: Note[] = []

  for (const take of takes) {
    const track = state.tracks[take.trackId]
    if (!track || track.kind !== 'midi' || take.notes.length === 0) continue

    const clipId = newId('clp')
    const clipStart = Math.max(0, Math.round(take.startTicks))
    const takeEnd = Math.max(clipStart + 1, Math.round(take.endTicks))

    let contentEnd = 0
    const takeNotes: Note[] = []
    for (const captured of take.notes) {
      const start = Math.max(0, Math.round(captured.startTicks) - clipStart)
      const absEnd = captured.endTicks === null ? takeEnd : Math.round(captured.endTicks)
      const end = Math.max(start + 1, absEnd - clipStart)
      contentEnd = Math.max(contentEnd, end)
      takeNotes.push({
        id: newId('not'),
        clipId,
        pitch: clampInt(captured.pitch, 0, 127),
        start,
        duration: end - start,
        velocity: clampInt(captured.velocity, 1, 127)
      })
    }

    clips.push({
      id: clipId,
      trackId: take.trackId,
      // Numbered by what the track already holds, like "Recording N".
      name: `Take ${clipsOfTrack(state, take.trackId).length + 1}`,
      start: clipStart,
      duration: Math.max(bar, Math.ceil(contentEnd / bar) * bar),
      assetId: null,
      offset: 0,
      color: null,
      fadeIn: 0,
      fadeOut: 0,
      reverse: false,
      pitch: 0,
      stretch: 1,
      loopLength: 0
    })
    notes.push(...takeNotes)
  }

  if (clips.length === 0) return null
  if (clips.length === 1) return { type: 'clip/create', clip: clips[0], notes }
  return { type: 'clip/createMany', clips, notes }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}
