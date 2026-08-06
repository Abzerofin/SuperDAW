import { RELAY_PROTOCOL_VERSION, type GuestId, type RelayToClient } from '@core/relay/protocol'
import { formatCode, normalizeCode } from '@core/relay/codes'
import { HostSession, type HostPeer } from '@core/session/host'
import { ClientSession } from '@core/session/client'
import type { ClientToHost, HostToClient, PresenceData } from '@core/session/protocol'
import type { TransferMeta } from '@core/session/transfer'
import type { CollabNetworking, NetworkStatus, NetworkingDeps } from './networking'
import type { RelayConnector, RelayLink } from './relayTransport'

const ATTACH_TIMEOUT_MS = 10_000

/**
 * Internet collaboration over the relay (docs/NETWORKING.md). Every peer
 * — host included — dials the relay; this class adapts relay frames to
 * the UNCHANGED session cores:
 *
 *   host:  guest-up/guest-msg/guest-down  ⇄  HostSession peers
 *   guest: host-msg                       ⇄  ClientSession
 *
 * Reconnects resume the relay seat with a resume token, then let the
 * inner protocol do what it already does: re-hello, snapshot resync,
 * idempotent pending replay. Ops are never buffered here — the store's
 * pending set is the one buffering mechanism.
 */
export class RelayNetworking implements CollabNetworking {
  status: NetworkStatus = 'off'
  role: 'host' | 'guest' | null = null

  private link: RelayLink | null = null
  private hostSession: HostSession | null = null
  private hostPeers = new Map<GuestId, HostPeer>()
  private clientSession: ClientSession | null = null
  private resumeToken: string | null = null
  private code: string | null = null
  private attachWaiter: { resolve: (m: RelayToClient) => void; reject: (e: Error) => void } | null =
    null

  private connector: RelayConnector
  private deps: NetworkingDeps

  constructor(connector: RelayConnector, deps: NetworkingDeps) {
    this.connector = connector
    this.deps = deps
  }

  // ---------- CollabNetworking ----------

  async createSession(): Promise<{ joinCode: string }> {
    this.teardown()
    this.role = 'host'
    this.setStatus('connecting')

    this.hostSession = new HostSession(this.deps.store, {
      hostName: this.deps.displayName(),
      assetProvider: this.deps.hostAssets,
      onRosterChange: (users) => this.deps.events.onRosterChange?.(users),
      onPresence: (userId, data) => this.deps.events.onPresence?.(userId, data)
    })

    this.openLink()
    const reply = await this.awaitAttach()
    if (reply.t !== 'created') throw this.attachFailure(reply)
    this.code = reply.code
    this.resumeToken = reply.resumeToken
    this.setStatus('online')
    return { joinCode: formatCode(reply.code) }
  }

  async joinSession(code: string): Promise<void> {
    this.teardown()
    this.role = 'guest'
    this.code = normalizeCode(code)
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

    this.openLink()
    const reply = await this.awaitAttach()
    if (reply.t !== 'attached') throw this.attachFailure(reply)
    this.resumeToken = reply.resumeToken
    this.connectInnerClient()
    this.setStatus('online')
  }

  leaveSession(): void {
    this.link?.send({ t: 'leave' })
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

  // ---------- link lifecycle ----------

  private openLink(): void {
    this.link = this.connector({
      onOpen: (first) => this.handleLinkOpen(first),
      onMessage: (message) => this.handleRelayMessage(message),
      onDown: () => this.handleLinkDown()
    })
  }

  private handleLinkOpen(first: boolean): void {
    if (this.role === 'host') {
      this.link?.send(
        first || !this.resumeToken
          ? { t: 'create', v: RELAY_PROTOCOL_VERSION }
          : { t: 'create', v: RELAY_PROTOCOL_VERSION, resumeToken: this.resumeToken }
      )
    } else if (this.role === 'guest' && this.code) {
      this.link?.send(
        first || !this.resumeToken
          ? { t: 'join', v: RELAY_PROTOCOL_VERSION, code: this.code }
          : { t: 'join', v: RELAY_PROTOCOL_VERSION, code: this.code, resumeToken: this.resumeToken }
      )
    }
  }

  private handleLinkDown(): void {
    if (this.status === 'off') return
    // Editing continues locally; pending accumulates in the store.
    this.clientSession?.handleDisconnect()
    this.setStatus('reconnecting')
  }

  private handleRelayMessage(message: RelayToClient): void {
    switch (message.t) {
      case 'created':
      case 'attached':
        this.attachWaiter?.resolve(message)
        return

      case 'resumed':
        if (this.role === 'guest') {
          // Same seat back; re-hello for a snapshot resync + pending replay.
          this.connectInnerClient()
        }
        this.setStatus('online')
        return

      // ---- host side ----
      case 'guest-up': {
        const session = this.hostSession
        const link = this.link
        if (!session || !link) return
        if (!this.hostPeers.has(message.guestId)) {
          this.hostPeers.set(
            message.guestId,
            session.addPeer({
              send: (m: HostToClient) => link.send({ t: 'msg', to: message.guestId, payload: m })
            })
          )
        }
        return
      }
      case 'guest-msg': {
        const peer = this.hostPeers.get(message.guestId)
        if (peer) this.hostSession?.handleMessage(peer, message.payload as ClientToHost)
        return
      }
      case 'guest-down': {
        const peer = this.hostPeers.get(message.guestId)
        if (peer) {
          this.hostSession?.removePeer(peer)
          this.hostPeers.delete(message.guestId)
        }
        return
      }

      // ---- guest side ----
      case 'host-msg':
        this.clientSession?.handleMessage(message.payload as HostToClient)
        return
      case 'host-away':
        this.clientSession?.handleDisconnect()
        this.setStatus('host-away')
        return
      case 'host-back':
        this.connectInnerClient()
        this.setStatus('online')
        return

      case 'closed': {
        const reason =
          message.reason === 'host-left'
            ? 'The host ended the session'
            : message.reason === 'server-shutdown'
              ? 'The collaboration server restarted'
              : 'The session expired'
        this.teardown()
        this.setStatus('off')
        this.deps.events.onSessionEnded?.(reason)
        return
      }

      case 'error': {
        const failure = new Error(message.message)
        if (this.attachWaiter) {
          this.attachWaiter.reject(failure)
          return
        }
        if (message.code === 'bad-resume') {
          // Our session died while we were away. Local copy is intact.
          this.teardown()
          this.setStatus('off')
          this.deps.events.onSessionEnded?.('The session expired while offline')
          return
        }
        this.deps.events.onError?.(message.message)
        return
      }

      case 'hb':
        return
    }
  }

  // ---------- helpers ----------

  /** (Re)attach the inner client session to the link — sends hello. */
  private connectInnerClient(): void {
    const link = this.link
    if (!link || !this.clientSession) return
    this.clientSession.connect({
      send: (m: ClientToHost) => link.send({ t: 'msg', payload: m })
    })
  }

  private awaitAttach(): Promise<RelayToClient> {
    return new Promise<RelayToClient>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.attachWaiter = null
        this.teardown()
        this.setStatus('off')
        reject(new Error('Could not reach the collaboration server'))
      }, ATTACH_TIMEOUT_MS)
      this.attachWaiter = {
        resolve: (m) => {
          clearTimeout(timer)
          this.attachWaiter = null
          resolve(m)
        },
        reject: (e) => {
          clearTimeout(timer)
          this.attachWaiter = null
          this.teardown()
          this.setStatus('off')
          reject(e)
        }
      }
    })
  }

  private attachFailure(message: RelayToClient): Error {
    return new Error(`Unexpected relay reply: ${message.t}`)
  }

  private teardown(): void {
    this.link?.close()
    this.link = null
    this.hostSession?.close()
    this.hostSession = null
    this.hostPeers.clear()
    this.clientSession?.leave()
    this.clientSession = null
    this.resumeToken = null
    this.code = null
    this.role = null
  }

  private setStatus(status: NetworkStatus): void {
    if (this.status === status) return
    this.status = status
    this.deps.events.onStatusChange?.(status)
  }
}
