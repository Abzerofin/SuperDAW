import { PPQ } from '@core/model/timebase'
import { MAX_STRETCH, MIN_STRETCH } from '@core/model/types'
import { onsetsForPeaks } from './onsets'

/**
 * Loop metadata embedded in WAV files — the "ACID-ized" chunks Sony ACID
 * established and most loop libraries still write, plus the standard
 * `smpl` (sampler loop points) and `cue ` (marker/slice positions) chunks
 * ReCycle-style editors export.
 *
 * Everything here is pure byte parsing: no DOM, no Electron, no store
 * access. Malformed, truncated or hostile buffers degrade to null fields —
 * this parser never throws. Nothing parsed here is ever written into the
 * project document; whatever the import path needs (a stretch factor, a
 * beat-snapped duration, slice positions) is derived at use time.
 */

/** A sustain/region loop from the `smpl` chunk, in sample frames. */
export interface SmplLoop {
  readonly startFrame: number
  readonly endFrame: number
}

export interface WavLoopMeta {
  /** acid chunk file type: true = one-shot, false = loop, null = no acid chunk. */
  readonly oneShot: boolean | null
  /** MIDI root note (only when the acid chunk flags it as set). */
  readonly rootNote: number | null
  /** Length of the loop in (quarter-note) beats. */
  readonly beats: number | null
  /** Meter as [numerator, denominator]. */
  readonly meter: readonly [number, number] | null
  /** Native tempo in BPM. */
  readonly tempo: number | null
  /** fmt chunk sample rate — converts marker frames to seconds. */
  readonly sampleRate: number | null
  readonly smplLoops: readonly SmplLoop[]
  /** `cue ` marker positions in sample frames, ascending, deduplicated. */
  readonly cueFrames: readonly number[]
}

/** How the audio should sit on the timeline for the loop to hit the project tempo. */
export interface LoopConform {
  /** Clip.stretch making the loop's native tempo land on the project tempo. */
  readonly stretch: number
  /** Clip duration snapped to the loop's beat count (ticks at PPQ). */
  readonly durationTicks: number
  /** The loop's native tempo (from the chunk, or implied by its beat count). */
  readonly fileTempo: number
}

const EMPTY_META: WavLoopMeta = {
  oneShot: null,
  rootNote: null,
  beats: null,
  meter: null,
  tempo: null,
  sampleRate: null,
  smplLoops: [],
  cueFrames: []
}

/** Defensive caps: a lying count field must never allocate unbounded arrays. */
const MAX_SMPL_LOOPS = 64
const MAX_CUE_POINTS = 4096

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
}

/**
 * Parse a WAV byte buffer's loop-related chunks. Returns null when the
 * bytes are not a RIFF/WAVE container at all; otherwise a meta object
 * whose fields are null (or empty) wherever a chunk is absent, truncated
 * or carries out-of-range values.
 */
export function parseWavLoopMeta(bytes: Uint8Array): WavLoopMeta | null {
  if (bytes.byteLength < 12) return null
  if (fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WAVE') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const len = bytes.byteLength

  let meta = EMPTY_META
  let pos = 12
  while (pos + 8 <= len) {
    const id = fourcc(bytes, pos)
    const size = view.getUint32(pos + 4, true)
    const body = pos + 8
    // A declared size past the end of the buffer (truncated file, hostile
    // length) is clamped to what is actually there; fixed-layout chunks
    // below then simply fail their length check and stay null.
    const avail = Math.min(size, len - body)
    if (id === 'fmt ' && meta.sampleRate === null && avail >= 8) {
      const rate = view.getUint32(body + 4, true)
      if (rate > 0 && rate <= 1_000_000) meta = { ...meta, sampleRate: rate }
    } else if (id === 'acid' && meta.oneShot === null && avail >= 24) {
      meta = { ...meta, ...parseAcid(view, body) }
    } else if (id === 'smpl' && meta.smplLoops.length === 0 && avail >= 36) {
      meta = { ...meta, smplLoops: parseSmplLoops(view, body, avail) }
    } else if (id === 'cue ' && meta.cueFrames.length === 0 && avail >= 4) {
      meta = { ...meta, cueFrames: parseCuePoints(view, body, avail) }
    }
    // Chunks are word-aligned: an odd size is followed by one pad byte.
    pos = body + size + (size & 1)
  }
  return meta
}

/**
 * The 24-byte acid chunk: file-type flags (bit 0 = one-shot, bit 1 = root
 * note valid), root note, number of beats, meter, native tempo (float).
 */
function parseAcid(
  view: DataView,
  body: number
): Pick<WavLoopMeta, 'oneShot' | 'rootNote' | 'beats' | 'meter' | 'tempo'> {
  const flags = view.getUint32(body, true)
  const rootRaw = view.getUint16(body + 4, true)
  const beatsRaw = view.getUint32(body + 12, true)
  const meterDen = view.getUint16(body + 16, true)
  const meterNum = view.getUint16(body + 18, true)
  const tempoRaw = view.getFloat32(body + 20, true)
  return {
    oneShot: (flags & 0x01) !== 0,
    rootNote: (flags & 0x02) !== 0 && rootRaw <= 127 ? rootRaw : null,
    beats: beatsRaw > 0 && beatsRaw <= 65536 ? beatsRaw : null,
    meter:
      meterNum >= 1 && meterNum <= 64 && meterDen >= 1 && meterDen <= 64
        ? [meterNum, meterDen]
        : null,
    tempo:
      Number.isFinite(tempoRaw) && tempoRaw > 0 && tempoRaw < 1000
        ? Math.round(tempoRaw * 100) / 100
        : null
  }
}

/** smpl: 36-byte header, then 24-byte loop records (start/end in frames). */
function parseSmplLoops(view: DataView, body: number, avail: number): SmplLoop[] {
  const declared = view.getUint32(body + 28, true)
  const fit = Math.floor((avail - 36) / 24)
  const count = Math.min(declared, fit, MAX_SMPL_LOOPS)
  const loops: SmplLoop[] = []
  for (let i = 0; i < count; i++) {
    const at = body + 36 + i * 24
    const startFrame = view.getUint32(at + 8, true)
    const endFrame = view.getUint32(at + 12, true)
    if (endFrame >= startFrame) loops.push({ startFrame, endFrame })
  }
  return loops
}

/** cue: count, then 24-byte cue records; the marker is the sampleOffset field. */
function parseCuePoints(view: DataView, body: number, avail: number): number[] {
  const declared = view.getUint32(body, true)
  const fit = Math.floor((avail - 4) / 24)
  const count = Math.min(declared, fit, MAX_CUE_POINTS)
  const frames: number[] = []
  for (let i = 0; i < count; i++) {
    frames.push(view.getUint32(body + 4 + i * 24 + 20, true))
  }
  frames.sort((a, b) => a - b)
  return frames.filter((f, i) => i === 0 || f !== frames[i - 1])
}

/**
 * The stretch/duration a fresh clip needs for this loop to sit on the
 * project tempo — the same tape-style conform (and the same 3-decimal
 * rounding and stretch clamp) `project/setTempo`'s conform machinery uses,
 * with the duration snapped to the loop's beat count so it tiles exactly.
 * Null = not a conformable loop (one-shot, no tempo/beat info, or the
 * metadata contradicts the audio's actual length).
 */
export function conformLoopToTempo(
  meta: WavLoopMeta | null,
  assetSeconds: number,
  projectTempo: number
): LoopConform | null {
  if (!meta || meta.oneShot !== false) return null
  if (!(assetSeconds > 0) || !(projectTempo > 0)) return null
  const beats =
    meta.beats ?? (meta.tempo !== null ? Math.round((assetSeconds * meta.tempo) / 60) : null)
  if (beats === null || beats <= 0) return null
  const impliedTempo = (beats * 60) / assetSeconds
  // The beat count must roughly agree with the audio it describes: a
  // doctored or stale chunk whose declared tempo is off by more than 50%
  // from what the samples imply is ignored rather than trusted.
  if (meta.tempo !== null && Math.abs(impliedTempo - meta.tempo) / meta.tempo > 0.5) return null
  // Beat-count-only files: the implied tempo must at least be a tempo.
  if (meta.tempo === null && (impliedTempo < 20 || impliedTempo > 400)) return null
  const stretch =
    Math.round(
      Math.min(MAX_STRETCH, Math.max(MIN_STRETCH, (beats * 60) / projectTempo / assetSeconds)) *
        1000
    ) / 1000
  return {
    stretch,
    durationTicks: Math.max(1, Math.round(beats * PPQ)),
    fileTempo: meta.tempo ?? Math.round(impliedTempo * 100) / 100
  }
}

/** Parsed metadata per encoded-bytes object (the buffer IS the cache key). */
const metaCache = new WeakMap<Uint8Array, WavLoopMeta | null>()

/** Cached loop metadata for an asset's encoded bytes; null for non-WAV files. */
export function loopMetaForBytes(encoded: Uint8Array, ext: string): WavLoopMeta | null {
  if (!/^wave?$/i.test(ext)) return null
  if (metaCache.has(encoded)) return metaCache.get(encoded) ?? null
  const meta = parseWavLoopMeta(encoded)
  metaCache.set(encoded, meta)
  return meta
}

const markerCache = new WeakMap<WavLoopMeta, number[] | null>()

/**
 * The file's authored slice markers in buffer seconds, or null when there
 * are none worth trusting. At least TWO cue points are required: editors
 * routinely leave a single stray marker behind, and one marker is not a
 * slice map. Marker positions come straight from the encoded bytes, so
 * every machine derives the identical list — even sturdier than the peak
 * detector, whose input can vary by a decoder's rounding.
 */
export function sliceMarkerSeconds(meta: WavLoopMeta | null): number[] | null {
  if (!meta || meta.sampleRate === null || meta.cueFrames.length < 2) return null
  const cached = markerCache.get(meta)
  if (cached !== undefined) return cached
  const rate = meta.sampleRate
  const markers = meta.cueFrames.map((frame) => frame / rate)
  markerCache.set(meta, markers)
  return markers
}

/** The slice of an asset every onset consumer needs to see. */
export interface OnsetAssetLike {
  readonly ext?: string
  readonly encoded?: Uint8Array
  readonly peaks?: Float32Array | null
  readonly peaksPerSecond?: number
}

/**
 * Where an asset's slices are: the file's own cue markers when it carries
 * a usable set (they are authorial truth), otherwise the detected
 * transient onsets from the peak envelope. The single seam shared by the
 * slicer actions, waveform-peak snapping, the sampler's SLICES mode in the
 * live engine and the offline render — so every consumer, on every
 * machine, agrees on the same boundaries and document data can keep
 * referencing slices by index.
 */
export function assetOnsetSeconds(asset: OnsetAssetLike): number[] {
  const meta =
    asset.encoded !== undefined && asset.ext !== undefined
      ? loopMetaForBytes(asset.encoded, asset.ext)
      : null
  const markers = sliceMarkerSeconds(meta)
  if (markers !== null) return markers
  return onsetsForPeaks(asset.peaks ?? null, asset.peaksPerSecond ?? 0)
}
