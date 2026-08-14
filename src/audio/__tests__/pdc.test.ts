import { describe as suite, expect, test } from 'vitest'
import { computePdc, pdcDelaysOf, type PdcTrack } from '../pdc'

/**
 * Plugin-delay compensation over the folder-bus graph.
 *
 * The property under test is always the same one, and it is the only one
 * that matters: every source in the project reaches the master having been
 * delayed by the SAME total. Each case states that as an explicit sum, so
 * a wrong answer names the path it got wrong rather than a number.
 */

const track = (id: string, parentId: string | null, latencySamples = 0): PdcTrack => ({
  id,
  parentId,
  latencySamples
})

/**
 * What a track's own material is delayed by on its way to the master:
 * its source compensation, then its own plugins and output compensation,
 * then the same for every bus above it.
 */
function totalForSources(tracks: readonly PdcTrack[], id: string): number {
  const plan = computePdc(tracks)
  const byId = new Map(tracks.map((t) => [t.id, t]))
  let total = pdcDelaysOf(plan, id).sourceSamples
  let current: string | null = id
  const seen = new Set<string>()
  while (current !== null && !seen.has(current)) {
    seen.add(current)
    const node: PdcTrack | undefined = byId.get(current)
    if (!node) break
    total += node.latencySamples + pdcDelaysOf(plan, current).outputSamples
    current = node.parentId !== null && byId.has(node.parentId) ? node.parentId : null
  }
  return total
}

suite('computePdc', () => {
  test('a project with no latency compensates nothing', () => {
    const plan = computePdc([track('a', null), track('b', null)])
    expect(plan.totalSamples).toBe(0)
    expect(plan.byTrack.size).toBe(0)
    expect(pdcDelaysOf(plan, 'a')).toEqual({ sourceSamples: 0, outputSamples: 0 })
  })

  test('one latent track delays its siblings by exactly its latency', () => {
    const tracks = [track('latent', null, 1024), track('plain', null), track('other', null)]
    const plan = computePdc(tracks)
    expect(plan.totalSamples).toBe(1024)
    // The latent track waits for nobody; the others wait for it.
    expect(pdcDelaysOf(plan, 'latent')).toEqual({ sourceSamples: 0, outputSamples: 0 })
    expect(pdcDelaysOf(plan, 'plain').outputSamples).toBe(1024)
    for (const id of ['latent', 'plain', 'other']) {
      expect(totalForSources(tracks, id)).toBe(1024)
    }
  })

  test('the deepest path sets the total, not the sum of all of them', () => {
    const tracks = [track('a', null, 300), track('b', null, 700), track('c', null)]
    const plan = computePdc(tracks)
    expect(plan.totalSamples).toBe(700)
    expect(pdcDelaysOf(plan, 'a').outputSamples).toBe(400)
    expect(pdcDelaysOf(plan, 'b').outputSamples).toBe(0)
    expect(pdcDelaysOf(plan, 'c').outputSamples).toBe(700)
  })

  test('a latent child aligns at its folder, not at the master', () => {
    // Two children of one folder; only one is latent. They must align
    // where they meet — the folder's input — and the folder's own plugin
    // then applies to both equally.
    const tracks = [
      track('folder', null, 200),
      track('latent', 'folder', 500),
      track('plain', 'folder'),
      track('outside', null)
    ]
    const plan = computePdc(tracks)
    expect(pdcDelaysOf(plan, 'plain').outputSamples).toBe(500)
    expect(pdcDelaysOf(plan, 'latent').outputSamples).toBe(0)
    // The folder waits 500 for its children before its own 200 applies,
    // so anything outside it waits 700.
    expect(plan.totalSamples).toBe(700)
    expect(pdcDelaysOf(plan, 'outside').outputSamples).toBe(700)
    for (const id of ['latent', 'plain', 'outside']) {
      expect(totalForSources(tracks, id)).toBe(700)
    }
  })

  test("a folder's own material waits for its children, its children do not", () => {
    // The case the second delay node exists for: a folder with clips of
    // its own AND a latent child. Its sources need the child's delay; the
    // child must not also get it.
    const tracks = [track('folder', null), track('latent', 'folder', 480)]
    const plan = computePdc(tracks)
    expect(pdcDelaysOf(plan, 'folder').sourceSamples).toBe(480)
    expect(pdcDelaysOf(plan, 'folder').outputSamples).toBe(0)
    expect(pdcDelaysOf(plan, 'latent')).toEqual({ sourceSamples: 0, outputSamples: 0 })
    expect(totalForSources(tracks, 'folder')).toBe(480)
    expect(totalForSources(tracks, 'latent')).toBe(480)
  })

  test('latency accumulates down a nested folder chain', () => {
    const tracks = [
      track('outer', null, 100),
      track('inner', 'outer', 50),
      track('leaf', 'inner', 25),
      track('bare', null)
    ]
    const plan = computePdc(tracks)
    expect(plan.totalSamples).toBe(175)
    expect(pdcDelaysOf(plan, 'bare').outputSamples).toBe(175)
    expect(totalForSources(tracks, 'leaf')).toBe(175)
    expect(totalForSources(tracks, 'bare')).toBe(175)
    // Every bus's own material waits for what feeds it.
    expect(pdcDelaysOf(plan, 'inner').sourceSamples).toBe(25)
    expect(pdcDelaysOf(plan, 'outer').sourceSamples).toBe(75)
  })

  test('a parentId naming no track routes to master, as the engine does', () => {
    const tracks = [track('orphan', 'gone', 64), track('plain', null)]
    const plan = computePdc(tracks)
    expect(plan.totalSamples).toBe(64)
    expect(pdcDelaysOf(plan, 'plain').outputSamples).toBe(64)
  })

  test('a parent cycle is broken rather than hung', () => {
    const plan = computePdc([track('a', 'b', 10), track('b', 'a', 20)])
    expect(Number.isFinite(plan.totalSamples)).toBe(true)
    for (const delays of plan.byTrack.values()) {
      expect(delays.sourceSamples).toBeGreaterThanOrEqual(0)
      expect(delays.outputSamples).toBeGreaterThanOrEqual(0)
    }
  })

  test('a negative reported latency never becomes a negative delay', () => {
    const plan = computePdc([track('bad', null, -500), track('plain', null, 100)])
    expect(plan.totalSamples).toBe(100)
    expect(pdcDelaysOf(plan, 'bad').outputSamples).toBe(100)
  })
})
