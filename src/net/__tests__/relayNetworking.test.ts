import { describe as suite, expect, test } from 'vitest'
import { createEmptyProject } from '@core/model/types'
import type { Track } from '@core/model/types'
import { ProjectStore } from '@core/state/store'
import { RelayCore, DEFAULT_CONFIG } from '@core/relay/relayCore.ts'
import type { Conn } from '@core/relay/sessionRegistry.ts'
import type { RelayToClient } from '@core/relay/protocol.ts'
import type { HostAssetProvider } from '@core/session/host'
import type { ClientAssetSource } from '@core/session/client'
import type { TransferMeta } from '@core/session/transfer'
import { RelayNetworking } from '../relayNetworking'
import type { RelayConnector, RelayLinkHandlers } from '../relayTransport'
import type { NetworkStatus } from '../networking'

/**
 * Full-loop integration: RelayNetworking peers (host + guests) wired to a
 * real RelayCore through queued in-memory links — the internet stack
 * minus sockets. Ops, presence, assets, host-away and resume all flow
 * through exactly the code the app ships.
 */

function makeTrack(id: string): Track {
  return {
    id,
    kind: 'audio',
    name: id,
    color: '#5b8def',
    muted: false,
    soloed: false,
    volume: 1,
    pan: 0,
    synth: {}
  }
}

class MapAssets implements HostAssetProvider, ClientAssetSource {
  readonly stored = new Map<string, { meta: TransferMeta; bytes: Uint8Array }>()

  add(meta: TransferMeta, bytes: Uint8Array): void {
    this.stored.set(meta.assetId, { meta, bytes })
  }
  has(assetId: string): boolean {
    return this.stored.has(assetId)
  }
  get(assetId: string): { meta: TransferMeta; bytes: Uint8Array } | null {
    return this.stored.get(assetId) ?? null
  }
  store(meta: TransferMeta, bytes: Uint8Array): void {
    this.stored.set(meta.assetId, { meta, bytes })
  }
}

interface FakeLink {
  name: string
  handlers: RelayLinkHandlers
  conn: Conn | null
  /** queued events awaiting delivery */
  toClient: RelayToClient[]
  toCore: Parameters<Conn['sink']['send']>[0][]
  pendingOpen: boolean | null // first?
  up: boolean
  /** Core called sink.close(); flush + go down on the next step. */
  coreClosed: boolean
}

class World {
  readonly core = new RelayCore({
    ...DEFAULT_CONFIG,
    randomByte: (() => {
      let x = 7
      return () => {
        x = (Math.imul(x, 1103515245) + 12345) >>> 0
        return x & 0xff
      }
    })()
  })
  readonly links: FakeLink[] = []
  now = 0

  connectorFor(name: string): RelayConnector {
    return (handlers) => {
      const link: FakeLink = {
        name,
        handlers,
        conn: null,
        toClient: [],
        toCore: [],
        pendingOpen: true,
        up: false,
        coreClosed: false
      }
      this.links.push(link)
      return {
        send: (m) => {
          if (link.up) link.toCore.push(m as never)
        },
        close: () => {
          // A deliberate close flushes queued frames first (TCP semantics);
          // an abrupt drop() loses them.
          if (link.up && link.conn) {
            while (link.toCore.length > 0) {
              this.core.handleMessage(link.conn, link.toCore.shift()! as never, this.now)
            }
            if (link.conn) this.core.handleClose(link.conn, this.now)
          }
          link.up = false
        }
      }
    }
  }

  /** Simulate transport loss for one client. */
  drop(name: string): void {
    const link = this.byName(name)
    if (link.conn && link.up) this.core.handleClose(link.conn, this.now)
    link.up = false
    link.conn = null
    link.toCore = []
    link.toClient = []
    link.handlers.onDown()
  }

  /** Simulate the connector's automatic reconnect succeeding. */
  restore(name: string): void {
    const link = this.byName(name)
    link.pendingOpen = false // not the first open
  }

  step(): boolean {
    for (const link of this.links) {
      if (link.pendingOpen !== null) {
        const first = link.pendingOpen
        link.pendingOpen = null
        link.up = true
        link.conn = this.core.connect(
          {
            send: (m) => link.toClient.push(m),
            close: () => {
              link.coreClosed = true
            }
          },
          this.now
        )
        link.handlers.onOpen(first)
        return true
      }
      if (link.up && link.toCore.length > 0 && link.conn) {
        this.core.handleMessage(link.conn, link.toCore.shift()! as never, this.now)
        return true
      }
      if (link.coreClosed) {
        // Core-initiated close: outgoing frames flush before the socket
        // dies (real ws semantics), then the link goes down.
        link.coreClosed = false
        while (link.toClient.length > 0) link.handlers.onMessage(link.toClient.shift()!)
        link.up = false
        link.conn = null
        link.handlers.onDown()
        return true
      }
      if (link.up && link.toClient.length > 0) {
        link.handlers.onMessage(link.toClient.shift()!)
        return true
      }
    }
    return false
  }

  flush(): void {
    let guard = 200_000
    while (this.step()) if (--guard <= 0) throw new Error('flush did not terminate')
  }

  private byName(name: string): FakeLink {
    const link = this.links.find((l) => l.name === name)
    if (!link) throw new Error(`no link ${name}`)
    return link
  }
}

interface Peer {
  net: RelayNetworking
  store: ProjectStore
  assets: MapAssets
  statuses: NetworkStatus[]
  ended: string[]
  errors: string[]
}

function makePeer(world: World, name: string, seedContent = false): Peer {
  const store = new ProjectStore(createEmptyProject(name), name)
  if (seedContent) {
    store.dispatch({
      type: 'track/create',
      track: makeTrack('t1'),
      index: 0,
      clips: [],
      automation: [],
      notes: [],
      plugins: []
    })
  }
  const assets = new MapAssets()
  const peer: Peer = { net: null as unknown as RelayNetworking, store, assets, statuses: [], ended: [], errors: [] }
  peer.net = new RelayNetworking(world.connectorFor(name), {
    store,
    displayName: () => name,
    hostAssets: assets,
    clientAssets: assets,
    events: {
      onStatusChange: (s) => peer.statuses.push(s),
      onSessionEnded: (reason) => peer.ended.push(reason),
      onError: (m) => peer.errors.push(m),
      onAssetAvailable: (meta) => {
        if (!assets.has(meta.assetId)) peer.net.requestAsset(meta.assetId)
      },
      onAssetComplete: (meta, bytes) => assets.store(meta, bytes)
    }
  })
  return peer
}

async function createAndJoin(world: World): Promise<{ host: Peer; alice: Peer; code: string }> {
  const host = makePeer(world, 'host', true)
  const createPromise = host.net.createSession()
  world.flush()
  const { joinCode } = await createPromise

  const alice = makePeer(world, 'alice')
  const joinPromise = alice.net.joinSession(joinCode)
  world.flush()
  await joinPromise
  world.flush()
  return { host, alice, code: joinCode }
}

suite('relay networking end to end', () => {
  test('create → join → ops from both sides converge through the relay', async () => {
    const world = new World()
    const { host, alice } = await createAndJoin(world)

    expect(alice.store.state).toEqual(host.store.state)

    alice.store.dispatch({ type: 'track/rename', trackId: 't1', name: 'Drums' })
    host.store.dispatch({ type: 'project/setTempo', tempo: 150 })
    world.flush()

    expect(alice.store.pendingOps).toHaveLength(0)
    expect(alice.store.state).toEqual(host.store.state)
    expect(host.store.state.tracks['t1'].name).toBe('Drums')
    expect(host.store.state.tempo).toBe(150)
  })

  test('host transport drop → guests see host-away, edit locally, converge on resume', async () => {
    const world = new World()
    const { host, alice } = await createAndJoin(world)

    world.drop('host')
    world.flush()
    expect(alice.statuses).toContain('host-away')

    // Offline edit on the guest piles up in pending.
    alice.store.dispatch({ type: 'track/rename', trackId: 't1', name: 'Offline Name' })
    expect(alice.store.pendingOps).toHaveLength(1)
    // Host edits locally too.
    host.store.dispatch({ type: 'project/setTempo', tempo: 90 })

    world.restore('host')
    world.flush()

    expect(alice.statuses[alice.statuses.length - 1]).toBe('online')
    expect(alice.store.pendingOps).toHaveLength(0)
    expect(alice.store.state).toEqual(host.store.state)
    expect(host.store.state.tracks['t1'].name).toBe('Offline Name')
    expect(host.store.state.tempo).toBe(90)
  })

  test('guest transport drop and resume: same seat, offline edits replayed', async () => {
    const world = new World()
    const { host, alice } = await createAndJoin(world)

    world.drop('alice')
    alice.store.dispatch({ type: 'track/rename', trackId: 't1', name: 'While Away' })
    world.restore('alice')
    world.flush()

    expect(alice.store.pendingOps).toHaveLength(0)
    expect(host.store.state.tracks['t1'].name).toBe('While Away')
    expect(alice.store.state).toEqual(host.store.state)
  })

  test('assets flow guest → host → other guest through the relay', async () => {
    const world = new World()
    const { host, alice, code } = await createAndJoin(world)

    const bob = makePeer(world, 'bob')
    const joinPromise = bob.net.joinSession(code)
    world.flush()
    await joinPromise
    world.flush()

    const bytes = new Uint8Array(300_000).map((_, i) => i & 0xff)
    const meta: TransferMeta = {
      assetId: 'wav1',
      name: 'take.wav',
      kind: 'audio',
      ext: 'wav',
      size: bytes.length
    }
    alice.assets.add(meta, bytes)
    alice.net.offerAsset(meta)
    world.flush()

    expect(host.assets.get('wav1')?.bytes).toEqual(bytes)
    expect(bob.assets.get('wav1')?.bytes).toEqual(bytes)
  })

  test('host leave ends the session for guests; their copies stay intact', async () => {
    const world = new World()
    const { host, alice } = await createAndJoin(world)
    host.store.dispatch({ type: 'project/setTempo', tempo: 132 })
    world.flush()

    host.net.leaveSession()
    world.flush()

    expect(alice.ended.length).toBe(1)
    expect(alice.net.status).toBe('off')
    expect(alice.store.state.tempo).toBe(132) // adopted local copy
  })

  test('joining a nonexistent code fails with a clean error', async () => {
    const world = new World()
    const peer = makePeer(world, 'lost')
    const joinPromise = peer.net.joinSession('ZZZZ-ZZZZ')
    world.flush()
    await expect(joinPromise).rejects.toThrow(/No session/)
    expect(peer.net.status).toBe('off')
  })
})
