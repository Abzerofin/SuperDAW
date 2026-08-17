import { describe, expect, it } from 'vitest'
import {
  SCALE_TYPES,
  isInScale,
  nearestScalePitch,
  pitchClassOf,
  scaleLabel,
  scalePitchClasses,
  type ScaleType
} from '../scales'

const byName = (name: string): ScaleType => {
  const type = SCALE_TYPES.find((t) => t.name === name)
  if (!type) throw new Error(`no scale named ${name}`)
  return type
}

const classes = (root: number, name: string): Set<number> =>
  scalePitchClasses(root, byName(name).intervals)

describe('scale definitions', () => {
  it('every scale starts at the root, ascends, and stays inside one octave', () => {
    for (const type of SCALE_TYPES) {
      expect(type.intervals[0], type.name).toBe(0)
      for (let i = 1; i < type.intervals.length; i++) {
        expect(type.intervals[i], type.name).toBeGreaterThan(type.intervals[i - 1])
      }
      expect(type.intervals[type.intervals.length - 1], type.name).toBeLessThan(12)
    }
  })

  it('has the promised roster', () => {
    for (const name of [
      'Major',
      'Natural minor',
      'Harmonic minor',
      'Melodic minor',
      'Dorian',
      'Phrygian',
      'Lydian',
      'Mixolydian',
      'Locrian',
      'Major pentatonic',
      'Minor pentatonic',
      'Blues'
    ]) {
      expect(byName(name)).toBeDefined()
    }
  })

  it('spot-checks the interval math against known keys', () => {
    // C major = the white keys.
    expect([...classes(0, 'Major')].sort((a, b) => a - b)).toEqual([0, 2, 4, 5, 7, 9, 11])
    // A natural minor = the same white keys, rooted on A.
    expect([...classes(9, 'Natural minor')].sort((a, b) => a - b)).toEqual([0, 2, 4, 5, 7, 9, 11])
    // D dorian is also the white keys.
    expect([...classes(2, 'Dorian')].sort((a, b) => a - b)).toEqual([0, 2, 4, 5, 7, 9, 11])
    // A harmonic minor raises G to G#.
    expect([...classes(9, 'Harmonic minor')].sort((a, b) => a - b)).toEqual([0, 2, 4, 5, 8, 9, 11])
    // E minor pentatonic: E G A B D.
    expect([...classes(4, 'Minor pentatonic')].sort((a, b) => a - b)).toEqual([2, 4, 7, 9, 11])
  })
})

describe('pitchClassOf / isInScale', () => {
  it('folds any pitch (negative included) to 0–11', () => {
    expect(pitchClassOf(60)).toBe(0)
    expect(pitchClassOf(61)).toBe(1)
    expect(pitchClassOf(11)).toBe(11)
    expect(pitchClassOf(-1)).toBe(11)
    expect(pitchClassOf(-12)).toBe(0)
  })

  it('answers membership in every octave', () => {
    const cMajor = classes(0, 'Major')
    for (const octave of [0, 36, 60, 96]) {
      expect(isInScale(octave, cMajor)).toBe(true) // C
      expect(isInScale(octave + 1, cMajor)).toBe(false) // C#
      expect(isInScale(octave + 4, cMajor)).toBe(true) // E
      expect(isInScale(octave + 6, cMajor)).toBe(false) // F#
    }
  })

  it('wraps roots outside 0–11 the same as chords do', () => {
    expect(classes(12, 'Major')).toEqual(classes(0, 'Major'))
    expect(scalePitchClasses(-3, byName('Major').intervals)).toEqual(classes(9, 'Major'))
  })
})

describe('nearestScalePitch', () => {
  const cMajor = classes(0, 'Major')

  it('returns an in-scale pitch unchanged', () => {
    for (let pitch = 21; pitch <= 108; pitch++) {
      if (isInScale(pitch, cMajor)) expect(nearestScalePitch(pitch, cMajor)).toBe(pitch)
    }
  })

  it('resolves ties DOWNWARD (the documented rule): C# in C major becomes C, not D', () => {
    expect(nearestScalePitch(61, cMajor)).toBe(60) // C#4 → C4 (C and D both 1 away)
    expect(nearestScalePitch(66, cMajor)).toBe(65) // F#4 → F4 (F and G both 1 away)
    // Every black key in C major ties down to the white key below it.
    for (const black of [1, 3, 6, 8, 10]) {
      expect(nearestScalePitch(60 + black, cMajor)).toBe(60 + black - 1)
    }
  })

  it('goes UP when up is strictly nearer', () => {
    const cMajPent = classes(0, 'Major pentatonic') // C D E G A
    expect(nearestScalePitch(66, cMajPent)).toBe(67) // F# → G (E is 2 away, G is 1)
    const cBlues = classes(0, 'Blues') // C Eb F F# G Bb
    expect(nearestScalePitch(62, cBlues)).toBe(63) // D → Eb (C is 2 away, Eb is 1)
  })

  it('goes DOWN when down is strictly nearer', () => {
    const cMajPent = classes(0, 'Major pentatonic')
    expect(nearestScalePitch(65, cMajPent)).toBe(64) // F → E (E is 1 away, G is 2)
    const cBlues = classes(0, 'Blues')
    expect(nearestScalePitch(61, cBlues)).toBe(60) // C# → C
  })

  it('never moves more than 2 semitones for any shipped scale', () => {
    for (const type of SCALE_TYPES) {
      for (let root = 0; root < 12; root++) {
        const set = scalePitchClasses(root, type.intervals)
        for (let pitch = 21; pitch <= 108; pitch++) {
          const snapped = nearestScalePitch(pitch, set)
          expect(Math.abs(snapped - pitch), `${type.name} root ${root} pitch ${pitch}`).toBeLessThanOrEqual(2)
          expect(isInScale(snapped, set)).toBe(true)
        }
      }
    }
  })

  it('respects the [lo, hi] bounds instead of snapping outside them', () => {
    const dMajor = classes(2, 'Major') // no pitch class 0
    // Pitch 0 with lo=0: C is out of scale, B below is out of range → C#.
    expect(nearestScalePitch(0, dMajor, 0, 127)).toBe(1)
    // Pitch 127 (G) is not in A harmonic minor; 128+ is out of range, so
    // only the downward walk can win: F (125).
    expect(nearestScalePitch(127, classes(9, 'Harmonic minor'), 0, 127)).toBe(125)
    const cMaj = classes(0, 'Major')
    // hi below the tie partner: C#4 with hi=60 can only go down.
    expect(nearestScalePitch(61, cMaj, 0, 61)).toBe(60)
    // lo above the downward tie winner forces the upward candidate.
    expect(nearestScalePitch(61, cMaj, 61, 127)).toBe(62)
  })

  it('returns the pitch unchanged for an empty scale', () => {
    expect(nearestScalePitch(61, new Set())).toBe(61)
  })
})

describe('scaleLabel', () => {
  it('names root + scale, wrapping the root', () => {
    expect(scaleLabel(9, byName('Natural minor'))).toBe('A Natural minor')
    expect(scaleLabel(12, byName('Major'))).toBe('C Major')
    expect(scaleLabel(-2, byName('Blues'))).toBe('A# Blues')
  })
})
