import { describe as suite, expect, test } from 'vitest'
import type { Clip, Comment, FileNode, PluginInstance, ProjectState, Track } from '../../model/types'
import { createEmptyProject, MASTER_BUS_ID, padIdAt, pluginsOfTrack } from '../../model/types'
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
  // t1 uses graph routing: in → fxA → out, fxA placed in the editor
  s = apply(s, {
    type: 'route/addMany',
    routes: [
      { id: 'rA', trackId: 't1', from: 'in', to: 'fxA' },
      { id: 'rB', trackId: 't1', from: 'fxA', to: 'out' }
    ]
  })
  s = apply(s, { type: 'plugin/setGraphPos', instanceId: 'fxA', x: 120, y: 80 })
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
  // A performance pad on cell 0·0 (pad/clear and reassignment round-trips)
  s = apply(s, { type: 'pad/set', pad: pad(0, 0, { kind: 'sample', assetId: 'ast_pad' }) })
  // tm's sampler holds a sample (clearing it must round-trip exactly)
  s = apply(s, { type: 'track/setSampler', trackId: 'tm', assetId: 'ast_base' })
  // An arrangement marker (delete and update round-trips target it)
  s = apply(s, { type: 'marker/create', marker: marker('mk1', { name: 'Verse', ticks: 960 }) })
  return s
}

function marker(
  id: string,
  overrides: Partial<import('../../model/types').ArrangementMarker> = {}
): import('../../model/types').ArrangementMarker {
  return { id, name: 'Marker 1', ticks: 0, color: '#d19a66', ...overrides }
}

function pad(
  row: number,
  col: number,
  overrides: Partial<import('../../model/types').PerformancePad> = {}
): import('../../model/types').PerformancePad {
  return {
    id: padIdAt(row, col),
    row,
    col,
    kind: 'sample',
    assetId: null,
    trackId: null,
    pitch: 60,
    clipId: null,
    name: '',
    color: null,
    gate: false,
    ...overrides
  }
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

  test('malformed pads are dropped whole, not partially applied', () => {
    const s = baseState()
    // Off-grid cell
    expect(apply(s, { type: 'pad/set', pad: pad(0, 0, { row: 99, col: 0 }) })).toBe(s)
    // Id not matching its cell (identity IS the cell)
    expect(
      apply(s, { type: 'pad/set', pad: { ...pad(1, 1), id: padIdAt(2, 2) } })
    ).toBe(s)
  })

  test('pad fields irrelevant to the kind are nulled', () => {
    const s = apply(baseState(), {
      type: 'pad/set',
      pad: pad(4, 4, { kind: 'clip', clipId: 'c1', assetId: 'smuggled', trackId: 'tm' })
    })
    const stored = s.pads[padIdAt(4, 4)]
    expect(stored.clipId).toBe('c1')
    expect(stored.assetId).toBeNull()
    expect(stored.trackId).toBeNull()
  })

  test('marker ops are idempotent (applying twice = applying once)', () => {
    const createOp: Operation = { type: 'marker/create', marker: marker('mk2', { ticks: 1920 }) }
    const created = apply(baseState(), createOp)
    expect(apply(created, createOp)).toBe(created)
    const updateOp: Operation = { type: 'marker/update', markerId: 'mk1', name: 'Drop', ticks: 480 }
    const updated = apply(created, updateOp)
    expect(updated.markers['mk1'].name).toBe('Drop')
    expect(updated.markers['mk1'].ticks).toBe(480)
    expect(apply(updated, updateOp)).toBe(updated)
    const deleteOp: Operation = { type: 'marker/delete', markerId: 'mk1' }
    const deleted = apply(updated, deleteOp)
    expect(apply(deleted, deleteOp)).toBe(deleted)
  })

  test('a replayed marker/create never clobbers a later marker/update', () => {
    const createOp: Operation = { type: 'marker/create', marker: marker('mk2', { name: 'Take 1' }) }
    let s = apply(baseState(), createOp)
    s = apply(s, { type: 'marker/update', markerId: 'mk2', name: 'Take 2' })
    // At-least-once delivery: the create arrives again after the rename.
    expect(apply(s, createOp)).toBe(s)
  })

  test('malformed markers are dropped or coerced field by field', () => {
    const s = baseState()
    // Non-finite position is load-bearing — the op is dropped whole.
    expect(
      apply(s, { type: 'marker/create', marker: marker('mkX', { ticks: Number.NaN }) })
    ).toBe(s)
    expect(apply(s, { type: 'marker/update', markerId: 'mk1', ticks: Number.NaN })).toBe(s)
    // Cosmetic junk coerces: bad color → default, negative ticks clamp to 0.
    const coerced = apply(s, {
      type: 'marker/create',
      marker: marker('mkY', { ticks: -50, color: 'not-a-color' })
    })
    expect(coerced.markers['mkY'].ticks).toBe(0)
    expect(coerced.markers['mkY'].color).toBe('#d19a66')
  })

  test('marker ops targeting missing markers are no-ops (convergence)', () => {
    const s = baseState()
    expect(apply(s, { type: 'marker/update', markerId: 'ghost', name: 'x' })).toBe(s)
    expect(apply(s, { type: 'marker/delete', markerId: 'ghost' })).toBe(s)
  })

  test('track/setSampler only applies to MIDI tracks', () => {
    const s = baseState()
    expect(apply(s, { type: 'track/setSampler', trackId: 't1', assetId: 'ast_x' })).toBe(s)
    const applied = apply(s, {
      type: 'track/setSampler',
      trackId: 'tm',
      assetId: 'ast_x',
      params: { smpRoot: 999 } // clamped to the def's max
    })
    expect(applied.tracks['tm'].samplerAssetId).toBe('ast_x')
    expect(applied.tracks['tm'].synth.smpRoot).toBe(127)
  })
})

suite('invert', () => {
  const roundTrips: Operation[] = [
    { type: 'project/rename', name: 'Renamed' },
    { type: 'project/setLyrics', lyrics: 'Verse 1\nla la la' },
    { type: 'project/setTempo', tempo: 140 },
    // Conforming variant: undo must restore the clip's previous stretch.
    { type: 'project/setTempo', tempo: 160, conform: [{ clipId: 'c1', stretch: 0.75 }] },
    // Warp toggle rides setPlayback; undo restores the previous mode.
    { type: 'clip/setPlayback', clipId: 'c1', reverse: false, pitch: 3, stretch: 1.5, warp: true },
    { type: 'project/setTimeSignature', timeSignature: [7, 8] },
    { type: 'project/updateSettings', patch: { loudnessTargetLufs: -14, swingPercent: 55 } },
    {
      type: 'project/updateSettings',
      patch: {
        defaultFadeTicks: 96,
        quantizeStrength: 0.5,
        humanizeTicks: 12,
        defaultGrid: '1/8',
        exportFormat: 'mp3',
        exportBitDepth: 24
      }
    },
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
    // Splice into the live graph: fxA→out (rB) is severed and rerouted
    // through the new node; undo must heal rB, not just drop the node.
    {
      type: 'plugin/add',
      instance: plugin('fx2', 't1', 'delay', {}, 2),
      routes: [
        { id: 'rS1', trackId: 't1', from: 'fxA', to: 'fx2' },
        { id: 'rS2', trackId: 't1', from: 'fx2', to: 'out' }
      ],
      severedRoutes: [{ id: 'rB', trackId: 't1', from: 'fxA', to: 'out' }]
    },
    // Cascades away rA/rB; the inverse must restore node AND edges.
    { type: 'plugin/remove', instanceId: 'fxA' },
    // Remove that heals previously severed edges: undo must sever again.
    {
      type: 'plugin/remove',
      instanceId: 'fxA',
      restoreRoutes: [{ id: 'rD', trackId: 't1', from: 'in', to: 'out' }]
    },
    // A parallel dry path next to the existing in → fxA → out.
    { type: 'route/addMany', routes: [{ id: 'r9', trackId: 't1', from: 'in', to: 'out' }] },
    { type: 'route/deleteMany', routeIds: ['rA'] },
    { type: 'plugin/setGraphPos', instanceId: 'fxA', x: 300, y: 40 },
    { type: 'plugin/setParam', instanceId: 'fxA', param: 'low', value: 6 },
    { type: 'plugin/setParams', instanceId: 'fxA', params: { low: 4, high: -3 } },
    { type: 'plugin/setEnabled', instanceId: 'fxA', enabled: false },
    { type: 'plugin/setState', instanceId: 'fxA', stateBlob: '{"component":"AAECAw=="}' },
    { type: 'track/setSynthParam', trackId: 'tm', param: 'cutoff', value: 3 },
    { type: 'track/setSynthParams', trackId: 'tm', params: { present: 0, on: 0, cutoff: 9 } },
    { type: 'note/add', note: { id: 'n1', clipId: 'c1', pitch: 64, start: 240, duration: 240, velocity: 90 } },
    { type: 'note/addMany', notes: [
      { id: 'n2', clipId: 'c1', pitch: 62, start: 0, duration: 240, velocity: 80 },
      { id: 'n3', clipId: 'c2', pitch: 65, start: 480, duration: 480, velocity: 80 }
    ] },
    { type: 'note/move', noteId: 'nA', pitch: 67, start: 960 },
    { type: 'note/moveMany', moves: [{ noteId: 'nA', pitch: 55, start: 1440 }] },
    { type: 'note/resize', noteId: 'nA', duration: 960 },
    // Left-edge trim: start and duration change in the one op.
    { type: 'note/resize', noteId: 'nA', duration: 240, start: 240 },
    { type: 'note/setVelocity', noteId: 'nA', velocity: 45 },
    { type: 'note/delete', noteIds: ['nA'] },
    { type: 'track/setVolume', trackId: 't1', volume: 0.7 },
    { type: 'track/setPan', trackId: 't2', pan: -0.4 },
    { type: 'project/setMasterVolume', volume: 1.2 },
    { type: 'automation/add', point: { id: 'ap1', trackId: 't1', param: 'volume', ticks: 960, value: 0.8 } },
    // Item-history restores: absolute field sets, invert = current fields.
    { type: 'clip/restore', clipId: 'c1', clip: { ...clip('c1', 't1', 480, 1920), pitch: 3, stretch: 1.5 } },
    {
      type: 'track/restore',
      trackId: 't1',
      track: { name: 'earlier', color: '#123456', muted: true, soloed: false, volume: 0.5, pan: -0.25, synth: {} }
    },
    { type: 'plugin/restore', instanceId: 'fxA', params: { low: 2, mid: -1, midFreq: 800, high: 0 }, enabled: false, stateBlob: null },
    { type: 'automation/move', pointId: 'apA', ticks: 1920, value: 0.25 },
    { type: 'automation/delete', pointId: 'apA' },
    { type: 'track/delete', trackId: 't1' },
    { type: 'track/rename', trackId: 't2', name: 'Renamed Track' },
    { type: 'track/setMute', trackId: 't1', muted: true },
    { type: 'track/setSolo', trackId: 't2', soloed: true },
    { type: 'track/reorder', trackId: 't2', index: 0 },
    { type: 'clip/create', clip: clip('c9', 't2', 480), notes: [] },
    // A free-length solo: the flag is the author's intent and has to
    // survive the op round-trip like any other clip field.
    { type: 'clip/create', clip: { ...clip('cs', 'tm', 0, 960), freeLength: true }, notes: [] },
    // A STAMP of an existing loop: no notes of its own, just the pointer.
    { type: 'clip/create', clip: { ...clip('cst', 't1', 1920), sourceClipId: 'c1' }, notes: [] },
    // Growing a loop takes its stamps with it: undo must put back the
    // loop's length AND every follower's, or a stamp keeps the new size.
    {
      type: 'clip/resizeWithNotes',
      clipId: 'c1',
      duration: 3840,
      notes: [{ id: 'ng9', clipId: 'c1', pitch: 38, start: 2880, duration: 240, velocity: 100 }],
      followers: [{ clipId: 'c2', duration: 3840 }]
    },
    // A clip created WITH seeded notes — the MIDI-take / import shape:
    // undoing must remove the clip AND its notes in one step.
    { type: 'clip/create', clip: clip('cn', 'tm', 0, 3840), notes: [
      { id: 'nn1', clipId: 'cn', pitch: 64, start: 120, duration: 240, velocity: 96 },
      { id: 'nn2', clipId: 'cn', pitch: 67, start: 480, duration: 480, velocity: 64 }
    ] },
    { type: 'clip/delete', clipId: 'c1' },
    { type: 'clip/move', clipId: 'c1', trackId: 't2', start: 4800 },
    { type: 'clip/moveMany', moves: [
      { clipId: 'c1', trackId: 't2', start: 1920 },
      { clipId: 'c2', trackId: 't1', start: 480 }
    ] },
    { type: 'clip/resizeMany', edits: [
      { clipId: 'c1', start: 240, duration: 1440, offset: 0 },
      { clipId: 'c2', start: 1920, duration: 480, offset: 0, loopLength: 240 }
    ] },
    { type: 'track/group', folder: { ...track('grp', 'Group'), kind: 'folder' }, index: 0, trackIds: ['t1', 't2'] },
    { type: 'clip/resize', clipId: 'c2', start: 960, duration: 1920, offset: 480 },
    // Programming a step past the end of a pattern: the clip grows and the
    // notes arrive together, so undo must take back BOTH in one step.
    { type: 'clip/resizeWithNotes', clipId: 'c1', duration: 7680, notes: [
      { id: 'ng1', clipId: 'c1', pitch: 36, start: 3840, duration: 240, velocity: 100 },
      { id: 'ng2', clipId: 'c1', pitch: 42, start: 4320, duration: 240, velocity: 127 }
    ] },
    // The inverse shape (shrink + remove) must round-trip too — that IS
    // what undoing the op above dispatches.
    { type: 'clip/resizeWithNotes', clipId: 'c1', duration: 960, notes: [], removeNoteIds: ['nA'] },
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
    { type: 'clip/slice', slices: [{ clipId: 'c1', at: [320, 640], newClipIds: ['cq1', 'cq2'] }] },
    { type: 'clip/slice', slices: [
      { clipId: 'c1', at: [480], newClipIds: ['cs2'] },
      { clipId: 'c2', at: [2400], newClipIds: ['cs3'] }
    ] },
    { type: 'file/create', nodes: [fileNode('f9', null, 'folder'), fileNode('a9', 'f9')] },
    { type: 'file/delete', nodeIds: ['f1'] }, // subtree: f1, f2, a1
    { type: 'file/delete', nodeIds: ['a2', 'f2'] },
    { type: 'file/rename', nodeId: 'a1', name: 'Renamed File' },
    { type: 'file/move', nodeId: 'a2', parentId: 'f2' },
    { type: 'comment/add', comments: [comment('cm9', 'c2')] },
    { type: 'comment/add', comments: [comment('cm9', 'c1', 'cm1')] },
    { type: 'comment/delete', commentId: 'cm2' }, // a reply
    { type: 'comment/delete', commentId: 'cm1' }, // a thread root + its reply
    { type: 'comment/setResolved', commentId: 'cm1', resolved: true },
    { type: 'track/setSampler', trackId: 'tm', assetId: 'ast_smp' },
    // Same-gesture params: undo must restore asset AND the touched keys.
    {
      type: 'track/setSampler',
      trackId: 'tm',
      assetId: 'ast_smp2',
      params: { instrument: 1, smpMode: 1, smpRoot: 48 }
    },
    { type: 'track/setSampler', trackId: 'tm', assetId: null },
    // Empty cell → invert is pad/clear; occupied cell → invert restores it.
    { type: 'pad/set', pad: pad(2, 3, { kind: 'note', trackId: 'tm', pitch: 52, gate: true }) },
    { type: 'pad/set', pad: pad(0, 0, { kind: 'clip', clipId: 'c1', name: 'Chorus' }) },
    { type: 'pad/clear', padId: padIdAt(0, 0) },
    // Arrangement markers: create/delete, and updates whose invert must
    // restore the previous values of exactly the touched fields.
    { type: 'marker/create', marker: marker('mk9', { name: 'Chorus', ticks: 3840 }) },
    { type: 'marker/delete', markerId: 'mk1' },
    { type: 'marker/update', markerId: 'mk1', name: 'Bridge' },
    { type: 'marker/update', markerId: 'mk1', ticks: 7680, color: '#5b8def' }
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

suite('project/updateSettings', () => {
  test('applies a patch of absolute values', () => {
    const s = apply(baseState(), {
      type: 'project/updateSettings',
      patch: { loudnessTargetLufs: -14, defaultFadeTicks: 96 }
    })
    expect(s.settings.loudnessTargetLufs).toBe(-14)
    expect(s.settings.defaultFadeTicks).toBe(96)
    // Untouched fields keep their values.
    expect(s.settings.swingPercent).toBe(0)
  })

  test('re-applying the same patch changes nothing (idempotent)', () => {
    const op: Operation = {
      type: 'project/updateSettings',
      patch: { loudnessTargetLufs: -16, swingPercent: 60 }
    }
    const once = apply(baseState(), op)
    expect(apply(once, op)).toBe(once)
  })

  test('unknown keys are dropped and values clamp deterministically', () => {
    const before = baseState()
    const s = apply(before, {
      type: 'project/updateSettings',
      patch: {
        loudnessTargetLufs: -999, // clamps to -36
        swingPercent: 400, // clamps to 100
        quantizeStrength: -2, // clamps to 0
        bogusKey: 'evil', // dropped
        defaultGrid: 'nonsense', // invalid choice — dropped
        exportBitDepth: 20 // not a supported word length — dropped
      } as never
    })
    expect(s.settings.loudnessTargetLufs).toBe(-36)
    expect(s.settings.swingPercent).toBe(100)
    expect(s.settings.quantizeStrength).toBe(0)
    expect(s.settings.defaultGrid).toBe(before.settings.defaultGrid)
    expect(s.settings.exportBitDepth).toBe(before.settings.exportBitDepth)
    expect('bogusKey' in s.settings).toBe(false)
  })

  test('null clears the loudness target', () => {
    const withTarget = apply(baseState(), {
      type: 'project/updateSettings',
      patch: { loudnessTargetLufs: -14 }
    })
    const cleared = apply(withTarget, {
      type: 'project/updateSettings',
      patch: { loudnessTargetLufs: null }
    })
    expect(cleared.settings.loudnessTargetLufs).toBeNull()
  })

  test('a patch of only invalid keys is a no-op with a no-op invert', () => {
    const before = baseState()
    const op: Operation = {
      type: 'project/updateSettings',
      patch: { nothing: 1 } as never
    }
    expect(apply(before, op)).toBe(before)
    // The inverse must not resurrect keys the reducer dropped.
    expect(invert(before, op)).toEqual({ type: 'project/updateSettings', patch: {} })
  })
})

suite('clip/slice', () => {
  // c1 on t1 spans 0..960.
  test('cuts a clip into equal pieces that tile the original span', () => {
    const s = apply(baseState(), {
      type: 'clip/slice',
      slices: [{ clipId: 'c1', at: [240, 480, 720], newClipIds: ['p1', 'p2', 'p3'] }]
    })
    const pieces = ['c1', 'p1', 'p2', 'p3'].map((id) => s.clips[id])
    expect(pieces.every(Boolean)).toBe(true)
    expect(pieces.map((c) => [c.start, c.duration])).toEqual([
      [0, 240],
      [240, 240],
      [480, 240],
      [720, 240]
    ])
    expect(pieces.every((c) => c.trackId === 't1')).toBe(true)
  })

  test('re-applying the same slice changes nothing (idempotent)', () => {
    const op: Operation = {
      type: 'clip/slice',
      slices: [{ clipId: 'c1', at: [240, 480], newClipIds: ['p1', 'p2'] }]
    }
    const once = apply(baseState(), op)
    expect(apply(once, op)).toBe(once)
  })

  test('cuts outside the clip are skipped, the rest still land', () => {
    const s = apply(baseState(), {
      type: 'clip/slice',
      slices: [{ clipId: 'c1', at: [-100, 480, 99999], newClipIds: ['p1', 'p2', 'p3'] }]
    })
    expect(s.clips['p1']).toBeUndefined() // before the clip
    expect(s.clips['p3']).toBeUndefined() // past its end
    expect(s.clips['p2']).toBeDefined()
    expect(s.clips['c1'].duration).toBe(480)
  })

  test('unslice puts a sliced clip back together', () => {
    const before = baseState()
    const op: Operation = {
      type: 'clip/slice',
      slices: [{ clipId: 'c1', at: [240, 480, 720], newClipIds: ['p1', 'p2', 'p3'] }]
    }
    const sliced = apply(before, op)
    expect(apply(sliced, invert(before, op)!)).toEqual(before)
  })

  test('slicing several clips at once round-trips', () => {
    const before = baseState()
    const op: Operation = {
      type: 'clip/slice',
      slices: [
        { clipId: 'c1', at: [480], newClipIds: ['p1'] },
        { clipId: 'c2', at: [2400], newClipIds: ['p2'] }
      ]
    }
    const sliced = apply(before, op)
    expect(sliced.clips['p1']).toBeDefined()
    expect(sliced.clips['p2']).toBeDefined()
    expect(apply(sliced, invert(before, op)!)).toEqual(before)
  })

  test('slicing a clip that is gone is a no-op', () => {
    const s = baseState()
    expect(
      apply(s, { type: 'clip/slice', slices: [{ clipId: 'ghost', at: [10], newClipIds: ['p1'] }] })
    ).toBe(s)
  })
})

suite('track/group', () => {
  const folder = (): Track => ({ ...track('grp', 'Group'), kind: 'folder' })

  test('wraps the tracks in a new folder, in order, right after it', () => {
    const s = apply(baseState(), {
      type: 'track/group',
      folder: folder(),
      index: 0,
      trackIds: ['t2', 't1']
    })
    expect(s.trackOrder).toEqual(['grp', 't2', 't1', 'tm'])
    expect(s.tracks['t1'].parentId).toBe('grp')
    expect(s.tracks['t2'].parentId).toBe('grp')
    expect(s.tracks['tm'].parentId).toBeNull()
  })

  test('ungroup restores the previous order and parents exactly', () => {
    const before = baseState()
    const op: Operation = {
      type: 'track/group',
      folder: folder(),
      index: 2,
      trackIds: ['t1', 'tm']
    }
    const grouped = apply(before, op)
    expect(grouped.tracks['grp']).toBeDefined()
    const inverse = invert(before, op)
    expect(apply(grouped, inverse!)).toEqual(before)
  })

  test('grouping tracks that are already in a folder re-parents them', () => {
    let s = folderState() // t1 lives in 'fold'
    expect(s.tracks['t1'].parentId).toBe('fold')
    s = apply(s, { type: 'track/group', folder: folder(), index: 0, trackIds: ['t1'] })
    expect(s.tracks['t1'].parentId).toBe('grp')
  })

  test('a folder id that already exists is refused', () => {
    const s = folderState()
    const dup: Track = { ...s.tracks['fold'] }
    expect(apply(s, { type: 'track/group', folder: dup, index: 0, trackIds: ['t2'] })).toBe(s)
  })

  test('grouping no usable tracks is a no-op', () => {
    const s = baseState()
    expect(apply(s, { type: 'track/group', folder: folder(), index: 0, trackIds: ['ghost'] })).toBe(s)
  })

  test('a folder cannot be grouped into itself', () => {
    const s = baseState()
    const f = folder()
    // The folder is not in state yet, so listing its own id must be ignored
    // rather than producing a self-parenting cycle.
    expect(apply(s, { type: 'track/group', folder: f, index: 0, trackIds: ['grp'] })).toBe(s)
  })

  test('ungrouping keeps children a peer added concurrently', () => {
    let s = folderState() // t1 in 'fold'
    // A peer moved t2 into the same folder; our ungroup op predates that.
    s = apply(s, { type: 'track/setParent', trackId: 't2', parentId: 'fold' })
    const out = apply(s, {
      type: 'track/ungroup',
      folderId: 'fold',
      restore: [{ trackId: 't1', parentId: null, index: 0 }]
    })
    expect(out.tracks['fold']).toBeUndefined()
    expect(out.tracks['t1'].parentId).toBeNull()
    // t2 inherits the removed folder's own parent instead of being orphaned.
    expect(out.tracks['t2'].parentId).toBe(s.tracks['fold'].parentId)
    expect(out.trackOrder).toContain('t2')
  })
})

suite('plugin/reorder', () => {
  /** baseState's fxA (rank 1) plus fxB, fxC — t1's chain is fxA, fxB, fxC. */
  function chainState(): ProjectState {
    let s = baseState()
    s = apply(s, { type: 'plugin/add', instance: plugin('fxB', 't1', 'delay', {}, 2) })
    s = apply(s, { type: 'plugin/add', instance: plugin('fxC', 't1', 'reverb', {}, 3) })
    return s
  }

  const chain = (s: ProjectState): string[] => pluginsOfTrack(s, 't1').map((p) => p.id)

  test('apply(invert) restores state for plugin/reorder', () => {
    const before = chainState()
    const op: Operation = { type: 'plugin/reorder', trackId: 't1', order: ['fxC', 'fxA', 'fxB'] }
    const inverse = invert(before, op)
    expect(inverse).not.toBeNull()
    const after = apply(before, op)
    expect(after).not.toBe(before)
    expect(chain(after)).toEqual(['fxC', 'fxA', 'fxB'])
    expect(apply(after, inverse!)).toEqual(before)
  })

  test('is idempotent — re-applying yields identical state', () => {
    const s = apply(chainState(), { type: 'plugin/reorder', trackId: 't1', order: ['fxC', 'fxB', 'fxA'] })
    expect(apply(s, { type: 'plugin/reorder', trackId: 't1', order: ['fxC', 'fxB', 'fxA'] })).toBe(s)
  })

  test('permutes existing ranks rather than renumbering from zero', () => {
    const after = apply(chainState(), { type: 'plugin/reorder', trackId: 't1', order: ['fxC', 'fxA', 'fxB'] })
    expect([after.plugins['fxC'].rank, after.plugins['fxA'].rank, after.plugins['fxB'].rank]).toEqual([1, 2, 3])
  })

  test('ids that are unknown, duplicated or on another track are skipped', () => {
    const after = apply(chainState(), {
      type: 'plugin/reorder',
      trackId: 't1',
      order: ['fxC', 'ghost', 'fxC', 'fxA', 'fxB']
    })
    expect(chain(after)).toEqual(['fxC', 'fxA', 'fxB'])
  })

  test('an insert missing from `order` keeps its place at the end', () => {
    // Models a peer adding fxC concurrently with a reorder that predates it.
    const after = apply(chainState(), { type: 'plugin/reorder', trackId: 't1', order: ['fxB', 'fxA'] })
    expect(chain(after)).toEqual(['fxB', 'fxA', 'fxC'])
  })

  test('a missing track is dropped, not thrown', () => {
    const s = chainState()
    expect(apply(s, { type: 'plugin/reorder', trackId: 'ghost', order: ['fxA'] })).toBe(s)
  })
})

suite('master-bus inserts', () => {
  /** Two inserts on the master bus (MASTER_BUS_ID is not a track). */
  function masterState(): ProjectState {
    let s = baseState()
    s = apply(s, { type: 'plugin/add', instance: plugin('mfx1', MASTER_BUS_ID, 'compressor', {}, 1) })
    s = apply(s, { type: 'plugin/add', instance: plugin('mfx2', MASTER_BUS_ID, 'limiter', {}, 2) })
    return s
  }

  test('plugin/add accepts the master bus without a track entry', () => {
    const s = masterState()
    expect(s.tracks[MASTER_BUS_ID]).toBeUndefined()
    expect(pluginsOfTrack(s, MASTER_BUS_ID).map((p) => p.id)).toEqual(['mfx1', 'mfx2'])
  })

  test('apply(invert) round-trips a master plugin/add', () => {
    const before = baseState()
    const op: Operation = { type: 'plugin/add', instance: plugin('mfx1', MASTER_BUS_ID, 'reverb') }
    const inverse = invert(before, op)
    expect(inverse).not.toBeNull()
    const after = apply(before, op)
    expect(after).not.toBe(before)
    expect(apply(after, inverse!)).toEqual(before)
  })

  test('apply(invert) round-trips a master plugin/remove', () => {
    const before = masterState()
    const op: Operation = { type: 'plugin/remove', instanceId: 'mfx1' }
    const inverse = invert(before, op)
    expect(inverse).not.toBeNull()
    expect(apply(apply(before, op), inverse!)).toEqual(before)
  })

  test('plugin/reorder works on the master chain and round-trips', () => {
    const before = masterState()
    const op: Operation = { type: 'plugin/reorder', trackId: MASTER_BUS_ID, order: ['mfx2', 'mfx1'] }
    const inverse = invert(before, op)
    const after = apply(before, op)
    expect(pluginsOfTrack(after, MASTER_BUS_ID).map((p) => p.id)).toEqual(['mfx2', 'mfx1'])
    expect(apply(after, inverse!)).toEqual(before)
  })

  test('params on master inserts clamp exactly like a track insert', () => {
    const s = apply(masterState(), {
      type: 'plugin/setParam',
      instanceId: 'mfx1',
      param: 'threshold',
      value: -10000
    })
    // The reducer clamps against the descriptor's defs, so the absurd
    // input cannot survive verbatim — same rule as any track insert.
    expect(s.plugins['mfx1'].params.threshold).toBeGreaterThan(-10000)
    expect(Number.isFinite(s.plugins['mfx1'].params.threshold)).toBe(true)
  })

  test('a normal track id that does not exist is still refused', () => {
    const s = baseState()
    expect(apply(s, { type: 'plugin/add', instance: plugin('mfx1', 'ghost', 'reverb') })).toBe(s)
  })

  test('the activity feed names the master bus', () => {
    const s = baseState()
    const text = describeOp(s, {
      type: 'plugin/add',
      instance: plugin('mfx1', MASTER_BUS_ID, 'reverb')
    })
    expect(text).toContain('"Master"')
  })
})

suite('plugin/setSidechain', () => {
  test('apply(invert) round-trips setting and clearing the key', () => {
    const before = baseState() // fxA lives on t1
    const set: Operation = { type: 'plugin/setSidechain', instanceId: 'fxA', trackId: 't2' }
    const inverse = invert(before, set)
    expect(inverse).not.toBeNull()
    const after = apply(before, set)
    expect(after.plugins['fxA'].sidechainTrackId).toBe('t2')
    expect(apply(after, inverse!)).toEqual(before)

    const clear: Operation = { type: 'plugin/setSidechain', instanceId: 'fxA', trackId: null }
    const clearInverse = invert(after, clear)
    const cleared = apply(after, clear)
    // Clearing removes the field outright — no explicit null accretes.
    expect('sidechainTrackId' in cleared.plugins['fxA']).toBe(false)
    expect(apply(cleared, clearInverse!)).toEqual(after)
  })

  test('is idempotent — re-applying the same key yields identical state', () => {
    const s = apply(baseState(), { type: 'plugin/setSidechain', instanceId: 'fxA', trackId: 't2' })
    expect(apply(s, { type: 'plugin/setSidechain', instanceId: 'fxA', trackId: 't2' })).toBe(s)
  })

  test('a self-key, an unknown track and an unknown instance are all no-ops', () => {
    const s = baseState()
    expect(apply(s, { type: 'plugin/setSidechain', instanceId: 'fxA', trackId: 't1' })).toBe(s)
    expect(apply(s, { type: 'plugin/setSidechain', instanceId: 'fxA', trackId: 'ghost' })).toBe(s)
    expect(apply(s, { type: 'plugin/setSidechain', instanceId: 'ghost', trackId: 't2' })).toBe(s)
  })

  test('the key survives the source track being deleted (stale, not cascaded)', () => {
    let s = apply(baseState(), { type: 'plugin/setSidechain', instanceId: 'fxA', trackId: 't2' })
    s = apply(s, { type: 'track/delete', trackId: 't2' })
    // The reference stays: the engine treats it as silent, and undoing the
    // delete brings the sidechain back with zero extra ops (the pad rule).
    expect(s.plugins['fxA'].sidechainTrackId).toBe('t2')
  })

  test('describes both directions for the activity feed', () => {
    const s = apply(baseState(), { type: 'plugin/setSidechain', instanceId: 'fxA', trackId: 't2' })
    expect(
      describeOp(baseState(), { type: 'plugin/setSidechain', instanceId: 'fxA', trackId: 't2' })
    ).toContain('Sidechained')
    expect(
      describeOp(s, { type: 'plugin/setSidechain', instanceId: 'fxA', trackId: null })
    ).toContain('Cleared')
  })
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

suite('effect routing', () => {
  /** baseState (in → fxA → out on t1) plus a second effect fxB, unwired. */
  const twoFx = (): ProjectState =>
    apply(baseState(), { type: 'plugin/add', instance: plugin('fxB', 't1', 'delay', {}, 2) })

  test('branching and merging: one output feeds many, many merge into out', () => {
    let s = twoFx()
    s = apply(s, {
      type: 'route/addMany',
      routes: [
        { id: 'r1', trackId: 't1', from: 'in', to: 'fxB' },
        { id: 'r2', trackId: 't1', from: 'fxB', to: 'out' }
      ]
    })
    // in fans out to fxA and fxB; both merge into out.
    expect(Object.keys(s.routes).sort()).toEqual(['r1', 'r2', 'rA', 'rB'])
  })

  test('a cycle is rejected; the rest of the op still lands', () => {
    let s = twoFx()
    s = apply(s, {
      type: 'route/addMany',
      routes: [
        { id: 'r1', trackId: 't1', from: 'fxA', to: 'fxB' },
        { id: 'r2', trackId: 't1', from: 'fxB', to: 'fxA' }, // closes a loop
        { id: 'r3', trackId: 't1', from: 'fxB', to: 'out' }
      ]
    })
    expect(s.routes['r1']).toBeDefined()
    expect(s.routes['r2']).toBeUndefined()
    expect(s.routes['r3']).toBeDefined()
  })

  test('duplicates, cross-track endpoints, self-loops and backwards terminals are rejected', () => {
    const s = twoFx()
    const rejected: Operation = {
      type: 'route/addMany',
      routes: [
        { id: 'd1', trackId: 't1', from: 'in', to: 'fxA' }, // duplicate of rA
        { id: 'd2', trackId: 't2', from: 'in', to: 'fxA' }, // fxA lives on t1
        { id: 'd3', trackId: 't1', from: 'fxA', to: 'fxA' }, // self-loop
        { id: 'd4', trackId: 't1', from: 'out', to: 'fxA' }, // out has no output
        { id: 'd5', trackId: 't1', from: 'fxA', to: 'in' } // in has no input
      ]
    }
    expect(apply(s, rejected)).toBe(s)
  })

  test('removing a plugin cascades its routes; undo restores node and edges', () => {
    const store = new ProjectStore(baseState(), 'tester')
    store.dispatch({ type: 'plugin/remove', instanceId: 'fxA' })
    expect(Object.keys(store.state.routes)).toHaveLength(0)
    store.undo()
    expect(store.state.plugins['fxA']).toBeDefined()
    expect(Object.keys(store.state.routes).sort()).toEqual(['rA', 'rB'])
  })

  test('deleting a track drops its routes; undo restores them', () => {
    const store = new ProjectStore(baseState(), 'tester')
    store.dispatch({ type: 'track/delete', trackId: 't1' })
    expect(Object.keys(store.state.routes)).toHaveLength(0)
    store.undo()
    expect(Object.keys(store.state.routes).sort()).toEqual(['rA', 'rB'])
  })

  test('duplicating a track clones its routing graph with remapped ids', () => {
    const s = baseState()
    const op = buildDuplicateTrackOp(s, 't1')!
    const after = apply(s, op)
    const copyId = (op as { track: Track }).track.id
    const copied = Object.values(after.routes).filter((r) => r.trackId === copyId)
    expect(copied).toHaveLength(2)
    // Same shape (in → copy-of-fxA → out), no id shared with the original.
    expect(copied.some((r) => r.from === 'in')).toBe(true)
    expect(copied.some((r) => r.to === 'out')).toBe(true)
    expect(copied.every((r) => !['rA', 'rB'].includes(r.id))).toBe(true)
    expect(copied.every((r) => r.from !== 'fxA' && r.to !== 'fxA')).toBe(true)
  })

  test('plugin-param automation: validated on add, cascades with the insert, restores on undo', () => {
    const store = new ProjectStore(baseState(), 'tester')
    // Rejected: unknown param on the insert, and wrong track.
    store.dispatch({
      type: 'automation/add',
      point: { id: 'apX', trackId: 't1', param: 'nope', instanceId: 'fxA', ticks: 0, value: 0.5 }
    })
    store.dispatch({
      type: 'automation/add',
      point: { id: 'apY', trackId: 't2', param: 'low', instanceId: 'fxA', ticks: 0, value: 0.5 }
    })
    expect(store.state.automation['apX']).toBeUndefined()
    expect(store.state.automation['apY']).toBeUndefined()
    // Accepted: a real param of fxA (an eq3) on its own track.
    store.dispatch({
      type: 'automation/add',
      point: { id: 'apF', trackId: 't1', param: 'low', instanceId: 'fxA', ticks: 480, value: 0.75 }
    })
    expect(store.state.automation['apF']).toBeDefined()
    // Removing the insert cascades its curve away; undo restores both.
    store.dispatch({ type: 'plugin/remove', instanceId: 'fxA' })
    expect(store.state.automation['apF']).toBeUndefined()
    store.undo()
    expect(store.state.plugins['fxA']).toBeDefined()
    expect(store.state.automation['apF']).toMatchObject({
      instanceId: 'fxA',
      param: 'low',
      value: 0.75
    })
  })

  test('graph terminal placement round-trips through undo (after first placement)', () => {
    const store = new ProjectStore(baseState(), 'tester')
    // First placement: nothing to restore, deliberately not undoable.
    expect(
      invert(store.state, {
        type: 'track/setGraphTerminal',
        trackId: 't1',
        terminal: 'out',
        x: 10,
        y: 10
      })
    ).toBeNull()
    store.dispatch({ type: 'track/setGraphTerminal', trackId: 't1', terminal: 'out', x: 500, y: 60 })
    expect(store.state.tracks['t1'].graphOutX).toBe(500)
    const placed = store.state
    store.dispatch({ type: 'track/setGraphTerminal', trackId: 't1', terminal: 'out', x: 620, y: 90 })
    store.undo()
    expect(store.state).toEqual(placed)
    // The other terminal is untouched throughout.
    expect(store.state.tracks['t1'].graphInX).toBeUndefined()
  })

  test('first node placement is not undoable (nothing to restore); later moves are', () => {
    const s = twoFx()
    // fxB has never been placed: no position to return to.
    expect(invert(s, { type: 'plugin/setGraphPos', instanceId: 'fxB', x: 10, y: 10 })).toBeNull()
    // fxA was placed at (120, 80) in baseState: invert restores that.
    expect(invert(s, { type: 'plugin/setGraphPos', instanceId: 'fxA', x: 10, y: 10 })).toEqual({
      type: 'plugin/setGraphPos',
      instanceId: 'fxA',
      x: 120,
      y: 80
    })
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

  test('resetting stretch to 1x undoes the whole gesture, plain and looped', () => {
    // The reset the stretch handle dispatches on double-click (ClipView):
    // rate AND length together, so it is the exact inverse of a drag.
    const resetOp = (c: Clip): Operation => ({
      type: 'clip/resize',
      clipId: c.id,
      start: c.start,
      duration: Math.max(1, Math.round(c.duration / c.stretch)),
      offset: c.offset,
      stretch: 1,
      ...(c.loopLength > 0 ? { loopLength: Math.round(c.loopLength / c.stretch) } : {})
    })

    const plain = baseState() // c1: duration 960, stretch 1
    const stretched = apply(plain, {
      type: 'clip/resize',
      clipId: 'c1',
      start: 0,
      duration: 1920,
      offset: 0,
      stretch: 2
    })
    expect(apply(stretched, resetOp(stretched.clips.c1))).toEqual(plain)

    // A looped clip comes back to its original period and repeat count.
    const looped = apply(plain, {
      type: 'clip/resize',
      clipId: 'c1',
      start: 0,
      duration: 2880, // 3 repeats of 960
      offset: 0,
      loopLength: 960
    })
    const loopedStretched = apply(looped, {
      type: 'clip/resize',
      clipId: 'c1',
      start: 0,
      duration: 5760,
      offset: 0,
      stretch: 2,
      loopLength: 1920
    })
    expect(apply(loopedStretched, resetOp(loopedStretched.clips.c1))).toEqual(looped)

    // Idempotent: the sync layer may deliver it more than once.
    const once = apply(stretched, resetOp(stretched.clips.c1))
    expect(apply(once, resetOp(stretched.clips.c1))).toEqual(once)
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

suite('project/setTempo trim-point preservation', () => {
  /** baseState plus one audio clip trimmed `offset` ticks into its source. */
  function withAudioClip(offset: number, extra: Partial<Clip> = {}): ProjectState {
    return apply(baseState(), {
      type: 'clip/create',
      clip: { ...clip('ca', 't1', 0, 960), assetId: 'ast_a', offset, ...extra },
      notes: []
    })
  }

  test('un-conformed audio offsets rescale so the source trim point holds', () => {
    const s = withAudioClip(480)
    const applied = apply(s, { type: 'project/setTempo', tempo: 240 })
    expect(applied.clips['ca'].offset).toBe(960) // 480 · 240/120
    // The physical trim — offset ticks / ticksPerSecond — is invariant.
    expect(applied.clips['ca'].offset / 240).toBeCloseTo(s.clips['ca'].offset / 120, 10)
  })

  test('MIDI clips keep their musical offsets', () => {
    const s = withAudioClip(480)
    const applied = apply(s, { type: 'project/setTempo', tempo: 240 })
    expect(applied.clips['c1'].offset).toBe(s.clips['c1'].offset)
    expect(applied.clips['c2'].offset).toBe(s.clips['c2'].offset)
  })

  test('conformed clips are left alone — their stretch already preserves the trim', () => {
    const s = withAudioClip(480)
    const applied = apply(s, {
      type: 'project/setTempo',
      tempo: 240,
      conform: [{ clipId: 'ca', stretch: 0.5 }]
    })
    expect(applied.clips['ca'].offset).toBe(480)
    expect(applied.clips['ca'].stretch).toBe(0.5)
  })

  test('re-delivery is a no-op (at-least-once safety)', () => {
    const s = withAudioClip(480)
    const op: Operation = { type: 'project/setTempo', tempo: 240 }
    const once = apply(s, op)
    expect(apply(once, op)).toBe(once)
  })

  test('explicit offsets entries override the derivation', () => {
    const s = withAudioClip(480)
    const applied = apply(s, {
      type: 'project/setTempo',
      tempo: 240,
      offsets: [{ clipId: 'ca', offset: 5 }]
    })
    expect(applied.clips['ca'].offset).toBe(5)
  })

  test('undo restores exact offsets where reverse derivation would round wrong', () => {
    // 120 → 80 with offset 100: forward rounds 66.67 → 67; deriving the
    // undo would give round(67 · 120/80) = round(100.5) = 101. The invert
    // op's explicit `offsets` list is what makes undo exact.
    const s = withAudioClip(100)
    const op: Operation = { type: 'project/setTempo', tempo: 80 }
    const inverse = invert(s, op)
    const applied = apply(s, op)
    expect(applied.clips['ca'].offset).toBe(67)
    expect(inverse).not.toBeNull()
    const undone = apply(applied, inverse!)
    expect(undone.clips['ca'].offset).toBe(100)
    expect(undone).toEqual(s)
  })
})

suite('take ops (comping)', () => {
  /**
   * baseState plus a second clip overlapping c1's bars and a take group on
   * t1: tg1 = { c1 (0..960, active), c3 (480..1440, inactive) }. c2
   * (1920..2880) stays loose. The starts differ so a merge of the two
   * members stays reconstructable by its inverse split.
   */
  function takeState(): ProjectState {
    let s = baseState()
    s = apply(s, { type: 'clip/create', clip: clip('c3', 't1', 480, 960), notes: [] })
    s = apply(s, {
      type: 'take/setGroups',
      entries: [
        { clipId: 'c1', groupId: 'tg1', active: true },
        { clipId: 'c3', groupId: 'tg1', active: false }
      ]
    })
    return s
  }

  // Every new op shape (and every takes-carrying variant) gets the same
  // apply(invert) round-trip the main invert suite runs.
  const roundTrips: Operation[] = [
    // Switch the active take: absolute flags for the whole group.
    {
      type: 'take/activate',
      groupId: 'tg1',
      clips: [
        { clipId: 'c1', active: false },
        { clipId: 'c3', active: true }
      ]
    },
    // Deactivate everything (divergence-tolerant absolute form).
    {
      type: 'take/activate',
      groupId: 'tg1',
      clips: [
        { clipId: 'c1', active: false },
        { clipId: 'c3', active: false }
      ]
    },
    // Pull a loose clip into an existing group.
    { type: 'take/setGroups', entries: [{ clipId: 'c2', groupId: 'tg1', active: false }] },
    // Dissolve the group; undo must restore membership AND active flags.
    {
      type: 'take/setGroups',
      entries: [
        { clipId: 'c1', groupId: null, active: false },
        { clipId: 'c3', groupId: null, active: false }
      ]
    },
    // Re-stamp into a fresh group with a different active member.
    {
      type: 'take/setGroups',
      entries: [
        { clipId: 'c1', groupId: 'tg2', active: false },
        { clipId: 'c2', groupId: 'tg2', active: true }
      ]
    },
    // The recording-commit shape: the new clip joins the group as THE
    // active take, the previous active deactivates — one op.
    {
      type: 'clip/create',
      clip: { ...clip('c9', 't1', 0, 960), takeGroupId: 'tg1', takeActive: true },
      notes: [],
      takes: [
        { clipId: 'c1', groupId: 'tg1', active: false },
        { clipId: 'c3', groupId: 'tg1', active: false }
      ]
    },
    // ...and its inverse shape: delete a take while promoting another.
    { type: 'clip/delete', clipId: 'c1', takes: [{ clipId: 'c3', groupId: 'tg1', active: true }] },
    // Multi-track MIDI recording commit shape.
    {
      type: 'clip/createMany',
      clips: [{ ...clip('c9', 't1', 0, 960), takeGroupId: 'tg1', takeActive: true }],
      notes: [],
      takes: [
        { clipId: 'c1', groupId: 'tg1', active: false },
        { clipId: 'c3', groupId: 'tg1', active: false }
      ]
    },
    // Flatten: keep c1, drop the other take, clear membership — ONE op,
    // so one undo restores the deleted take AND c1's previous membership.
    {
      type: 'clip/deleteMany',
      clipIds: ['c3'],
      takes: [{ clipId: 'c1', groupId: null, active: false }]
    },
    // Splitting a grouped take: both halves stay takes of the group.
    { type: 'clip/split', clipId: 'c1', at: 480, rightClipId: 'cs1' },
    // Merging a grouped clip over a LOOSE one: without the invert's
    // rightTake, the reconstructing split would wrongly stamp c2 into
    // c1's group by inheritance. (c2 is non-overlapping — a merge across
    // an overlap cannot reconstruct exactly, take fields or not: the
    // split reducer clamps leftDuration at the cut.)
    { type: 'clip/merge', clipId: 'c1', rightClipId: 'c2' }
  ]

  for (const op of roundTrips) {
    test(`apply(invert) restores state for ${op.type} (${JSON.stringify(op).slice(0, 60)}…)`, () => {
      const before = takeState()
      const inverse = invert(before, op)
      expect(inverse).not.toBeNull()
      const after = apply(before, op)
      expect(after).not.toBe(before)
      expect(apply(after, inverse!)).toEqual(before)
    })
  }

  test('take fields keep their canonical form (absent, never false/null)', () => {
    const s = takeState()
    expect(s.clips['c1'].takeGroupId).toBe('tg1')
    expect(s.clips['c1'].takeActive).toBe(true)
    expect(s.clips['c3'].takeGroupId).toBe('tg1')
    // Inactive member: the flag is ABSENT, not false.
    expect('takeActive' in s.clips['c3']).toBe(false)
    // Ungrouping removes both fields entirely.
    const cleared = apply(s, {
      type: 'take/setGroups',
      entries: [
        { clipId: 'c1', groupId: null, active: false },
        { clipId: 'c3', groupId: null, active: false }
      ]
    })
    expect('takeGroupId' in cleared.clips['c1']).toBe(false)
    expect('takeActive' in cleared.clips['c1']).toBe(false)
    // A clip/create carrying junk take fields is canonicalized on entry.
    const junk = apply(s, {
      type: 'clip/create',
      clip: { ...clip('cj', 't2', 0, 960), takeGroupId: null, takeActive: true },
      notes: []
    })
    expect('takeGroupId' in junk.clips['cj']).toBe(false)
    expect('takeActive' in junk.clips['cj']).toBe(false)
  })

  test('take ops are idempotent under at-least-once re-delivery', () => {
    const s = takeState()
    const activate: Operation = {
      type: 'take/activate',
      groupId: 'tg1',
      clips: [
        { clipId: 'c1', active: false },
        { clipId: 'c3', active: true }
      ]
    }
    const once = apply(s, activate)
    expect(apply(once, activate)).toBe(once)
    const stamp: Operation = {
      type: 'take/setGroups',
      entries: [{ clipId: 'c2', groupId: 'tg1', active: false }]
    }
    const stamped = apply(s, stamp)
    expect(apply(stamped, stamp)).toBe(stamped)
    const record: Operation = {
      type: 'clip/create',
      clip: { ...clip('c9', 't1', 0, 960), takeGroupId: 'tg1', takeActive: true },
      notes: [],
      takes: [
        { clipId: 'c1', groupId: 'tg1', active: false },
        { clipId: 'c3', groupId: 'tg1', active: false }
      ]
    }
    const recorded = apply(s, record)
    expect(apply(recorded, record)).toBe(recorded)
  })

  test('entries for missing clips drop individually; the rest still land (convergence)', () => {
    const s = takeState()
    const applied = apply(s, {
      type: 'take/setGroups',
      entries: [
        { clipId: 'ghost', groupId: 'tg9', active: true },
        { clipId: 'c2', groupId: 'tg9', active: true }
      ]
    })
    expect(applied.clips['c2'].takeGroupId).toBe('tg9')
    const flip = apply(s, {
      type: 'take/activate',
      groupId: 'tg1',
      clips: [
        { clipId: 'ghost', active: true },
        { clipId: 'c1', active: false },
        { clipId: 'c3', active: true }
      ]
    })
    expect('takeActive' in flip.clips['c1']).toBe(false)
    expect(flip.clips['c3'].takeActive).toBe(true)
  })

  test('an activate racing an ungroup does not resurrect membership', () => {
    const s = takeState()
    const ungrouped = apply(s, {
      type: 'take/setGroups',
      entries: [
        { clipId: 'c1', groupId: null, active: false },
        { clipId: 'c3', groupId: null, active: false }
      ]
    })
    // The stale activate targets tg1, which no clip belongs to anymore.
    const after = apply(ungrouped, {
      type: 'take/activate',
      groupId: 'tg1',
      clips: [
        { clipId: 'c1', active: false },
        { clipId: 'c3', active: true }
      ]
    })
    expect(after).toBe(ungrouped)
  })

  test('a group can never stretch across tracks (the entry drops)', () => {
    const s = takeState()
    // c9 lives on t2; tg1 lives on t1.
    const withOther = apply(s, { type: 'clip/create', clip: clip('c9', 't2', 0, 960), notes: [] })
    const stamped = apply(withOther, {
      type: 'take/setGroups',
      entries: [{ clipId: 'c9', groupId: 'tg1', active: true }]
    })
    expect(stamped).toBe(withOther)
  })

  test('several actives after concurrent edits: both flags stand until converged', () => {
    // Two peers activate different takes; the ops arrive in some order and
    // the LATER one wins whole-group (absolute flags for every member).
    const s = takeState()
    const peerA: Operation = {
      type: 'take/activate',
      groupId: 'tg1',
      clips: [
        { clipId: 'c1', active: true },
        { clipId: 'c3', active: false }
      ]
    }
    const peerB: Operation = {
      type: 'take/activate',
      groupId: 'tg1',
      clips: [
        { clipId: 'c1', active: false },
        { clipId: 'c3', active: true }
      ]
    }
    const oneOrder = apply(apply(s, peerA), peerB)
    const otherOrder = apply(apply(s, peerB), peerA)
    expect(oneOrder.clips['c3'].takeActive).toBe(true)
    expect('takeActive' in oneOrder.clips['c1']).toBe(false)
    expect(otherOrder.clips['c1'].takeActive).toBe(true)
    expect('takeActive' in otherOrder.clips['c3']).toBe(false)
  })

  test('splitting a grouped take leaves both halves in the group, active flag intact', () => {
    const s = takeState()
    const splitDone = apply(s, { type: 'clip/split', clipId: 'c1', at: 480, rightClipId: 'cs1' })
    expect(splitDone.clips['cs1'].takeGroupId).toBe('tg1')
    expect(splitDone.clips['cs1'].takeActive).toBe(true)
    // The inactive member splits into two inactive halves.
    const splitInactive = apply(s, { type: 'clip/split', clipId: 'c3', at: 960, rightClipId: 'cs3' })
    expect(splitInactive.clips['cs3'].takeGroupId).toBe('tg1')
    expect('takeActive' in splitInactive.clips['cs3']).toBe(false)
  })

  test('merging members with DIFFERENT take fields round-trips via rightTake', () => {
    // c2 (1920..2880, non-overlapping) joins tg1 as an inactive take; the
    // merged clip keeps c1's active membership, and undo must hand c2 its
    // own previous fields back — inheritance alone would mark it active.
    const before = apply(takeState(), {
      type: 'take/setGroups',
      entries: [{ clipId: 'c2', groupId: 'tg1', active: false }]
    })
    const op: Operation = { type: 'clip/merge', clipId: 'c1', rightClipId: 'c2' }
    const inverse = invert(before, op)
    expect(inverse).not.toBeNull()
    const after = apply(before, op)
    expect(after.clips['c2']).toBeUndefined()
    expect(after.clips['c1'].takeActive).toBe(true)
    expect(apply(after, inverse!)).toEqual(before)
  })

  test('deleting a take drops it from the group; remaining members are untouched', () => {
    const s = takeState()
    const after = apply(s, { type: 'clip/delete', clipId: 'c3' })
    expect(after.clips['c3']).toBeUndefined()
    expect(after.clips['c1'].takeGroupId).toBe('tg1')
    expect(after.clips['c1'].takeActive).toBe(true)
  })
})

