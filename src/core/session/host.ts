import type { ProjectStore } from '../state/store'
import type { OpEnvelope } from '../ops/operations'
import { newId } from '../model/ids'
import {
  PROTOCOL_VERSION,
  SESSION_COLOR_COUNT,
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
  /**
   * A guest upload completed; decode/register happens app-side. May be
   * async — the host waits for it to settle before announcing the asset,
   * so `has`/`get` never lag behind an `asset-available` it has sent.
   */
  store(meta: TransferMeta, bytes: Uint8Array): void | Promise<void>
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

  /** The live connection a person is on, if any. Identity is by userId. */
  private peerFor(userId: string): HostPeer | null {
    for (const peer of this.peers) if (peer.user?.userId === userId) return peer
    return null
  }

  private releaseTransfers(peer: HostPeer): void {
    for (const transfer of peer.outgoing.values()) transfer.abort()
    for (const transfer of peer.incoming.values()) transfer.abort()
    peer.outgoing.clear()
    peer.incoming.clear()
    peer.expectedUploads.clear()
  }

  /**
   * Lowest free palette slot, skipping 0 (the host's). Recycled on purpose:
   * a monotonic counter walks off the end of the palette after eight
   * (re)joins and wraps a guest onto the host's own colour, so two people
   * end up wearing one identity. Past a full palette, reuse is unavoidable.
   */
  private allocateColorIndex(): number {
    const taken = new Set<number>([0])
    for (const peer of this.peers) if (peer.user) taken.add(peer.user.colorIndex)
    for (let i = 1; i < SESSION_COLOR_COUNT; i++) if (!taken.has(i)) return i
    return 1 + (this.peers.size % (SESSION_COLOR_COUNT - 1))
  }

  removePeer(peer: HostPeer): void {
    if (!this.peers.delete(peer)) return
    this.releaseTransfers(peer)
    const user = peer.user
    peer.user = null
    if (!user) return
    // A reconnect may already have re-seated this person on a newer
    // connection. The dying socket must not then evict them from everyone
    // else's roster — that is how a live collaborator's name disappears
    // (or worse, gets re-used) while they are still editing.
    if (this.peerFor(user.userId)) return
    this.broadcast({ t: 'user-left', userId: user.userId })
    this.options.onRosterChange?.(this.users)
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
        // Identity is keyed by userId, never by connection. A guest that
        // reconnects (dropped socket, VPN hiccup) arrives on a brand-new
        // HostPeer, so without this the session holds two entries for one
        // person: the newcomer takes a fresh colour, and the late user-left
        // from the dead socket erases the LIVE entry. That is what "names
        // get mixed up" looks like, and it only becomes visible with a
        // third peer to receive the broadcasts.
        const stale = this.peerFor(message.userId)
        if (stale && stale !== peer) {
          this.releaseTransfers(stale)
          this.peers.delete(stale)
          stale.user = null
        }
        const user: SessionUser = {
          userId: message.userId,
          name: message.name,
          // Keep the colour they already had, so a reconnect doesn't
          // repaint them mid-session (and doesn't burn a palette slot).
          colorIndex: (peer.user ?? stale?.user)?.colorIndex ?? this.allocateColorIndex()
        }
        peer.user = user
        peer.sink.send({
          t: 'welcome',
          seq: this.seq,
          snapshot: this.store.state,
          users: this.users,
          you: user,
          projectId: this.store.lineage.projectId
        })
        // Sent for rejoins too: the client upserts by userId, so this is
        // how the rest of the session repairs a roster after a reconnect
        // and picks up a display name changed since the last hello.
        this.broadcast({ t: 'user-joined', user }, peer)
        this.options.onRosterChange?.(this.users)
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
        // One live transfer per asset per peer. A client re-runs
        // requestMissingAssets on every welcome (including reconnect
        // resyncs) and also requests on asset-available, so the same file
        // gets asked for twice; serving it twice doubles the bytes on the
        // wire and crowds out op traffic for everyone.
        for (const live of peer.outgoing.values()) {
          if (live.meta.assetId === message.assetId) return
        }
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
              // The uploader has it by definition; everyone else fetches.
              // Announce only once the provider can actually SERVE it —
              // storing is async app-side (decode), and a guest that
              // requests too early gets a silently dropped asset-request
              // and spins forever.
              const announce = (): void =>
                this.broadcast({ t: 'asset-available', meta: message.meta }, peer)
              const stored = provider.store(message.meta, bytes)
              if (stored instanceof Promise) void stored.then(announce)
              else announce()
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
