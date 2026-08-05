import type { ProjectStore } from '../state/store'
import type { OpEnvelope } from '../ops/operations'
import {
  PROTOCOL_VERSION,
  type ClientToHost,
  type HostToClient,
  type MessageSink,
  type PresenceData,
  type SessionUser
} from './protocol'

/**
 * The authoritative sequencer. Runs on the hosting peer, next to its
 * ProjectStore (which stays in plain solo/host mode — the host has no
 * pending set; its edits are sequenced the moment they commit).
 *
 * Transport-agnostic: peers are just MessageSinks handed to `addPeer`,
 * and the transport calls `handleMessage`/`removePeer`. Assets are served
 * via a pluggable provider so core stays free of audio/file concerns.
 */

export interface HostAssetProvider {
  getAssetForTransfer(
    assetId: string
  ): { name: string; kind: 'audio' | 'midi'; ext: string; bytesBase64: string } | null
}

export interface HostPeer {
  readonly sink: MessageSink<HostToClient>
  user: SessionUser | null
}

export interface HostSessionOptions {
  hostName: string
  assetProvider?: HostAssetProvider
  onRosterChange?: (users: SessionUser[]) => void
  /** Client presence surfaced to the HOST's own UI (relay to others is automatic). */
  onPresence?: (userId: string, data: PresenceData) => void
}

export class HostSession {
  private seq = 0
  private peers = new Set<HostPeer>()
  private nextColorIndex = 1 // 0 is the host's
  private detachStore: () => void

  readonly hostUser: SessionUser

  constructor(
    private store: ProjectStore,
    private options: HostSessionOptions
  ) {
    this.hostUser = { userId: store.userId, name: options.hostName, colorIndex: 0 }
    // Every op committed on the host's store — its own edits AND client
    // ops it applied — is sequenced and broadcast in commit order.
    this.detachStore = store.onOperation((envelope) => this.broadcastOp(envelope))
  }

  get users(): SessionUser[] {
    const users = [this.hostUser]
    for (const peer of this.peers) if (peer.user) users.push(peer.user)
    return users
  }

  get currentSeq(): number {
    return this.seq
  }

  addPeer(sink: MessageSink<HostToClient>): HostPeer {
    const peer: HostPeer = { sink, user: null }
    this.peers.add(peer)
    return peer
  }

  removePeer(peer: HostPeer): void {
    if (!this.peers.delete(peer)) return
    if (peer.user) {
      this.broadcast({ t: 'user-left', userId: peer.user.userId })
      this.options.onRosterChange?.(this.users)
    }
  }

  /** Stop hosting: the project simply becomes a local project again. */
  close(): void {
    this.detachStore()
    this.peers.clear()
  }

  handleMessage(peer: HostPeer, message: ClientToHost): void {
    switch (message.t) {
      case 'hello': {
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          peer.sink.send({
            t: 'reject',
            reason: `Version mismatch: session is v${PROTOCOL_VERSION}, you are v${message.protocolVersion}`
          })
          return
        }
        const rejoining = peer.user !== null
        const user: SessionUser = peer.user ?? {
          userId: message.userId,
          name: message.name,
          colorIndex: this.nextColorIndex++
        }
        peer.user = user
        peer.sink.send({
          t: 'welcome',
          seq: this.seq,
          snapshot: this.store.state,
          users: this.users,
          you: user
        })
        if (!rejoining) {
          this.broadcast({ t: 'user-joined', user }, peer)
          this.options.onRosterChange?.(this.users)
        }
        return
      }

      case 'op': {
        if (!peer.user) return // ops before hello are dropped
        // Sequencing = applying to the host store; the onOperation tap
        // broadcasts it in commit order. If the op no-ops (target vanished,
        // idempotent re-send after reconnect) nothing is sequenced — but the
        // origin still gets a targeted ack so its pending set drains.
        const applied = this.store.dispatch(
          message.envelope.op,
          'remote',
          peer.user.userId,
          message.envelope.id
        )
        if (!applied) peer.sink.send({ t: 'op-noop', envelopeId: message.envelope.id })
        return
      }

      case 'presence': {
        if (!peer.user) return
        this.broadcast({ t: 'presence', userId: peer.user.userId, data: message.data }, peer)
        this.options.onPresence?.(peer.user.userId, message.data)
        return
      }

      case 'asset-request': {
        if (!peer.user || !this.options.assetProvider) return
        const asset = this.options.assetProvider.getAssetForTransfer(message.assetId)
        if (asset) peer.sink.send({ t: 'asset-data', assetId: message.assetId, ...asset })
        return
      }
    }
  }

  /** Host-side presence fan-out (the host's own cursor/pings). */
  sendHostPresence(data: PresenceData): void {
    this.broadcast({ t: 'presence', userId: this.hostUser.userId, data })
  }

  private broadcastOp(envelope: OpEnvelope): void {
    this.seq += 1
    this.broadcast({ t: 'op', seq: this.seq, envelope })
  }

  private broadcast(message: HostToClient, except?: HostPeer): void {
    for (const peer of this.peers) {
      if (peer === except || peer.user === null) continue
      peer.sink.send(message)
    }
  }
}
