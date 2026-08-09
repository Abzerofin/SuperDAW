import type { ProjectState } from '../model/types'
import type { OpEnvelope } from '../ops/operations'
import type { AssetTransferMessage, TransferMeta } from './transfer'

/**
 * Wire protocol for a collaboration session (see docs/PROTOCOL.md).
 * Everything here is plain JSON-serializable data; the transport layer
 * (WebSocket, in-memory test relay, internet relay) just moves these
 * messages verbatim.
 *
 * v2: single-blob asset-data replaced by chunked, flow-controlled
 * transfers (transfer.ts) with guest uploads (asset-offer/asset-pull).
 */

export const PROTOCOL_VERSION = 2

/**
 * Size of the shared presence palette (renderer: state/collab USER_COLORS).
 * The host allocates within it so two people in one session never wear the
 * same colour; index 0 is always the host's.
 */
export const SESSION_COLOR_COUNT = 8

export interface SessionUser {
  readonly userId: string
  readonly name: string
  /** Index into the shared presence palette, assigned by the host. */
  readonly colorIndex: number
}

/** Ephemeral presence payload — relayed, never stored, never in the document. */
export interface PresenceData {
  /**
   * Timeline cursor, when the pointer is over the timeline. `yFrac` is the
   * pointer's vertical position within the lane (0 = lane top, 1 = lane
   * bottom) — semantic rather than pixels, so the literal cursor lands on
   * the same track even when peers differ in zoom, compact mode, or open
   * automation lanes. Absent on older peers; receivers fall back to a
   * plain lane caret.
   */
  readonly cursor?: { ticks: number; trackIndex: number; yFrac?: number } | null
  /** A transient ping anchored to something. */
  readonly ping?: {
    readonly pingId: string
    readonly ticks: number
    readonly trackIndex: number | null
    /** Human-readable target, e.g. 'clip "Drums 1"' or 'bar 17'. */
    readonly label: string
    /**
     * Present = a UI ping rather than a timeline ping: a string anchors to
     * the element carrying that `data-ping-id` on the receiver's screen
     * (found by identity, so it lands correctly in ANY layout); null means
     * no stable anchor exists and only the label is shown.
     */
    readonly uiTarget?: string | null
  }
}

export type ClientToHost =
  | {
      t: 'hello'
      protocolVersion: number
      userId: string
      name: string
      /** Last authoritative seq seen, or null on first join. */
      lastSeq: number | null
    }
  | { t: 'op'; envelope: OpEnvelope }
  | { t: 'presence'; data: PresenceData }
  /** "Send me this asset" — `haveBytes` resumes an interrupted download. */
  | { t: 'asset-request'; assetId: string; haveBytes: number }
  /** "I imported an asset" — the host pulls it if it doesn't have it. */
  | { t: 'asset-offer'; meta: TransferMeta }
  | AssetTransferMessage

export type HostToClient =
  | {
      t: 'welcome'
      seq: number
      snapshot: ProjectState
      users: SessionUser[]
      you: SessionUser
      /**
       * The host project's lineage id (additive in v2). Guests adopt it with
       * the snapshot as their origin, so a copy saved by any participant can
       * later be merged offline with any other copy (core/merge).
       */
      projectId?: string
    }
  | { t: 'reject'; reason: string }
  | { t: 'op'; seq: number; envelope: OpEnvelope }
  /**
   * A client op that applied as a no-op on the host (target vanished, or an
   * idempotent re-send). Not sequenced or broadcast — but the origin still
   * needs the ack so the envelope leaves its pending set.
   */
  | { t: 'op-noop'; envelopeId: string }
  | { t: 'presence'; userId: string; data: PresenceData }
  | { t: 'user-joined'; user: SessionUser }
  | { t: 'user-left'; userId: string }
  /** Host wants an offered asset uploaded; the guest answers with asset-begin. */
  | { t: 'asset-pull'; assetId: string; transferId: string }
  /** A new asset exists in the session; clients missing it should request it. */
  | { t: 'asset-available'; meta: TransferMeta }
  | AssetTransferMessage

export type SessionMessage = ClientToHost | HostToClient

/** One direction of a peer connection; implemented by transports. */
export interface MessageSink<M> {
  send(message: M): void
}
