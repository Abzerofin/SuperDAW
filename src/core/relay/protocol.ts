/**
 * Relay wire protocol (outer layer) — see docs/NETWORKING.md.
 *
 * The relay server routes frames between one HOST connection and N GUEST
 * connections per session. `payload` is the inner session protocol
 * (core/session/protocol.ts) and is COMPLETELY OPAQUE to the relay: it
 * never parses an Operation, never sees project state as anything but
 * bytes in flight. This file has no imports by design — it is shared by
 * the app and the standalone server, and it must never grow the ability
 * to interpret DAW data.
 */

export const RELAY_PROTOCOL_VERSION = 1

export type GuestId = string

export type SessionClosedReason = 'expired' | 'host-left' | 'server-shutdown'

export type RelayErrorCode =
  | 'bad-code'
  | 'bad-resume'
  | 'session-full'
  | 'version-mismatch'
  | 'already-attached'
  | 'rate-limited'
  | 'protocol-error'

export type ClientToRelay =
  /** Host a new session — or resume one after a drop via resumeToken. */
  | { t: 'create'; v: number; resumeToken?: string }
  /** Join a session by code — or resume a guest seat via resumeToken. */
  | { t: 'join'; v: number; code: string; resumeToken?: string }
  /**
   * Route an opaque payload. From the host: to one guest (`to`) or every
   * guest (no `to`). From a guest: always to the host (`to` forbidden).
   */
  | { t: 'msg'; to?: GuestId; payload: unknown }
  | { t: 'leave' }
  /** App-level heartbeat (browsers cannot send WebSocket pings). */
  | { t: 'hb' }

export type RelayToClient =
  | { t: 'created'; code: string; sessionId: string; resumeToken: string }
  | { t: 'attached'; guestId: GuestId; resumeToken: string }
  | { t: 'resumed'; role: 'host' | 'guest'; guestId?: GuestId }
  // Host side:
  | { t: 'guest-up'; guestId: GuestId }
  | { t: 'guest-msg'; guestId: GuestId; payload: unknown }
  | { t: 'guest-down'; guestId: GuestId }
  // Guest side:
  | { t: 'host-msg'; payload: unknown }
  | { t: 'host-away' }
  | { t: 'host-back' }
  | { t: 'closed'; reason: SessionClosedReason }
  | { t: 'hb' }
  | { t: 'error'; code: RelayErrorCode; message: string }
