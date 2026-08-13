import { referencedAssetIds } from '@core/persistence/format'
import { projectStore } from './projectStore'
import { assetStore, audioEngine } from './audioInstance'

/**
 * Asset memory policy: the store retains decoded AudioBuffers (and
 * reversed copies) forever on its own, which is ~3–4× the file size held
 * in RAM per asset — untenable for 100-file projects. This module is the
 * policy the store deliberately lacks: it refcounts assets against the
 * DOCUMENT (clips + bay entries + frozen tracks = `referencedAssetIds`,
 * the same rule save-time GC uses) and tells the store what to free.
 *
 * - A decoded buffer is evicted once its asset has been unreferenced for
 *   a grace period (undo/redo churn must not thrash the decoder). Encoded
 *   bytes are NEVER evicted — they are what saves and collab transfers
 *   read, and dropping them would turn "unreferenced but undoable" into
 *   data loss.
 * - A reversed copy lives only while some clip actually plays its asset
 *   reversed; rebuilding one is a synchronous mirror pass, so no grace.
 * - When an op re-references an evicted asset (undo of a clip delete),
 *   its bytes are re-decoded here and rehydrated; the engine's asset
 *   listener then re-queues the affected tracks. Only ids THIS module
 *   evicted are re-decoded — assets whose decode failed at load keep
 *   their explicit silent-with-warning state instead of a retry loop.
 */

const SWEEP_INTERVAL_MS = 10_000
const EVICT_AFTER_MS = 30_000

class AssetMemoryPolicy {
  /** First sweep that saw the asset unreferenced, by id. */
  private unreferencedSince = new Map<string, number>()
  /** Ids evicted by this module — the only ones re-decode may resurrect. */
  private evicted = new Set<string>()
  private decoding = new Set<string>()
  private prevClips: unknown = null
  private prevFiles: unknown = null
  private prevTracks: unknown = null

  start(): void {
    setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
    projectStore.subscribe(() => this.redecodeMissing())
  }

  private sweep(): void {
    const state = projectStore.state
    const referenced = referencedAssetIds(state)
    const now = performance.now()
    const evictable = new Set<string>()
    for (const asset of assetStore.all()) {
      if (referenced.has(asset.id)) {
        this.unreferencedSince.delete(asset.id)
        continue
      }
      if (asset.kind !== 'audio' || asset.buffer === null) continue
      const since = this.unreferencedSince.get(asset.id)
      if (since === undefined) this.unreferencedSince.set(asset.id, now)
      else if (now - since >= EVICT_AFTER_MS) evictable.add(asset.id)
    }
    // Assets gone entirely (project switch cleared the store).
    for (const id of this.unreferencedSince.keys()) {
      if (!assetStore.get(id)) {
        this.unreferencedSince.delete(id)
        this.evicted.delete(id)
      }
    }
    const keepReversed = new Set<string>()
    for (const clip of Object.values(state.clips)) {
      if (clip.reverse && clip.assetId) keepReversed.add(clip.assetId)
    }
    if (assetStore.evict(evictable, keepReversed) > 0) {
      for (const id of evictable) {
        this.evicted.add(id)
        this.unreferencedSince.delete(id)
      }
    }
    // The engine's backend adopted these buffers for playback; its copies
    // must release with the store's or the eviction frees nothing.
    audioEngine.pruneAdoptedBuffers(evictable, keepReversed)
  }

  /** An op may have re-referenced an evicted asset — decode it back. */
  private redecodeMissing(): void {
    const state = projectStore.state
    if (
      state.clips === this.prevClips &&
      state.files === this.prevFiles &&
      state.tracks === this.prevTracks
    ) {
      return
    }
    this.prevClips = state.clips
    this.prevFiles = state.files
    this.prevTracks = state.tracks
    if (this.evicted.size === 0) return
    const referenced = referencedAssetIds(state)
    for (const id of this.evicted) {
      if (!referenced.has(id) || this.decoding.has(id)) continue
      const asset = assetStore.get(id)
      if (!asset) {
        this.evicted.delete(id)
        continue
      }
      if (asset.buffer !== null) {
        this.evicted.delete(id)
        continue
      }
      this.decoding.add(id)
      void audioEngine
        .decode(asset.encoded.slice().buffer)
        .then((buffer) => {
          assetStore.rehydrate(id, buffer)
          this.evicted.delete(id)
        })
        .catch((error) => {
          // Stays silent (the status bar counts it); retried on the next
          // referencing op rather than in a loop.
          console.warn(`Could not re-decode asset ${id}`, error)
        })
        .finally(() => this.decoding.delete(id))
    }
  }
}

export const assetMemory = new AssetMemoryPolicy()

if (typeof window !== 'undefined') assetMemory.start()
