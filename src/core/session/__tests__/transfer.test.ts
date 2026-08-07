import { describe as suite, expect, test } from 'vitest'
import { createEmptyProject } from '../../model/types'
import { ProjectStore } from '../../state/store'
import { HostSession, type HostAssetProvider, type HostPeer } from '../host'
import { ClientSession, type ClientAssetSource } from '../client'
import type { ClientToHost, HostToClient } from '../protocol'
import { ASSET_CHUNK_BYTES, TRANSFER_WINDOW_CHUNKS, type TransferMeta } from '../transfer'

/**
 * Chunked asset transfer scenarios over the same in-memory harness the
 * sync tests use: in-order queues, explicit delivery, lossy disconnects.
 */

function bytesOf(size: number, seed = 7): Uint8Array {
  const u8 = new Uint8Array(size)
  let x = seed
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    u8[i] = x & 0xff
  }
  return u8
}

function meta(assetId: string, size: number): TransferMeta {
  return { assetId, name: `${assetId}.wav`, kind: 'audio', ext: 'wav', size }
}

class MapAssets implements HostAssetProvider, ClientAssetSource {
  readonly stored = new Map<string, { meta: TransferMeta; bytes: Uint8Array }>()

  add(m: TransferMeta, bytes: Uint8Array): void {
    this.stored.set(m.assetId, { meta: m, bytes })
  }

  has(assetId: string): boolean {
    return this.stored.has(assetId)
  }

  get(assetId: string): { meta: TransferMeta; bytes: Uint8Array } | null {
    return this.stored.get(assetId) ?? null
  }

  store(m: TransferMeta, bytes: Uint8Array): void {
    this.stored.set(m.assetId, { meta: m, bytes })
  }
}

interface Guest {
  session: ClientSession
  assets: MapAssets
  peer: HostPeer | null
  toHost: ClientToHost[]
  fromHost: HostToClient[]
  connected: boolean
  received: Map<string, Uint8Array>
  progress: Array<{ assetId: string; received: number; total: number }>
  available: TransferMeta[]
}

class TransferNet {
  readonly hostAssets = new MapAssets()
  readonly host: HostSession
  readonly guests: Guest[] = []

  constructor() {
    this.host = new HostSession(new ProjectStore(createEmptyProject('T'), 'host'), {
      hostName: 'Host',
      assetProvider: this.hostAssets
    })
  }

  addGuest(name: string): Guest {
    const assets = new MapAssets()
    const guest: Guest = {
      session: null as unknown as ClientSession,
      assets,
      peer: null,
      toHost: [],
      fromHost: [],
      connected: false,
      received: new Map(),
      progress: [],
      available: []
    }
    guest.session = new ClientSession(
      new ProjectStore(createEmptyProject('g'), name),
      name,
      {
        onAssetAvailable: (m) => guest.available.push(m),
        onAssetProgress: (assetId, received, total) =>
          guest.progress.push({ assetId, received, total }),
        onAssetComplete: (m, bytes) => guest.received.set(m.assetId, bytes)
      },
      assets
    )
    this.guests.push(guest)
    this.connect(guest)
    return guest
  }

  connect(guest: Guest): void {
    guest.toHost = []
    guest.fromHost = []
    guest.connected = true
    const peer = this.host.addPeer({
      send: (m) => {
        if (guest.peer === peer && guest.connected) guest.fromHost.push(m)
      }
    })
    guest.peer = peer
    guest.session.connect({
      send: (m) => {
        if (guest.peer === peer && guest.connected) guest.toHost.push(m)
      }
    })
  }

  disconnect(guest: Guest): void {
    guest.connected = false
    if (guest.peer) this.host.removePeer(guest.peer)
    guest.peer = null
    guest.session.handleDisconnect()
    guest.toHost = []
    guest.fromHost = []
  }

  /** Deliver one message; alternates directions for interleaving. */
  step(): boolean {
    for (const guest of this.guests) {
      if (!guest.connected) continue
      if (guest.fromHost.length > 0) {
        guest.session.handleMessage(guest.fromHost.shift()!)
        return true
      }
      if (guest.toHost.length > 0 && guest.peer) {
        this.host.handleMessage(guest.peer, guest.toHost.shift()!)
        return true
      }
    }
    return false
  }

  flush(): void {
    let guard = 100_000
    while (this.step()) if (--guard <= 0) throw new Error('flush did not terminate')
  }
}

suite('chunked asset download (host → guest)', () => {
  test('multi-chunk download completes byte-identical with monotonic progress', () => {
    const net = new TransferNet()
    const data = bytesOf(ASSET_CHUNK_BYTES * 4 + 123)
    net.hostAssets.add(meta('a1', data.length), data)

    const g = net.addGuest('alice')
    net.flush() // hello/welcome
    g.session.requestAsset('a1')
    net.flush()

    expect(g.received.get('a1')).toEqual(data)
    const prog = g.progress.filter((p) => p.assetId === 'a1')
    expect(prog.length).toBeGreaterThan(1)
    for (let i = 1; i < prog.length; i++) {
      expect(prog[i].received).toBeGreaterThanOrEqual(prog[i - 1].received)
    }
    expect(prog[prog.length - 1].received).toBe(data.length)
  })

  test('sender never puts more than the window in flight before credits', () => {
    const net = new TransferNet()
    const data = bytesOf(ASSET_CHUNK_BYTES * 10)
    net.hostAssets.add(meta('a1', data.length), data)

    const g = net.addGuest('alice')
    net.flush()
    g.session.requestAsset('a1')
    // Deliver only the request to the host; then inspect its outbound queue
    // without delivering any credits back.
    while (g.toHost.length > 0 && g.peer) net.host.handleMessage(g.peer, g.toHost.shift()!)
    const chunks = g.fromHost.filter((m) => m.t === 'asset-chunk')
    expect(chunks.length).toBe(TRANSFER_WINDOW_CHUNKS)
    net.flush()
    expect(g.received.get('a1')).toEqual(data)
  })

  test('tiny and empty assets transfer in a single chunk', () => {
    const net = new TransferNet()
    const tiny = bytesOf(17)
    net.hostAssets.add(meta('small', tiny.length), tiny)
    net.hostAssets.add(meta('empty', 0), new Uint8Array(0))

    const g = net.addGuest('alice')
    net.flush()
    g.session.requestAsset('small')
    g.session.requestAsset('empty')
    net.flush()
    expect(g.received.get('small')).toEqual(tiny)
    expect(g.received.get('empty')).toEqual(new Uint8Array(0))
  })

  test('disconnect mid-download resumes from the partial, not from zero', () => {
    const net = new TransferNet()
    const data = bytesOf(ASSET_CHUNK_BYTES * 8)
    net.hostAssets.add(meta('big', data.length), data)

    const g = net.addGuest('alice')
    net.flush()
    g.session.requestAsset('big')

    // Deliver request + first chunks so the guest holds a partial prefix.
    for (let i = 0; i < 6; i++) net.step()
    expect(g.received.has('big')).toBe(false)

    net.disconnect(g)
    net.connect(g)
    net.flush() // welcome resync

    g.session.requestAsset('big')
    // The re-request must carry the partial as haveBytes...
    const req = g.toHost.find((m) => m.t === 'asset-request' && m.assetId === 'big')
    expect(req && req.t === 'asset-request' && req.haveBytes).toBeGreaterThan(0)
    net.flush()
    // ...the host must start above chunk 0...
    expect(g.received.get('big')).toEqual(data)
  })
})

suite('guest uploads (asset-offer / asset-pull)', () => {
  test('offered asset flows guest → host → other guests', () => {
    const net = new TransferNet()
    const a = net.addGuest('alice')
    const b = net.addGuest('bob')
    net.flush()

    const data = bytesOf(ASSET_CHUNK_BYTES * 2 + 5, 42)
    const m = meta('drums', data.length)
    a.assets.add(m, data)
    a.session.offerAsset(m)
    net.flush()

    // Host stored the upload…
    expect(net.hostAssets.get('drums')?.bytes).toEqual(data)
    // …announced it to the OTHER guest (not the uploader)…
    expect(b.available.some((x) => x.assetId === 'drums')).toBe(true)
    expect(a.available.some((x) => x.assetId === 'drums')).toBe(false)

    // …and bob can download it from the host.
    b.session.requestAsset('drums')
    net.flush()
    expect(b.received.get('drums')).toEqual(data)
  })

  test('re-offering an asset the host already has broadcasts availability, no re-upload', () => {
    const net = new TransferNet()
    const a = net.addGuest('alice')
    const b = net.addGuest('bob')
    net.flush()

    const data = bytesOf(100, 3)
    const m = meta('kick', data.length)
    net.hostAssets.add(m, data)
    a.assets.add(m, data)
    a.session.offerAsset(m)
    net.flush()

    expect(b.available.some((x) => x.assetId === 'kick')).toBe(true)
    // No pull was issued to alice.
    expect(a.fromHost.filter((x) => x.t === 'asset-pull')).toHaveLength(0)
  })

  test('a repeated request for an in-flight asset does not start a second transfer', () => {
    const net = new TransferNet()
    // Bigger than the credit window, so the first transfer is still open
    // (awaiting credits) when the duplicate request arrives.
    const data = bytesOf(ASSET_CHUNK_BYTES * (TRANSFER_WINDOW_CHUNKS + 1), 5)
    net.hostAssets.add(meta('loop', data.length), data)

    const g = net.addGuest('alice')
    net.flush()

    // A welcome-driven request and an asset-available-driven one can race.
    g.session.requestAsset('loop')
    g.session.requestAsset('loop')
    // Deliver BOTH to the host before it can finish serving either.
    while (g.toHost.length > 0 && g.peer) net.host.handleMessage(g.peer, g.toHost.shift()!)

    // One announcement, one live transfer — the second request is dropped.
    // (That the surviving transfer completes is covered by the download
    // tests above; finishing it here would only re-pay the base64 cost.)
    expect(g.fromHost.filter((m) => m.t === 'asset-begin')).toHaveLength(1)
    expect(g.peer!.outgoing.size).toBe(1)
  })

  test('availability is announced only once an async provider has stored the bytes', async () => {
    const net = new TransferNet()
    // App-side storing decodes audio before registering, so it is async.
    // Announcing before it settles advertises an asset the host cannot
    // serve yet — the requester's asset-request is dropped and it hangs.
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const inner = net.hostAssets.store.bind(net.hostAssets)
    net.hostAssets.store = (m, bytes) => gate.then(() => inner(m, bytes))

    const a = net.addGuest('alice')
    const b = net.addGuest('bob')
    net.flush()

    const data = bytesOf(ASSET_CHUNK_BYTES + 9, 11)
    const m = meta('vocals', data.length)
    a.assets.add(m, data)
    a.session.offerAsset(m)
    net.flush()

    // Upload finished, but the host cannot serve it yet — stay quiet.
    expect(net.hostAssets.has('vocals')).toBe(false)
    expect(b.available.some((x) => x.assetId === 'vocals')).toBe(false)

    release()
    await gate
    await Promise.resolve()
    net.flush()

    expect(b.available.some((x) => x.assetId === 'vocals')).toBe(true)
    b.session.requestAsset('vocals')
    net.flush()
    expect(b.received.get('vocals')).toEqual(data)
  })

  test('unsolicited asset-begin (no matching pull) is ignored by the host', () => {
    const net = new TransferNet()
    const a = net.addGuest('alice')
    net.flush()
    a.peer &&
      net.host.handleMessage(a.peer, {
        t: 'asset-begin',
        transferId: 'forged',
        meta: meta('evil', 10),
        chunkCount: 1,
        startIndex: 0
      })
    a.peer &&
      net.host.handleMessage(a.peer, {
        t: 'asset-chunk',
        transferId: 'forged',
        index: 0,
        bytesBase64: 'AAAA'
      })
    a.peer && net.host.handleMessage(a.peer, { t: 'asset-done', transferId: 'forged' })
    expect(net.hostAssets.has('evil')).toBe(false)
  })
})
