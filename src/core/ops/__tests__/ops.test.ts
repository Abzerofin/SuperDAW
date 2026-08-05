import { describe as suite, expect, test } from 'vitest'
import type { Clip, Comment, FileNode, ProjectState, Track } from '../../model/types'
import { createEmptyProject } from '../../model/types'
import { describe as describeOp } from '../describe'
import type { Operation } from '../operations'
import { apply } from '../apply'
import { invert } from '../invert'
import { ProjectStore } from '../../state/store'

function track(id: string, name = id): Track {
  return {
    id,
    kind: 'audio',
    name,
    color: '#5b8def',
    muted: false,
    soloed: false,
    volume: 1,
    pan: 0
  }
}

function clip(id: string, trackId: string, start = 0, duration = 960): Clip {
  return { id, trackId, name: id, start, duration, assetId: null, offset: 0, color: null }
}

function fileNode(id: string, parentId: string | null, kind: FileNode['kind'] = 'audio'): FileNode {
  return { id, parentId, kind, name: id, assetId: kind === 'folder' ? null : `asset-${id}` }
}

function comment(id: string, anchorId: string, parentId: string | null = null): Comment {
  return {
    id,
    anchor: { kind: 'clip', id: anchorId },
    parentId,
    userId: 'u1',
    authorName: 'Tester',
    time: 1000,
    text: `text of ${id}`,
    resolved: false
  }
}

function baseState(): ProjectState {
  let s = createEmptyProject('Test')
  s = apply(s, { type: 'track/create', track: track('t1'), index: 0, clips: [], automation: [], notes: [] })
  s = apply(s, { type: 'track/create', track: track('t2'), index: 1, clips: [], automation: [], notes: [] })
  s = apply(s, { type: 'clip/create', clip: clip('c1', 't1', 0, 960), notes: [] })
  s = apply(s, { type: 'clip/create', clip: clip('c2', 't1', 1920, 960), notes: [] })
  // File bay: root folder f1 containing f2 (folder) and a1; a2 at root
  s = apply(s, {
    type: 'file/create',
    nodes: [
      fileNode('f1', null, 'folder'),
      fileNode('f2', 'f1', 'folder'),
      fileNode('a1', 'f1'),
      fileNode('a2', null)
    ]
  })
  // A comment thread on c1: root cm1 with reply cm2
  s = apply(s, { type: 'comment/add', comments: [comment('cm1', 'c1')] })
  s = apply(s, { type: 'comment/add', comments: [comment('cm2', 'c1', 'cm1')] })
  // Volume automation on t1
  s = apply(s, {
    type: 'automation/add',
    point: { id: 'apA', trackId: 't1', param: 'volume', ticks: 0, value: 1 }
  })
  // A note on c1
  s = apply(s, {
    type: 'note/add',
    note: { id: 'nA', clipId: 'c1', pitch: 60, start: 0, duration: 480, velocity: 100 }
  })
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
    expect(apply(s, { type: 'clip/create', clip: clip('c3', 'ghost-track'), notes: [] })).toBe(s)
  })

  test('never mutates the input state', () => {
    const s = baseState()
    const frozen = JSON.stringify(s)
    apply(s, { type: 'clip/resize', clipId: 'c1', start: 480, duration: 480, offset: 240 })
    apply(s, { type: 'track/delete', trackId: 't1' })
    expect(JSON.stringify(s)).toBe(frozen)
  })
})

suite('invert', () => {
  const roundTrips: Operation[] = [
    { type: 'project/rename', name: 'Renamed' },
    { type: 'project/setTempo', tempo: 140 },
    {
      type: 'track/create',
      track: track('t9'),
      index: 1,
      clips: [clip('c9', 't9')],
      automation: [{ id: 'ap9', trackId: 't9', param: 'volume', ticks: 0, value: 0.5 }],
      notes: [{ id: 'n9', clipId: 'c9', pitch: 60, start: 0, duration: 480, velocity: 100 }]
    },
    { type: 'note/add', note: { id: 'n1', clipId: 'c1', pitch: 64, start: 240, duration: 240, velocity: 90 } },
    { type: 'note/addMany', notes: [
      { id: 'n2', clipId: 'c1', pitch: 62, start: 0, duration: 240, velocity: 80 },
      { id: 'n3', clipId: 'c2', pitch: 65, start: 480, duration: 480, velocity: 80 }
    ] },
    { type: 'note/move', noteId: 'nA', pitch: 67, start: 960 },
    { type: 'note/resize', noteId: 'nA', duration: 960 },
    { type: 'note/delete', noteIds: ['nA'] },
    { type: 'track/setVolume', trackId: 't1', volume: 0.7 },
    { type: 'track/setPan', trackId: 't2', pan: -0.4 },
    { type: 'project/setMasterVolume', volume: 1.2 },
    { type: 'automation/add', point: { id: 'ap1', trackId: 't1', param: 'volume', ticks: 960, value: 0.8 } },
    { type: 'automation/move', pointId: 'apA', ticks: 1920, value: 0.25 },
    { type: 'automation/delete', pointId: 'apA' },
    { type: 'track/delete', trackId: 't1' },
    { type: 'track/rename', trackId: 't2', name: 'Renamed Track' },
    { type: 'track/setMute', trackId: 't1', muted: true },
    { type: 'track/setSolo', trackId: 't2', soloed: true },
    { type: 'track/reorder', trackId: 't2', index: 0 },
    { type: 'clip/create', clip: clip('c9', 't2', 480), notes: [] },
    { type: 'clip/delete', clipId: 'c1' },
    { type: 'clip/move', clipId: 'c1', trackId: 't2', start: 4800 },
    { type: 'clip/resize', clipId: 'c2', start: 960, duration: 1920, offset: 480 },
    { type: 'clip/rename', clipId: 'c2', name: 'Renamed Clip' },
    { type: 'file/create', nodes: [fileNode('f9', null, 'folder'), fileNode('a9', 'f9')] },
    { type: 'file/delete', nodeIds: ['f1'] }, // subtree: f1, f2, a1
    { type: 'file/delete', nodeIds: ['a2', 'f2'] },
    { type: 'file/rename', nodeId: 'a1', name: 'Renamed File' },
    { type: 'file/move', nodeId: 'a2', parentId: 'f2' },
    { type: 'comment/add', comments: [comment('cm9', 'c2')] },
    { type: 'comment/add', comments: [comment('cm9', 'c1', 'cm1')] },
    { type: 'comment/delete', commentId: 'cm2' }, // a reply
    { type: 'comment/delete', commentId: 'cm1' }, // a thread root + its reply
    { type: 'comment/setResolved', commentId: 'cm1', resolved: true }
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

suite('file bay ops', () => {
  test('deleting a folder deletes its whole subtree', () => {
    const s = apply(baseState(), { type: 'file/delete', nodeIds: ['f1'] })
    expect(Object.keys(s.files).sort()).toEqual(['a2'])
  })

  test('a folder cannot move into itself or its own subtree', () => {
    const s = baseState()
    expect(apply(s, { type: 'file/move', nodeId: 'f1', parentId: 'f1' })).toBe(s)
    expect(apply(s, { type: 'file/move', nodeId: 'f1', parentId: 'f2' })).toBe(s)
  })

  test('a node cannot move into a non-folder or missing parent', () => {
    const s = baseState()
    expect(apply(s, { type: 'file/move', nodeId: 'f2', parentId: 'a2' })).toBe(s)
    expect(apply(s, { type: 'file/move', nodeId: 'f2', parentId: 'ghost' })).toBe(s)
  })

  test('moving to root and back preserves structure', () => {
    let s = apply(baseState(), { type: 'file/move', nodeId: 'a1', parentId: null })
    expect(s.files['a1'].parentId).toBeNull()
    s = apply(s, { type: 'file/move', nodeId: 'a1', parentId: 'f2' })
    expect(s.files['a1'].parentId).toBe('f2')
  })
})

suite('note ops', () => {
  const note = (id: string, clipId = 'c1', start = 0): Operation => ({
    type: 'note/add',
    note: { id, clipId, pitch: 60, start, duration: 480, velocity: 100 }
  })

  test('notes cascade through clip delete and restore with undo', () => {
    const store = new ProjectStore(baseState(), 'tester')
    store.dispatch(note('n1'))
    store.dispatch(note('n2', 'c1', 480))
    store.dispatch({ type: 'clip/delete', clipId: 'c1' })
    expect(Object.keys(store.state.notes)).toHaveLength(0) // incl. baseState's nA
    store.undo()
    expect(Object.keys(store.state.notes).sort()).toEqual(['n1', 'n2', 'nA'])
  })

  test('notes cascade through track delete and restore with undo', () => {
    const store = new ProjectStore(baseState(), 'tester')
    store.dispatch(note('n1'))
    store.dispatch({ type: 'track/delete', trackId: 't1' })
    expect(store.state.notes['n1']).toBeUndefined()
    store.undo()
    expect(store.state.notes['n1']).toBeDefined()
    expect(store.state.clips['c1']).toBeDefined()
  })

  test('note add requires a live clip; values are clamped', () => {
    let s = baseState()
    expect(
      apply(s, {
        type: 'note/add',
        note: { id: 'nx', clipId: 'ghost', pitch: 60, start: 0, duration: 480, velocity: 100 }
      })
    ).toBe(s)
    s = apply(s, {
      type: 'note/add',
      note: { id: 'ny', clipId: 'c1', pitch: 300, start: -5, duration: 0, velocity: 400 }
    })
    expect(s.notes['ny']).toEqual({
      id: 'ny',
      clipId: 'c1',
      pitch: 127,
      start: 0,
      duration: 1,
      velocity: 127
    })
  })

  test('multi-delete restores as one undo step', () => {
    const store = new ProjectStore(baseState(), 'tester')
    store.dispatch(note('n1'))
    store.dispatch(note('n2', 'c1', 480))
    store.dispatch({ type: 'note/delete', noteIds: ['n1', 'n2'] })
    expect(Object.keys(store.state.notes)).toEqual(['nA']) // baseState note remains
    store.undo()
    expect(Object.keys(store.state.notes).sort()).toEqual(['n1', 'n2', 'nA'])
  })
})

suite('conversation ops', () => {
  const msg = {
    id: 'msg1',
    userId: 'u1',
    authorName: 'Tester',
    time: 2000,
    text: 'hello'
  }

  test('chat/post appends, is idempotent, and is NOT undoable', () => {
    const store = new ProjectStore(baseState(), 'tester')
    expect(store.dispatch({ type: 'chat/post', message: msg })).toBe(true)
    expect(store.dispatch({ type: 'chat/post', message: msg })).toBe(false) // idempotent
    expect(store.state.chat).toHaveLength(1)
    expect(store.canUndo).toBe(false)
    // â€¦and it stays out of the activity feed.
    expect(store.activity.some((a) => a.text.includes('hello'))).toBe(false)
  })

  test('comment ops ARE undoable and appear in the activity feed', () => {
    const store = new ProjectStore(baseState(), 'tester')
    store.dispatch({ type: 'comment/add', comments: [comment('cm5', 'c1')] })
    expect(store.activity.at(-1)?.text).toBe('Commented on clip "c1"')
    expect(store.canUndo).toBe(true)
    store.undo()
    expect(store.state.comments['cm5']).toBeUndefined()
  })

  test('deleting a thread root deletes its replies; undo restores both', () => {
    const store = new ProjectStore(baseState(), 'tester')
    store.dispatch({ type: 'comment/delete', commentId: 'cm1' })
    expect(store.state.comments['cm1']).toBeUndefined()
    expect(store.state.comments['cm2']).toBeUndefined()
    store.undo()
    expect(store.state.comments['cm1']).toBeDefined()
    expect(store.state.comments['cm2']).toBeDefined()
  })

  test('a reply to a deleted thread is dropped, not orphaned', () => {
    const s = apply(baseState(), { type: 'comment/delete', commentId: 'cm1' })
    const after = apply(s, { type: 'comment/add', comments: [comment('cm9', 'c1', 'cm1')] })
    expect(after).toBe(s)
  })

  test('describe returns null only for chat', () => {
    const s = baseState()
    expect(describeOp(s, { type: 'chat/post', message: msg })).toBeNull()
    expect(describeOp(s, { type: 'comment/setResolved', commentId: 'cm1', resolved: true })).toBe(
      'Resolved a comment on clip "c1"'
    )
  })
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
