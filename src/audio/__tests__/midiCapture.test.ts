import { describe as suite, expect, test } from 'vitest'
import {
  applyMidiCaptureEvent,
  midiEventSec,
  parseMidiNoteMessage,
  type MidiNoteSink
} from '../midiCapture'

const msg = (...bytes: number[]): ReturnType<typeof parseMidiNoteMessage> =>
  parseMidiNoteMessage(Uint8Array.from(bytes))

suite('parseMidiNoteMessage', () => {
  test('note-on: 0x9n with velocity > 0, channel 1-based', () => {
    expect(msg(0x90, 60, 100)).toEqual({ kind: 'on', channel: 1, pitch: 60, velocity: 100 })
    expect(msg(0x9f, 127, 1)).toEqual({ kind: 'on', channel: 16, pitch: 127, velocity: 1 })
  })

  test('note-off: 0x8n, and the running-status form 0x9n velocity 0', () => {
    expect(msg(0x80, 60, 64)).toEqual({ kind: 'off', channel: 1, pitch: 60, velocity: 64 })
    expect(msg(0x93, 72, 0)).toEqual({ kind: 'off', channel: 4, pitch: 72, velocity: 0 })
  })

  test('data bytes mask to 7 bits', () => {
    expect(msg(0x90, 0xff, 0xff)).toEqual({ kind: 'on', channel: 1, pitch: 127, velocity: 127 })
  })

  test('short realtime and non-note messages parse to null', () => {
    expect(msg(0xf8)).toBeNull() // clock
    expect(msg(0xfe)).toBeNull() // active sensing
    expect(msg(0xb0, 64, 127)).toBeNull() // CC (sustain)
    expect(msg(0xe0, 0, 64)).toBeNull() // pitch bend
    expect(msg(0xa0, 60, 50)).toBeNull() // poly aftertouch
  })
})

suite('midiEventSec', () => {
  test('maps the performance timeline onto the audio clock', () => {
    // Context clock at 10 s when performance.now() read 2000 ms.
    const offset = 10 - 2000 / 1000
    expect(midiEventSec(2500, offset)).toBeCloseTo(10.5)
  })
})

suite('applyMidiCaptureEvent', () => {
  const sink = (): MidiNoteSink => ({ active: new Map(), closed: [] })

  test('on opens a held note; off closes and removes it', () => {
    const s = sink()
    applyMidiCaptureEvent(s, 'on', 60, 100, 1)
    expect(s.active.get(60)).toEqual({ pitch: 60, velocity: 100, startSec: 1, endSec: null })
    applyMidiCaptureEvent(s, 'off', 60, 0, 2)
    expect(s.active.size).toBe(0)
    expect(s.closed).toEqual([{ pitch: 60, velocity: 100, startSec: 1, endSec: 2 }])
  })

  test('retrigger: a note-on over a held pitch closes it and replaces it', () => {
    const s = sink()
    applyMidiCaptureEvent(s, 'on', 60, 100, 1)
    applyMidiCaptureEvent(s, 'on', 60, 80, 1.5)
    expect(s.closed).toEqual([{ pitch: 60, velocity: 100, startSec: 1, endSec: 1.5 }])
    expect(s.active.get(60)).toEqual({ pitch: 60, velocity: 80, startSec: 1.5, endSec: null })
  })

  test('an orphan note-off (no open note) is dropped', () => {
    const s = sink()
    applyMidiCaptureEvent(s, 'off', 60, 0, 1)
    expect(s.active.size).toBe(0)
    expect(s.closed).toEqual([])
  })

  test('ends clamp to their start — out-of-order timestamps cannot go negative', () => {
    const s = sink()
    applyMidiCaptureEvent(s, 'on', 60, 100, 2)
    applyMidiCaptureEvent(s, 'off', 60, 0, 1.5)
    expect(s.closed[0].endSec).toBe(2)
  })

  test('pitches are tracked independently', () => {
    const s = sink()
    applyMidiCaptureEvent(s, 'on', 60, 100, 1)
    applyMidiCaptureEvent(s, 'on', 64, 90, 1.1)
    applyMidiCaptureEvent(s, 'off', 60, 0, 2)
    expect(s.closed.map((n) => n.pitch)).toEqual([60])
    expect([...s.active.keys()]).toEqual([64])
  })
})
