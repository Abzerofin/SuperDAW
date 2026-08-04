import { newId } from '@core/model/ids'

/**
 * Decoded audio assets, held OUTSIDE project state. The project document
 * only references assets by id — this split is what later allows instant
 * state sync while asset binaries transfer in the background.
 */

/** Minimal shape of an AudioBuffer; lets peak math run in tests without Web Audio. */
export interface AudioBufferLike {
  readonly numberOfChannels: number
  readonly length: number
  readonly sampleRate: number
  getChannelData(channel: number): Float32Array
}

export interface AudioAsset {
  readonly id: string
  readonly name: string
  readonly seconds: number
  readonly buffer: AudioBuffer
  /** Interleaved [min, max] pairs for waveform drawing. */
  readonly peaks: Float32Array
  readonly peaksPerSecond: number
}

export const PEAKS_PER_SECOND = 120

export class AssetStore {
  private assets = new Map<string, AudioAsset>()
  private listeners = new Set<() => void>()

  add(name: string, buffer: AudioBuffer): AudioAsset {
    const asset: AudioAsset = {
      id: newId('ast'),
      name,
      seconds: buffer.length / buffer.sampleRate,
      buffer,
      peaks: computePeaks(buffer, PEAKS_PER_SECOND),
      peaksPerSecond: PEAKS_PER_SECOND
    }
    this.assets.set(asset.id, asset)
    for (const listener of this.listeners) listener()
    return asset
  }

  get(id: string): AudioAsset | undefined {
    return this.assets.get(id)
  }

  /** Duration in seconds, or null if the asset isn't (yet) available. */
  getSeconds(id: string): number | null {
    return this.assets.get(id)?.seconds ?? null
  }

  subscribe = (listener: () => void): (() => void) => {
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
