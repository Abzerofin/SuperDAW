import type { ProjectStore } from '../state/store'
import type { OpEnvelope } from '../ops/operations'
import { newId } from '../model/ids'
import {
  PROTOCOL_VERSION,
  type ClientToHost,
  type HostToClient,
  type MessageSink,
  type PresenceData,
  type SessionUser
} from './protocol'
import {
  IncomingTransfer,
  OutgoingTransfer,
  type AssetTransferMessage,
  type TransferMeta
} from './transfer'

/**
 * The authoritative sequencer. Runs on the hosting peer, next to its
 * ProjectStore (which stays in plain solo/host mode — the host has no
 * pending set; its edits are sequenced the moment they commit).
 *
 * Transport-agnostic: peers are just MessageSinks handed to `addPeer`,
 * and the transport calls `handleMessage`/`removePeer`.
 *
 * The host is also the session's ASSET HUB: guests offer their imports,
 * the host pulls what it lacks, then announces availability so other
 * guests can download from it. One authority for state, one hub for
 * bytes. Assets are stored/served via a pluggable provider so core stays
 * free of audio/file concerns.
 */

export interface HostAssetProvider {
  has(assetId: string): boolean
  get(assetId: string): { meta: TransferMeta; bytes: Uint8Array } | null
  /** A guest upload completed; decode/register happens app-side. */
  store(meta: TransferMeta, bytes: Uint8Array): void
}

export interface HostPeer {
  readonly sink: MessageSink<HostToClient>
  user: SessionUser | null
  /** Live transfers with THIS peer, keyed by transferId. */
  readonly outgoing: Map<string, OutgoingTransfer>
  readonly incoming: Map<string, IncomingTransfer>
  /** asset-pulls issued to this peer awaiting its asset-begin. */
  readonly expectedUploads: Map<string, string>
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
    const peer: HostPeer = {
      sink,
      user: null,
      outgoing: new Map(),
      incoming: new Map(),
      expectedUploads: new Map()
    }
    this.peers.add(peer)
    return peer
  }

  removePeer(peer: HostPeer): void {
    if (!this.peers.delete(peer)) return
    for (const transfer of peer.outgoing.values()) transfer.abort()
    for (const transfer of peer.incoming.values()) transfer.abort()
    peer.outgoing.clear()
    peer.incoming.clear()
    peer.expectedUploads.clear()
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
        if (!peer.user) return
        const asset = this.options.assetProvider?.get(message.assetId)
        if (!asset) return
        const transfer = new OutgoingTransfer(
          newId('xfr'),
          asset.meta,
          asset.bytes,
          message.haveBytes,
          (m) => peer.sink.send(m),
          () => peer.outgoing.delete(transfer.transferId)
        )
        peer.outgoing.set(transfer.transferId, transfer)
        transfer.start()
        return
      }

      case 'asset-offer': {
        if (!peer.user || !this.options.assetProvider) return
        if (this.options.assetProvider.has(message.meta.assetId)) {
          // Already have it (idempotent re-offer) — just make sure the
          // rest of the session knows it exists.
          this.broadcast({ t: 'asset-available', meta: message.meta }, peer)
          return
        }
        const transferId = newId('xfr')
        peer.expectedUploads.set(transferId, message.meta.assetId)
        peer.sink.send({ t: 'asset-pull', assetId: message.meta.assetId, transferId })
        return
      }

      case 'asset-begin':
      case 'asset-chunk':
      case 'asset-done':
      case 'asset-credit':
      case 'asset-cancel':
        if (peer.user) this.handleTransferMessage(peer, message)
        return
    }
  }

  /** Routes chunk-level traffic to the transfer it belongs to. */
  private handleTransferMessage(peer: HostPeer, message: AssetTransferMessage): void {
    switch (message.t) {
      case 'asset-begin': {
        // Only transfers the host explicitly pulled are accepted.
        const expectedAssetId = peer.expectedUploads.get(message.transferId)
        if (expectedAssetId === undefined || message.meta.assetId !== expectedAssetId) return
        peer.expectedUploads.delete(message.transferId)
        const provider = this.options.assetProvider
        if (!provider) return
        const transfer = new IncomingTransfer(
          message.transferId,
          message.meta,
          message.chunkCount,
          message.startIndex,
          null,
          (m) => peer.sink.send(m),
          {
            onComplete: (bytes) => {
              peer.incoming.delete(message.transferId)
              provider.store(message.meta, bytes)
              // The uploader has it by definition; everyone else fetches.
              this.broadcast({ t: 'asset-available', meta: message.meta }, peer)
            },
            onError: () => peer.incoming.delete(message.transferId)
          }
        )
        peer.incoming.set(message.transferId, transfer)
        return
      }
      case 'asset-chunk':
        peer.incoming.get(message.transferId)?.onChunk(message.index, message.bytesBase64)
        return
      case 'asset-done': {
        const transfer = peer.incoming.get(message.transferId)
        peer.incoming.delete(message.transferId)
        transfer?.onDone()
        return
      }
      case 'asset-credit':
        peer.outgoing.get(message.transferId)?.onCredit(message.upToIndex)
        return
      case 'asset-cancel': {
        peer.outgoing.get(message.transferId)?.abort()
        peer.outgoing.delete(message.transferId)
        peer.incoming.get(message.transferId)?.abort()
        peer.incoming.delete(message.transferId)
        return
      }
    }
  }

  /** The host imported an asset locally — tell guests it exists. */
  announceAsset(meta: TransferMeta): void {
    this.broadcast({ t: 'asset-available', meta })
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
