import {
  referencedAssetIds,
  serializeProjectJson,
  type AssetManifestEntry
} from '@core/persistence/format'
import { projectStore } from '@/state/projectStore'
import { assetStore } from '@/state/audioInstance'
import { sessionFile } from '@/state/sessionFile'
import { preferences } from '@/state/preferences'

/**
 * Crash recovery: while the project is dirty, snapshot it periodically into
 * a single recovery slot in userData (see src/main/recovery.ts). The
 * document (project.json — same serializer as .sdaw saves) is rewritten
 * whenever state changed since the last snapshot; asset BYTES are immutable
 * by id and written once each, so a tick after the first costs one JSON
 * stringify, not a re-zip of hundreds of MB of audio.
 *
 * Policy lives here, bytes live in main:
 * - snapshot: every SNAPSHOT_INTERVAL while dirty and changed (plus when
 *   the window is hidden — the OS kills background apps first)
 * - clear: a successful save, or an explicit user discard (new/close
 *   project confirms, the home screen's Discard). Opening another project
 *   deliberately does NOT clear — a crashed session's work must survive
 *   the user browsing elsewhere before noticing the offer.
 *
 * Electron-only by nature; in the browser build every entry point no-ops.
 */

/**
 * The heartbeat fires often; each beat snapshots only when the user's
 * configured interval (Settings ▸ General, default 20 s) has elapsed —
 * so the cadence follows the preference without rescheduling timers.
 */
const HEARTBEAT_MS = 5_000

export interface RecoveryOffer {
  readonly name: string
  readonly path: string | null
  readonly savedAt: number
}

class Autosave {
  private lastSnapshotState: unknown = null
  /** Asset file names already persisted into the CURRENT slot generation. */
  private written = new Set<string>()
  private busy = false
  /** Bumped by clearRecovery so an in-flight tick stops polluting the slot. */
  private generation = 0
  private lastSnapshotAt = 0

  /**
   * Snapshot now if dirty, changed and due; quietly does nothing otherwise.
   * `force` skips the interval check (window hide — the OS kills background
   * apps first, so waiting out the cadence there risks real work).
   */
  tick = async (force = false): Promise<void> => {
    const bridge = window.superdaw
    if (!bridge || this.busy || !sessionFile.dirty) return
    if (!force && performance.now() - this.lastSnapshotAt < preferences.autosaveIntervalSec * 1000)
      return
    const state = projectStore.state
    if (state === this.lastSnapshotState) return
    this.busy = true
    this.lastSnapshotAt = performance.now()
    const generation = this.generation
    try {
      const referenced = referencedAssetIds(state)
      const manifest: AssetManifestEntry[] = []
      const toWrite: { fileName: string; data: Uint8Array }[] = []
      for (const asset of assetStore.all()) {
        if (!referenced.has(asset.id)) continue
        manifest.push({ id: asset.id, name: asset.name, kind: asset.kind, ext: asset.ext })
        const fileName = `${asset.id}.${asset.ext}`
        if (!this.written.has(fileName)) toWrite.push({ fileName, data: asset.encoded })
      }
      const json = serializeProjectJson(state, manifest, projectStore.lineage, projectStore.opLog)
      if (generation !== this.generation) return
      await bridge.recoveryWriteDoc({ json, name: state.name, path: sessionFile.path })
      this.lastSnapshotState = state
      for (const entry of toWrite) {
        // A save or discard mid-write cleared the slot: writing the rest
        // would leave orphan bytes claiming to be persisted.
        if (generation !== this.generation) return
        await bridge.recoveryWriteAsset(entry)
        this.written.add(entry.fileName)
      }
    } catch (error) {
      // Never surface: autosave must not interrupt work. The next tick
      // retries; a persistently failing disk shows up at real save time.
      console.warn('Recovery snapshot failed', error)
    } finally {
      this.busy = false
    }
  }

  /** Drop the slot (work was saved for real, or explicitly discarded). */
  async clearRecovery(): Promise<void> {
    this.generation++
    this.written.clear()
    this.lastSnapshotState = null
    this.lastSnapshotAt = 0
    try {
      await window.superdaw?.recoveryClear()
    } catch (error) {
      console.warn('Could not clear recovery snapshot', error)
    }
  }
}

export const autosave = new Autosave()

/** Is there a snapshot to offer on the home screen? */
export async function peekRecovery(): Promise<RecoveryOffer | null> {
  const bridge = window.superdaw
  if (!bridge) return null
  try {
    return await bridge.recoveryPeek()
  } catch {
    return null
  }
}

// Wired at import (from main.tsx, like the close guard). The hidden-window
// snapshot matters: minimized apps are what the OS reclaims first.
if (typeof window !== 'undefined' && window.superdaw) {
  setInterval(() => void autosave.tick(), HEARTBEAT_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void autosave.tick(true)
  })
}
