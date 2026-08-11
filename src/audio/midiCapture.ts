/**
 * Pure bookkeeping for live MIDI capture — the message-parsing and
 * note-tracking halves of the record path. state/midiInputs routes,
 * state/recording anchors the clock; neither owns any note math, so this
 * module stays testable without a browser. Times are seconds on the
 * AudioContext clock; `midiEventSec` is the only place the performance
 * timeline crosses over.
 */

/** One parsed note message; channel is 1-based like the channel selector. */
export interface MidiNoteMessage {
  readonly kind: 'on' | 'off'
  readonly channel: number
  readonly pitch: number
  readonly velocity: number
}

/**
 * Note-on (0x9n, velocity > 0) and note-off (0x8n, or 0x9n with velocity
 * 0) only; clock/active-sensing (1-byte realtime), CC, aftertouch and
 * pitch-bend parse to null.
 */
export function parseMidiNoteMessage(data: Uint8Array): MidiNoteMessage | null {
  if (data.length < 3) return null
  const status = data[0] & 0xf0
  const channel = (data[0] & 0x0f) + 1
  const pitch = data[1] & 0x7f
  const velocity = data[2] & 0x7f
  if (status === 0x90 && velocity > 0) return { kind: 'on', channel, pitch, velocity }
  if (status === 0x80 || status === 0x90) return { kind: 'off', channel, pitch, velocity }
  return null
}

/** One captured note; times on the AudioContext clock, endSec null = held. */
export interface CapturedNote {
  pitch: number
  velocity: number
  startSec: number
  endSec: number | null
}

/** A growing take's note sink. */
export interface MidiNoteSink {
  /** Held keys → their open note (retrigger closes and replaces). */
  active: Map<number, CapturedNote>
  closed: CapturedNote[]
}

/** Web MIDI event.timeStamp (performance timeline, ms) → audio-clock sec. */
export function midiEventSec(timeStampMs: number, clockOffsetSec: number): number {
  return timeStampMs / 1000 + clockOffsetSec
}

/**
 * Track one event. A note-on over a held pitch closes it (retrigger); a
 * note-off with no open note is an orphan (key was already down at record
 * start) and is dropped. Ends clamp to their start so out-of-order
 * timestamps can never produce a negative-length note.
 */
export function applyMidiCaptureEvent(
  sink: MidiNoteSink,
  kind: 'on' | 'off',
  pitch: number,
  velocity: number,
  eventSec: number
): void {
  const open = sink.active.get(pitch)
  if (kind === 'on') {
    if (open) {
      open.endSec = Math.max(open.startSec, eventSec)
      sink.closed.push(open)
    }
    sink.active.set(pitch, { pitch, velocity, startSec: eventSec, endSec: null })
  } else {
    if (!open) return
    open.endSec = Math.max(open.startSec, eventSec)
    sink.closed.push(open)
    sink.active.delete(pitch)
  }
}
