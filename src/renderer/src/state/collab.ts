import { useSyncExternalStore } from 'react'
import type { ProjectState } from '@core/model/types'
import { newId } from '@core/model/ids'
import { referencedAssetIds } from '@core/persistence/format'
import type { PresenceData, SessionUser } from '@core/session/protocol'
import type { TransferMeta } from '@core/session/transfer'
import { isRelayCode } from '@core/relay/codes'
import type { CollabNetworking, NetworkingDeps } from '../../../net/networking'
import { RelayNetworking } from '../../../net/relayNetworking'
import { webSocketConnector } from '../../../net/relayTransport'
import { LanNetworking } from '../../../net/lanNetworking'
import type { ProjectAsset } from '@audio/assets'
import { projectStore } from './projectStore'
import { assetStore, audioEngine } from './audioInstance'
import { preferences } from './preferences'

/**
 * Session orchestration for the renderer. All networking goes through the
 * CollabNetworking interface (src/net) — this store never touches a
 * WebSocket. Two implementations sit behind it: internet sessions via the
 * relay (8-char codes) and LAN sessions served by the host's machine
 * (15-char codes); the join box tells them apart by code shape. This
 * store owns what the UI reads: mode, roster, cursors, pings, quiet
 * connection health. Nothing here ever blocks editing.
 */

export type CollabMode = 'off' | 'hosting' | 'joined'
export type CollabTransport = 'internet' | 'lan'

/**
 * Presence palette (index 0 = host). Deliberately avoids the UI accent
 * blue (#5b8def): a person's dot must never look like part of the chrome —
 * a host wearing the accent colour reads as "the collab button is on",
 * not "that's a person".
 */
export const USER_COLORS = [
  '#e8875b',
  '#6fbf73',
  '#c678dd',
  '#56b6c2',
  '#e06c75',
  '#d19a66',
  '#98c379',
  '#d574b6'
] as const

export interface RemoteCursor {
  readonly userId: string
  readonly ticks: number
  readonly trackIndex: number
  /** Vertical position within the lane (0..1); absent from older peers. */
  readonly yFrac?: number
  readonly lastSeen: number
}

export interface ActivePing {
  readonly pingId: string
  readonly userId: string
  readonly ticks: number
  readonly trackIndex: number | null
  readonly label: string
  /** See PresenceData: string = anchored UI ping, null = label-only. */
  readonly uiTarget?: string | null
  readonly at: number
}

/** A collaborator's file awaiting the user's go-ahead to download. */
export interface PendingDownload {
  readonly assetId: string
  readonly name: string
  /** Bytes when known (announced assets); null on the join path. */
  readonly size: number | null
}

const PING_LIFETIME_MS = 4000
/**
 * How long a collaborator's last-known cursor stays visible. Departures
 * already clear cursors (user-left), so this only sweeps up ghosts from a
 * peer that vanished without saying goodbye — it must NOT be so short that
 * a peer who simply stopped moving disappears, which is what makes cursors
 * feel absent.
 */
const CURSOR_STALE_MS = 30000
const DEFAULT_RELAY_URL = 'ws://localhost:8787'

/**
 * Best available name for an asset we do not have yet: its File Bay entry,
 * else a clip that plays it (the join path only carries ids).
 */
function assetDisplayName(state: ProjectState, assetId: string): string {
  for (const node of Object.values(state.files)) {
    if (node.assetId === assetId) return node.name
  }
  for (const clip of Object.values(state.clips)) {
    if (clip.assetId === assetId) return clip.name
  }
  return 'audio file'
}

function metaOf(asset: ProjectAsset): TransferMeta {
  return {
    assetId: asset.id,
    name: asset.name,
    kind: asset.kind,
    ext: asset.ext,
    size: asset.encoded.length
  }
}

class CollabStore {
  mode: CollabMode = 'off'
  transport: CollabTransport | null = null
  joinCode: string | null = null
  users: SessionUser[] = []
  /** Transport lost / host away — editing continues, syncing paused. */
  reconnecting = false
  hostAway = false
  lastError: string | null = null
  displayName: string =
    (typeof localStorage !== 'undefined' && localStorage.getItem('superdaw.displayName')) || 'Anon'

  private cursors = new Map<string, RemoteCursor>()
  private pingList: ActivePing[] = []
  /** Names/colors survive departures so the activity feed stays readable. */
  private identities = new Map<string, { name: string; colorIndex: number }>()
  /** Live downloads: assetId → progress (drives placeholder fills). */
  readonly assetProgress = new Map<string, { received: number; total: number }>()
  /** Files waiting on the user (Settings ▸ Collaboration, auto-download off). */
  readonly pendingDownloads = new Map<string, PendingDownload>()
  /**
   * Download scheduler: a join used to request EVERY missing asset at
   * once, which shoved the whole project into the socket ahead of op
   * traffic. At most a few run concurrently; the rest wait here.
   */
  private downloadQueue: string[] = []
  private activeDownloads = new Set<string>()
  private lastProgressAt = new Map<string, number>()
  private downloadWatchdog: ReturnType<typeof setInterval> | null = null

  private active: CollabNetworking | null = null
  private relayNet: RelayNetworking | null = null
  private lanNet: LanNetworking | null = null

  private version = 0
  private listeners = new Set<() => void>()

  // ---------- subscriptions ----------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version

  private emit(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }

  private progressEmitTimer: ReturnType<typeof setTimeout> | null = null
  private scheduleProgressEmit(): void {
    if (this.progressEmitTimer !== null) return
    this.progressEmitTimer = setTimeout(() => {
      this.progressEmitTimer = null
      this.emit()
    }, 100)
  }

  // ---------- identity helpers ----------

  setDisplayName(name: string): void {
    this.displayName = name.trim() || 'Anon'
    localStorage.setItem('superdaw.displayName', this.displayName)
    this.emit()
  }

  // ---------- relay address (per-machine, never in the project) ----------

  get relayUrl(): string {
    return (
      (typeof localStorage !== 'undefined' && localStorage.getItem('superdaw.relayUrl')) ||
      DEFAULT_RELAY_URL
    )
  }

  /** Empty resets to the default. Drops the cached client so the next
   *  session dials the new address. */
  setRelayUrl(url: string): void {
    const trimmed = url.trim()
    if (trimmed) localStorage.setItem('superdaw.relayUrl', trimmed)
    else localStorage.removeItem('superdaw.relayUrl')
    this.relayNet = null
    this.emit()
  }

  nameFor(userId: string): string {
    if (userId === projectStore.userId) return 'You'
    return this.identities.get(userId)?.name ?? 'Peer'
  }

  colorFor(userId: string): string {
    const index = this.identities.get(userId)?.colorIndex ?? 0
    return USER_COLORS[index % USER_COLORS.length]
  }

  remoteCursors(): RemoteCursor[] {
    const now = Date.now()
    return [...this.cursors.values()].filter((c) => now - c.lastSeen < CURSOR_STALE_MS)
  }

  pings(): ActivePing[] {
    const now = Date.now()
    return this.pingList.filter((p) => now - p.at < PING_LIFETIME_MS)
  }

  // ---------- networking wiring ----------

  private deps(): NetworkingDeps {
    return {
      store: projectStore,
      displayName: () => this.displayName,
      hostAssets: {
        has: (assetId) => assetStore.get(assetId) !== undefined,
        get: (assetId) => {
          const asset = assetStore.get(assetId)
          if (!asset) return null
          return { meta: metaOf(asset), bytes: asset.encoded }
        },
        // Returned, not fired and forgotten: the host announces the asset
        // only after the decode/register settles, so a guest that requests
        // it immediately is never met with an empty store.
        store: (meta, bytes) => this.receiveAsset(meta, bytes)
      },
      clientAssets: {
        get: (assetId) => {
          const asset = assetStore.get(assetId)
          if (!asset) return null
          return { meta: metaOf(asset), bytes: asset.encoded }
        }
      },
      events: {
        onStatusChange: (status) => {
          this.reconnecting = status === 'reconnecting' || status === 'host-away'
          this.hostAway = status === 'host-away'
          if (status === 'off' && this.mode !== 'off') this.resetLocalState()
          this.emit()
        },
        onWelcome: (snapshot, users, _you, _firstJoin) => {
          this.users = users
          this.rememberIdentities(users)
          this.requestMissingAssets(snapshot)
          this.announceParamPolicy()
          this.emit()
        },
        onRosterChange: (users) => {
          this.users = users
          this.rememberIdentities(users)
          this.announceParamPolicy()
          this.emit()
        },
        onUserJoined: (user) => {
          this.users = [...this.users.filter((u) => u.userId !== user.userId), user]
          this.rememberIdentities([user])
          // Presence is transient: re-state the policy so the newcomer
          // learns it instead of defaulting to "accepting".
          this.announceParamPolicy()
          this.emit()
        },
        onUserLeft: (userId) => {
          this.users = this.users.filter((u) => u.userId !== userId)
          this.cursors.delete(userId)
          this.paramEditsDeclinedBy.delete(userId)
          this.emit()
        },
        onPresence: (userId, data) => this.applyRemotePresence(userId, data),
        onAssetAvailable: (meta) => {
          if (assetStore.get(meta.assetId)) return
          if (preferences.autoDownloadAssets) {
            this.active?.requestAsset(meta.assetId)
            return
          }
          // Deferred until the user says go — clips referencing it simply
          // play silent in the meantime, so waiting is always safe.
          this.pendingDownloads.set(meta.assetId, {
            assetId: meta.assetId,
            name: meta.name,
            size: meta.size
          })
          this.emit()
        },
        onAssetProgress: (assetId, received, total) => {
          this.assetProgress.set(assetId, { received, total })
          this.lastProgressAt.set(assetId, Date.now())
          // Chunks arrive at up to hundreds per second; re-rendering every
          // collab subscriber per chunk would swamp the UI thread exactly
          // while the user is trying to edit. One emit per ~100 ms reads
          // identically on a progress bar.
          this.scheduleProgressEmit()
        },
        onAssetComplete: (meta, bytes) => {
          this.assetProgress.delete(meta.assetId)
          this.downloadSettled(meta.assetId)
          void this.receiveAsset(meta, bytes)
        },
        onSessionEnded: (reason) => {
          this.lastError = reason
          this.resetLocalState()
          this.emit()
        },
        onError: (message) => this.fail(message)
      }
    }
  }

  private relay(): RelayNetworking {
    if (!this.relayNet) {
      this.relayNet = new RelayNetworking(webSocketConnector(this.relayUrl), this.deps())
    }
    return this.relayNet
  }

  private lan(): LanNetworking {
    if (!this.lanNet) {
      this.lanNet = new LanNetworking(window.superdaw ?? null, this.deps())
    }
    return this.lanNet
  }

  // ---------- hosting / joining ----------

  async startHosting(transport: CollabTransport): Promise<void> {
    if (this.mode !== 'off') this.stopAll()
    const net = transport === 'internet' ? this.relay() : this.lan()
    try {
      const { joinCode } = await net.createSession()
      this.active = net
      this.transport = transport
      this.joinCode = joinCode
      this.mode = 'hosting'
      this.users = [{ userId: projectStore.userId, name: this.displayName, colorIndex: 0 }]
      this.rememberIdentities(this.users)
      this.lastError = null
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
    }
    this.emit()
  }

  async join(code: string): Promise<void> {
    if (this.mode !== 'off') this.stopAll()
    const transport: CollabTransport = isRelayCode(code) ? 'internet' : 'lan'
    const net = transport === 'internet' ? this.relay() : this.lan()
    this.mode = 'joined'
    this.transport = transport
    this.lastError = null
    this.emit()
    try {
      await net.joinSession(code)
      this.active = net
    } catch (error) {
      this.mode = 'off'
      this.transport = null
      this.fail(error instanceof Error ? error.message : String(error))
    }
    this.emit()
  }

  leave(): void {
    this.stopAll()
    this.emit()
  }

  stopHosting(): void {
    this.stopAll()
    this.emit()
  }

  private stopAll(): void {
    this.active?.leaveSession()
    this.resetLocalState()
  }

  private resetLocalState(): void {
    this.active = null
    this.mode = 'off'
    this.transport = null
    this.joinCode = null
    this.users = []
    this.cursors.clear()
    this.paramEditsDeclinedBy.clear()
    this.assetProgress.clear()
    this.pendingDownloads.clear()
    this.clearDownloadState()
    this.reconnecting = false
    this.hostAway = false
  }

  // ---------- presence ----------

  /** Throttled by the caller (timeline pointer handler). */
  sendCursor(cursor: { ticks: number; trackIndex: number; yFrac?: number } | null): void {
    this.sendPresence({ cursor })
  }

  ping(ticks: number, trackIndex: number | null, label: string): void {
    this.emitPing({ pingId: newId('png'), ticks, trackIndex, label })
  }

  /**
   * Ping anything outside the timeline: `target` names a `data-ping-id`
   * element so peers can ring it in their own layout; null shows just the
   * label.
   */
  uiPing(target: string | null, label: string): void {
    this.emitPing({ pingId: newId('png'), ticks: 0, trackIndex: null, label, uiTarget: target })
  }

  private emitPing(ping: NonNullable<PresenceData['ping']>): void {
    // Show own pings too — the sender needs the same feedback.
    this.pingList.push({ ...ping, userId: projectStore.userId, at: Date.now() })
    this.schedulePingSweep()
    this.emit()
    this.sendPresence({ ping })
  }

  /**
   * Broadcast a performance-pad hit (the collaborative-DJ channel). The
   * sender has ALREADY played it locally (zero-latency local echo, like
   * pings); peers reproduce the sound through their own engine.
   */
  sendPadHit(padId: string, action: 'down' | 'up', velocity: number): void {
    this.sendPresence({ padHit: { hitId: newId('hit'), padId, action, velocity } })
  }

  /**
   * The pad-performance store registers here (a callback, not the pull-
   * from-store model pings use — audio must fire exactly once, on arrival,
   * never per React render). Registered from padPerform to avoid an import
   * cycle.
   */
  private padHitListener:
    | ((userId: string, hit: NonNullable<PresenceData['padHit']>) => void)
    | null = null
  private seenPadHits = new Set<string>()

  setPadHitListener(
    listener: ((userId: string, hit: NonNullable<PresenceData['padHit']>) => void) | null
  ): void {
    this.padHitListener = listener
  }

  /**
   * Peers who have declined parameter values for plugins they own, from
   * collaborators who do not own them (Settings ▸ Collaboration). Only
   * peers that explicitly announce `false` land here; silence means
   * accepting, so older builds behave exactly as they always have.
   */
  private paramEditsDeclinedBy = new Set<string>()

  /**
   * Tell the session whether this machine accepts such values. Sent on
   * every roster change as well as on the setting itself, because
   * presence is transient: someone who joins later has not seen the
   * announcements that went out before they arrived.
   */
  announceParamPolicy(): void {
    if (this.mode === 'off') return
    this.sendPresence({ acceptsParamEdits: preferences.acceptCollaboratorParamEdits })
  }

  /**
   * May this client offer parameter controls for a plugin it cannot run?
   *
   * Alone, yes — there is no one else's plugin to drive, and the values
   * are ordinary document data. In a session, one participant declining
   * withdraws the controls: a knob whose owner has said no should not be
   * offered to someone who cannot run the plugin themselves. Anyone who
   * HAS the plugin is unaffected — they get the real insert controls and
   * never reach this path.
   */
  paramEditsPermitted(): boolean {
    if (this.mode === 'off') return true
    return this.paramEditsDeclinedBy.size === 0
  }

  private sendPresence(data: PresenceData): void {
    this.active?.sendPresence(data)
  }

  private applyRemotePresence(userId: string, data: PresenceData): void {
    if (data.cursor !== undefined) {
      if (data.cursor === null) this.cursors.delete(userId)
      else this.cursors.set(userId, { userId, ...data.cursor, lastSeen: Date.now() })
    }
    if (data.ping) {
      this.pingList.push({ ...data.ping, userId, at: Date.now() })
      this.schedulePingSweep()
    }
    if (data.padHit && !this.seenPadHits.has(data.padHit.hitId)) {
      if (this.seenPadHits.size > 1024) this.seenPadHits.clear()
      this.seenPadHits.add(data.padHit.hitId)
      this.padHitListener?.(userId, data.padHit)
    }
    if (data.acceptsParamEdits !== undefined) {
      if (data.acceptsParamEdits) this.paramEditsDeclinedBy.delete(userId)
      else this.paramEditsDeclinedBy.add(userId)
    }
    this.emit()
  }

  private pingSweepTimer: ReturnType<typeof setTimeout> | null = null
  private schedulePingSweep(): void {
    if (this.pingSweepTimer !== null) return
    this.pingSweepTimer = setTimeout(() => {
      this.pingSweepTimer = null
      const now = Date.now()
      this.pingList = this.pingList.filter((p) => now - p.at < PING_LIFETIME_MS)
      this.emit()
      if (this.pingList.length > 0) this.schedulePingSweep()
    }, 1000)
  }

  // ---------- assets ----------

  /** How many downloads run at once; the rest queue in arrival order. */
  private static readonly MAX_CONCURRENT_DOWNLOADS = 3
  /** No progress for this long = assume the transfer died; free its slot. */
  private static readonly DOWNLOAD_STALL_MS = 20_000

  private scheduleDownload(assetId: string): void {
    if (assetStore.get(assetId)) return
    if (this.activeDownloads.has(assetId) || this.downloadQueue.includes(assetId)) return
    if (this.activeDownloads.size < CollabStore.MAX_CONCURRENT_DOWNLOADS) {
      this.activeDownloads.add(assetId)
      this.lastProgressAt.set(assetId, Date.now())
      this.active?.requestAsset(assetId)
      this.ensureDownloadWatchdog()
    } else {
      this.downloadQueue.push(assetId)
    }
  }

  private downloadSettled(assetId: string): void {
    this.activeDownloads.delete(assetId)
    this.lastProgressAt.delete(assetId)
    while (
      this.activeDownloads.size < CollabStore.MAX_CONCURRENT_DOWNLOADS &&
      this.downloadQueue.length > 0
    ) {
      const next = this.downloadQueue.shift()!
      if (assetStore.get(next)) continue
      this.activeDownloads.add(next)
      this.lastProgressAt.set(next, Date.now())
      this.active?.requestAsset(next)
    }
    if (this.activeDownloads.size > 0) this.ensureDownloadWatchdog()
  }

  /**
   * A transfer that stops making progress must not pin its slot forever
   * (that would silently stall the whole queue). Freeing the slot is safe:
   * if the stalled transfer later revives, receiveAsset dedupes.
   */
  private ensureDownloadWatchdog(): void {
    if (this.downloadWatchdog !== null) return
    this.downloadWatchdog = setInterval(() => {
      const now = Date.now()
      for (const assetId of [...this.activeDownloads]) {
        const last = this.lastProgressAt.get(assetId) ?? 0
        if (now - last > CollabStore.DOWNLOAD_STALL_MS) this.downloadSettled(assetId)
      }
      if (this.activeDownloads.size === 0 && this.downloadWatchdog !== null) {
        clearInterval(this.downloadWatchdog)
        this.downloadWatchdog = null
      }
    }, 5000)
  }

  private clearDownloadState(): void {
    this.downloadQueue.length = 0
    this.activeDownloads.clear()
    this.lastProgressAt.clear()
    if (this.downloadWatchdog !== null) {
      clearInterval(this.downloadWatchdog)
      this.downloadWatchdog = null
    }
  }

  private requestMissingAssets(state: ProjectState): void {
    let queued = false
    for (const assetId of referencedAssetIds(state)) {
      if (assetStore.get(assetId)) continue
      if (preferences.autoDownloadAssets) {
        this.scheduleDownload(assetId)
        continue
      }
      this.pendingDownloads.set(assetId, {
        assetId,
        name: assetDisplayName(state, assetId),
        size: null
      })
      queued = true
    }
    if (queued) this.emit()
  }

  /** User said go for one queued file. */
  downloadPending(assetId: string): void {
    if (!this.pendingDownloads.delete(assetId)) return
    this.scheduleDownload(assetId)
    this.emit()
  }

  /**
   * Fetch one missing asset on demand (clip context menu), whether or not
   * it still sits in the pending queue — a dismissed prompt must not make
   * a clip permanently undownloadable.
   */
  requestAsset(assetId: string): void {
    if (assetStore.get(assetId)) return
    if (this.assetProgress.has(assetId)) return // already on its way
    this.pendingDownloads.delete(assetId)
    this.scheduleDownload(assetId)
    this.emit()
  }

  downloadAllPending(): void {
    for (const assetId of [...this.pendingDownloads.keys()]) {
      this.pendingDownloads.delete(assetId)
      this.scheduleDownload(assetId)
    }
    this.emit()
  }

  dismissPendingDownloads(): void {
    if (this.pendingDownloads.size === 0) return
    this.pendingDownloads.clear()
    this.emit()
  }

  /** A transfer finished (download, or a guest upload while hosting). */
  private async receiveAsset(meta: TransferMeta, bytes: Uint8Array): Promise<void> {
    // Arrived some other way (guest upload while hosting): no longer pending.
    this.pendingDownloads.delete(meta.assetId)
    if (assetStore.get(meta.assetId)) return
    let buffer: AudioBuffer | null = null
    if (meta.kind === 'audio') {
      try {
        buffer = await audioEngine.decode(bytes.slice().buffer)
      } catch (error) {
        console.error(`Could not decode received asset "${meta.name}"`, error)
      }
    }
    assetStore.restore(meta.assetId, meta.name, meta.kind, meta.ext, bytes, buffer)
  }

  /**
   * Auto-offer: any asset imported/recorded ON THIS MACHINE while in a
   * session is announced so collaborators get it in the background — the
   * user never thinks about it. Wired once at construction.
   */
  attachAssetOffers(): void {
    assetStore.subscribe((event) => {
      if (!event || event.origin !== 'local') return
      const meta = metaOf(event.asset)
      if (this.mode === 'hosting') this.active?.announceAsset(meta)
      else if (this.mode === 'joined') this.active?.offerAsset(meta)
    })
  }

  // ---------- misc ----------

  private rememberIdentities(users: SessionUser[]): void {
    for (const user of users) {
      this.identities.set(user.userId, { name: user.name, colorIndex: user.colorIndex })
    }
  }

  private fail(message: string): void {
    this.lastError = message
    this.emit()
  }
}

export const collab = new CollabStore()
collab.attachAssetOffers()

/** Re-render on any collab change; read fields directly off `collab`. */
export function useCollab(): CollabStore {
  useSyncExternalStore(collab.subscribe, collab.getVersion)
  return collab
}
