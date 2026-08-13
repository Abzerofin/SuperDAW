import type { Clip, ClipId, Note, ProjectState, TrackId } from '@core/model/types'
import { noteSourceOf, patternsOfTrack, stampsOf, timelineClips } from '@core/model/types'
import { ticksPerBar } from '@core/model/timebase'
import { newId } from '@core/model/ids'
import { projectStore } from '@/state/projectStore'
import { editorUi } from '@/state/editorUi'
import { selection } from '@/state/selection'

/**
 * DRUM LOOPS — the clips a drum machine calls A, B, C — and the two ways
 * to repeat one:
 *
 * - STAMP it further along the track. A stamp plays the original's notes
 *   (`Clip.sourceClipId`), so editing the loop is heard in every stamp of
 *   it. That is the point of stamping rather than copying.
 * - Or drag the LOOP HANDLE, which repeats the loop inside one clip. Same
 *   sharing, for free, since a repeat is the same clip.
 *
 * A SOLO is the other kind: a one-off phrase that is not bound to measure
 * lengths and grows exactly as far as it is played (`Clip.freeLength`).
 */

/** Loop names in order; past Z they keep counting (AA is not a loop). */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * A track's bank: the patterns in the step panel. These are NOT on the
 * timeline — deleting every clip that places one leaves it right here,
 * ready to stamp again.
 */
export function patternsOf(state: ProjectState, trackId: TrackId): Clip[] {
  return patternsOfTrack(state, trackId)
}

/** The next unused loop name on a track: A, B, C… then 27, 28, … */
export function nextPatternName(state: ProjectState, trackId: TrackId): string {
  const taken = new Set(patternsOf(state, trackId).map((c) => c.name))
  for (const letter of LETTERS) if (!taken.has(letter)) return letter
  let n = LETTERS.length + 1
  while (taken.has(String(n))) n++
  return String(n)
}

/**
 * The lengths the + button offers, as fractions of a measure. A loop built
 * from one of these is MEASURE-SHAPED: it starts on a measure fraction and
 * grows in whole bars. The solo entry is deliberately not one of them.
 */
export const PATTERN_LENGTHS: ReadonlyArray<{ label: string; measures: number }> = [
  { label: '¼ measure', measures: 0.25 },
  { label: '½ measure', measures: 0.5 },
  { label: '1 measure', measures: 1 },
  { label: '2 measures', measures: 2 },
  { label: '4 measures', measures: 4 }
]

/**
 * A solo starts at an eighth of a measure — shorter than anything the
 * length menu offers, so it never looks like one of the measure-shaped
 * loops — and grows exactly as far as it is played.
 */
const SOLO_START_MEASURES = 1 / 8

/**
 * Create a pattern in a track's BANK and stamp it once onto the timeline,
 * so the new loop is both editable and audible in one gesture. `notes`
 * seeds it — that is how "place the first step on an empty track" works.
 *
 * Both clips arrive in ONE op, so undo takes the pattern and its first
 * stamp back together. The stamp lands after whatever is already on the
 * track, so pressing + repeatedly chains A, B, C like a drum machine.
 */
export function createPattern(
  trackId: TrackId,
  options: {
    notes?: readonly Note[]
    start?: number
    duration?: number
    freeLength?: boolean
  } = {}
): ClipId | null {
  const state = projectStore.state
  if (!state.tracks[trackId]) return null
  const bar = ticksPerBar(state.timeSignature)
  const trackEnd = timelineClips(state)
    .filter((c) => c.trackId === trackId)
    .reduce((max, c) => Math.max(max, c.start + c.duration), 0)
  const start =
    options.start !== undefined ? Math.max(0, Math.floor(options.start / bar) * bar) : trackEnd
  // A solo is allowed to be shorter than a bar — that is the whole point;
  // a measure-shaped loop is floored at the shortest offered fraction.
  const defaultDuration = options.freeLength ? bar * SOLO_START_MEASURES : bar
  const floor = options.freeLength ? 1 : Math.round(bar * PATTERN_LENGTHS[0].measures)
  const duration = Math.max(floor, Math.round(options.duration ?? defaultDuration))
  const pattern: Clip = {
    id: newId('pat'),
    trackId,
    name: nextPatternName(state, trackId),
    // Bank material: it is nowhere on the timeline, so `start` is unused.
    isPattern: true,
    start: 0,
    duration,
    assetId: null,
    offset: 0,
    color: null,
    fadeIn: 0,
    fadeOut: 0,
    reverse: false,
    pitch: 0,
    stretch: 1,
    loopLength: 0,
    ...(options.freeLength ? { freeLength: true } : {})
  }
  const firstStamp: Clip = {
    ...pattern,
    id: newId('clp'),
    isPattern: false,
    sourceClipId: pattern.id,
    start
  }
  const notes = (options.notes ?? []).map((note) => ({ ...note, clipId: pattern.id }))
  projectStore.dispatch({ type: 'clip/createMany', clips: [pattern, firstStamp], notes })
  selection.select(firstStamp.id, trackId)
  editorUi.open(pattern.id)
  return pattern.id
}

/**
 * Remove a pattern from the bank, and with it every clip that places it.
 * The bank is the source: nothing on the timeline can outlive it. One op,
 * so undo brings the pattern, its notes and all its stamps back together.
 */
export function deletePattern(patternId: ClipId): void {
  const state = projectStore.state
  const pattern = state.clips[patternId]
  if (!pattern?.isPattern) return
  const ids = [...stampsOf(state, patternId).map((c) => c.id), patternId]
  projectStore.dispatch({ type: 'clip/deleteMany', clipIds: ids })
}

/**
 * Stamp a loop onto the track: another clip playing the SAME notes, so
 * editing the loop changes every stamp of it. Defaults to landing right
 * after whatever is already on the track — press it repeatedly to chain
 * the loop along.
 *
 * Stamping a stamp stamps its source, so the chain never grows a second
 * level to reason about.
 */
export function stampPattern(
  clipId: ClipId,
  options: { start?: number; duration?: number } = {}
): ClipId | null {
  const state = projectStore.state
  const sourceId = noteSourceOf(state, clipId)
  const source = state.clips[sourceId]
  if (!source || source.assetId !== null) return null
  const bar = ticksPerBar(state.timeSignature)
  const trackEnd = timelineClips(state)
    .filter((c) => c.trackId === source.trackId)
    .reduce((max, c) => Math.max(max, c.start + c.duration), 0)
  const start =
    options.start !== undefined ? Math.max(0, Math.floor(options.start / bar) * bar) : trackEnd
  const clip: Clip = {
    ...source,
    id: newId('clp'),
    // The stamp is on the timeline; the pattern it came from stays in the bank.
    isPattern: false,
    sourceClipId: sourceId,
    start,
    duration: Math.max(1, Math.round(options.duration ?? source.duration))
  }
  // The stamp carries no notes of its own — that is what makes it follow.
  projectStore.dispatch({ type: 'clip/create', clip, notes: [] })
  selection.select(clip.id, source.trackId)
  return clip.id
}

/** How many times a loop is on the timeline, counting itself. */
export function stampCount(state: ProjectState, clipId: ClipId): number {
  return stampsOf(state, noteSourceOf(state, clipId)).length + 1
}
