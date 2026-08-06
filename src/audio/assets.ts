import { newId } from '@core/model/ids'

/**
 * Decoded audio assets, held OUTSIDE project state. The project document
 * only references assets by id — this split is what later allows instant
 * state sync while asset binaries transfer in the background.
 *
 * The original encoded bytes are retained: they are what gets written into
 * project files (and, later, transferred to collaborators). MIDI assets
 * carry bytes only for now; parsing arrives with the piano-roll milestone.
 */

/** Minimal shape of an AudioBuffer; lets peak math run in tests without Web Audio. */
export interface AudioBufferLike {
  readonly numberOfChannels: number
  readonly length: number
  readonly sampleRate: number
  getChannelData(channel: number): Float32Array
}

export interface ProjectAsset {
  readonly id: string
  readonly name: string
  readonly kind: 'audio' | 'midi'
  /** Original file extension without the dot, e.g. "wav". */
  readonly ext: string
  /** Original encoded file bytes (written into project files). */
  readonly encoded: Uint8Array
  /** Decoded audio; null for MIDI assets. */
  readonly buffer: AudioBuffer | null
  /** Playable length in seconds; null when unknown (MIDI, for now). */
  readonly seconds: number | null
  /** Interleaved [min, max] pairs for waveform drawing; null for MIDI. */
  readonly peaks: Float32Array | null
  readonly peaksPerSecond: number
}

export const PEAKS_PER_SECOND = 120

/**
 * 'local' = imported/recorded on THIS machine (a session should offer it
 * to collaborators); 'restored' = loaded from a project file or received
 * from the session (never re-offered). Absent for bulk changes (clear).
 */
export interface AssetEvent {
  readonly asset: ProjectAsset
  readonly origin: 'local' | 'restored'
}

export class AssetStore {
  private assets = new Map<string, ProjectAsset>()
  private reversed = new Map<string, AudioBuffer>()
  private listeners = new Set<(event?: AssetEvent) => void>()

  /**
   * A mirrored copy of an asset's buffer, for clips playing in reverse.
   * Web Audio cannot read a buffer backwards, so one flipped copy per
   * ASSET is built on demand and shared by every reversed clip using it —
   * clip-level data is still never duplicated.
   */
  reversedBuffer(id: string, create: (channels: Float32Array[], sampleRate: number) => AudioBuffer): AudioBuffer | null {
    const cached = this.reversed.get(id)
    if (cached) return cached
    const buffer = this.assets.get(id)?.buffer
    if (!buffer) return null
    const channels: Float32Array[] = []
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const source = buffer.getChannelData(ch)
      const flipped = new Float32Array(source.length)
      for (let i = 0, j = source.length - 1; i < source.length; i++, j--) flipped[i] = source[j]
      channels.push(flipped)
    }
    const mirrored = create(channels, buffer.sampleRate)
    this.reversed.set(id, mirrored)
    return mirrored
  }

  addAudio(name: string, ext: string, encoded: Uint8Array, buffer: AudioBuffer): ProjectAsset {
    return this.register(newId('ast'), name, 'audio', ext, encoded, buffer, 'local')
  }

  addMidi(name: string, ext: string, encoded: Uint8Array): ProjectAsset {
    return this.register(newId('ast'), name, 'midi', ext, encoded, null, 'local')
  }

  /** Register an asset under a fixed id (loading project files, remote sync). */
  restore(
    id: string,
    name: string,
    kind: 'audio' | 'midi',
    ext: string,
    encoded: Uint8Array,
    buffer: AudioBuffer | null
  ): ProjectAsset {
    return this.register(id, name, kind, ext, encoded, buffer, 'restored')
  }

  private register(
    id: string,
    name: string,
    kind: 'audio' | 'midi',
    ext: string,
    encoded: Uint8Array,
    buffer: AudioBuffer | null,
    origin: 'local' | 'restored'
  ): ProjectAsset {
    const asset: ProjectAsset = {
      id,
      name,
      kind,
      ext,
      encoded,
      buffer,
      seconds: buffer ? buffer.length / buffer.sampleRate : null,
      peaks: buffer ? computePeaks(buffer, PEAKS_PER_SECOND) : null,
      peaksPerSecond: PEAKS_PER_SECOND
    }
    this.assets.set(asset.id, asset)
    for (const listener of this.listeners) listener({ asset, origin })
    return asset
  }

  get(id: string): ProjectAsset | undefined {
    return this.assets.get(id)
  }

  all(): ProjectAsset[] {
    return [...this.assets.values()]
  }

  /** Playable duration in seconds, or null if unavailable. */
  getSeconds(id: string): number | null {
    return this.assets.get(id)?.seconds ?? null
  }

  /** Drop everything (loading a different project). */
  clear(): void {
    this.assets.clear()
    this.reversed.clear()
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: (event?: AssetEvent) => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/** Channel-merged min/max buckets at a fixed time resolution. */
export function computePeaks(buffer: AudioBufferLike, bucketsPerSecond: number): Float32Array {
  const bucketSize = Math.max(1, Math.round(buffer.sampleRate / bucketsPerSecond))
  const bucketCount = Math.ceil(buffer.length / bucketSize)
  const peaks = new Float32Array(bucketCount * 2)
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c))

  for (let b = 0; b < bucketCount; b++) {
    let min = 0
    let max = 0
    const from = b * bucketSize
    const to = Math.min(buffer.length, from + bucketSize)
    for (const data of channels) {
      for (let i = from; i < to; i++) {
        const v = data[i]
        if (v < min) min = v
        if (v > max) max = v
      }
    }
    peaks[b * 2] = min
    peaks[b * 2 + 1] = max
  }
  return peaks
}
