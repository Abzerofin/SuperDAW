import { useSyncExternalStore } from 'react'
import type { ProjectState } from '@core/model/types'
import { newId } from '@core/model/ids'
import { referencedAssetIds } from '@core/persistence/format'
import { HostSession, type HostPeer } from '@core/session/host'
import { ClientSession } from '@core/session/client'
import type { PresenceData, SessionUser } from '@core/session/protocol'
import type { TransferMeta } from '@core/session/transfer'
import { decodeJoinCode, encodeJoinCode } from '@core/session/joinCode'
import type { ProjectAsset } from '@audio/assets'
import { projectStore } from './projectStore'
import { assetStore, audioEngine } from './audioInstance'

function metaOf(asset: ProjectAsset): TransferMeta {
  return {
    assetId: asset.id,
    name: asset.name,
    kind: asset.kind,
    ext: asset.ext,
    size: asset.encoded.length
  }
}

/**
 * Session orchestration for the renderer: hosting (via the main-process
 * WebSocket relay), joining (a plain renderer WebSocket), reconnection,
 * asset transfer, and the ephemeral presence state (cursors, pings,
 * roster). Networking stays invisible: the UI reads this store; nothing
 * here ever blocks editing.
 */

export type CollabMode = 'off' | 'hosting' | 'joined'

export const USER_COLORS = [
  '#5b8def',
  '#e8875b',
  '#6fbf73',
  '#c678dd',
  '#56b6c2',
  '#e06c75',
  '#d19a66',
  '#98c379'
] as const

export interface RemoteCursor {
  readonly userId: string
  readonly ticks: number
  readonly trackIndex: number
  readonly lastSeen: number
}

export interface ActivePing {
  readonly pingId: string
  readonly userId: string
  readonly ticks: number
  readonly trackIndex: number | null
  readonly label: string
  readonly at: number
}

const PING_LIFETIME_MS = 4000
const CURSOR_STALE_MS = 6000
const RECONNECT_DELAY_MS = 1500

class CollabStore {
  mode: CollabMode = 'off'
  joinCode: string | null = null
  users: SessionUser[] = []
  /** joined-mode connection health; hosting is always 'connected'. */
  reconnecting = false
  lastError: string | null = null
  displayName: string =
    (typeof localStorage !== 'undefined' && localStorage.getItem('superdaw.displayName')) || 'Anon'

  private cursors = new Map<string, RemoteCursor>()
  private pingList: ActivePing[] = []
  /** Names/colors survive departures so the activity feed stays readable. */
  private identities = new Map<string, { name: string; colorIndex: number }>()
  /** Live downloads: assetId → progress (drives placeholder fills). */
  readonly assetProgress = new Map<string, { received: number; total: number }>()

  private hostSession: HostSession | null = null
  private hostPeers = new Map<number, HostPeer>()
  private unsubPeerEvents: (() => void) | null = null

  private clientSession: ClientSession | null = null
  private ws: WebSocket | null = null
  private wsGeneration = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

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

  // ---------- identity helpers ----------

  setDisplayName(name: string): void {
    this.displayName = name.trim() || 'Anon'
    localStorage.setItem('superdaw.displayName', this.displayName)
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

  // ---------- hosting ----------

  async startHosting(): Promise<void> {
    const bridge = window.superdaw
    if (!bridge) {
      this.fail('Hosting a session requires the desktop app')
      return
    }
    if (this.mode !== 'off') this.stopAll()

    const started = await bridge.collabHostStart()
    if ('error' in started) {
      this.fail(started.error)
      return
    }

    const session = new HostSession(projectStore, {
      hostName: this.displayName,
      assetProvider: {
        has: (assetId) => assetStore.get(assetId) !== undefined,
        get: (assetId) => {
          const asset = assetStore.get(assetId)
          if (!asset) return null
          return { meta: metaOf(asset), bytes: asset.encoded }
        },
        store: (meta, bytes) => {
          void this.receiveAsset(meta, bytes)
        }
      },
      onRosterChange: (users) => {
        this.users = users
        this.rememberIdentities(users)
        this.emit()
      },
      onPresence: (userId, data) => this.applyRemotePresence(userId, data)
    })
    this.hostSession = session
    this.users = session.users
    this.rememberIdentities(this.users)

    this.unsubPeerEvents = bridge.onCollabEvent({
      connected: (connId) => {
        this.hostPeers.set(
          connId,
          session.addPeer({ send: (m) => bridge.collabSendToPeer(connId, JSON.stringify(m)) })
        )
      },
      message: (connId, data) => {
        const peer = this.hostPeers.get(connId)
        if (peer) session.handleMessage(peer, JSON.parse(data))
      },
      disconnected: (connId) => {
        const peer = this.hostPeers.get(connId)
        if (peer) {
          session.removePeer(peer)
          this.hostPeers.delete(connId)
        }
      }
    })

    this.joinCode = encodeJoinCode(started)
    this.mode = 'hosting'
    this.lastError = null
    this.emit()
  }

  // ---------- joining ----------

  join(code: string): void {
    let target
    try {
      target = decodeJoinCode(code)
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
      return
    }
    if (this.mode !== 'off') this.stopAll()

    this.clientSession = new ClientSession(
      projectStore,
      this.displayName,
      {
        onWelcome: (snapshot, users, _you, _firstJoin) => {
          this.users = users
          this.rememberIdentities(users)
          this.reconnecting = false
          this.requestMissingAssets(snapshot)
          this.emit()
        },
        onRejected: (reason) => {
          this.fail(reason)
          this.leave()
        },
        onUserJoined: (user) => {
          this.users = [...this.users.filter((u) => u.userId !== user.userId), user]
          this.rememberIdentities([user])
          this.emit()
        },
        onUserLeft: (userId) => {
          this.users = this.users.filter((u) => u.userId !== userId)
          this.cursors.delete(userId)
          this.emit()
        },
        onPresence: (userId, data) => this.applyRemotePresence(userId, data),
        onAssetAvailable: (meta) => {
          if (!assetStore.get(meta.assetId)) this.clientSession?.requestAsset(meta.assetId)
        },
        onAssetProgress: (assetId, received, total) => {
          this.assetProgress.set(assetId, { received, total })
          this.emit()
        },
        onAssetComplete: (meta, bytes) => {
          this.assetProgress.delete(meta.assetId)
          void this.receiveAsset(meta, bytes)
        }
      },
      {
        // Uploads (host pulls an asset we offered) read from the asset store.
        get: (assetId) => {
          const asset = assetStore.get(assetId)
          if (!asset) return null
          return { meta: metaOf(asset), bytes: asset.encoded }
        }
      }
    )

    this.mode = 'joined'
    this.reconnecting = true
    this.lastError = null
    this.connectWebSocket(target)
    this.emit()
  }

  private connectWebSocket(target: { host: string; port: number; token: string }): void {
    const generation = ++this.wsGeneration
    const ws = new WebSocket(`ws://${target.host}:${target.port}/${target.token}`)
    this.ws = ws

    ws.onopen = () => {
      if (generation !== this.wsGeneration) return
      this.clientSession?.connect({ send: (m) => ws.send(JSON.stringify(m)) })
    }
    ws.onmessage = (event) => {
      if (generation !== this.wsGeneration) return
      this.clientSession?.handleMessage(JSON.parse(String(event.data)))
    }
    ws.onclose = () => {
      if (generation !== this.wsGeneration || this.mode !== 'joined') return
      this.clientSession?.handleDisconnect()
      this.reconnecting = true
      this.emit()
      // Keep working locally; retry quietly until the host is back.
      this.reconnectTimer = setTimeout(() => this.connectWebSocket(target), RECONNECT_DELAY_MS)
    }
    ws.onerror = () => ws.close()
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
    this.wsGeneration++
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.ws?.close()
    this.ws = null
    this.clientSession?.leave()
    this.clientSession = null
    this.hostSession?.close()
    this.hostSession = null
    this.hostPeers.clear()
    this.unsubPeerEvents?.()
    this.unsubPeerEvents = null
    void window.superdaw?.collabHostStop()
    this.mode = 'off'
    this.joinCode = null
    this.users = []
    this.cursors.clear()
    this.reconnecting = false
  }

  // ---------- presence ----------

  /** Throttled by the caller (timeline pointer handler). */
  sendCursor(cursor: { ticks: number; trackIndex: number } | null): void {
    this.sendPresence({ cursor })
  }

  ping(ticks: number, trackIndex: number | null, label: string): void {
    const ping = { pingId: newId('png'), ticks, trackIndex, label }
    // Show own pings too — the sender needs the same feedback.
    this.pingList.push({ ...ping, userId: projectStore.userId, at: Date.now() })
    this.schedulePingSweep()
    this.emit()
    this.sendPresence({ ping })
  }

  private sendPresence(data: PresenceData): void {
    if (this.mode === 'hosting') this.hostSession?.sendHostPresence(data)
    else if (this.mode === 'joined') this.clientSession?.sendPresence(data)
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

  private requestMissingAssets(state: ProjectState): void {
    for (const assetId of referencedAssetIds(state)) {
      if (!assetStore.get(assetId)) this.clientSession?.requestAsset(assetId)
    }
  }

  /** A transfer finished (download, or a guest upload while hosting). */
  private async receiveAsset(meta: TransferMeta, bytes: Uint8Array): Promise<void> {
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
      if (this.mode === 'hosting') this.hostSession?.announceAsset(meta)
      else if (this.mode === 'joined') this.clientSession?.offerAsset(meta)
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
