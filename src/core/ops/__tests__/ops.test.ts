import { describe as suite, expect, test } from 'vitest'
import type { Clip, ProjectState, Track } from '../../model/types'
import { createEmptyProject } from '../../model/types'
import type { Operation } from '../operations'
import { apply } from '../apply'
import { invert } from '../invert'
import { ProjectStore } from '../../state/store'

function track(id: string, name = id): Track {
  return { id, kind: 'audio', name, color: '#5b8def', muted: false, soloed: false }
}

function clip(id: string, trackId: string, start = 0, duration = 960): Clip {
  return { id, trackId, name: id, start, duration, color: null }
}

function baseState(): ProjectState {
  let s = createEmptyProject('Test')
  s = apply(s, { type: 'track/create', track: track('t1'), index: 0, clips: [] })
  s = apply(s, { type: 'track/create', track: track('t2'), index: 1, clips: [] })
  s = apply(s, { type: 'clip/create', clip: clip('c1', 't1', 0, 960) })
  s = apply(s, { type: 'clip/create', clip: clip('c2', 't1', 1920, 960) })
  return s
}

suite('apply', () => {
  test('moves a clip across tracks and clamps start to zero', () => {
    const s = apply(baseState(), { type: 'clip/move', clipId: 'c1', trackId: 't2', start: -500 })
    expect(s.clips['c1'].trackId).toBe('t2')
    expect(s.clips['c1'].start).toBe(0)
  })

  test('deleting a track also deletes its clips', () => {
    const s = apply(baseState(), { type: 'track/delete', trackId: 't1' })
    expect(s.tracks['t1']).toBeUndefined()
    expect(s.trackOrder).toEqual(['t2'])
    expect(Object.keys(s.clips)).toHaveLength(0)
  })

  test('ops targeting missing entities are no-ops returning identical state', () => {
    const s = baseState()
    expect(apply(s, { type: 'clip/move', clipId: 'ghost', trackId: 't1', start: 0 })).toBe(s)
    expect(apply(s, { type: 'track/rename', trackId: 'ghost', name: 'x' })).toBe(s)
    expect(apply(s, { type: 'clip/create', clip: clip('c3', 'ghost-track') })).toBe(s)
  })

  test('never mutates the input state', () => {
    const s = baseState()
    const frozen = JSON.stringify(s)
    apply(s, { type: 'clip/resize', clipId: 'c1', start: 480, duration: 480 })
    apply(s, { type: 'track/delete', trackId: 't1' })
    expect(JSON.stringify(s)).toBe(frozen)
  })
})

suite('invert', () => {
  const roundTrips: Operation[] = [
    { type: 'project/rename', name: 'Renamed' },
    { type: 'project/setTempo', tempo: 140 },
    { type: 'track/create', track: track('t9'), index: 1, clips: [clip('c9', 't9')] },
    { type: 'track/delete', trackId: 't1' },
    { type: 'track/rename', trackId: 't2', name: 'Renamed Track' },
    { type: 'track/setMute', trackId: 't1', muted: true },
    { type: 'track/setSolo', trackId: 't2', soloed: true },
    { type: 'track/reorder', trackId: 't2', index: 0 },
    { type: 'clip/create', clip: clip('c9', 't2', 480) },
    { type: 'clip/delete', clipId: 'c1' },
    { type: 'clip/move', clipId: 'c1', trackId: 't2', start: 4800 },
    { type: 'clip/resize', clipId: 'c2', start: 960, duration: 1920 },
    { type: 'clip/rename', clipId: 'c2', name: 'Renamed Clip' }
  ]

  for (const op of roundTrips) {
    test(`apply(invert) restores state for ${op.type}`, () => {
      const before = baseState()
      const inverse = invert(before, op)
      expect(inverse).not.toBeNull()
      const after = apply(before, op)
      expect(after).not.toBe(before) // sanity: op actually did something
      expect(apply(after, inverse!)).toEqual(before)
    })
  }
})

suite('ProjectStore', () => {
  test('undo/redo round-trips a sequence of edits', () => {
    const store = new ProjectStore(baseState(), 'tester')
    store.dispatch({ type: 'clip/move', clipId: 'c1', trackId: 't2', start: 960 })
    store.dispatch({ type: 'track/rename', trackId: 't1', name: 'Drums' })
    const edited = store.state

    store.undo()
    store.undo()
    expect(store.state).toEqual(baseState())
    expect(store.canUndo).toBe(false)

    store.redo()
    store.redo()
    expect(store.state).toEqual(edited)
    expect(store.canRedo).toBe(false)
  })

  test('remote ops are not undoable locally', () => {
    const store = new ProjectStore(baseState(), 'tester')
    store.dispatch({ type: 'track/setMute', trackId: 't1', muted: true }, 'remote', 'peer-1')
    expect(store.canUndo).toBe(false)
    expect(store.state.tracks['t1'].muted).toBe(true)
  })

  test('activity feed records ops with the acting user', () => {
    const store = new ProjectStore(baseState(), 'tester')
    store.dispatch({ type: 'track/rename', trackId: 't1', name: 'Drums' })
    store.dispatch({ type: 'track/setMute', trackId: 't1', muted: true }, 'remote', 'peer-1')
    const texts = store.activity.map((a) => `${a.userId}: ${a.text}`)
    expect(texts).toEqual(['tester: Renamed track "t1" to "Drums"', 'peer-1: Muted "Drums"'])
  })

  test('op listeners see every commit with its source', () => {
    const store = new ProjectStore(baseState(), 'tester')
    const seen: string[] = []
    store.onOperation((env, source) => seen.push(`${source}:${env.op.type}`))
    store.dispatch({ type: 'project/setTempo', tempo: 90 })
    store.undo()
    expect(seen).toEqual(['local:project/setTempo', 'history:project/setTempo'])
  })
})
