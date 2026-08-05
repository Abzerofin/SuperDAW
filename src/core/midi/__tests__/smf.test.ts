import { describe as suite, expect, test } from 'vitest'
import { PPQ } from '../../model/timebase'
import { parseSmf } from '../smf'

/** Build a one-track SMF (format 0) from (delta, bytes...) event tuples. */
function smf(division: number, events: number[][]): Uint8Array {
  const track: number[] = []
  for (const [delta, ...data] of events) {
    // varint delta (test values stay < 0x4000)
    if (delta < 0x80) track.push(delta)
    else track.push(0x80 | (delta >> 7), delta & 0x7f)
    track.push(...data)
  }
  track.push(0, 0xff, 0x2f, 0) // end of track
  const header = [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, division >> 8, division & 0xff,
    0x4d, 0x54, 0x72, 0x6b,
    (track.length >>> 24) & 0xff,
    (track.length >>> 16) & 0xff,
    (track.length >>> 8) & 0xff,
    track.length & 0xff
  ]
  return new Uint8Array([...header, ...track])
}

suite('parseSmf', () => {
  test('reads note on/off pairs and rescales division to our PPQ', () => {
    // division 480 (half our PPQ): C4 at t0 for 480 file-ticks, E4 after
    const bytes = smf(480, [
      [0, 0x90, 60, 100], // C4 on
      [480, 0x80, 60, 64], // C4 off after one beat
      [0, 0x90, 64, 90], // E4 on
      [240, 0x80, 64, 64] // E4 off after half beat
    ])
    const { notes, totalTicks } = parseSmf(bytes)
    expect(notes).toEqual([
      { pitch: 60, start: 0, duration: PPQ, velocity: 100 },
      { pitch: 64, start: PPQ, duration: PPQ / 2, velocity: 90 }
    ])
    expect(totalTicks).toBe(PPQ + PPQ / 2)
  })

  test('handles running status and note-on-velocity-zero as note-off', () => {
    const bytes = smf(960, [
      [0, 0x90, 60, 100],
      [100, 62, 100], // running status: another note-on at t=100
      [100, 60, 0], // running status: C4 off via vel 0 at t=200
      [100, 62, 0] // D4 off at t=300
    ])
    const { notes } = parseSmf(bytes)
    expect(notes).toEqual([
      { pitch: 60, start: 0, duration: 200, velocity: 100 },
      { pitch: 62, start: 100, duration: 200, velocity: 100 }
    ])
  })

  test('skips meta and other channel events without losing sync', () => {
    const bytes = smf(960, [
      [0, 0xff, 0x51, 3, 7, 0xa1, 0x20], // tempo meta (ignored)
      [0, 0xc0, 5], // program change
      [0, 0x90, 72, 80],
      [50, 0xb0, 7, 100], // CC volume
      [50, 0x80, 72, 0]
    ])
    const { notes } = parseSmf(bytes)
    expect(notes).toEqual([{ pitch: 72, start: 0, duration: 100, velocity: 80 }])
  })

  test('rejects non-MIDI data', () => {
    expect(() => parseSmf(new Uint8Array([1, 2, 3, 4]))).toThrow(/MThd/)
  })
})
