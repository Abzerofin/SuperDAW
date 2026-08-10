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
  /** SHA-256 (hex) of encoded bytes → asset id, for import dedup. */
  private byDigest = new Map<string, string>()

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

  addAudio(name: string, ext: string, encoded: Uint8Array, buffer: AudioBuffer, digest?: string): ProjectAsset {
    return this.register(newId('ast'), name, 'audio', ext, encoded, buffer, 'local', digest)
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

  /**
   * An already-held asset with byte-identical content, if any. Importing
   * the same file twice (or a file that matches a loaded project asset)
   * reuses the existing asset instead of decoding and holding a second
   * copy — dropping one 100 MB loop on three tracks must cost one asset.
   */
  findByDigest(digest: string): ProjectAsset | undefined {
    const id = this.byDigest.get(digest)
    return id !== undefined ? this.assets.get(id) : undefined
  }

  private register(
    id: string,
    name: string,
    kind: 'audio' | 'midi',
    ext: string,
    encoded: Uint8Array,
    buffer: AudioBuffer | null,
    origin: 'local' | 'restored',
    digest?: string
  ): ProjectAsset {
    const asset: ProjectAsset = {
      id,
      name,
      kind,
      ext,
      encoded,
      buffer,
      seconds: buffer ? buffer.length / buffer.sampleRate : null,
      // Peaks arrive asynchronously (see below): scanning every sample of
      // a long file on the UI thread froze the app for hundreds of
      // milliseconds per import. The asset is usable immediately — clips
      // draw their placeholder until the waveform lands.
      peaks: null,
      peaksPerSecond: PEAKS_PER_SECOND
    }
    this.assets.set(asset.id, asset)
    if (digest !== undefined && !this.byDigest.has(digest)) this.byDigest.set(digest, id)
    else if (digest === undefined) this.recordDigestLater(id, encoded)
    for (const listener of this.listeners) listener({ asset, origin })
    if (buffer) this.fillPeaksLater(id, buffer)
    return asset
  }

  /** Chunked, off-the-hot-path peak fill; swaps the asset when done. */
  private fillPeaksLater(id: string, buffer: AudioBuffer): void {
    void computePeaksAsync(buffer, PEAKS_PER_SECOND).then((peaks) => {
      const current = this.assets.get(id)
      // Cleared or replaced while computing (project switch) — drop it.
      if (!current || current.buffer !== buffer) return
      this.assets.set(id, { ...current, peaks })
      for (const listener of this.listeners) listener()
    })
  }

  /**
   * Hash in the background so later imports can dedupe against assets that
   * arrived without a digest (project loads, collab transfers, recordings).
   * crypto.subtle runs off-thread; a hash failing (non-secure context)
   * just means no dedup — never an error.
   */
  private recordDigestLater(id: string, encoded: Uint8Array): void {
    void digestOf(encoded)
      .then((digest) => {
        if (digest === null) return
        if (this.assets.has(id) && !this.byDigest.has(digest)) this.byDigest.set(digest, id)
      })
      .catch(() => {})
  }

  /**
   * Free the decoded memory of the given assets (policy — WHICH ids are
   * safe and WHEN — lives with the caller, which knows the document; this
   * store deliberately does not). Encoded bytes, seconds and peaks are
   * kept: they are the save/transfer source of truth and stay valid across
   * decode cycles, so an undo that re-references an evicted asset costs
   * one re-decode (see rehydrate), not a re-import. Reversed copies are a
   * pure cache rebuilt on demand, so everything outside `keepReversed` is
   * dropped unconditionally. Returns how many decoded buffers were freed.
   */
  evict(ids: ReadonlySet<string>, keepReversed: ReadonlySet<string>): number {
    let freed = 0
    for (const id of ids) {
      const asset = this.assets.get(id)
      if (!asset || asset.buffer === null) continue
      this.assets.set(id, { ...asset, buffer: null })
      freed++
    }
    for (const id of [...this.reversed.keys()]) {
      if (!keepReversed.has(id) || ids.has(id)) this.reversed.delete(id)
    }
    return freed
  }

  /**
   * Re-attach a decoded buffer to an evicted asset. Notifies subscribers
   * with a 'restored' event so the engine re-queues the clips that were
   * playing silent — and so collab never re-offers it as new material.
   */
  rehydrate(id: string, buffer: AudioBuffer): void {
    const current = this.assets.get(id)
    if (!current || current.buffer !== null) return
    const updated: ProjectAsset = {
      ...current,
      buffer,
      seconds: buffer.length / buffer.sampleRate
    }
    this.assets.set(id, updated)
    for (const listener of this.listeners) listener({ asset: updated, origin: 'restored' })
    if (!updated.peaks) this.fillPeaksLater(id, buffer)
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
    this.byDigest.clear()
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
  fillPeakRange(peaks, channels, buffer.length, bucketSize, 0, bucketCount)
  return peaks
}

/**
 * The same peaks, computed in slices with the event loop released between
 * them — a ten-minute file is tens of millions of sample reads, which as
 * one synchronous pass visibly froze the UI on every import, load and
 * record-stop.
 */
export async function computePeaksAsync(
  buffer: AudioBufferLike,
  bucketsPerSecond: number
): Promise<Float32Array> {
  const bucketSize = Math.max(1, Math.round(buffer.sampleRate / bucketsPerSecond))
  const bucketCount = Math.ceil(buffer.length / bucketSize)
  const peaks = new Float32Array(bucketCount * 2)
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c))
  // ~4M samples of work per slice ≈ a few ms; long files take many slices.
  const bucketsPerSlice = Math.max(1, Math.floor(4_000_000 / Math.max(1, bucketSize * channels.length)))
  for (let from = 0; from < bucketCount; from += bucketsPerSlice) {
    const to = Math.min(bucketCount, from + bucketsPerSlice)
    fillPeakRange(peaks, channels, buffer.length, bucketSize, from, to)
    if (to < bucketCount) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return peaks
}

function fillPeakRange(
  peaks: Float32Array,
  channels: readonly Float32Array[],
  length: number,
  bucketSize: number,
  fromBucket: number,
  toBucket: number
): void {
  for (let b = fromBucket; b < toBucket; b++) {
    let min = 0
    let max = 0
    const from = b * bucketSize
    const to = Math.min(length, from + bucketSize)
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
}

/** SHA-256 of raw bytes as hex, or null where WebCrypto is unavailable. */
export async function digestOf(bytes: Uint8Array): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  // A copy: digest() needs a plain ArrayBuffer view it can read while the
  // caller's buffer may be a view into something larger.
  const hash = await subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
