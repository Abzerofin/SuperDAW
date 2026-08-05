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

/**
 * Client side of a session: the bridge between a transport and the store's
 * optimistic pipeline. Transport-agnostic — the transport hands it a sink
 * and forwards incoming messages; reconnects just call `connect` again.
 *
 * Offline behavior falls out of the store model: with no sink, local ops
 * simply accumulate in `pending`; every `welcome` re-sends the whole
 * pending backlog (safe: ops are idempotent, and no-op re-sends are acked
 * via `op-noop`).
 */

export interface ClientSessionEvents {
  /** After every welcome. `firstJoin` distinguishes join from resync. */
  onWelcome?(snapshot: ProjectState, users: SessionUser[], you: SessionUser, firstJoin: boolean): void
  onRejected?(reason: string): void
  onUserJoined?(user: SessionUser): void
  onUserLeft?(userId: string): void
  onPresence?(userId: string, data: PresenceData): void
  onAssetData?(assetId: string, name: string, kind: 'audio' | 'midi', ext: string, bytesBase64: string): void
}

export class ClientSession implements SequencerLink {
  private sink: MessageSink<ClientToHost> | null = null
  private joined = false
  private lastSeq: number | null = null

  constructor(
    private store: ProjectStore,
    private name: string,
    private events: ClientSessionEvents = {}
  ) {}

  get isConnected(): boolean {
    return this.sink !== null
  }

  /** Call on (re)connect with a live sink to the host. */
  connect(sink: MessageSink<ClientToHost>): void {
    this.sink = sink
    this.sendHello()
  }

  /** Transport lost. Editing continues locally; ops pile up in pending. */
  handleDisconnect(): void {
    this.sink = null
  }

  /** Leave for good: the project becomes a plain local project again. */
  leave(): void {
    this.sink = null
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
    this.sink?.send({ t: 'asset-request', assetId })
  }

  handleMessage(message: HostToClient): void {
    switch (message.t) {
      case 'welcome': {
        const firstJoin = !this.joined
        if (firstJoin) {
          // Joining replaces the document wholesale (fresh history)…
          this.store.loadProject(message.snapshot)
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

      case 'asset-data':
        this.events.onAssetData?.(
          message.assetId,
          message.name,
          message.kind,
          message.ext,
          message.bytesBase64
        )
        return
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
