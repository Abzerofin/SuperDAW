import { describe as suite, expect, test } from 'vitest'
import type { Clip, ProjectState, Track } from '../../model/types'
import { createEmptyProject, isClipTakeAudible, takeGroupMembers } from '../../model/types'
import { apply } from '../apply'
import { invert } from '../invert'
import {
  buildActivateTakeOp,
  buildFlattenTakesOp,
  buildGroupTakesOp,
  buildUngroupTakesOp,
  overlappingClips,
  takeCompForClip
} from '../takes'

function track(id: string, kind: Track['kind'] = 'audio'): Track {
  return {
    id,
    kind,
    name: id,
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

function clip(id: string, trackId: string, start = 0, duration = 960, extra: Partial<Clip> = {}): Clip {
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
    loopLength: 0,
    ...extra
  }
}

/** Two tracks; t1 holds c1 (0..960), c2 (480..1440), c3 (2000..2960). */
function baseState(): ProjectState {
  let s = createEmptyProject('Test')
  s = apply(s, { type: 'track/create', track: track('t1'), index: 0, clips: [], automation: [], notes: [], plugins: [] })
  s = apply(s, { type: 'track/create', track: track('t2'), index: 1, clips: [], automation: [], notes: [], plugins: [] })
  s = apply(s, { type: 'clip/create', clip: clip('c1', 't1', 0, 960), notes: [] })
  s = apply(s, { type: 'clip/create', clip: clip('c2', 't1', 480, 960), notes: [] })
  s = apply(s, { type: 'clip/create', clip: clip('c3', 't1', 2000, 960), notes: [] })
  return s
}

/** baseState with c1+c2 grouped (c1 active). */
function groupedState(): ProjectState {
  return apply(baseState(), {
    type: 'take/setGroups',
    entries: [
      { clipId: 'c1', groupId: 'tg1', active: true },
      { clipId: 'c2', groupId: 'tg1', active: false }
    ]
  })
}

suite('takeCompForClip (recording comp, shared by audio and MIDI)', () => {
  test('no overlap: the clip records exactly as before, no stamps', () => {
    const s = baseState()
    const fresh = clip('cn', 't1', 5000, 960)
    const comped = takeCompForClip(s, fresh)
    expect(comped.clip).toBe(fresh)
    expect(comped.takes).toEqual([])
  })

  test('overlapping a loose clip forms a fresh group; the old clip deactivates', () => {
    const s = baseState()
    const comped = takeCompForClip(s, clip('cn', 't1', 2100, 960))
    expect(comped.clip.takeGroupId).toBeTruthy()
    expect(comped.clip.takeActive).toBe(true)
    expect(comped.takes).toEqual([
      { clipId: 'c3', groupId: comped.clip.takeGroupId, active: false }
    ])
  })

  test('overlapping an existing group joins it and deactivates EVERY member', () => {
    const s = groupedState()
    // Overlaps only c2's window, but the whole group must deactivate —
    // including c1, the previous active, which the new take replaces.
    const comped = takeCompForClip(s, clip('cn', 't1', 1000, 400))
    expect(comped.clip.takeGroupId).toBe('tg1')
    expect(comped.clip.takeActive).toBe(true)
    expect([...comped.takes].sort((a, b) => (a.clipId < b.clipId ? -1 : 1))).toEqual([
      { clipId: 'c1', groupId: 'tg1', active: false },
      { clipId: 'c2', groupId: 'tg1', active: false }
    ])
  })

  test('overlapping a group AND a loose clip pulls the loose one in too', () => {
    let s = groupedState()
    s = apply(s, { type: 'clip/create', clip: clip('c4', 't1', 900, 300), notes: [] })
    const comped = takeCompForClip(s, clip('cn', 't1', 0, 1440))
    expect(comped.clip.takeGroupId).toBe('tg1')
    const ids = comped.takes.map((t) => t.clipId).sort()
    expect(ids).toEqual(['c1', 'c2', 'c4'])
    expect(comped.takes.every((t) => t.groupId === 'tg1' && !t.active)).toBe(true)
  })

  test('clips on other tracks and patterns never join', () => {
    let s = baseState()
    s = apply(s, { type: 'clip/create', clip: clip('cp', 't1', 0, 960, { isPattern: true }), notes: [] })
    s = apply(s, { type: 'clip/create', clip: clip('co', 't2', 0, 960), notes: [] })
    const comped = takeCompForClip(s, clip('cn', 't1', 0, 960))
    expect(comped.takes.map((t) => t.clipId)).toEqual(['c1', 'c2'])
  })

  test('the commit round-trips: one undo removes the take and restores the previous active', () => {
    const before = groupedState()
    const comped = takeCompForClip(before, clip('cn', 't1', 0, 960))
    const op = {
      type: 'clip/create' as const,
      clip: comped.clip,
      notes: [],
      takes: comped.takes
    }
    const inverse = invert(before, op)
    expect(inverse).not.toBeNull()
    const after = apply(before, op)
    // The new take is the one that sounds; the old active is silent.
    expect(after.clips['cn'].takeActive).toBe(true)
    expect(isClipTakeAudible(after.clips['c1'])).toBe(false)
    expect(apply(after, inverse!)).toEqual(before)
  })
})

suite('take builders', () => {
  test('overlappingClips finds same-track window intersections only', () => {
    const s = baseState()
    expect(overlappingClips(s, s.clips['c1']).map((c) => c.id)).toEqual(['c2'])
    expect(overlappingClips(s, s.clips['c3'])).toEqual([])
  })

  test('buildActivateTakeOp names every member with absolute flags', () => {
    const s = groupedState()
    const op = buildActivateTakeOp(s, 'c2')
    expect(op).toEqual({
      type: 'take/activate',
      groupId: 'tg1',
      clips: [
        { clipId: 'c1', active: false },
        { clipId: 'c2', active: true }
      ]
    })
    const after = apply(s, op!)
    expect(after.clips['c2'].takeActive).toBe(true)
    expect('takeActive' in after.clips['c1']).toBe(false)
    // Ungrouped clips build nothing.
    expect(buildActivateTakeOp(s, 'c3')).toBeNull()
  })

  test('buildGroupTakesOp validates: >= 2 clips, one track, no patterns', () => {
    const s = baseState()
    const op = buildGroupTakesOp(s, ['c1', 'c2'], 'c1')
    expect(op).not.toBeNull()
    const after = apply(s, op!)
    expect(after.clips['c1'].takeGroupId).toBeTruthy()
    expect(after.clips['c2'].takeGroupId).toBe(after.clips['c1'].takeGroupId)
    expect(after.clips['c1'].takeActive).toBe(true)
    expect('takeActive' in after.clips['c2']).toBe(false)

    expect(buildGroupTakesOp(s, ['c1'], 'c1')).toBeNull()
    expect(buildGroupTakesOp(s, ['c1', 'ghost'], 'c1')).toBeNull()
    let withOther = apply(s, { type: 'clip/create', clip: clip('co', 't2', 0, 960), notes: [] })
    expect(buildGroupTakesOp(withOther, ['c1', 'co'], 'c1')).toBeNull()
    withOther = apply(s, {
      type: 'clip/create',
      clip: clip('cp', 't1', 0, 960, { isPattern: true }),
      notes: []
    })
    expect(buildGroupTakesOp(withOther, ['c1', 'cp'], 'c1')).toBeNull()
  })

  test('buildUngroupTakesOp dissolves the group; undo restores it exactly', () => {
    const before = groupedState()
    const op = buildUngroupTakesOp(before, 'tg1')!
    const inverse = invert(before, op)!
    const after = apply(before, op)
    expect(takeGroupMembers(after, 'tg1')).toEqual([])
    expect(isClipTakeAudible(after.clips['c2'])).toBe(true) // everything sounds again
    expect(apply(after, inverse)).toEqual(before)
  })

  test('buildFlattenTakesOp keeps one take, deletes the rest, clears membership — one undo', () => {
    const before = groupedState()
    const op = buildFlattenTakesOp(before, 'c2')!
    const inverse = invert(before, op)!
    const after = apply(before, op)
    expect(after.clips['c1']).toBeUndefined()
    expect('takeGroupId' in after.clips['c2']).toBe(false)
    expect(isClipTakeAudible(after.clips['c2'])).toBe(true)
    expect(apply(after, inverse)).toEqual(before)
  })

  test('flattening a one-member group degrades to ungrouping it', () => {
    let s = baseState()
    s = apply(s, {
      type: 'take/setGroups',
      entries: [{ clipId: 'c3', groupId: 'tgSolo', active: true }]
    })
    const op = buildFlattenTakesOp(s, 'c3')!
    expect(op.type).toBe('take/setGroups')
    const after = apply(s, op)
    expect('takeGroupId' in after.clips['c3']).toBe(false)
  })
})
