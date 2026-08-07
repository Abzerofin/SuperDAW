// NOTE: .ts extensions are deliberate — the standalone relay server runs
// these modules under Node's native type stripping, which requires them.
import type { ClientToRelay, RelayErrorCode } from './protocol.ts'
import { RELAY_PROTOCOL_VERSION } from './protocol.ts'
import { normalizeCode } from './codes.ts'
import { SessionRegistry, type Conn, type RelaySink, type Session } from './sessionRegistry.ts'

/**
 * All relay behavior, transport-agnostic: the ws adapter feeds it sinks
 * and parsed messages; tests feed it fakes. Its entire job is routing
 * opaque payloads between one host and N guests per session, plus the
 * session lifecycle (create → active ⇄ host-away → expired). It never
 * inspects a payload — see docs/NETWORKING.md.
 *
 * Time is passed in explicitly (`now`) and expiry runs in `tick()`, so
 * every lifecycle path is deterministic under test.
 */

export interface RelayCoreConfig {
  maxSessions: number
  maxGuestsPerSession: number
  /** Host disconnected longer than this → session expires. */
  hostAwayGraceMs: number
  /** No connections at all longer than this → session evaporates. */
  emptyLingerMs: number
  /** Absolute backstop: no traffic at all for this long → expire. */
  idleCapMs: number
  /** Join/create attempts allowed per connection before rate-limiting. */
  maxAttemptsPerConn: number
  randomByte: () => number
}

export const DEFAULT_CONFIG: Omit<RelayCoreConfig, 'randomByte'> = {
  maxSessions: 1000,
  maxGuestsPerSession: 16,
  hostAwayGraceMs: 120_000,
  emptyLingerMs: 60_000,
  idleCapMs: 24 * 60 * 60 * 1000,
  maxAttemptsPerConn: 5
}

export class RelayCore {
  readonly sessions: SessionRegistry
  private config: RelayCoreConfig

  constructor(config: RelayCoreConfig) {
    this.config = config
    this.sessions = new SessionRegistry(config.randomByte)
  }

  connect(sink: RelaySink, now: number): Conn {
    return { sink, session: null, role: null, guestId: null, joinAttempts: 0, lastSeen: now }
  }

  handleMessage(conn: Conn, message: ClientToRelay, now: number): void {
    conn.lastSeen = now
    if (conn.session) conn.session.lastTraffic = now

    switch (message.t) {
      case 'create':
        this.handleCreate(conn, message, now)
        return
      case 'join':
        this.handleJoin(conn, message, now)
        return
      case 'msg':
        this.handleMsg(conn, message)
        return
      case 'leave':
        this.handleLeave(conn)
        return
      case 'hb':
        conn.sink.send({ t: 'hb' })
        return
    }
  }

  /** Transport closed underneath the connection. */
  handleClose(conn: Conn, now: number): void {
    const session = conn.session
    if (!session) return
    conn.session = null

    if (conn.role === 'host' && session.hostConn === conn) {
      session.hostConn = null
      session.hostAwaySince = now
      this.toGuests(session, { t: 'host-away' })
    } else if (conn.role === 'guest' && conn.guestId) {
      const seat = session.guests.get(conn.guestId)
      if (seat && seat.conn === conn) {
        seat.conn = null // seat survives for resume
        session.hostConn?.sink.send({ t: 'guest-down', guestId: conn.guestId })
      }
    }
    if (this.sessions.isEmpty(session)) session.emptySince = now
  }

  /** Periodic sweep: expiry timers. Call every few seconds. */
  tick(now: number): void {
    for (const session of [...this.sessions.all()]) {
      const hostAwayTooLong =
        session.hostAwaySince !== null && now - session.hostAwaySince > this.config.hostAwayGraceMs
      const idleTooLong = now - session.lastTraffic > this.config.idleCapMs
      if (hostAwayTooLong || idleTooLong) {
        this.sessions.close(session, 'expired')
        continue
      }
      if (
        session.emptySince !== null &&
        this.sessions.isEmpty(session) &&
        now - session.emptySince > this.config.emptyLingerMs
      ) {
        this.sessions.remove(session)
      }
    }
  }

  /** Process shutdown: tell everyone, drop everything. */
  shutdown(): void {
    for (const session of [...this.sessions.all()]) {
      this.sessions.close(session, 'server-shutdown')
    }
  }

  // ---------- message handlers ----------

  private handleCreate(conn: Conn, message: { v: number; resumeToken?: string }, now: number): void {
    if (!this.checkAttachable(conn, message.v)) return

    if (message.resumeToken !== undefined) {
      const session = this.sessions.byHostResumeToken(message.resumeToken)
      if (!session || session.hostConn !== null) {
        this.error(conn, 'bad-resume', 'That session cannot be resumed')
        return
      }
      session.hostConn = conn
      session.hostAwaySince = null
      session.emptySince = null
      session.lastTraffic = now
      conn.session = session
      conn.role = 'host'
      conn.sink.send({ t: 'resumed', role: 'host' })
      this.toGuests(session, { t: 'host-back' })
      return
    }

    if (this.sessions.count >= this.config.maxSessions) {
      this.error(conn, 'session-full', 'The relay is at capacity, try again later')
      return
    }
    const session = this.sessions.create(now)
    session.hostConn = conn
    conn.session = session
    conn.role = 'host'
    conn.sink.send({
      t: 'created',
      code: session.code,
      sessionId: session.sessionId,
      resumeToken: session.hostResumeToken
    })
  }

  private handleJoin(
    conn: Conn,
    message: { v: number; code: string; resumeToken?: string },
    now: number
  ): void {
    if (!this.checkAttachable(conn, message.v)) return

    const session = this.sessions.byJoinCode(normalizeCode(message.code))
    if (!session) {
      this.error(conn, 'bad-code', 'No session with that code')
      return
    }
    session.lastTraffic = now

    if (message.resumeToken !== undefined) {
      const seat = [...session.guests.values()].find((s) => s.resumeToken === message.resumeToken)
      if (!seat) {
        this.error(conn, 'bad-resume', 'That seat cannot be resumed')
        return
      }
      // A valid resumeToken proves ownership of the seat, so a seat that is
      // still "attached" here holds a connection we have not reaped yet:
      // the guest gives up on a dead link sooner than the server's silence
      // timer fires, so a reconnect lands inside that window. Hand the seat
      // over rather than refusing — refusing ends a healthy session, and
      // that window widens with every extra guest.
      const stale = seat.conn
      seat.conn = conn
      // Reseated first, so the stale socket's own close is a no-op for the
      // seat (handleClose only clears a seat it still owns).
      if (stale !== null && stale !== conn) stale.sink.close()
      session.emptySince = null
      conn.session = session
      conn.role = 'guest'
      conn.guestId = seat.guestId
      conn.sink.send({ t: 'resumed', role: 'guest', guestId: seat.guestId })
      session.hostConn?.sink.send({ t: 'guest-up', guestId: seat.guestId })
      if (session.hostAwaySince !== null) conn.sink.send({ t: 'host-away' })
      return
    }

    const liveGuests = [...session.guests.values()].filter((s) => s.conn !== null).length
    if (liveGuests >= this.config.maxGuestsPerSession) {
      this.error(conn, 'session-full', 'This session is full')
      return
    }
    const seat = this.sessions.addGuest(session)
    seat.conn = conn
    session.emptySince = null
    conn.session = session
    conn.role = 'guest'
    conn.guestId = seat.guestId
    conn.sink.send({ t: 'attached', guestId: seat.guestId, resumeToken: seat.resumeToken })
    session.hostConn?.sink.send({ t: 'guest-up', guestId: seat.guestId })
    if (session.hostAwaySince !== null) conn.sink.send({ t: 'host-away' })
  }

  private handleMsg(conn: Conn, message: { to?: string; payload: unknown }): void {
    const session = conn.session
    if (!session || conn.role === null) {
      this.error(conn, 'protocol-error', 'msg before create/join')
      return
    }
    if (conn.role === 'guest') {
      if (message.to !== undefined) {
        this.error(conn, 'protocol-error', 'guests can only send to the host')
        return
      }
      // Host away → drop; the inner protocol re-sends pending on host-back.
      session.hostConn?.sink.send({
        t: 'guest-msg',
        guestId: conn.guestId!,
        payload: message.payload
      })
      return
    }
    // Host → one guest or all guests.
    if (message.to !== undefined) {
      session.guests.get(message.to)?.conn?.sink.send({ t: 'host-msg', payload: message.payload })
      return
    }
    this.toGuests(session, { t: 'host-msg', payload: message.payload })
  }

  private handleLeave(conn: Conn): void {
    const session = conn.session
    if (!session) return
    if (conn.role === 'host') {
      // Deliberate stop — not a drop. The session ends for everyone.
      this.sessions.close(session, 'host-left')
      conn.session = null
      return
    }
    if (conn.guestId) {
      session.guests.delete(conn.guestId) // deliberate leave forfeits the seat
      session.hostConn?.sink.send({ t: 'guest-down', guestId: conn.guestId })
    }
    conn.session = null
    conn.role = null
    conn.guestId = null
  }

  // ---------- helpers ----------

  private checkAttachable(conn: Conn, version: number): boolean {
    if (conn.session) {
      this.error(conn, 'already-attached', 'Already in a session')
      return false
    }
    if (version !== RELAY_PROTOCOL_VERSION) {
      this.error(conn, 'version-mismatch', `Relay speaks v${RELAY_PROTOCOL_VERSION}`)
      return false
    }
    conn.joinAttempts += 1
    if (conn.joinAttempts > this.config.maxAttemptsPerConn) {
      this.error(conn, 'rate-limited', 'Too many attempts')
      conn.sink.close()
      return false
    }
    return true
  }

  private toGuests(session: Session, message: Parameters<RelaySink['send']>[0]): void {
    for (const seat of session.guests.values()) seat.conn?.sink.send(message)
  }

  private error(conn: Conn, code: RelayErrorCode, message: string): void {
    conn.sink.send({ t: 'error', code, message })
  }
}
