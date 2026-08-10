import { describe as suite, expect, test } from 'vitest'
import { AssetStore, type AudioBufferLike } from '../assets'

/** Minimal stand-in: the store only reads shape, never plays it. */
function fakeBuffer(seconds: number, sampleRate = 10): AudioBuffer {
  const length = Math.round(seconds * sampleRate)
  const data = new Float32Array(length)
  const like: AudioBufferLike = {
    numberOfChannels: 1,
    length,
    sampleRate,
    getChannelData: () => data
  }
  return like as unknown as AudioBuffer
}

function storeWithTwo(): AssetStore {
  const store = new AssetStore()
  store.restore('a1', 'one.wav', 'audio', 'wav', new Uint8Array([1, 2]), fakeBuffer(2))
  store.restore('a2', 'two.wav', 'audio', 'wav', new Uint8Array([3]), fakeBuffer(3))
  return store
}

suite('AssetStore eviction', () => {
  test('evict frees only the requested decoded buffers and keeps bytes + metadata', () => {
    const store = storeWithTwo()
    expect(store.evict(new Set(['a2']), new Set())).toBe(1)
    expect(store.get('a1')!.buffer).not.toBeNull()
    const evicted = store.get('a2')!
    expect(evicted.buffer).toBeNull()
    // Save/transfer source of truth and re-decode-free metadata survive.
    expect(evicted.encoded).toEqual(new Uint8Array([3]))
    expect(evicted.seconds).toBeCloseTo(3)
    expect(store.getSeconds('a2')).toBeCloseTo(3)
    // Evicting again is a no-op, not a second "freed" count.
    expect(store.evict(new Set(['a2']), new Set())).toBe(0)
  })

  test('reversed copies live only while kept, and die with their asset', () => {
    const store = storeWithTwo()
    let builds = 0
    const create = (channels: Float32Array[], sampleRate: number): AudioBuffer => {
      builds++
      return fakeBuffer(channels[0].length / sampleRate, sampleRate)
    }
    store.reversedBuffer('a1', create)
    store.reversedBuffer('a1', create)
    expect(builds).toBe(1) // cached

    store.evict(new Set(), new Set(['a1'])) // kept
    store.reversedBuffer('a1', create)
    expect(builds).toBe(1)

    store.evict(new Set(), new Set()) // no clip plays it reversed anymore
    store.reversedBuffer('a1', create)
    expect(builds).toBe(2) // rebuilt on demand

    // Evicting the asset itself always drops the mirror; with no decoded
    // source the mirror cannot be rebuilt until rehydration.
    store.evict(new Set(['a1']), new Set(['a1']))
    expect(store.reversedBuffer('a1', create)).toBeNull()
    expect(builds).toBe(2)
  })

  test('rehydrate re-attaches a buffer and notifies as restored', () => {
    const store = storeWithTwo()
    store.evict(new Set(['a2']), new Set())
    const events: Array<{ id: string; origin: string } | null> = []
    store.subscribe((event) => {
      events.push(event ? { id: event.asset.id, origin: event.origin } : null)
    })

    store.rehydrate('a2', fakeBuffer(3))
    expect(store.get('a2')!.buffer).not.toBeNull()
    expect(store.get('a2')!.seconds).toBeCloseTo(3)
    expect(events).toContainEqual({ id: 'a2', origin: 'restored' })

    // Rehydrating something never evicted is a no-op — no event.
    const before = events.length
    store.rehydrate('a1', fakeBuffer(2))
    expect(events.length).toBe(before)
  })
})
