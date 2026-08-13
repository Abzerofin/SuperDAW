import { describe as suite, expect, test } from 'vitest'
import type { Clip, ProjectState, Track } from '../types'
import { createEmptyProject, noteSourceOf, notesOfClip, patternsOfTrack, stampsOf, timelineClips } from '../types'
import { apply } from '../../ops/apply'

/**
 * Drum loops and the two shapes a track's material comes in: PATTERNS,
 * which live in the step panel's bank and nowhere on the timeline, and
 * ordinary note clips, which own their notes AND sit at a position (every
 * clip made before patterns existed is one of these). STAMPS are neither:
 * they own nothing and simply play someone else's material.
 */

const BAR = 3840

function track(id: string): Track {
  return {
    id,
    kind: 'drum',
    name: id,
    color: '#fff',
    muted: false,
    soloed: false,
    parentId: null,
    frozenAssetId: null,
    volume: 1,
    pan: 0,
    synth: {}
  }
}

function clip(id: string, extra: Partial<Clip> = {}): Clip {
  return {
    id,
    trackId: 't1',
    name: id,
    start: 0,
    duration: BAR,
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

/** A track holding: a bank-only pattern, a legacy clip, and a stamp. */
function baseState(): ProjectState {
  let s = createEmptyProject('T')
  s = apply(s, {
    type: 'track/create',
    track: track('t1'),
    index: 0,
    clips: [],
    automation: [],
    notes: [],
    plugins: []
  })
  s = apply(s, {
    type: 'clip/create',
    clip: clip('patA', { name: 'A', isPattern: true }),
    notes: [{ id: 'n1', clipId: 'patA', pitch: 36, start: 0, duration: 240, velocity: 100 }]
  })
  s = apply(s, {
    type: 'clip/create',
    clip: clip('stampA', { name: 'A', sourceClipId: 'patA', start: BAR }),
    notes: []
  })
  // A clip from before patterns existed: owns its notes, sits on the grid.
  s = apply(s, {
    type: 'clip/create',
    clip: clip('legacy', { name: 'Old', start: BAR * 4 }),
    notes: [{ id: 'n2', clipId: 'legacy', pitch: 38, start: 0, duration: 240, velocity: 100 }]
  })
  return s
}

suite('patterns, stamps and the bank', () => {
  test('the bank lists everything that owns notes, and never a stamp', () => {
    const names = patternsOfTrack(baseState(), 't1').map((c) => c.id)
    // The legacy clip belongs in the bank too — an old project must still
    // offer its material to stamp — but the stamp itself does not.
    expect(names).toEqual(['patA', 'legacy'])
  })

  test('only patterns are kept off the timeline', () => {
    const onGrid = timelineClips(baseState()).map((c) => c.id)
    expect(onGrid).toEqual(['stampA', 'legacy'])
  })

  test('a stamp plays its source material; the source owns it', () => {
    const s = baseState()
    expect(noteSourceOf(s, 'stampA')).toBe('patA')
    expect(notesOfClip(s, 'stampA').map((n) => n.id)).toEqual(['n1'])
    expect(stampsOf(s, 'patA').map((c) => c.id)).toEqual(['stampA'])
    // A clip that owns its notes resolves to itself.
    expect(noteSourceOf(s, 'legacy')).toBe('legacy')
  })

  test('deleting a stamp leaves the pattern and its notes alone', () => {
    const s = apply(baseState(), { type: 'clip/delete', clipId: 'stampA' })
    expect(s.clips['patA']).toBeDefined()
    expect(s.notes['n1']).toBeDefined()
    expect(patternsOfTrack(s, 't1').map((c) => c.id)).toContain('patA')
  })

  test('growing a loop grows the stamps that still match its length', () => {
    let s = baseState()
    // A second stamp, deliberately trimmed to half a bar.
    s = apply(s, {
      type: 'clip/create',
      clip: clip('stampTrim', { sourceClipId: 'patA', start: BAR * 2, duration: BAR / 2 }),
      notes: []
    })
    const before = s
    s = apply(s, {
      type: 'clip/resizeWithNotes',
      clipId: 'patA',
      duration: BAR * 2,
      notes: [{ id: 'n3', clipId: 'patA', pitch: 42, start: BAR, duration: 240, velocity: 100 }],
      followers: [{ clipId: 'stampA', duration: BAR * 2 }]
    })
    expect(s.clips['patA'].duration).toBe(BAR * 2)
    expect(s.clips['stampA'].duration).toBe(BAR * 2) // followed the loop
    expect(s.clips['stampTrim'].duration).toBe(BAR / 2) // a deliberate trim stands
    // Idempotent: the same op again changes nothing (at-least-once delivery).
    expect(apply(s, {
      type: 'clip/resizeWithNotes',
      clipId: 'patA',
      duration: BAR * 2,
      notes: [{ id: 'n3', clipId: 'patA', pitch: 42, start: BAR, duration: 240, velocity: 100 }],
      followers: [{ clipId: 'stampA', duration: BAR * 2 }]
    })).toEqual(s)
    // And the whole thing is one undo step, followers included.
    expect(before.clips['stampA'].duration).toBe(BAR)
  })
})
