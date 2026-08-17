/**
 * Musical scales for the piano roll's scale guide and snap-to-scale.
 *
 * Pure data + math, exactly like chords.ts next door. The guide only
 * highlights rows — nothing here reaches the document. Snap-to-scale
 * resolves every pitch with these helpers BEFORE the one note/moveMany op
 * is built (see lib/noteActions.ts), so the op stays absolute and the
 * reducer stays dumb.
 */

import { NOTE_NAMES } from './chords'

export interface ScaleType {
  readonly name: string
  /** Semitones above the root, within one octave, ascending, starting at 0. */
  readonly intervals: readonly number[]
}

/**
 * The everyday scales first, then the remaining church modes, then the
 * pentatonics and blues. Ionian and Aeolian are not listed twice — they
 * ARE Major and Natural minor.
 */
export const SCALE_TYPES: readonly ScaleType[] = [
  { name: 'Major', intervals: [0, 2, 4, 5, 7, 9, 11] }, // Ionian
  { name: 'Natural minor', intervals: [0, 2, 3, 5, 7, 8, 10] }, // Aeolian
  { name: 'Harmonic minor', intervals: [0, 2, 3, 5, 7, 8, 11] },
  { name: 'Melodic minor', intervals: [0, 2, 3, 5, 7, 9, 11] }, // ascending form
  { name: 'Dorian', intervals: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'Phrygian', intervals: [0, 1, 3, 5, 7, 8, 10] },
  { name: 'Lydian', intervals: [0, 2, 4, 6, 7, 9, 11] },
  { name: 'Mixolydian', intervals: [0, 2, 4, 5, 7, 9, 10] },
  { name: 'Locrian', intervals: [0, 1, 3, 5, 6, 8, 10] },
  { name: 'Major pentatonic', intervals: [0, 2, 4, 7, 9] },
  { name: 'Minor pentatonic', intervals: [0, 3, 5, 7, 10] },
  { name: 'Blues', intervals: [0, 3, 5, 6, 7, 10] }
]

/** A MIDI pitch folded to its class (0–11); tolerant of negative input. */
export const pitchClassOf = (pitch: number): number => ((pitch % 12) + 12) % 12

/**
 * The pitch classes a scale occupies — the guide marks every key of the
 * scale, in every octave (same shape as chordPitchClasses).
 */
export function scalePitchClasses(root: number, intervals: readonly number[]): Set<number> {
  const out = new Set<number>()
  for (const interval of intervals) out.add(pitchClassOf(root + interval))
  return out
}

/** Is this pitch in the scale? (`classes` from scalePitchClasses.) */
export function isInScale(pitch: number, classes: ReadonlySet<number>): boolean {
  return classes.has(pitchClassOf(pitch))
}

/**
 * The in-scale pitch nearest to `pitch`, staying within [lo, hi].
 *
 * TIE RULE: ties resolve DOWNWARD — when an in-scale pitch sits the same
 * distance above and below, the lower one wins (a note is pulled flat,
 * never sharp; C♯ in C major becomes C, not D).
 *
 * An in-scale pitch returns itself; an empty scale returns the pitch
 * unchanged (nothing to snap to).
 */
export function nearestScalePitch(
  pitch: number,
  classes: ReadonlySet<number>,
  lo = 0,
  hi = 127
): number {
  if (classes.size === 0) return pitch
  for (let d = 0; d <= hi - lo; d++) {
    const below = pitch - d
    if (below >= lo && below <= hi && classes.has(pitchClassOf(below))) return below
    const above = pitch + d
    if (d > 0 && above >= lo && above <= hi && classes.has(pitchClassOf(above))) return above
  }
  return pitch
}

/** "A Natural minor" — what the roll shows while a scale guide is up. */
export function scaleLabel(root: number, type: ScaleType): string {
  return `${NOTE_NAMES[pitchClassOf(root)]} ${type.name}`
}
