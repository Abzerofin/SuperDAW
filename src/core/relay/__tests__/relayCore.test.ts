import { describe as suite, expect, test } from 'vitest'
import type { RelayToClient } from '../protocol.ts'
import { RELAY_PROTOCOL_VERSION as V } from '../protocol.ts'
import { RelayCore, DEFAULT_CONFIG } from '../relayCore.ts'
import type { Conn } from '../sessionRegistry.ts'

/** Deterministic byte source (32-bit-safe) so codes/tokens are stable. */
function seededBytes(seed = 1): () => number {
  let x = seed >>> 0
  return () => {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    return x & 0xff
  }
}

interface FakeClient {
  conn: Conn
  inbox: RelayToClient[]
  closed: boolean
}

function makeCore(overrides: Partial<typeof DEFAULT_CONFIG> = {}): RelayCore {
  return new RelayCore({ ...DEFAULT_CONFIG, ...overrides, randomByte: seededBytes() })
}

function attach(core: RelayCore, now = 0): FakeClient {
  const client: FakeClient = { conn: null as unknown as Conn, inbox: [], closed: false }
  client.conn = core.connect(
    {
      send: (m) => client.inbox.push(m),
      close: () => {
        client.closed = true
      }
    },
    now
  )
  return client
}

function last(client: FakeClient): RelayToClient {
  return client.inbox[client.inbox.length - 1]
}

function createSession(core: RelayCore, now = 0): { host: FakeClient; code: string; token: string } {
  const host = attach(core, now)
  core.handleMessage(host.conn, { t: 'create', v: V }, now)
  const created = last(host)
  if (created.t !== 'created') throw new Error(`expected created, got ${created.t}`)
  return { host, code: created.code, token: created.resumeToken }
}

function joinSession(core: RelayCore, code: string, now = 0): { guest: FakeClient; guestId: string; token: string } {
  const guest = attach(core, now)
  core.handleMessage(guest.conn, { t: 'join', v: V, code }, now)
  const attached = last(guest)
  if (attached.t !== 'attached') throw new Error(`expected attached, got ${attached.t}`)
  return { guest, guestId: attached.guestId, token: attached.resumeToken }
}

suite('session creation and joining', () => {
  test('create returns a well-formed code; join attaches and notifies the host', () => {
    const core = makeCore()
    const { host, code } = createSession(core)
    expect(code).toHaveLength(8)

    const { guestId } = joinSession(core, code)
    expect(last(host)).toEqual({ t: 'guest-up', guestId })
  })

  test('joining accepts formatted and confusable input (ab4x-k92p style)', () => {
    const core = makeCore()
    const { code } = createSession(core)
    const mangled = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase().replace(/0/g, 'o')
    const { guest } = joinSession(core, mangled)
    expect(last(guest).t).not.toBe('error')
  })

  test('bad code, wrong version, and double-attach are rejected with typed errors', () => {
    const core = makeCore()
    const { code } = createSession(core)

    const g1 = attach(core)
    core.handleMessage(g1.conn, { t: 'join', v: V, code: 'ZZZZZZZZ' }, 0)
    expect(last(g1)).toMatchObject({ t: 'error', code: 'bad-code' })

    const g2 = attach(core)
    core.handleMessage(g2.conn, { t: 'join', v: 99, code }, 0)
    expect(last(g2)).toMatchObject({ t: 'error', code: 'version-mismatch' })

    const { guest } = joinSession(core, code)
    core.handleMessage(guest.conn, { t: 'join', v: V, code }, 0)
    expect(last(guest)).toMatchObject({ t: 'error', code: 'already-attached' })
  })

  test('guest cap and join-attempt rate limit are enforced', () => {
    const core = makeCore({ maxGuestsPerSession: 1, maxAttemptsPerConn: 2 })
    const { code } = createSession(core)
    joinSession(core, code)

    const overflow = attach(core)
    core.handleMessage(overflow.conn, { t: 'join', v: V, code }, 0)
    expect(last(overflow)).toMatchObject({ t: 'error', code: 'session-full' })
    core.handleMessage(overflow.conn, { t: 'join', v: V, code: 'WRONG000' }, 0)
    core.handleMessage(overflow.conn, { t: 'join', v: V, code: 'WRONG000' }, 0)
    expect(last(overflow)).toMatchObject({ t: 'error', code: 'rate-limited' })
    expect(overflow.closed).toBe(true)
  })
})

suite('routing', () => {
  test('guest msgs go only to the host; host msgs broadcast or target one guest', () => {
    const core = makeCore()
    const { host, code } = createSession(core)
    const a = joinSession(core, code)
    const b = joinSession(core, code)

    core.handleMessage(a.guest.conn, { t: 'msg', payload: 'from-a' }, 0)
    expect(last(host)).toEqual({ t: 'guest-msg', guestId: a.guestId, payload: 'from-a' })
    expect(a.guest.inbox.every((m) => m.t !== 'guest-msg')).toBe(true)

    core.handleMessage(host.conn, { t: 'msg', payload: 'to-all' }, 0)
    expect(last(a.guest)).toEqual({ t: 'host-msg', payload: 'to-all' })
    expect(last(b.guest)).toEqual({ t: 'host-msg', payload: 'to-all' })

    core.handleMessage(host.conn, { t: 'msg', to: b.guestId, payload: 'just-b' }, 0)
    expect(last(b.guest)).toEqual({ t: 'host-msg', payload: 'just-b' })
    expect(last(a.guest)).toEqual({ t: 'host-msg', payload: 'to-all' })
  })

  test('a guest addressing another guest is a protocol error', () => {
    const core = makeCore()
    const { code } = createSession(core)
    const a = joinSession(core, code)
    core.handleMessage(a.guest.conn, { t: 'msg', to: 'someone', payload: 'x' }, 0)
    expect(last(a.guest)).toMatchObject({ t: 'error', code: 'protocol-error' })
  })
})

suite('lifecycle: host-away, resume, expiry', () => {
  test('host drop → host-away; resume within grace → host-back; guests keep seats', () => {
    const core = makeCore()
    const { host, code, token } = createSession(core)
    const a = joinSession(core, code)

    core.handleClose(host.conn, 1000)
    expect(last(a.guest)).toEqual({ t: 'host-away' })

    const host2 = attach(core, 2000)
    core.handleMessage(host2.conn, { t: 'create', v: V, resumeToken: token }, 2000)
    expect(last(host2)).toEqual({ t: 'resumed', role: 'host' })
    expect(last(a.guest)).toEqual({ t: 'host-back' })

    // Routing still works after resume.
    core.handleMessage(a.guest.conn, { t: 'msg', payload: 'hello-again' }, 2001)
    expect(last(host2)).toMatchObject({ t: 'guest-msg', payload: 'hello-again' })
  })

  test('grace expiry closes the session for everyone', () => {
    const core = makeCore({ hostAwayGraceMs: 5000 })
    const { host, code } = createSession(core)
    const a = joinSession(core, code)

    core.handleClose(host.conn, 1000)
    core.tick(3000)
    expect(last(a.guest)).toEqual({ t: 'host-away' }) // still waiting
    core.tick(7000)
    expect(last(a.guest)).toEqual({ t: 'closed', reason: 'expired' })
    expect(core.sessions.count).toBe(0)
  })

  test('guest drop keeps the seat; resume restores it; deliberate leave forfeits it', () => {
    const core = makeCore()
    const { host, code } = createSession(core)
    const a = joinSession(core, code)

    core.handleClose(a.guest.conn, 1000)
    expect(last(host)).toEqual({ t: 'guest-down', guestId: a.guestId })

    const back = attach(core, 2000)
    core.handleMessage(back.conn, { t: 'join', v: V, code, resumeToken: a.token }, 2000)
    expect(last(back)).toEqual({ t: 'resumed', role: 'guest', guestId: a.guestId })
    expect(last(host)).toEqual({ t: 'guest-up', guestId: a.guestId })

    core.handleMessage(back.conn, { t: 'leave' }, 3000)
    const again = attach(core, 4000)
    core.handleMessage(again.conn, { t: 'join', v: V, code, resumeToken: a.token }, 4000)
    expect(last(again)).toMatchObject({ t: 'error', code: 'bad-resume' })
  })

  test('host leave (deliberate) ends the session with host-left', () => {
    const core = makeCore()
    const { host, code } = createSession(core)
    const a = joinSession(core, code)
    core.handleMessage(host.conn, { t: 'leave' }, 0)
    expect(last(a.guest)).toEqual({ t: 'closed', reason: 'host-left' })
    expect(core.sessions.count).toBe(0)
  })

  test('a fully empty session lingers, then evaporates silently', () => {
    const core = makeCore({ emptyLingerMs: 10_000, hostAwayGraceMs: 60_000 })
    const { host, code } = createSession(core)
    const a = joinSession(core, code)
    core.handleClose(a.guest.conn, 1000)
    core.handleClose(host.conn, 2000)
    core.tick(5000)
    expect(core.sessions.count).toBe(1)
    core.tick(13_000)
    expect(core.sessions.count).toBe(0)
  })

  test('shutdown notifies every attached connection', () => {
    const core = makeCore()
    const { host, code } = createSession(core)
    const a = joinSession(core, code)
    core.shutdown()
    expect(last(host)).toEqual({ t: 'closed', reason: 'server-shutdown' })
    expect(last(a.guest)).toEqual({ t: 'closed', reason: 'server-shutdown' })
    expect(core.sessions.count).toBe(0)
  })
})
