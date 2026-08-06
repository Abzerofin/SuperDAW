import { HostSession, type HostPeer } from '@core/session/host'
import { ClientSession } from '@core/session/client'
import type { ClientToHost, HostToClient, PresenceData } from '@core/session/protocol'
import type { TransferMeta } from '@core/session/transfer'
import { decodeJoinCode, encodeJoinCode } from '@core/session/joinCode'
import type { CollabNetworking, NetworkStatus, NetworkingDeps } from './networking'

const RECONNECT_DELAY_MS = 1500

/**
 * LAN sessions behind the same CollabNetworking interface as the relay:
 * the host's machine serves directly (WebSocket server in the Electron
 * main process, reached through the injected bridge), guests dial it
 * straight over the local network. No internet, no server, 15-char codes
 * encoding IP + port + token. Injection keeps this module free of
 * Electron imports — a browser build simply passes no bridge and can only
 * join, not host.
 */

export interface LanHostBridge {
  collabHostStart(): Promise<{ host: string; port: number; token: string } | { error: string }>
  collabHostStop(): Promise<void>
  collabSendToPeer(connId: number, data: string): void
  onCollabEvent(handlers: {
    connected(connId: number): void
    message(connId: number, data: string): void
    disconnected(connId: number): void
  }): () => void
}

export class LanNetworking implements CollabNetworking {
  status: NetworkStatus = 'off'
  role: 'host' | 'guest' | null = null

  private hostSession: HostSession | null = null
  private hostPeers = new Map<number, HostPeer>()
  private unsubPeerEvents: (() => void) | null = null

  private clientSession: ClientSession | null = null
  private ws: WebSocket | null = null
  private wsGeneration = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  private bridge: LanHostBridge | null
  private deps: NetworkingDeps

  constructor(bridge: LanHostBridge | null, deps: NetworkingDeps) {
    this.bridge = bridge
    this.deps = deps
  }

  // ---------- CollabNetworking ----------

  async createSession(): Promise<{ joinCode: string }> {
    const bridge = this.bridge
    if (!bridge) throw new Error('Hosting a LAN session requires the desktop app')
    this.teardown()

    const started = await bridge.collabHostStart()
    if ('error' in started) throw new Error(started.error)

    const session = new HostSession(this.deps.store, {
      hostName: this.deps.displayName(),
      assetProvider: this.deps.hostAssets,
      onRosterChange: (users) => this.deps.events.onRosterChange?.(users),
      onPresence: (userId, data) => this.deps.events.onPresence?.(userId, data)
    })
    this.hostSession = session
    this.role = 'host'

    this.unsubPeerEvents = bridge.onCollabEvent({
      connected: (connId) => {
        this.hostPeers.set(
          connId,
          session.addPeer({
            send: (m: HostToClient) => bridge.collabSendToPeer(connId, JSON.stringify(m))
          })
        )
      },
      message: (connId, data) => {
        const peer = this.hostPeers.get(connId)
        if (peer) session.handleMessage(peer, JSON.parse(data) as ClientToHost)
      },
      disconnected: (connId) => {
        const peer = this.hostPeers.get(connId)
        if (peer) {
          session.removePeer(peer)
          this.hostPeers.delete(connId)
        }
      }
    })

    this.setStatus('online')
    return { joinCode: encodeJoinCode(started) }
  }

  async joinSession(code: string): Promise<void> {
    const target = decodeJoinCode(code) // throws a readable error on bad codes
    this.teardown()
    this.role = 'guest'
    this.setStatus('connecting')

    this.clientSession = new ClientSession(
      this.deps.store,
      this.deps.displayName(),
      {
        onWelcome: (snapshot, users, you, firstJoin) => {
          if (this.status !== 'off') this.setStatus('online')
          this.deps.events.onWelcome?.(snapshot, users, you, firstJoin)
        },
        onRejected: (reason) => {
          this.deps.events.onError?.(reason)
          this.leaveSession()
        },
        onUserJoined: (user) => this.deps.events.onUserJoined?.(user),
        onUserLeft: (userId) => this.deps.events.onUserLeft?.(userId),
        onPresence: (userId, data) => this.deps.events.onPresence?.(userId, data),
        onAssetAvailable: (meta) => this.deps.events.onAssetAvailable?.(meta),
        onAssetProgress: (assetId, received, total) =>
          this.deps.events.onAssetProgress?.(assetId, received, total),
        onAssetComplete: (meta, bytes) => this.deps.events.onAssetComplete?.(meta, bytes)
      },
      this.deps.clientAssets
    )

    this.connectWebSocket(target)
  }

  leaveSession(): void {
    this.teardown()
    this.setStatus('off')
  }

  sendPresence(data: PresenceData): void {
    if (this.role === 'host') this.hostSession?.sendHostPresence(data)
    else this.clientSession?.sendPresence(data)
  }

  requestAsset(assetId: string): void {
    this.clientSession?.requestAsset(assetId)
  }

  offerAsset(meta: TransferMeta): void {
    this.clientSession?.offerAsset(meta)
  }

  announceAsset(meta: TransferMeta): void {
    this.hostSession?.announceAsset(meta)
  }

  // ---------- transport ----------

  private connectWebSocket(target: { host: string; port: number; token: string }): void {
    const generation = ++this.wsGeneration
    const ws = new WebSocket(`ws://${target.host}:${target.port}/${target.token}`)
    this.ws = ws

    ws.onopen = () => {
      if (generation !== this.wsGeneration) return
      this.clientSession?.connect({
        send: (m: ClientToHost) => ws.send(JSON.stringify(m))
      })
    }
    ws.onmessage = (event) => {
      if (generation !== this.wsGeneration) return
      this.clientSession?.handleMessage(JSON.parse(String(event.data)) as HostToClient)
    }
    ws.onclose = () => {
      if (generation !== this.wsGeneration || this.role !== 'guest') return
      this.clientSession?.handleDisconnect()
      this.setStatus('reconnecting')
      // Keep working locally; retry quietly until the host is back.
      this.reconnectTimer = setTimeout(() => this.connectWebSocket(target), RECONNECT_DELAY_MS)
    }
    ws.onerror = () => ws.close()
  }

  private teardown(): void {
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
    if (this.role === 'host') void this.bridge?.collabHostStop()
    this.role = null
  }

  private setStatus(status: NetworkStatus): void {
    if (this.status === status) return
    this.status = status
    this.deps.events.onStatusChange?.(status)
  }
}
