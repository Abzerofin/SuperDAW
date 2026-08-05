import type { ProjectState } from '../model/types'
import type { OpEnvelope } from '../ops/operations'

/**
 * Wire protocol for a collaboration session (see docs/PROTOCOL.md).
 * Everything here is plain JSON-serializable data; the transport layer
 * (WebSocket, in-memory test relay) just moves these messages verbatim.
 */

export const PROTOCOL_VERSION = 1

export interface SessionUser {
  readonly userId: string
  readonly name: string
  /** Index into the shared presence palette, assigned by the host. */
  readonly colorIndex: number
}

/** Ephemeral presence payload — relayed, never stored, never in the document. */
export interface PresenceData {
  /** Timeline cursor, when the pointer is over the timeline. */
  readonly cursor?: { ticks: number; trackIndex: number } | null
  /** A transient ping anchored to something. */
  readonly ping?: {
    readonly pingId: string
    readonly ticks: number
    readonly trackIndex: number | null
    /** Human-readable target, e.g. 'clip "Drums 1"' or 'bar 17'. */
    readonly label: string
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
  | { t: 'asset-request'; assetId: string }

export type HostToClient =
  | {
      t: 'welcome'
      seq: number
      snapshot: ProjectState
      users: SessionUser[]
      you: SessionUser
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
  | {
      t: 'asset-data'
      assetId: string
      name: string
      kind: 'audio' | 'midi'
      ext: string
      bytesBase64: string
    }

export type SessionMessage = ClientToHost | HostToClient

/** One direction of a peer connection; implemented by transports. */
export interface MessageSink<M> {
  send(message: M): void
}
