import type { ProjectState } from '../model/types'
import type { OpEnvelope } from '../ops/operations'
import type { ProjectStore, SequencerLink } from '../state/store'
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
 * Client side of a session: the bridge between a transport and the store's
 * optimistic pipeline. Transport-agnostic — the transport hands it a sink
 * and forwards incoming messages; reconnects just call `connect` again.
 *
 * Offline behavior falls out of the store model: with no sink, local ops
 * simply accumulate in `pending`; every `welcome` re-sends the whole
 * pending backlog (safe: ops are idempotent, and no-op re-sends are acked
 * via `op-noop`).
 *
 * Assets move as chunked transfers (transfer.ts): downloads from the host
 * (with resume — interrupted partials survive a disconnect and continue
 * from where they stopped), and uploads to the host when it pulls an
 * asset this client offered.
 */

/** Where uploads read bytes from — app-side, so core stays audio-free. */
export interface ClientAssetSource {
  get(assetId: string): { meta: TransferMeta; bytes: Uint8Array } | null
}

export interface ClientSessionEvents {
  /** After every welcome. `firstJoin` distinguishes join from resync. */
  onWelcome?(snapshot: ProjectState, users: SessionUser[], you: SessionUser, firstJoin: boolean): void
  onRejected?(reason: string): void
  onUserJoined?(user: SessionUser): void
  onUserLeft?(userId: string): void
  onPresence?(userId: string, data: PresenceData): void
  /** A new asset exists in the session; request it if it's missing locally. */
  onAssetAvailable?(meta: TransferMeta): void
  onAssetProgress?(assetId: string, receivedBytes: number, totalBytes: number): void
  onAssetComplete?(meta: TransferMeta, bytes: Uint8Array): void
}

export class ClientSession implements SequencerLink {
  private sink: MessageSink<ClientToHost> | null = null
  private joined = false
  private lastSeq: number | null = null

  private incoming = new Map<string, IncomingTransfer>()
  private outgoing = new Map<string, OutgoingTransfer>()
  /** Partial downloads that survived a disconnect, keyed by assetId. */
  private partials = new Map<string, Uint8Array>()

  constructor(
    private store: ProjectStore,
    private name: string,
    private events: ClientSessionEvents = {},
    private assets: ClientAssetSource | null = null
  ) {}

  get isConnected(): boolean {
    return this.sink !== null
  }

  /** Call on (re)connect with a live sink to the host. */
  connect(sink: MessageSink<ClientToHost>): void {
    this.sink = sink
    this.sendHello()
  }

  /**
   * Transport lost. Editing continues locally; ops pile up in pending.
   * In-flight downloads stash their partial bytes for resume.
   */
  handleDisconnect(): void {
    this.sink = null
    for (const transfer of this.incoming.values()) {
      if (transfer.haveBytes > 0) this.partials.set(transfer.meta.assetId, transfer.partialBytes)
      transfer.abort()
    }
    this.incoming.clear()
    for (const transfer of this.outgoing.values()) transfer.abort()
    this.outgoing.clear()
  }

  /** Leave for good: the project becomes a plain local project again. */
  leave(): void {
    this.handleDisconnect()
    this.partials.clear()
    if (this.joined) {
      this.store.detachSession()
      this.joined = false
    }
    this.lastSeq = null
  }

  sendLocalOp(envelope: OpEnvelope): void {
    this.sink?.send({ t: 'op', envelope })
  }

  sendPresence(data: PresenceData): void {
    this.sink?.send({ t: 'presence', data })
  }

  requestAsset(assetId: string): void {
    const haveBytes = this.partials.get(assetId)?.length ?? 0
    this.sink?.send({ t: 'asset-request', assetId, haveBytes })
  }

  /** Announce a locally imported asset so the host can pull and rehost it. */
  offerAsset(meta: TransferMeta): void {
    this.sink?.send({ t: 'asset-offer', meta })
  }

  handleMessage(message: HostToClient): void {
    switch (message.t) {
      case 'welcome': {
        const firstJoin = !this.joined
        if (firstJoin) {
          // Joining replaces the document wholesale (fresh history). Adopt
          // the host's project identity with the snapshot as our origin, so
          // a copy saved here can merge offline with any other copy.
          const lineage = message.projectId
            ? { projectId: message.projectId, originTime: Date.now(), origin: message.snapshot }
            : undefined
          this.store.loadProject(message.snapshot, lineage)
          this.store.attachSession(this)
          this.joined = true
        } else {
          // …but a reconnect resync preserves history and offline edits.
          this.store.resetToSnapshot(message.snapshot)
        }
        this.lastSeq = message.seq
        for (const pending of this.store.pendingOps) {
          this.sink?.send({ t: 'op', envelope: pending })
        }
        this.events.onWelcome?.(message.snapshot, message.users, message.you, firstJoin)
        return
      }

      case 'reject':
        this.events.onRejected?.(message.reason)
        this.leave()
        return

      case 'op': {
        if (!this.joined) return
        if (this.lastSeq !== null && message.seq !== this.lastSeq + 1) {
          // Gap in the authoritative stream (should not happen over TCP):
          // ask for a fresh snapshot rather than diverge.
          this.sendHello()
          return
        }
        this.lastSeq = message.seq
        this.store.receiveAuthoritative(message.envelope)
        return
      }

      case 'op-noop':
        this.store.confirmNoop(message.envelopeId)
        return

      case 'user-joined':
        this.events.onUserJoined?.(message.user)
        return

      case 'user-left':
        this.events.onUserLeft?.(message.userId)
        return

      case 'presence':
        this.events.onPresence?.(message.userId, message.data)
        return

      case 'asset-available':
        this.events.onAssetAvailable?.(message.meta)
        return

      case 'asset-pull': {
        // The host wants an asset we offered. Stream it up.
        const asset = this.assets?.get(message.assetId)
        if (!asset || !this.sink) return
        const sink = this.sink
        const transfer = new OutgoingTransfer(
          message.transferId,
          asset.meta,
          asset.bytes,
          0,
          (m) => sink.send(m),
          () => this.outgoing.delete(message.transferId)
        )
        this.outgoing.set(message.transferId, transfer)
        transfer.start()
        return
      }

      case 'asset-begin': {
        if (!this.sink) return
        const sink = this.sink
        const partial = this.partials.get(message.meta.assetId) ?? null
        const transfer = new IncomingTransfer(
          message.transferId,
          message.meta,
          message.chunkCount,
          message.startIndex,
          partial,
          (m) => sink.send(m),
          {
            onProgress: (received, total) =>
              this.events.onAssetProgress?.(message.meta.assetId, received, total),
            onComplete: (bytes) => {
              this.incoming.delete(message.transferId)
              this.partials.delete(message.meta.assetId)
              this.events.onAssetComplete?.(message.meta, bytes)
            },
            onError: () => this.incoming.delete(message.transferId)
          }
        )
        this.incoming.set(message.transferId, transfer)
        return
      }

      case 'asset-chunk':
      case 'asset-done':
      case 'asset-credit':
      case 'asset-cancel':
        this.handleTransferMessage(message)
        return
    }
  }

  private handleTransferMessage(message: AssetTransferMessage): void {
    switch (message.t) {
      case 'asset-chunk':
        this.incoming.get(message.transferId)?.onChunk(message.index, message.bytesBase64)
        return
      case 'asset-done': {
        const transfer = this.incoming.get(message.transferId)
        this.incoming.delete(message.transferId)
        transfer?.onDone()
        return
      }
      case 'asset-credit':
        this.outgoing.get(message.transferId)?.onCredit(message.upToIndex)
        return
      case 'asset-cancel':
        this.incoming.get(message.transferId)?.abort()
        this.incoming.delete(message.transferId)
        this.outgoing.get(message.transferId)?.abort()
        this.outgoing.delete(message.transferId)
        return
      case 'asset-begin':
        return // handled in handleMessage
    }
  }

  private sendHello(): void {
    this.sink?.send({
      t: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      userId: this.store.userId,
      name: this.name,
      lastSeq: this.lastSeq
    })
  }
}
