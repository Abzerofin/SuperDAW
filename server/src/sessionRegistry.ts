import type { GuestId, RelayToClient, SessionClosedReason } from '../../src/core/relay/protocol.ts'
import { mintCode } from '../../src/core/relay/codes.ts'

/**
 * In-memory session table — the relay's ONLY state. No database, no
 * disk: when a session ends (or the process does), everything about it
 * ceases to exist. Timers are timestamps swept by RelayCore.tick(), so
 * this module stays pure and deterministic under test.
 */

export interface RelaySink {
  send(message: RelayToClient): void
  close(): void
}

/** One live connection (transport hands these in; role assigned on create/join). */
export interface Conn {
  readonly sink: RelaySink
  session: Session | null
  role: 'host' | 'guest' | null
  guestId: GuestId | null
  joinAttempts: number
  lastSeen: number
}

/** A guest's place in a session; survives a dropped conn for resume. */
export interface GuestSeat {
  readonly guestId: GuestId
  readonly resumeToken: string
  conn: Conn | null
}

export interface Session {
  readonly sessionId: string
  readonly code: string
  readonly hostResumeToken: string
  hostConn: Conn | null
  readonly guests: Map<GuestId, GuestSeat>
  /** Set while the host is disconnected (grace window running). */
  hostAwaySince: number | null
  /** Set while NO connection is attached (linger window running). */
  emptySince: number | null
  lastTraffic: number
}

export class SessionRegistry {
  private byCode = new Map<string, Session>()
  private byHostToken = new Map<string, Session>()
  private nextId = 1
  private nextGuestId = 1
  private randomByte: () => number

  constructor(randomByte: () => number) {
    this.randomByte = randomByte
  }

  get count(): number {
    return this.byCode.size
  }

  all(): Iterable<Session> {
    return this.byCode.values()
  }

  create(now: number): Session {
    let code = mintCode(this.randomByte)
    while (this.byCode.has(code)) code = mintCode(this.randomByte)
    const session: Session = {
      sessionId: `s${this.nextId++}`,
      code,
      hostResumeToken: this.mintToken(),
      hostConn: null,
      guests: new Map(),
      hostAwaySince: null,
      emptySince: null,
      lastTraffic: now
    }
    this.byCode.set(code, session)
    this.byHostToken.set(session.hostResumeToken, session)
    return session
  }

  byJoinCode(code: string): Session | undefined {
    return this.byCode.get(code)
  }

  byHostResumeToken(token: string): Session | undefined {
    return this.byHostToken.get(token)
  }

  addGuest(session: Session): GuestSeat {
    // Identity is a counter (uniqueness is what matters); the CAPABILITY
    // to resume the seat is the random token.
    const seat: GuestSeat = {
      guestId: `g${this.nextGuestId++}`,
      resumeToken: this.mintToken(),
      conn: null
    }
    session.guests.set(seat.guestId, seat)
    return seat
  }

  /** Notify every attached connection, then delete the session. */
  close(session: Session, reason: SessionClosedReason): void {
    const closed: RelayToClient = { t: 'closed', reason }
    session.hostConn?.sink.send(closed)
    session.hostConn?.sink.close()
    for (const seat of session.guests.values()) {
      seat.conn?.sink.send(closed)
      seat.conn?.sink.close()
    }
    this.remove(session)
  }

  /** Delete without ceremony (nothing attached to notify). */
  remove(session: Session): void {
    this.byCode.delete(session.code)
    this.byHostToken.delete(session.hostResumeToken)
  }

  /** True when no live connection remains on the session. */
  isEmpty(session: Session): boolean {
    if (session.hostConn) return false
    for (const seat of session.guests.values()) if (seat.conn) return false
    return true
  }

  mintToken(): string {
    let token = ''
    for (let i = 0; i < 16; i++) {
      token += (this.randomByte() & 0xff).toString(16).padStart(2, '0')
    }
    return token
  }
}
