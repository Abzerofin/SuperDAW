import { describe as suite, expect, test } from 'vitest'
import { PPQ } from '../../core/model/timebase'
import { MAX_STRETCH, MIN_STRETCH } from '../../core/model/types'
import {
  assetOnsetSeconds,
  conformLoopToTempo,
  loopMetaForBytes,
  parseWavLoopMeta,
  sliceMarkerSeconds,
  type WavLoopMeta
} from '../loopMeta'

/* ---------- Hand-built RIFF fixtures (no binary files committed) ---------- */

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0))
}

function u16(value: number): Uint8Array {
  const b = new Uint8Array(2)
  new DataView(b.buffer).setUint16(0, value, true)
  return b
}

function u32(value: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, value, true)
  return b
}

function f32(value: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setFloat32(0, value, true)
  return b
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

/** A chunk with its header; declaredSize lets a fixture lie about its length. */
function chunk(id: string, body: Uint8Array, declaredSize = body.byteLength): Uint8Array {
  const padded = body.byteLength % 2 === 1 ? concat(body, new Uint8Array(1)) : body
  return concat(ascii(id), u32(declaredSize), padded)
}

function riffWav(...chunks: Uint8Array[]): Uint8Array {
  const body = concat(ascii('WAVE'), ...chunks)
  return concat(ascii('RIFF'), u32(body.byteLength), body)
}

function fmtChunk(sampleRate: number): Uint8Array {
  return chunk(
    'fmt ',
    concat(u16(1), u16(2), u32(sampleRate), u32(sampleRate * 4), u16(4), u16(16))
  )
}

function acidBody(options: {
  flags: number
  root?: number
  beats?: number
  meterDen?: number
  meterNum?: number
  tempo?: number
}): Uint8Array {
  return concat(
    u32(options.flags),
    u16(options.root ?? 0),
    u16(0x8000),
    f32(0),
    u32(options.beats ?? 0),
    u16(options.meterDen ?? 4),
    u16(options.meterNum ?? 4),
    f32(options.tempo ?? 0)
  )
}

function smplChunk(loops: Array<[start: number, end: number]>, declaredLoops = loops.length): Uint8Array {
  const header = concat(
    u32(0), u32(0), u32(0), u32(60), u32(0), u32(0), u32(0),
    u32(declaredLoops),
    u32(0)
  )
  const records = loops.map(([start, end]) =>
    concat(u32(0), u32(0), u32(start), u32(end), u32(0), u32(0))
  )
  return chunk('smpl', concat(header, ...records))
}

function cueChunk(frames: number[], declaredCount = frames.length): Uint8Array {
  const records = frames.map((frame, i) =>
    concat(u32(i), u32(frame), ascii('data'), u32(0), u32(0), u32(frame))
  )
  return chunk('cue ', concat(u32(declaredCount), ...records))
}

/** A 4-second, 8-beat, 120 BPM ACID loop fixture. */
function acidLoopWav(): Uint8Array {
  return riffWav(
    fmtChunk(44100),
    chunk('acid', acidBody({ flags: 0x02, root: 60, beats: 8, meterNum: 4, meterDen: 4, tempo: 120 }))
  )
}

/* ------------------------------ parser ------------------------------ */

suite('parseWavLoopMeta', () => {
  test('parses the acid chunk of a loop', () => {
    const meta = parseWavLoopMeta(acidLoopWav())
    expect(meta).not.toBeNull()
    expect(meta?.oneShot).toBe(false)
    expect(meta?.rootNote).toBe(60)
    expect(meta?.beats).toBe(8)
    expect(meta?.meter).toEqual([4, 4])
    expect(meta?.tempo).toBe(120)
    expect(meta?.sampleRate).toBe(44100)
  })

  test('one-shot flag and unset root note', () => {
    const meta = parseWavLoopMeta(
      riffWav(chunk('acid', acidBody({ flags: 0x01, root: 60, beats: 1, tempo: 170 })))
    )
    expect(meta?.oneShot).toBe(true)
    // Root note only counts when flag 0x02 says it is meaningful.
    expect(meta?.rootNote).toBeNull()
    expect(meta?.tempo).toBe(170)
  })

  test('non-RIFF and non-WAVE bytes are null; absent chunks are null fields', () => {
    expect(parseWavLoopMeta(new Uint8Array(0))).toBeNull()
    expect(parseWavLoopMeta(ascii('not a wav file at all'))).toBeNull()
    expect(parseWavLoopMeta(concat(ascii('RIFF'), u32(4), ascii('AVI ')))).toBeNull()
    const plain = parseWavLoopMeta(riffWav(fmtChunk(48000)))
    expect(plain).not.toBeNull()
    expect(plain?.oneShot).toBeNull()
    expect(plain?.beats).toBeNull()
    expect(plain?.tempo).toBeNull()
    expect(plain?.smplLoops).toEqual([])
    expect(plain?.cueFrames).toEqual([])
  })

  test('truncated acid chunk leaves acid fields null without throwing', () => {
    const full = acidBody({ flags: 0x02, beats: 8, tempo: 120 })
    // Declares 24 bytes but the file ends after 10.
    const truncated = riffWav(concat(ascii('acid'), u32(24), full.subarray(0, 10)))
    const meta = parseWavLoopMeta(truncated)
    expect(meta).not.toBeNull()
    expect(meta?.oneShot).toBeNull()
    expect(meta?.tempo).toBeNull()
  })

  test('hostile chunk sizes terminate cleanly', () => {
    // A chunk claiming 4 GB of body.
    const hostile = riffWav(fmtChunk(44100), concat(ascii('junk'), u32(0xffffffff), u32(0)))
    const meta = parseWavLoopMeta(hostile)
    expect(meta?.sampleRate).toBe(44100)
    // Zero-size chunks still advance the walk.
    const zeros = riffWav(chunk('junk', new Uint8Array(0)), fmtChunk(22050))
    expect(parseWavLoopMeta(zeros)?.sampleRate).toBe(22050)
  })

  test('never throws on arbitrary byte soup', () => {
    let seed = 0x2f6e2b1
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % 256
    }
    for (let n = 0; n < 200; n += 7) {
      const bytes = new Uint8Array(n)
      for (let i = 0; i < n; i++) bytes[i] = rand()
      // Make some of them look like WAVs so the walker actually runs.
      if (n >= 12) {
        bytes.set(ascii('RIFF'), 0)
        bytes.set(ascii('WAVE'), 8)
      }
      expect(() => parseWavLoopMeta(bytes)).not.toThrow()
    }
  })

  test('odd-sized chunks are padded to word alignment', () => {
    const odd = chunk('LIST', ascii('abc')) // 3 bytes + 1 pad
    const meta = parseWavLoopMeta(riffWav(odd, fmtChunk(32000)))
    expect(meta?.sampleRate).toBe(32000)
  })

  test('out-of-range acid values become null fields', () => {
    const meta = parseWavLoopMeta(
      riffWav(
        chunk(
          'acid',
          acidBody({ flags: 0x02, root: 200, beats: 0, meterNum: 0, meterDen: 4, tempo: -3 })
        )
      )
    )
    expect(meta?.oneShot).toBe(false)
    expect(meta?.rootNote).toBeNull() // > 127
    expect(meta?.beats).toBeNull() // zero
    expect(meta?.meter).toBeNull() // numerator 0
    expect(meta?.tempo).toBeNull() // negative
  })

  test('smpl loops parse, and a lying loop count is clamped to what fits', () => {
    const meta = parseWavLoopMeta(riffWav(smplChunk([[100, 44100]], 1000)))
    expect(meta?.smplLoops).toEqual([{ startFrame: 100, endFrame: 44100 }])
    // end < start is dropped.
    const inverted = parseWavLoopMeta(riffWav(smplChunk([[500, 100]])))
    expect(inverted?.smplLoops).toEqual([])
  })

  test('cue markers sort, dedupe, and survive a lying count', () => {
    const meta = parseWavLoopMeta(riffWav(cueChunk([22050, 0, 11025, 22050], 4000)))
    expect(meta?.cueFrames).toEqual([0, 11025, 22050])
  })
})

/* --------------------------- conform math --------------------------- */

const loopMeta = (overrides: Partial<WavLoopMeta>): WavLoopMeta => ({
  oneShot: false,
  rootNote: null,
  beats: null,
  meter: null,
  tempo: null,
  sampleRate: null,
  smplLoops: [],
  cueFrames: [],
  ...overrides
})

suite('conformLoopToTempo', () => {
  test('file tempo lands on the project tempo, duration snapped to beats', () => {
    // 4 s of audio, 8 beats at 120 BPM, project at 90: play it slower.
    const conform = conformLoopToTempo(loopMeta({ beats: 8, tempo: 120 }), 4, 90)
    expect(conform).not.toBeNull()
    expect(conform?.stretch).toBeCloseTo(120 / 90, 2)
    expect(conform?.stretch).toBe(1.333) // 3-decimal rounding, like setTempo's conform
    expect(conform?.durationTicks).toBe(8 * PPQ)
    expect(conform?.fileTempo).toBe(120)
  })

  test('same tempo is stretch 1 with a beat-exact duration', () => {
    const conform = conformLoopToTempo(loopMeta({ beats: 8, tempo: 120 }), 4, 120)
    expect(conform?.stretch).toBe(1)
    expect(conform?.durationTicks).toBe(8 * PPQ)
  })

  test('beat count derives from tempo alone, and tempo from beats alone', () => {
    // 2 s at 120 BPM = 4 beats.
    const fromTempo = conformLoopToTempo(loopMeta({ tempo: 120 }), 2, 60)
    expect(fromTempo?.durationTicks).toBe(4 * PPQ)
    expect(fromTempo?.stretch).toBe(2)
    // 4 beats in 2 s implies 120 BPM.
    const fromBeats = conformLoopToTempo(loopMeta({ beats: 4 }), 2, 120)
    expect(fromBeats?.fileTempo).toBe(120)
    expect(fromBeats?.stretch).toBe(1)
  })

  test('one-shots, chunkless files and empty audio never conform', () => {
    expect(conformLoopToTempo(loopMeta({ oneShot: true, beats: 8, tempo: 120 }), 4, 90)).toBeNull()
    expect(conformLoopToTempo(loopMeta({ oneShot: null, beats: 8 }), 4, 90)).toBeNull()
    expect(conformLoopToTempo(null, 4, 90)).toBeNull()
    expect(conformLoopToTempo(loopMeta({ beats: 8, tempo: 120 }), 0, 90)).toBeNull()
    expect(conformLoopToTempo(loopMeta({}), 4, 90)).toBeNull()
  })

  test('metadata contradicting the audio length is distrusted', () => {
    // Claims 8 beats at 120 BPM (4 s) but the audio is 40 s long.
    expect(conformLoopToTempo(loopMeta({ beats: 8, tempo: 120 }), 40, 90)).toBeNull()
    // Beats-only with an absurd implied tempo.
    expect(conformLoopToTempo(loopMeta({ beats: 512 }), 4, 90)).toBeNull()
  })

  test('stretch clamps to the model limits', () => {
    // 1 beat over 4 s into a 400 BPM project wants a microscopic stretch.
    const tiny = conformLoopToTempo(loopMeta({ beats: 2, tempo: 30 }), 4, 400)
    expect(tiny?.stretch).toBe(MIN_STRETCH)
    const huge = conformLoopToTempo(loopMeta({ beats: 8, tempo: 120 }), 4, 20)
    expect(huge?.stretch).toBe(MAX_STRETCH)
  })
})

/* --------------------- markers & the onset seam --------------------- */

suite('slice markers and assetOnsetSeconds', () => {
  test('cue markers convert to seconds through the fmt sample rate', () => {
    const meta = parseWavLoopMeta(riffWav(fmtChunk(44100), cueChunk([0, 22050, 44100])))
    expect(sliceMarkerSeconds(meta)).toEqual([0, 0.5, 1])
  })

  test('a single stray cue marker is not a slice map', () => {
    const meta = parseWavLoopMeta(riffWav(fmtChunk(44100), cueChunk([22050])))
    expect(sliceMarkerSeconds(meta)).toBeNull()
    // No sample rate = no way to place the markers.
    const rateless = parseWavLoopMeta(riffWav(cueChunk([0, 22050])))
    expect(sliceMarkerSeconds(rateless)).toBeNull()
  })

  test('assetOnsetSeconds prefers file markers and falls back to peak onsets', () => {
    const marked = riffWav(fmtChunk(44100), cueChunk([0, 22050]))
    expect(assetOnsetSeconds({ ext: 'wav', encoded: marked, peaks: null, peaksPerSecond: 120 }))
      .toEqual([0, 0.5])

    // Unmarked file: detected transients from the peak envelope. Two clear
    // hits over silence at 120 buckets/s.
    const peaks = new Float32Array(240) // one second
    peaks[0] = -0.9
    peaks[1] = 0.9
    peaks[120] = -0.9
    peaks[121] = 0.9
    const plain = riffWav(fmtChunk(44100))
    const onsets = assetOnsetSeconds({ ext: 'wav', encoded: plain, peaks, peaksPerSecond: 120 })
    expect(onsets.length).toBe(2)
    expect(onsets[0]).toBeCloseTo(0, 5)
    expect(onsets[1]).toBeCloseTo(0.5, 5)

    // Non-WAV assets (mp3 etc.) go straight to the detector.
    const mp3 = assetOnsetSeconds({ ext: 'mp3', encoded: marked, peaks, peaksPerSecond: 120 })
    expect(mp3.length).toBe(2)
  })

  test('loopMetaForBytes caches per byte buffer and rejects non-wav extensions', () => {
    const bytes = acidLoopWav()
    const first = loopMetaForBytes(bytes, 'wav')
    expect(first?.tempo).toBe(120)
    expect(loopMetaForBytes(bytes, 'wav')).toBe(first)
    expect(loopMetaForBytes(bytes, 'flac')).toBeNull()
  })
})
