import { PPQ } from '../model/timebase'

/**
 * Minimal Standard MIDI File reader: extracts note events from format 0/1
 * files with tick-based division, remapped to our PPQ. All tracks and
 * channels merge into one note list (a dropped .mid becomes one clip).
 * Tempo/meta events are skipped — the project's own tempo rules playback.
 */

export interface SmfNote {
  readonly pitch: number
  /** Ticks at our PPQ, relative to file start. */
  readonly start: number
  readonly duration: number
  readonly velocity: number
}

export interface SmfResult {
  readonly notes: SmfNote[]
  /** End of the last note in our ticks (0 for an empty file). */
  readonly totalTicks: number
}

export function parseSmf(bytes: Uint8Array): SmfResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 14 || readAscii(bytes, 0, 4) !== 'MThd') {
    throw new Error('Not a MIDI file (missing MThd header)')
  }
  const headerLength = view.getUint32(4)
  const format = view.getUint16(8)
  const trackCount = view.getUint16(10)
  const division = view.getUint16(12)
  if (format > 1) throw new Error(`Unsupported MIDI format ${format} (only 0/1)`)
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported')
  const scale = PPQ / division

  const notes: SmfNote[] = []
  let offset = 8 + headerLength

  for (let t = 0; t < trackCount && offset + 8 <= bytes.length; t++) {
    if (readAscii(bytes, offset, 4) !== 'MTrk') break
    const trackLength = view.getUint32(offset + 4)
    let p = offset + 8
    const trackEnd = p + trackLength

    let tick = 0
    let runningStatus = 0
    // Open notes per (channel << 8 | pitch): start tick + velocity.
    const open = new Map<number, { start: number; velocity: number }>()

    while (p < trackEnd) {
      // Delta time (variable length)
      let delta = 0
      for (;;) {
        const byte = bytes[p++]
        delta = (delta << 7) | (byte & 0x7f)
        if ((byte & 0x80) === 0) break
      }
      tick += delta

      let status = bytes[p]
      if (status < 0x80) {
        status = runningStatus // running status: reuse previous
      } else {
        p++
        if (status < 0xf0) runningStatus = status
      }

      const kind = status & 0xf0
      const channel = status & 0x0f

      if (kind === 0x90 || kind === 0x80) {
        const pitch = bytes[p++]
        const velocity = bytes[p++]
        const key = (channel << 8) | pitch
        const isOn = kind === 0x90 && velocity > 0
        if (isOn) {
          if (!open.has(key)) open.set(key, { start: tick, velocity })
        } else {
          const started = open.get(key)
          if (started) {
            open.delete(key)
            const start = Math.round(started.start * scale)
            const end = Math.round(tick * scale)
            if (end > start) {
              notes.push({ pitch, start, duration: end - start, velocity: started.velocity })
            }
          }
        }
      } else if (kind === 0xa0 || kind === 0xb0 || kind === 0xe0) {
        p += 2
      } else if (kind === 0xc0 || kind === 0xd0) {
        p += 1
      } else if (status === 0xff) {
        p++ // meta type
        let length = 0
        for (;;) {
          const byte = bytes[p++]
          length = (length << 7) | (byte & 0x7f)
          if ((byte & 0x80) === 0) break
        }
        p += length
      } else if (status === 0xf0 || status === 0xf7) {
        let length = 0
        for (;;) {
          const byte = bytes[p++]
          length = (length << 7) | (byte & 0x7f)
          if ((byte & 0x80) === 0) break
        }
        p += length
      } else {
        break // unknown status — abandon this track safely
      }
    }
    offset = trackEnd
  }

  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  const totalTicks = notes.reduce((max, n) => Math.max(max, n.start + n.duration), 0)
  return { notes, totalTicks }
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i])
  return out
}
