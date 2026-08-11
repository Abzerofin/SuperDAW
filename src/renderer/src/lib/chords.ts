/**
 * Chord shapes for the piano roll's chord guide.
 *
 * Display data only — picking a chord highlights the rows it occupies so
 * the notes you draw land in key (FL's chord stamp, as a guide rather than
 * a note generator). Nothing here reaches the document.
 */

export interface ChordType {
  readonly name: string
  /** Semitones above the root. */
  readonly intervals: readonly number[]
}

export const NOTE_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B'
] as const

/** Triads first, then sevenths, then extensions — the order they get reached for. */
export const CHORD_TYPES: readonly ChordType[] = [
  { name: 'Major', intervals: [0, 4, 7] },
  { name: 'Minor', intervals: [0, 3, 7] },
  { name: 'Diminished', intervals: [0, 3, 6] },
  { name: 'Augmented', intervals: [0, 4, 8] },
  { name: 'Sus2', intervals: [0, 2, 7] },
  { name: 'Sus4', intervals: [0, 5, 7] },
  { name: 'Power (5)', intervals: [0, 7] },
  { name: '6', intervals: [0, 4, 7, 9] },
  { name: 'm6', intervals: [0, 3, 7, 9] },
  { name: '7', intervals: [0, 4, 7, 10] },
  { name: 'maj7', intervals: [0, 4, 7, 11] },
  { name: 'm7', intervals: [0, 3, 7, 10] },
  { name: 'mMaj7', intervals: [0, 3, 7, 11] },
  { name: 'dim7', intervals: [0, 3, 6, 9] },
  { name: 'm7♭5', intervals: [0, 3, 6, 10] },
  { name: 'aug7', intervals: [0, 4, 8, 10] },
  { name: 'maj7♯5', intervals: [0, 4, 8, 11] },
  { name: '7sus4', intervals: [0, 5, 7, 10] },
  { name: 'add9', intervals: [0, 4, 7, 14] },
  { name: 'm add9', intervals: [0, 3, 7, 14] },
  { name: '6/9', intervals: [0, 4, 7, 9, 14] },
  { name: '9', intervals: [0, 4, 7, 10, 14] },
  { name: 'maj9', intervals: [0, 4, 7, 11, 14] },
  { name: 'm9', intervals: [0, 3, 7, 10, 14] },
  { name: '7♭9', intervals: [0, 4, 7, 10, 13] },
  { name: '7♯9', intervals: [0, 4, 7, 10, 15] },
  { name: '7♯11', intervals: [0, 4, 7, 10, 18] },
  { name: '11', intervals: [0, 4, 7, 10, 14, 17] },
  { name: 'm11', intervals: [0, 3, 7, 10, 14, 17] },
  { name: '13', intervals: [0, 4, 7, 10, 14, 21] },
  { name: 'maj13', intervals: [0, 4, 7, 11, 14, 21] },
  { name: 'm13', intervals: [0, 3, 7, 10, 14, 21] }
]

/**
 * The pitch classes a chord occupies. Extensions fold back into an octave
 * — the guide marks every key that belongs to the chord, in every octave.
 */
export function chordPitchClasses(root: number, intervals: readonly number[]): Set<number> {
  const out = new Set<number>()
  for (const interval of intervals) out.add((((root + interval) % 12) + 12) % 12)
  return out
}

/** "C maj7" — what the roll shows while a chord guide is up. */
export function chordLabel(root: number, type: ChordType): string {
  return `${NOTE_NAMES[((root % 12) + 12) % 12]} ${type.name}`
}
