import { describe, expect, test } from 'vitest'
import type { Clip, ProjectState, Track } from '../../model/types'
import { createEmptyProject } from '../../model/types'
import { apply } from '../../ops/apply'
import type { Operation, OpEnvelope } from '../../ops/operations'
import type { ProjectLineage } from '../../state/store'
import { mergeForks, type ProjectFork } from '../merge'

function track(id: string, name = id): Track {
  return {
    id,
    kind: 'audio',
    name,
    color: '#5b8def',
    muted: false,
    soloed: false,
    parentId: null,
    frozenAssetId: null,
    volume: 1,
    pan: 0,
    synth: {}
  }
}

function clip(id: string, trackId: string, start = 0, duration = 960): Clip {
  return {
    id,
    trackId,
    name: id,
    start,
    duration,
    assetId: null,
    offset: 0,
    color: null,
    fadeIn: 0,
    fadeOut: 0,
    reverse: false,
    pitch: 0,
    stretch: 1,
    loopLength: 0
  }
}

function origin(): ProjectState {
  let s = createEmptyProject('Merge test')
  s = apply(s, {
    type: 'track/create',
    track: track('t1'),
    index: 0,
    clips: [],
    automation: [],
    notes: [],
    plugins: []
  })
  s = apply(s, { type: 'clip/create', clip: clip('c1', 't1'), notes: [] })
  return s
}

function env(id: string, time: number, op: Operation, userId = 'u1'): OpEnvelope {
  return { id, userId, time, op }
}

function lineage(originState: ProjectState, originTime = 0, projectId = 'prj_x'): ProjectLineage {
  return { projectId, originTime, origin: originState }
}

function fork(log: OpEnvelope[], line = lineage(origin())): ProjectFork {
  return { lineage: line, log }
}

describe('mergeForks', () => {
  test('rejects forks of different projects', () => {
    const a = fork([], lineage(origin(), 0, 'prj_a'))
    const b = fork([], lineage(origin(), 0, 'prj_b'))
    expect(() => mergeForks(a, b)).toThrow(/not copies of the same project/)
  })

  test('per-field last-write-wins across forks, both fields at once', () => {
    // Fork A: newer pan, older volume. Fork B: newer volume, older pan.
    const a = fork([
      env('op_a1', 10, { type: 'track/setVolume', trackId: 't1', volume: 0.2 }),
      env('op_a2', 40, { type: 'track/setPan', trackId: 't1', pan: -0.5 })
    ])
    const b = fork([
      env('op_b1', 20, { type: 'track/setPan', trackId: 't1', pan: 0.9 }),
      env('op_b2', 30, { type: 'track/setVolume', trackId: 't1', volume: 0.8 })
    ])
    const merged = mergeForks(a, b)
    expect(merged.state.tracks.t1.volume).toBe(0.8) // B's is newer
    expect(merged.state.tracks.t1.pan).toBe(-0.5) // A's is newer
  })

  test('shared history is deduped by envelope id', () => {
    const shared = env('op_shared', 5, { type: 'track/rename', trackId: 't1', name: 'Shared' })
    const a = fork([shared, env('op_a', 10, { type: 'track/setVolume', trackId: 't1', volume: 0.5 })])
    const b = fork([shared])
    const merged = mergeForks(a, b)
    expect(merged.log.filter((e) => e.id === 'op_shared')).toHaveLength(1)
    expect(merged.state.tracks.t1.name).toBe('Shared')
    expect(merged.state.tracks.t1.volume).toBe(0.5)
  })

  test('is deterministic regardless of argument order', () => {
    const a = fork([
      env('op_a1', 10, { type: 'clip/move', clipId: 'c1', trackId: 't1', start: 480 }),
      env('op_a2', 10, { type: 'track/rename', trackId: 't1', name: 'From A' })
    ])
    const b = fork([env('op_b1', 10, { type: 'track/rename', trackId: 't1', name: 'From B' })])
    const ab = mergeForks(a, b)
    const ba = mergeForks(b, a)
    expect(ab.state).toEqual(ba.state)
    expect(ab.log.map((e) => e.id)).toEqual(ba.log.map((e) => e.id))
  })

  test('delete beats an older move; a move after a delete is dropped', () => {
    // A moved the clip at t=10; B deleted it at t=20 → gone.
    const merged1 = mergeForks(
      fork([env('op_move', 10, { type: 'clip/move', clipId: 'c1', trackId: 't1', start: 480 })]),
      fork([env('op_del', 20, { type: 'clip/delete', clipId: 'c1' })])
    )
    expect(merged1.state.clips.c1).toBeUndefined()

    // B deleted at t=10; A's later move (t=20) targets a gone clip → dropped, still gone.
    const merged2 = mergeForks(
      fork([env('op_move', 20, { type: 'clip/move', clipId: 'c1', trackId: 't1', start: 480 })]),
      fork([env('op_del', 10, { type: 'clip/delete', clipId: 'c1' })])
    )
    expect(merged2.state.clips.c1).toBeUndefined()
    expect(merged2.dropped).toBe(1)
  })

  test('independent additions from both forks both survive', () => {
    const a = fork([
      env('op_a', 10, {
        type: 'track/create',
        track: track('t2', 'From A'),
        index: 1,
        clips: [],
        automation: [],
        notes: [],
        plugins: []
      })
    ])
    const b = fork([env('op_b', 20, { type: 'clip/create', clip: clip('c2', 't1', 1920), notes: [] })])
    const merged = mergeForks(a, b)
    expect(merged.state.tracks.t2?.name).toBe('From A')
    expect(merged.state.clips.c2?.start).toBe(1920)
    expect(merged.state.clips.c1).toBeDefined()
  })

  test('uses the earliest origin as base (collab guest with later origin)', () => {
    // Host fork: origin at t=0, log covers everything including the rename
    // that is already baked into the guest's welcome-snapshot origin.
    const hostLog = [
      env('op_pre', 5, { type: 'track/rename', trackId: 't1', name: 'Before welcome' }),
      env('op_host', 30, { type: 'track/setVolume', trackId: 't1', volume: 0.3 })
    ]
    const host = fork(hostLog, lineage(origin(), 0))

    // Guest origin = host state at welcome (t=10): rename already applied.
    let guestOrigin = origin()
    guestOrigin = apply(guestOrigin, hostLog[0].op)
    const guest: ProjectFork = {
      lineage: lineage(guestOrigin, 10),
      log: [env('op_guest', 40, { type: 'track/setPan', trackId: 't1', pan: 0.4 })]
    }

    const merged = mergeForks(guest, host)
    expect(merged.lineage.originTime).toBe(0) // host's origin won
    expect(merged.state.tracks.t1.name).toBe('Before welcome')
    expect(merged.state.tracks.t1.volume).toBe(0.3)
    expect(merged.state.tracks.t1.pan).toBe(0.4)
  })

  test('merged lineage + log reproduces the merged state (merges chain)', () => {
    const a = fork([env('op_a', 10, { type: 'track/setVolume', trackId: 't1', volume: 0.6 })])
    const b = fork([env('op_b', 20, { type: 'clip/delete', clipId: 'c1' })])
    const merged = mergeForks(a, b)

    let replayed = merged.lineage.origin
    for (const e of merged.log) replayed = apply(replayed, e.op)
    expect(replayed).toEqual(merged.state)
  })
})
