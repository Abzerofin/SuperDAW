import { describe as suite, expect, test } from 'vitest'
import type { Clip, ProjectState, Track } from '../../model/types'
import { createEmptyProject } from '../../model/types'
import { PPQ } from '../../model/timebase'
import type { ClientToHost, HostToClient } from '../protocol'
import { ProjectStore } from '../../state/store'
import { HostSession, type HostPeer } from '../host'
import { ClientSession } from '../client'

// ---------- deterministic rng ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------- simulated network ----------

interface TestClient {
  readonly name: string
  store: ProjectStore
  session: ClientSession
  peer: HostPeer | null
  toHost: ClientToHost[]
  fromHost: HostToClient[]
  connected: boolean
}

function makeTrack(id: string, kind: Track['kind'] = 'audio'): Track {
  return { id, kind, name: id, color: '#5b8def', muted: false, soloed: false }
}

function makeClip(id: string, trackId: string, start = 0, duration = PPQ * 4): Clip {
  return { id, trackId, name: id, start, duration, assetId: null, offset: 0, color: null }
}

function seedProject(): ProjectState {
  let s = createEmptyProject('Session Test')
  return s
}

class TestNetwork {
  readonly hostStore: ProjectStore
  readonly host: HostSession
  readonly clients: TestClient[] = []
  private rng: () => number

  constructor(seed = 1) {
    this.rng = mulberry32(seed)
    this.hostStore = new ProjectStore(seedProject(), 'host')
    this.host = new HostSession(this.hostStore, { hostName: 'Host' })
    // Baseline content, created through the normal pipeline.
    this.hostStore.dispatch({ type: 'track/create', track: makeTrack('t1'), index: 0, clips: [] })
    this.hostStore.dispatch({ type: 'track/create', track: makeTrack('t2'), index: 1, clips: [] })
    this.hostStore.dispatch({ type: 'clip/create', clip: makeClip('c1', 't1') })
  }

  addClient(name: string): TestClient {
    const client: TestClient = {
      name,
      store: new ProjectStore(createEmptyProject('empty'), name),
      session: null as unknown as ClientSession,
      peer: null,
      toHost: [],
      fromHost: [],
      connected: false
    }
    client.session = new ClientSession(client.store, name)
    this.clients.push(client)
    this.connect(client)
    return client
  }

  connect(client: TestClient): void {
    client.toHost = []
    client.fromHost = []
    client.connected = true
    const peer = this.host.addPeer({
      send: (m) => {
        if (client.peer === peer && client.connected) client.fromHost.push(m)
      }
    })
    client.peer = peer
    client.session.connect({
      send: (m) => {
        if (client.peer === peer && client.connected) client.toHost.push(m)
      }
    })
  }

  disconnect(client: TestClient): void {
    client.connected = false
    if (client.peer) this.host.removePeer(client.peer)
    client.peer = null
    client.session.handleDisconnect()
    client.toHost = [] // in-flight messages are lost with the connection
    client.fromHost = []
  }

  /** Deliver the front message of one random non-empty queue. */
  step(): boolean {
    const queues: Array<() => void> = []
    for (const c of this.clients) {
      if (!c.connected) continue
      if (c.toHost.length > 0)
        queues.push(() => {
          const m = c.toHost.shift()!
          if (c.peer) this.host.handleMessage(c.peer, m)
        })
      if (c.fromHost.length > 0) queues.push(() => c.session.handleMessage(c.fromHost.shift()!))
    }
    if (queues.length === 0) return false
    queues[Math.floor(this.rng() * queues.length)]()
    return true
  }

  flush(): void {
    let guard = 100_000
    while (this.step()) if (--guard <= 0) throw new Error('flush did not terminate')
  }

  /** Deliver exactly one client's outbound queue fully (ordering control). */
  drainToHost(client: TestClient): void {
    while (client.toHost.length > 0 && client.peer) {
      this.host.handleMessage(client.peer, client.toHost.shift()!)
    }
  }

  expectConverged(): void {
    for (const c of this.clients.filter((c) => c.connected)) {
      expect(c.store.pendingOps, `${c.name} pending should drain`).toHaveLength(0)
      expect(c.store.confirmedState, `${c.name} confirmed`).toEqual(this.hostStore.state)
      expect(c.store.state, `${c.name} displayed`).toEqual(this.hostStore.state)
    }
  }
}

// ---------- scenarios ----------

suite('session sync', () => {
  test('join delivers a snapshot; edits from every side converge', () => {
    const net = new TestNetwork()
    const a = net.addClient('alice')
    const b = net.addClient('bob')
    net.flush()
    expect(a.store.state).toEqual(net.hostStore.state)

    a.store.dispatch({ type: 'track/rename', trackId: 't1', name: 'Drums' })
    b.store.dispatch({ type: 'clip/move', clipId: 'c1', trackId: 't2', start: PPQ })
    net.hostStore.dispatch({ type: 'project/setTempo', tempo: 140 })
    net.flush()

    net.expectConverged()
    expect(net.hostStore.state.tracks['t1'].name).toBe('Drums')
    expect(net.hostStore.state.clips['c1'].trackId).toBe('t2')
    expect(net.hostStore.state.tempo).toBe(140)
  })

  test('concurrent writes to the same property: host arrival order wins everywhere', () => {
    const net = new TestNetwork()
    const a = net.addClient('alice')
    const b = net.addClient('bob')
    net.flush()

    a.store.dispatch({ type: 'track/rename', trackId: 't1', name: 'From A' })
    b.store.dispatch({ type: 'track/rename', trackId: 't1', name: 'From B' })
    // Both peers optimistically show their own value right now.
    expect(a.store.state.tracks['t1'].name).toBe('From A')
    expect(b.store.state.tracks['t1'].name).toBe('From B')

    net.drainToHost(a)
    net.drainToHost(b) // B arrives last => B wins in host order
    net.flush()

    net.expectConverged()
    expect(net.hostStore.state.tracks['t1'].name).toBe('From B')
  })

  test('move-vs-delete converges with the clip gone, in both arrival orders', () => {
    for (const deleteFirst of [true, false]) {
      const net = new TestNetwork()
      const a = net.addClient('alice')
      const b = net.addClient('bob')
      net.flush()

      a.store.dispatch({ type: 'clip/move', clipId: 'c1', trackId: 't2', start: PPQ })
      b.store.dispatch({ type: 'clip/delete', clipId: 'c1' })

      if (deleteFirst) {
        net.drainToHost(b)
        net.drainToHost(a)
      } else {
        net.drainToHost(a)
        net.drainToHost(b)
      }
      net.flush()

      net.expectConverged()
      expect(net.hostStore.state.clips['c1']).toBeUndefined()
    }
  })

  test('optimistic rebase: remote op sequenced before my in-flight op', () => {
    const net = new TestNetwork()
    const a = net.addClient('alice')
    const b = net.addClient('bob')
    net.flush()

    // A's op is in flight; B's op reaches the host FIRST.
    a.store.dispatch({ type: 'track/rename', trackId: 't1', name: 'A-name' })
    b.store.dispatch({ type: 'track/rename', trackId: 't1', name: 'B-name' })
    net.drainToHost(b)
    // A now receives B's authoritative op while its own is still pending:
    // the rebase must keep A's optimistic value (it is later in host order).
    while (a.fromHost.length > 0) a.session.handleMessage(a.fromHost.shift()!)
    expect(a.store.state.tracks['t1'].name).toBe('A-name')
    expect(a.store.confirmedState.tracks['t1'].name).toBe('B-name')

    net.flush()
    net.expectConverged()
    expect(net.hostStore.state.tracks['t1'].name).toBe('A-name')
  })

  test('offline editing: reconnect resyncs, replays the backlog, converges', () => {
    const net = new TestNetwork()
    const a = net.addClient('alice')
    const b = net.addClient('bob')
    net.flush()

    net.disconnect(a)
    // Both sides edit during the partition.
    a.store.dispatch({ type: 'clip/create', clip: makeClip('c-offline', 't1', PPQ * 8) })
    a.store.dispatch({ type: 'track/rename', trackId: 't2', name: 'Offline Rename' })
    b.store.dispatch({ type: 'clip/move', clipId: 'c1', trackId: 't2', start: PPQ * 2 })
    net.flush()
    expect(a.store.pendingOps).toHaveLength(2)

    net.connect(a)
    net.flush()

    net.expectConverged()
    const s = net.hostStore.state
    expect(s.clips['c-offline']).toBeDefined()
    expect(s.tracks['t2'].name).toBe('Offline Rename')
    expect(s.clips['c1'].trackId).toBe('t2')
  })

  test('ops delivered twice (at-least-once transport) cause no double effects', () => {
    const net = new TestNetwork()
    const a = net.addClient('alice')
    net.addClient('bob')
    net.flush()

    a.store.dispatch({ type: 'clip/create', clip: makeClip('c-dup', 't1', PPQ * 4) })
    a.store.dispatch({ type: 'clip/resize', clipId: 'c1', start: PPQ, duration: PPQ * 2, offset: 0 })
    // Duplicate every outbound op message.
    a.toHost = a.toHost.flatMap((m): ClientToHost[] => (m.t === 'op' ? [m, m] : [m]))
    net.flush()

    net.expectConverged()
    expect(Object.keys(net.hostStore.state.clips).sort()).toEqual(['c-dup', 'c1'].sort())
  })

  test('a client op whose target a peer deleted no-ops but still drains pending', () => {
    const net = new TestNetwork()
    const a = net.addClient('alice')
    const b = net.addClient('bob')
    net.flush()

    b.store.dispatch({ type: 'clip/delete', clipId: 'c1' })
    net.drainToHost(b)
    // A hasn't heard yet and edits the now-dead clip.
    a.store.dispatch({ type: 'clip/rename', clipId: 'c1', name: 'Ghost' })
    net.drainToHost(a) // no-ops on host -> op-noop ack
    net.flush()

    net.expectConverged()
    expect(net.hostStore.state.clips['c1']).toBeUndefined()
  })

  test('undo travels as a normal op and syncs to everyone', () => {
    const net = new TestNetwork()
    const a = net.addClient('alice')
    const b = net.addClient('bob')
    net.flush()

    a.store.dispatch({ type: 'clip/create', clip: makeClip('c-undo', 't2', 0) })
    net.flush()
    expect(b.store.state.clips['c-undo']).toBeDefined()

    a.store.undo()
    net.flush()

    net.expectConverged()
    expect(net.hostStore.state.clips['c-undo']).toBeUndefined()
    expect(b.store.state.clips['c-undo']).toBeUndefined()
  })

  test('late joiner receives the full current document', () => {
    const net = new TestNetwork()
    const a = net.addClient('alice')
    net.flush()
    a.store.dispatch({ type: 'track/create', track: makeTrack('t3', 'midi'), index: 2, clips: [] })
    net.flush()

    const c = net.addClient('carol')
    net.flush()
    expect(c.store.state).toEqual(net.hostStore.state)
    expect(c.store.state.tracks['t3']).toBeDefined()
  })

  test('leaving adopts the displayed state as a plain local project', () => {
    const net = new TestNetwork()
    const a = net.addClient('alice')
    net.flush()

    net.disconnect(a)
    a.store.dispatch({ type: 'track/rename', trackId: 't1', name: 'Mine Now' })
    a.session.leave()

    expect(a.store.pendingOps).toHaveLength(0)
    expect(a.store.state.tracks['t1'].name).toBe('Mine Now')
    expect(a.store.confirmedState).toEqual(a.store.state)
    // Still fully editable and undoable offline.
    expect(a.store.undo()).toBe(true)
    expect(a.store.state.tracks['t1'].name).toBe('t1')
  })
})

// ---------- fuzz ----------

suite('session fuzz', () => {
  test('random concurrent editing with partitions converges (seeded)', () => {
    for (const seed of [42, 1337, 99991]) {
      const rng = mulberry32(seed)
      const net = new TestNetwork(seed)
      const clients = [net.addClient('alice'), net.addClient('bob'), net.addClient('carol')]
      net.flush()

      const actors = [
        { name: 'host', store: net.hostStore, client: null as TestClient | null },
        ...clients.map((c) => ({ name: c.name, store: c.store, client: c }))
      ]

      let idCounter = 0
      const randomOp = (store: ProjectStore): boolean => {
        const s = store.state
        const trackIds = Object.keys(s.tracks)
        const clipIds = Object.keys(s.clips)
        const fileIds = Object.keys(s.files)
        const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]
        const roll = rng()

        if (roll < 0.1) {
          return store.dispatch({
            type: 'track/create',
            track: makeTrack(`t-${seed}-${idCounter++}`),
            index: Math.floor(rng() * (trackIds.length + 1)),
            clips: []
          })
        }
        if (roll < 0.3 && trackIds.length > 0) {
          return store.dispatch({
            type: 'clip/create',
            clip: makeClip(
              `c-${seed}-${idCounter++}`,
              pick(trackIds),
              Math.floor(rng() * 32) * PPQ
            )
          })
        }
        if (roll < 0.45 && clipIds.length > 0 && trackIds.length > 0) {
          return store.dispatch({
            type: 'clip/move',
            clipId: pick(clipIds),
            trackId: pick(trackIds),
            start: Math.floor(rng() * 64) * (PPQ / 4)
          })
        }
        if (roll < 0.55 && clipIds.length > 0) {
          return store.dispatch({ type: 'clip/rename', clipId: pick(clipIds), name: `n${idCounter++}` })
        }
        if (roll < 0.62 && clipIds.length > 0) {
          return store.dispatch({ type: 'clip/delete', clipId: pick(clipIds) })
        }
        if (roll < 0.7 && trackIds.length > 1) {
          return store.dispatch({ type: 'track/delete', trackId: pick(trackIds) })
        }
        if (roll < 0.78 && trackIds.length > 0) {
          return store.dispatch({
            type: 'track/setMute',
            trackId: pick(trackIds),
            muted: rng() < 0.5
          })
        }
        if (roll < 0.84) {
          return store.dispatch({
            type: 'file/create',
            nodes: [
              {
                id: `f-${seed}-${idCounter++}`,
                parentId: fileIds.length > 0 && rng() < 0.4
                  ? (() => {
                      const folders = fileIds.filter((id) => s.files[id].kind === 'folder')
                      return folders.length > 0 ? pick(folders) : null
                    })()
                  : null,
                kind: rng() < 0.5 ? 'folder' : 'audio',
                name: `file${idCounter}`,
                assetId: null
              }
            ]
          })
        }
        if (roll < 0.88 && fileIds.length > 0) {
          return store.dispatch({ type: 'file/delete', nodeIds: [pick(fileIds)] })
        }
        if (roll < 0.94) {
          return store.undo()
        }
        return store.redo()
      }

      for (let i = 0; i < 400; i++) {
        const actor = actors[Math.floor(rng() * actors.length)]
        randomOp(actor.store)

        // Randomly deliver a few messages so streams interleave heavily.
        const deliveries = Math.floor(rng() * 4)
        for (let d = 0; d < deliveries; d++) net.step()

        // Occasionally partition and heal a client.
        if (rng() < 0.02 && actor.client && actor.client.connected && net.clients.filter((c) => c.connected).length > 1) {
          net.disconnect(actor.client)
        }
        if (rng() < 0.04) {
          const offline = net.clients.find((c) => !c.connected)
          if (offline) net.connect(offline)
        }
      }

      // Heal all partitions and drain everything.
      for (const c of net.clients) if (!c.connected) net.connect(c)
      net.flush()

      net.expectConverged()
    }
  })
})
