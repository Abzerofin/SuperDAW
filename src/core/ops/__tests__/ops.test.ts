import { describe as suite, expect, test } from 'vitest'
import type { Clip, Comment, FileNode, PluginInstance, ProjectState, Track } from '../../model/types'
import { createEmptyProject } from '../../model/types'
import { synthDefaults, type EffectType } from '../../model/effects'
import { builtinEffectDescriptor } from '../../plugins/builtin'
import { describe as describeOp } from '../describe'
import type { Operation } from '../operations'
import { apply } from '../apply'
import { invert } from '../invert'
import { buildDuplicateTrackOp } from '../duplicateTrack'
import { ProjectStore } from '../../state/store'

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
  return { id, trackId, name: id, start, duration, assetId: null, offset: 0, color: null, fadeIn: 0, fadeOut: 0, reverse: false, pitch: 0, stretch: 1, loopLength: 0 }
}

function fileNode(id: string, parentId: string | null, kind: FileNode['kind'] = 'audio'): FileNode {
  return { id, parentId, kind, name: id, assetId: kind === 'folder' ? null : `asset-${id}` }
}

function plugin(
  id: string,
  trackId: string,
  type: EffectType,
  params: Record<string, number> = {},
  rank = 1
): PluginInstance {
  return {
    id,
    trackId,
    descriptor: builtinEffectDescriptor(type),
    enabled: true,
    rank,
    params,
    stateBlob: null
  }
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
  s = apply(s, { type: 'track/create', track: track('t1'), index: 0, clips: [], automation: [], notes: [], plugins: [] })
  s = apply(s, { type: 'track/create', track: track('t2'), index: 1, clips: [], automation: [], notes: [], plugins: [] })
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
  // An EQ on t1, and a MIDI track with default synth params
  s = apply(s, { type: 'plugin/add', instance: plugin('fxA', 't1', 'eq3') })
  s = apply(s, {
    type: 'track/create',
    track: { ...track('tm'), kind: 'midi', synth: synthDefaults() },
    index: 2,
    clips: [],
    automation: [],
    notes: [],
    plugins: []
  })
  // t2 is frozen (its render asset is referenced by id only)
  s = apply(s, { type: 'track/freeze', trackId: 't2', assetId: 'ast_frozen' })
  return s
}

/** baseState plus a folder containing t1 (and its clips/notes/automation/plugin). */
function folderState(): ProjectState {
  let s = baseState()
  s = apply(s, {
    type: 'track/create',
    track: { ...track('fold'), kind: 'folder' },
    index: 3,
    clips: [],
    automation: [],
    notes: [],
    plugins: []
  })
  s = apply(s, { type: 'track/setParent', trackId: 't1', parentId: 'fold' })
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
    expect(s.trackOrder).toEqual(['t2', 'tm'])
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
    { type: 'project/setTimeSignature', timeSignature: [7, 8] },
    {
      type: 'track/create',
      track: track('t9'),
      index: 1,
      clips: [clip('c9', 't9')],
      automation: [{ id: 'ap9', trackId: 't9', param: 'volume', ticks: 0, value: 0.5 }],
      notes: [{ id: 'n9', clipId: 'c9', pitch: 60, start: 0, duration: 480, velocity: 100 }],
      plugins: [plugin('fx9', 't9', 'eq3', { low: 3, mid: 0, midFreq: 1000, high: -2 })]
    },
    { type: 'plugin/add', instance: plugin('fx1', 't1', 'compressor') },
    { type: 'plugin/remove', instanceId: 'fxA' },
    { type: 'plugin/setParam', instanceId: 'fxA', param: 'low', value: 6 },
    { type: 'plugin/setEnabled', instanceId: 'fxA', enabled: false },
    { type: 'track/setSynthParam', trackId: 'tm', param: 'cutoff', value: 3 },
    { type: 'note/add', note: { id: 'n1', clipId: 'c1', pitch: 64, start: 240, duration: 240, velocity: 90 } },
    { type: 'note/addMany', notes: [
      { id: 'n2', clipId: 'c1', pitch: 62, start: 0, duration: 240, velocity: 80 },
      { id: 'n3', clipId: 'c2', pitch: 65, start: 480, duration: 480, velocity: 80 }
    ] },
    { type: 'note/move', noteId: 'nA', pitch: 67, start: 960 },
    { type: 'note/resize', noteId: 'nA', duration: 960 },
    { type: 'note/setVelocity', noteId: 'nA', velocity: 45 },
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
    { type: 'clip/setColor', clipId: 'c1', color: '#e06c75' },
    { type: 'clip/setFades', clipId: 'c1', fadeIn: 120, fadeOut: 240 },
    { type: 'track/freeze', trackId: 't1', assetId: 'ast_f1' },
    { type: 'track/unfreeze', trackId: 't2' },
    { type: 'track/reorder', trackId: 't1', index: 2, parentId: null },
    { type: 'clip/split', clipId: 'c1', at: 480, rightClipId: 'cs1' },
    // c1 (0..960) and c2 (1920..2880) are non-adjacent: the merge/split
    // round-trip must restore the gap via leftDuration.
    { type: 'clip/merge', clipId: 'c1', rightClipId: 'c2' },
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

  test('split reassigns notes past the cut to the right clip; undo restores', () => {
    const store = new ProjectStore(baseState(), 'tester')
    store.dispatch(note('n1', 'c1', 0))
    store.dispatch(note('n2', 'c1', 600))
    store.dispatch({ type: 'clip/split', clipId: 'c1', at: 480, rightClipId: 'cr1' })
    expect(store.state.clips['c1'].duration).toBe(480)
    expect(store.state.clips['cr1']).toMatchObject({ start: 480, duration: 480 })
    expect(store.state.notes['n1']).toMatchObject({ clipId: 'c1', start: 0 })
    expect(store.state.notes['n2']).toMatchObject({ clipId: 'cr1', start: 120 })
    store.undo()
    expect(store.state.clips['cr1']).toBeUndefined()
    expect(store.state.clips['c1'].duration).toBe(960)
    expect(store.state.notes['n2']).toMatchObject({ clipId: 'c1', start: 600 })
  })

  test('split is dropped when the cut misses the clip body', () => {
    const s = baseState()
    expect(apply(s, { type: 'clip/split', clipId: 'c1', at: 0, rightClipId: 'x' })).toBe(s)
    expect(apply(s, { type: 'clip/split', clipId: 'c1', at: 960, rightClipId: 'x' })).toBe(s)
    expect(apply(s, { type: 'clip/split', clipId: 'ghost', at: 480, rightClipId: 'x' })).toBe(s)
    // Idempotency: re-delivered split with an existing right clip is a no-op.
    const once = apply(s, { type: 'clip/split', clipId: 'c1', at: 480, rightClipId: 'cr1' })
    expect(apply(once, { type: 'clip/split', clipId: 'c1', at: 480, rightClipId: 'cr1' })).toBe(once)
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

suite('buildDuplicateTrackOp', () => {
  test('materializes a full copy with fresh ids and remapped references', () => {
    const before = baseState()
    const op = buildDuplicateTrackOp(before, 't1')
    expect(op).not.toBeNull()
    if (!op || op.type !== 'track/create') throw new Error('expected a track/create op')

    expect(op.track.name).toBe('t1 Copy')
    expect(op.track.id).not.toBe('t1')
    expect(op.index).toBe(1) // right after the original
    expect(op.clips).toHaveLength(2)
    expect(op.notes).toHaveLength(1)
    expect(op.automation).toHaveLength(1)
    expect(op.plugins).toHaveLength(1)

    // Every cloned entity points at the new track/clips, never the originals.
    for (const c of op.clips) expect(c.trackId).toBe(op.track.id)
    for (const p of op.automation) expect(p.trackId).toBe(op.track.id)
    for (const p of op.plugins) expect(p.trackId).toBe(op.track.id)
    const clipIds = new Set(op.clips.map((c) => c.id))
    for (const n of op.notes) expect(clipIds.has(n.clipId)).toBe(true)
    expect(clipIds.has('c1')).toBe(false)

    // Applying it leaves the source track untouched and undo removes it all.
    const after = apply(before, op)
    expect(after.trackOrder).toEqual(['t1', op.track.id, 't2', 'tm'])
    expect(after.tracks['t1']).toEqual(before.tracks['t1'])
    const inverse = invert(before, op)
    expect(inverse).not.toBeNull()
    expect(apply(after, inverse!)).toEqual(before)
  })

  test('returns null for a missing track', () => {
    expect(buildDuplicateTrackOp(baseState(), 'ghost')).toBeNull()
  })
})

suite('track folders', () => {
  test('setParent rejects non-folders, self and subtree cycles', () => {
    let s = folderState()
    expect(apply(s, { type: 'track/setParent', trackId: 't2', parentId: 't1' })).toBe(s) // audio, not folder
    expect(apply(s, { type: 'track/setParent', trackId: 'fold', parentId: 'fold' })).toBe(s)
    s = apply(s, {
      type: 'track/create',
      track: { ...track('fold2'), kind: 'folder', parentId: 'fold' },
      index: 4,
      clips: [],
      automation: [],
      notes: [],
      plugins: []
    })
    // fold2 lives inside fold: moving fold under fold2 would be a cycle.
    expect(apply(s, { type: 'track/setParent', trackId: 'fold', parentId: 'fold2' })).toBe(s)
  })

  test('deleting a folder cascades over the subtree and undo restores it atomically', () => {
    const before = folderState()
    const op: Operation = { type: 'track/delete', trackId: 'fold' }
    const inverse = invert(before, op)
    const after = apply(before, op)
    // Folder and child (with all content) are gone
    expect(after.tracks['fold']).toBeUndefined()
    expect(after.tracks['t1']).toBeUndefined()
    expect(Object.keys(after.clips)).toHaveLength(0)
    expect(after.plugins['fxA']).toBeUndefined()
    expect(inverse).not.toBeNull()
    expect(apply(after, inverse!)).toEqual(before)
  })

  test('reorder with parentId moves and re-parents atomically, and inverts', () => {
    const before = folderState()
    // Order is [t1, t2, tm, fold]; index applies after removal, so 3 = after fold.
    const op: Operation = { type: 'track/reorder', trackId: 't2', index: 3, parentId: 'fold' }
    const after = apply(before, op)
    expect(after.tracks['t2'].parentId).toBe('fold')
    expect(after.trackOrder).toEqual(['t1', 'tm', 'fold', 't2'])
    const inverse = invert(before, op)
    expect(inverse).not.toBeNull()
    expect(apply(after, inverse!)).toEqual(before)
  })

  test('clips can never land on folder tracks', () => {
    const s = folderState()
    expect(apply(s, { type: 'clip/create', clip: clip('cf', 'fold'), notes: [] })).toBe(s)
    expect(apply(s, { type: 'clip/move', clipId: 'c1', trackId: 'fold', start: 0 })).toBe(s)
  })

  test('duplicating a folder clones the whole subtree with fresh remapped ids', () => {
    const before = folderState()
    const op = buildDuplicateTrackOp(before, 'fold')
    if (!op || op.type !== 'track/create') throw new Error('expected track/create')
    expect(op.track.kind).toBe('folder')
    expect(op.track.name).toBe('fold Copy')
    expect(op.descendants).toHaveLength(1)
    const childCopy = op.descendants![0].track
    expect(childCopy.name).toBe('t1') // only the root gets "Copy"
    expect(childCopy.parentId).toBe(op.track.id) // remapped into the new folder
    const after = apply(before, op)
    expect(Object.keys(after.tracks)).toHaveLength(Object.keys(before.tracks).length + 2)
    const inverse = invert(before, op)
    expect(apply(after, inverse!)).toEqual(before)
  })
})

suite('track freeze', () => {
  test('freeze stores the render asset and unfreeze restores the original untouched', () => {
    const before = baseState()
    const frozen = apply(before, { type: 'track/freeze', trackId: 't1', assetId: 'ast_r' })
    expect(frozen.tracks['t1'].frozenAssetId).toBe('ast_r')
    // Original content untouched by freezing
    expect(frozen.clips).toEqual(before.clips)
    expect(frozen.plugins).toEqual(before.plugins)
    const thawed = apply(frozen, { type: 'track/unfreeze', trackId: 't1' })
    expect(thawed.tracks['t1'].frozenAssetId).toBeNull()
    expect(thawed).toEqual(before)
  })

  test('folders cannot freeze', () => {
    const s = folderState()
    expect(apply(s, { type: 'track/freeze', trackId: 'fold', assetId: 'x' })).toBe(s)
  })
})

suite('clip fades', () => {
  test('setFades clamps so fades never overlap', () => {
    // c1 is 960 ticks long: 800 + 700 collide -> fadeOut shrinks first
    const s = apply(baseState(), { type: 'clip/setFades', clipId: 'c1', fadeIn: 800, fadeOut: 700 })
    expect(s.clips['c1'].fadeIn).toBe(800)
    expect(s.clips['c1'].fadeOut).toBe(160)
  })

  test('split moves the fade-out to the right half and merge restores it', () => {
    let s = apply(baseState(), { type: 'clip/setFades', clipId: 'c1', fadeIn: 120, fadeOut: 240 })
    const withFades = s
    s = apply(s, { type: 'clip/split', clipId: 'c1', at: 480, rightClipId: 'cs1' })
    expect(s.clips['c1'].fadeIn).toBe(120)
    expect(s.clips['c1'].fadeOut).toBe(0)
    expect(s.clips['cs1'].fadeIn).toBe(0)
    expect(s.clips['cs1'].fadeOut).toBe(240)
    const merged = apply(s, { type: 'clip/merge', clipId: 'c1', rightClipId: 'cs1' })
    expect(merged.clips['c1']).toEqual(withFades.clips['c1'])
  })
})

suite('clip looping', () => {
  test('loop-handle resize sets the period and invert restores the old loop state', () => {
    const before = baseState() // c1: start 0, duration 960, loopLength 0
    const op: Operation = {
      type: 'clip/resize',
      clipId: 'c1',
      start: 0,
      duration: 2880,
      offset: 0,
      loopLength: 960
    }
    const after = apply(before, op)
    expect(after.clips.c1.duration).toBe(2880)
    expect(after.clips.c1.loopLength).toBe(960)
    const inverse = invert(before, op)
    expect(inverse).not.toBeNull()
    expect(apply(after, inverse!)).toEqual(before)

    // Dragging back to one repeat clears the loop; invert restores it.
    const unloop: Operation = {
      type: 'clip/resize',
      clipId: 'c1',
      start: 0,
      duration: 960,
      offset: 0,
      loopLength: 0
    }
    const cleared = apply(after, unloop)
    expect(cleared.clips.c1.loopLength).toBe(0)
    const uninvert = invert(after, unloop)
    expect(apply(cleared, uninvert!)).toEqual(after)
  })

  test('plain trims never touch the loop; the reducer clamps absurd periods', () => {
    let s = apply(baseState(), {
      type: 'clip/resize',
      clipId: 'c1',
      start: 0,
      duration: 2880,
      offset: 0,
      loopLength: 960
    })
    // A trim without loop fields keeps the period.
    s = apply(s, { type: 'clip/resize', clipId: 'c1', start: 0, duration: 2400, offset: 0 })
    expect(s.clips.c1.loopLength).toBe(960)
    // Tiny/negative periods clamp to the minimum / off.
    s = apply(s, { type: 'clip/resize', clipId: 'c1', start: 0, duration: 2400, offset: 0, loopLength: 5 })
    expect(s.clips.c1.loopLength).toBe(60)
    s = apply(s, { type: 'clip/resize', clipId: 'c1', start: 0, duration: 2400, offset: 0, loopLength: -3 })
    expect(s.clips.c1.loopLength).toBe(0)
  })

  test('stretch-handle resize scales time in one op; invert restores exactly', () => {
    const before = baseState() // c1: duration 960, stretch 1
    const op: Operation = {
      type: 'clip/resize',
      clipId: 'c1',
      start: 0,
      duration: 1920,
      offset: 0,
      stretch: 2
    }
    const after = apply(before, op)
    expect(after.clips.c1.duration).toBe(1920)
    expect(after.clips.c1.stretch).toBe(2)
    const inverse = invert(before, op)
    expect(apply(after, inverse!)).toEqual(before)
    // Reducer clamps the factor exactly like clip/setPlayback.
    const wild = apply(before, { ...op, stretch: 99 })
    expect(wild.clips.c1.stretch).toBe(4)
    // A plain trim never touches the factor.
    const trimmed = apply(after, { type: 'clip/resize', clipId: 'c1', start: 0, duration: 960, offset: 0 })
    expect(trimmed.clips.c1.stretch).toBe(2)
  })

  test('stretching a looped clip scales the period with it (same repeat count)', () => {
    let s = apply(baseState(), {
      type: 'clip/resize',
      clipId: 'c1',
      start: 0,
      duration: 2880, // 3 repeats of 960
      offset: 0,
      loopLength: 960
    })
    s = apply(s, {
      type: 'clip/resize',
      clipId: 'c1',
      start: 0,
      duration: 5760, // stretched ×2
      offset: 0,
      stretch: 2,
      loopLength: 1920
    })
    expect(s.clips.c1.stretch).toBe(2)
    expect(s.clips.c1.loopLength).toBe(1920)
    expect(s.clips.c1.duration / s.clips.c1.loopLength).toBe(3) // still 3 repeats
  })

  test('splitting a looped clip keeps the period and re-anchors the right half in-pattern', () => {
    let s = apply(baseState(), {
      type: 'clip/create',
      clip: { ...clip('ca', 't2'), assetId: 'ast_1' },
      notes: []
    })
    s = apply(s, {
      type: 'clip/resize',
      clipId: 'ca',
      start: 0,
      duration: 2880,
      offset: 120,
      loopLength: 960
    })
    // Cut mid-second-repeat (tick 1440 = 480 into the pattern).
    s = apply(s, { type: 'clip/split', clipId: 'ca', at: 1440, rightClipId: 'cr' })
    expect(s.clips.ca.loopLength).toBe(960)
    expect(s.clips.cr.loopLength).toBe(960)
    expect(s.clips.cr.offset).toBe(120 + 480) // offset within the pattern, not from clip start
  })
})

suite('op log & lineage', () => {
  test('every commit lands in the op log — dispatch, undo, redo', () => {
    const store = new ProjectStore(baseState(), 'tester')
    expect(store.opLog).toHaveLength(0)
    store.dispatch({ type: 'track/rename', trackId: 't1', name: 'Logged' })
    store.undo()
    store.redo()
    expect(store.opLog).toHaveLength(3)
    expect(store.opLog[1].op).toMatchObject({ type: 'track/rename', name: 't1' }) // the inverse
    // origin + log reproduces the document
    let replayed = store.lineage.origin
    for (const e of store.opLog) replayed = apply(replayed, e.op)
    expect(replayed).toEqual(store.state)
  })

  test('the host echo of an own op is not logged twice', () => {
    const store = new ProjectStore(baseState(), 'tester')
    const sent: import('../operations').OpEnvelope[] = []
    store.attachSession({ sendLocalOp: (e) => sent.push(e) })
    store.dispatch({ type: 'track/setVolume', trackId: 't1', volume: 0.4 })
    expect(store.opLog).toHaveLength(1)
    store.receiveAuthoritative(sent[0]) // echo comes back
    expect(store.opLog).toHaveLength(1)
    // …while a remote peer's op IS logged.
    store.receiveAuthoritative({
      id: 'op_remote',
      userId: 'peer',
      time: Date.now(),
      op: { type: 'track/setPan', trackId: 't1', pan: 0.5 }
    })
    expect(store.opLog).toHaveLength(2)
  })

  test('loadProject restores a saved lineage or mints a fresh one', () => {
    const store = new ProjectStore(baseState(), 'tester')
    const saved = {
      projectId: 'prj_keep',
      originTime: 42,
      origin: baseState()
    }
    const log = [
      {
        id: 'op_1',
        userId: 'u1',
        time: 50,
        op: { type: 'track/rename', trackId: 't1', name: 'X' } as Operation
      }
    ]
    store.loadProject(baseState(), saved, log)
    expect(store.lineage.projectId).toBe('prj_keep')
    expect(store.opLog).toEqual(log)

    store.loadProject(baseState())
    expect(store.lineage.projectId).not.toBe('prj_keep')
    expect(store.opLog).toHaveLength(0)
  })
})

