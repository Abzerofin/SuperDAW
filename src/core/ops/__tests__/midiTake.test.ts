import { describe as suite, expect, test } from 'vitest'
import type { ProjectState, Track } from '../../model/types'
import { createEmptyProject } from '../../model/types'
import { ticksPerBar } from '../../model/timebase'
import { apply } from '../apply'
import { invert } from '../invert'
import { buildMidiTakeOp, type MidiTake } from '../midiTake'

function track(id: string, kind: Track['kind'] = 'midi'): Track {
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

/** Two MIDI tracks (m1 with one existing clip+note), one audio track. */
function baseState(): ProjectState {
  let s = createEmptyProject('Test')
  s = apply(s, { type: 'track/create', track: track('m1'), index: 0, clips: [], automation: [], notes: [], plugins: [] })
  s = apply(s, { type: 'track/create', track: track('m2'), index: 1, clips: [], automation: [], notes: [], plugins: [] })
  s = apply(s, { type: 'track/create', track: track('a1', 'audio'), index: 2, clips: [], automation: [], notes: [], plugins: [] })
  s = apply(s, {
    type: 'clip/create',
    clip: { id: 'c1', trackId: 'm1', name: 'c1', start: 0, duration: 3840, assetId: null, offset: 0, color: null, fadeIn: 0, fadeOut: 0, reverse: false, pitch: 0, stretch: 1, loopLength: 0 },
    notes: [{ id: 'n1', clipId: 'c1', pitch: 60, start: 0, duration: 480, velocity: 100 }]
  })
  return s
}

const BAR = ticksPerBar(createEmptyProject('x').timeSignature) // 4/4 → 3840

function take(
  trackId: string,
  startTicks: number,
  endTicks: number,
  notes: MidiTake['notes']
): MidiTake {
  return { trackId, startTicks, endTicks, notes }
}

suite('buildMidiTakeOp', () => {
  test('mints fresh ids per build, never colliding, notes pointing at the minted clip', () => {
    const s = baseState()
    const input = [
      take('m1', 0, BAR, [
        { pitch: 60, velocity: 100, startTicks: 0, endTicks: 480 },
        { pitch: 64, velocity: 80, startTicks: 480, endTicks: 960 }
      ])
    ]
    const first = buildMidiTakeOp(s, input)
    const second = buildMidiTakeOp(s, input)
    if (first?.type !== 'clip/create' || second?.type !== 'clip/create') {
      throw new Error('expected clip/create ops')
    }
    // Fresh ids on every build, colliding with nothing already in the state.
    expect(first.clip.id).not.toBe(second.clip.id)
    expect(s.clips[first.clip.id]).toBeUndefined()
    const firstNoteIds = first.notes.map((n) => n.id)
    const secondNoteIds = second.notes.map((n) => n.id)
    expect(new Set([...firstNoteIds, ...secondNoteIds]).size).toBe(4)
    for (const id of firstNoteIds) expect(s.notes[id]).toBeUndefined()
    // Every note belongs to the minted clip.
    for (const note of first.notes) expect(note.clipId).toBe(first.clip.id)
  })

  test('rebases absolute ticks to clip-relative, clamping at the clip start', () => {
    const start = 2 * BAR
    const op = buildMidiTakeOp(baseState(), [
      take('m2', start, start + BAR, [
        { pitch: 62, velocity: 90, startTicks: start + 120, endTicks: start + 600 },
        // Latency compensation pulled this one slightly before the roll.
        { pitch: 65, velocity: 70, startTicks: start - 50, endTicks: start + 200 }
      ])
    ])
    if (op?.type !== 'clip/create') throw new Error('expected clip/create')
    expect(op.clip.start).toBe(start)
    expect(op.notes[0].start).toBe(120)
    expect(op.notes[0].duration).toBe(480)
    expect(op.notes[1].start).toBe(0)
    expect(op.notes[1].duration).toBe(200)
  })

  test('closes notes still held at stop at the take end', () => {
    const op = buildMidiTakeOp(baseState(), [
      take('m2', 0, 1000, [{ pitch: 60, velocity: 100, startTicks: 400, endTicks: null }])
    ])
    if (op?.type !== 'clip/create') throw new Error('expected clip/create')
    expect(op.notes[0].start).toBe(400)
    expect(op.notes[0].duration).toBe(600) // to the take end, >= 1 tick
  })

  test('rounds the clip duration up to whole bars, minimum one bar', () => {
    const tiny = buildMidiTakeOp(baseState(), [
      take('m2', 0, 10, [{ pitch: 60, velocity: 1, startTicks: 0, endTicks: 1 }])
    ])
    if (tiny?.type !== 'clip/create') throw new Error('expected clip/create')
    expect(tiny.clip.duration).toBe(BAR)

    const overOneBar = buildMidiTakeOp(baseState(), [
      take('m2', 0, 2 * BAR, [{ pitch: 60, velocity: 100, startTicks: 0, endTicks: BAR + 1 }])
    ])
    if (overOneBar?.type !== 'clip/create') throw new Error('expected clip/create')
    expect(overOneBar.clip.duration).toBe(2 * BAR)
  })

  test('empty takes build nothing; a mix keeps only the non-empty ones', () => {
    const s = baseState()
    expect(buildMidiTakeOp(s, [])).toBeNull()
    expect(buildMidiTakeOp(s, [take('m1', 0, BAR, [])])).toBeNull()
    const mixed = buildMidiTakeOp(s, [
      take('m1', 0, BAR, []),
      take('m2', 0, BAR, [{ pitch: 60, velocity: 100, startTicks: 0, endTicks: 480 }])
    ])
    if (mixed?.type !== 'clip/create') throw new Error('expected single clip/create')
    expect(mixed.clip.trackId).toBe('m2')
  })

  test('skips missing and non-MIDI tracks', () => {
    const s = baseState()
    const notes = [{ pitch: 60, velocity: 100, startTicks: 0, endTicks: 480 }]
    expect(buildMidiTakeOp(s, [take('ghost', 0, BAR, notes)])).toBeNull()
    expect(buildMidiTakeOp(s, [take('a1', 0, BAR, notes)])).toBeNull()
  })

  test('several takes stopping together become ONE clip/createMany', () => {
    const op = buildMidiTakeOp(baseState(), [
      take('m1', 0, BAR, [{ pitch: 60, velocity: 100, startTicks: 0, endTicks: 480 }]),
      take('m2', 0, BAR, [
        { pitch: 64, velocity: 90, startTicks: 100, endTicks: 500 },
        { pitch: 67, velocity: 80, startTicks: 200, endTicks: null }
      ])
    ])
    if (op?.type !== 'clip/createMany') throw new Error('expected clip/createMany')
    expect(op.clips).toHaveLength(2)
    expect(op.notes).toHaveLength(3)
    const clipIds = new Set(op.clips.map((c) => c.id))
    for (const note of op.notes) expect(clipIds.has(note.clipId)).toBe(true)
  })

  test('take names count the clips the track already holds', () => {
    const op = buildMidiTakeOp(baseState(), [
      take('m1', 0, BAR, [{ pitch: 60, velocity: 100, startTicks: 0, endTicks: 480 }]),
      take('m2', 0, BAR, [{ pitch: 64, velocity: 90, startTicks: 0, endTicks: 480 }])
    ])
    if (op?.type !== 'clip/createMany') throw new Error('expected clip/createMany')
    expect(op.clips[0].name).toBe('Take 2') // m1 already has c1
    expect(op.clips[1].name).toBe('Take 1')
  })

  test('velocity and pitch clamp into MIDI range', () => {
    const op = buildMidiTakeOp(baseState(), [
      take('m2', 0, BAR, [
        { pitch: 200, velocity: 0, startTicks: 0, endTicks: 480 },
        { pitch: -5, velocity: 300, startTicks: 480, endTicks: 960 }
      ])
    ])
    if (op?.type !== 'clip/create') throw new Error('expected clip/create')
    expect(op.notes[0].pitch).toBe(127)
    expect(op.notes[0].velocity).toBe(1)
    expect(op.notes[1].pitch).toBe(0)
    expect(op.notes[1].velocity).toBe(127)
  })

  test('apply + invert round-trips, single take', () => {
    const before = baseState()
    const op = buildMidiTakeOp(before, [
      take('m2', BAR, 2 * BAR, [
        { pitch: 60, velocity: 100, startTicks: BAR, endTicks: BAR + 480 },
        { pitch: 64, velocity: 90, startTicks: BAR + 480, endTicks: null }
      ])
    ])!
    const inverse = invert(before, op)
    expect(inverse).not.toBeNull()
    const after = apply(before, op)
    expect(after).not.toBe(before)
    expect(apply(after, inverse!)).toEqual(before)
  })

  test('apply + invert round-trips, multi-track take (one undo, whole take)', () => {
    const before = baseState()
    const op = buildMidiTakeOp(before, [
      take('m1', 0, BAR, [{ pitch: 60, velocity: 100, startTicks: 0, endTicks: 480 }]),
      take('m2', 0, BAR, [{ pitch: 64, velocity: 90, startTicks: 0, endTicks: 480 }])
    ])!
    const inverse = invert(before, op)
    expect(inverse).not.toBeNull()
    expect(apply(apply(before, op), inverse!)).toEqual(before)
  })

  test('re-applying the same op changes nothing (idempotent, at-least-once safe)', () => {
    const before = baseState()
    const single = buildMidiTakeOp(before, [
      take('m2', 0, BAR, [{ pitch: 60, velocity: 100, startTicks: 0, endTicks: 480 }])
    ])!
    const onceSingle = apply(before, single)
    expect(apply(onceSingle, single)).toBe(onceSingle)

    const many = buildMidiTakeOp(before, [
      take('m1', 0, BAR, [{ pitch: 60, velocity: 100, startTicks: 0, endTicks: 480 }]),
      take('m2', 0, BAR, [{ pitch: 64, velocity: 90, startTicks: 0, endTicks: 480 }])
    ])!
    const onceMany = apply(before, many)
    expect(apply(onceMany, many)).toBe(onceMany)
  })
})
