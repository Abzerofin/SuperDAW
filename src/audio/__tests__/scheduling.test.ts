import { describe as suite, expect, test } from 'vitest'
import type { Clip, ProjectState, Track } from '@core/model/types'
import { createEmptyProject } from '@core/model/types'
import { PPQ } from '@core/model/timebase'
import { apply } from '@core/ops/apply'
import { beatIndexAt, metronomeClicks, scheduleClips, scheduleNotes, ticksPerSecond } from '../scheduling'
import { computePeaks, type AudioBufferLike } from '../assets'

// 120 BPM => 2 beats/sec => 1920 ticks/sec; 1 beat = 960 ticks = 0.5 s
const TEMPO = 120
const TPS = ticksPerSecond(TEMPO)

function stateWith(clips: Partial<Clip>[]): ProjectState {
  const track: Track = {
    id: 't1',
    kind: 'audio',
    name: 'T',
    color: '#fff',
    muted: false,
    soloed: false,
    volume: 1,
    pan: 0
  }
  let s = createEmptyProject('Test')
  s = { ...s, tempo: TEMPO }
  s = apply(s, { type: 'track/create', track, index: 0, clips: [], automation: [], notes: [] })
  for (const [i, partial] of clips.entries()) {
    const clip: Clip = {
      id: `c${i}`,
      trackId: 't1',
      name: `c${i}`,
      start: 0,
      duration: PPQ * 4,
      assetId: 'a1',
      offset: 0,
      color: null,
      ...partial
    }
    s = apply(s, { type: 'clip/create', clip, notes: [] })
  }
  return s
}

const tenSecondAsset = (): number | null => 10

suite('scheduleClips', () => {
  test('future clip starts at its mapped clock time with its base offset', () => {
    // clip at bar 2 (tick 3840) = 2.0 s after tick 0; anchor at origin, clock 100
    const s = stateWith([{ start: 3840, offset: 960 }])
    const [sched] = scheduleClips(s, tenSecondAsset, 0, 100)
    expect(sched.when).toBeCloseTo(102)
    expect(sched.offsetSec).toBeCloseTo(960 / TPS) // 0.5 s into the source
    expect(sched.durationSec).toBeCloseTo((PPQ * 4) / TPS) // 2 s
  })

  test('starting mid-clip advances the source offset by the elapsed amount', () => {
    // anchor 1 beat (0.5 s) into a clip that starts at 0
    const s = stateWith([{ start: 0, duration: PPQ * 4 }])
    const [sched] = scheduleClips(s, tenSecondAsset, 960, 100)
    expect(sched.when).toBeCloseTo(100)
    expect(sched.offsetSec).toBeCloseTo(0.5)
    expect(sched.durationSec).toBeCloseTo(1.5)
  })

  test('clips entirely in the past or with unavailable assets are skipped', () => {
    const s = stateWith([{ start: 0, duration: 960 }, { start: 960, assetId: null }])
    expect(scheduleClips(s, tenSecondAsset, 4800, 100)).toHaveLength(0)
    const s2 = stateWith([{ start: 0 }])
    expect(scheduleClips(s2, () => null, 0, 100)).toHaveLength(0)
  })

  test('duration is clamped to the remaining source material', () => {
    // 10 s asset, clip trimmed to start 9.5 s into it, clip length 2 s
    const s = stateWith([{ start: 0, duration: PPQ * 4, offset: Math.round(9.5 * TPS) }])
    const [sched] = scheduleClips(s, tenSecondAsset, 0, 0)
    expect(sched.durationSec).toBeCloseTo(0.5)
  })

  test('clip trimmed entirely past the end of its source is silent', () => {
    const s = stateWith([{ start: 0, offset: Math.round(11 * TPS) }])
    expect(scheduleClips(s, tenSecondAsset, 0, 0)).toHaveLength(0)
  })
})

suite('scheduleNotes', () => {
  function midiState(
    clipStart: number,
    clipDuration: number,
    notes: Array<{ id: string; start: number; duration: number; pitch?: number }>
  ): ProjectState {
    let s = createEmptyProject('Test')
    s = { ...s, tempo: TEMPO }
    s = apply(s, {
      type: 'track/create',
      track: {
        id: 'm1',
        kind: 'midi',
        name: 'M',
        color: '#fff',
        muted: false,
        soloed: false,
        volume: 1,
        pan: 0
      },
      index: 0,
      clips: [],
      automation: [],
      notes: []
    })
    s = apply(s, {
      type: 'clip/create',
      clip: {
        id: 'mc1',
        trackId: 'm1',
        name: 'MC',
        start: clipStart,
        duration: clipDuration,
        assetId: null,
        offset: 0,
        color: null
      },
      notes: notes.map((n) => ({
        id: n.id,
        clipId: 'mc1',
        pitch: n.pitch ?? 60,
        start: n.start,
        duration: n.duration,
        velocity: 100
      }))
    })
    return s
  }

  test('maps clip-relative note time to absolute clock time', () => {
    // clip at bar 2 (tick 3840 = 2 s); note one beat in, one beat long
    const s = midiState(3840, PPQ * 4, [{ id: 'n1', start: PPQ, duration: PPQ }])
    const [n] = scheduleNotes(s, 0, 100)
    expect(n.startSec).toBeCloseTo(102.5)
    expect(n.endSec).toBeCloseTo(103)
    expect(n.velocity).toBeCloseTo(100 / 127)
  })

  test('notes are clipped to the clip window and past notes skipped', () => {
    const s = midiState(0, PPQ * 2, [
      { id: 'ended', start: 0, duration: PPQ }, // past when anchored at 3 beats
      { id: 'overhang', start: PPQ, duration: PPQ * 4 } // truncated at clip end
    ])
    const scheduled = scheduleNotes(s, PPQ * 3, 100)
    expect(scheduled).toHaveLength(0) // both fully before the anchor after clipping

    const fromStart = scheduleNotes(s, 0, 100)
    const overhang = fromStart.find((n) => n.startSec > 100)!
    expect(overhang.endSec).toBeCloseTo(101) // clip end at 1 s, not note end at 2.5 s
  })

  test('notes on audio tracks or dead clips are ignored', () => {
    const s = midiState(0, PPQ * 4, [{ id: 'n1', start: 0, duration: PPQ }])
    const dead = apply(s, { type: 'clip/delete', clipId: 'mc1' })
    expect(scheduleNotes(dead, 0, 0)).toHaveLength(0)
  })
})

suite('metronomeClicks', () => {
  test('emits beat-aligned clicks with downbeats every bar', () => {
    const s = stateWith([])
    // anchor: tick 0 at clock 10. Window covering first 5 beats (2.5 s).
    const { clicks, nextBeatIndex } = metronomeClicks(s, 0, 10, 0, 10, 12.5)
    expect(clicks.map((c) => c.when)).toEqual([10, 10.5, 11, 11.5, 12])
    expect(clicks.map((c) => c.isDownbeat)).toEqual([true, false, false, false, true])
    expect(nextBeatIndex).toBe(5)
  })

  test('windows are contiguous and non-overlapping across calls', () => {
    const s = stateWith([])
    const w1 = metronomeClicks(s, 0, 10, 0, 10, 10.7)
    const w2 = metronomeClicks(s, 0, 10, w1.nextBeatIndex, 10.7, 11.6)
    expect(w1.clicks.map((c) => c.when)).toEqual([10, 10.5])
    expect(w2.clicks.map((c) => c.when)).toEqual([11, 11.5])
  })

  test('beatIndexAt finds the next beat boundary', () => {
    const s = stateWith([])
    expect(beatIndexAt(s, 0)).toBe(0)
    expect(beatIndexAt(s, 1)).toBe(1)
    expect(beatIndexAt(s, 960)).toBe(1)
  })
})

suite('computePeaks', () => {
  test('captures min/max per bucket across channels', () => {
    const sampleRate = 100
    const left = new Float32Array(200)
    const right = new Float32Array(200)
    left[10] = 0.5 // first second
    right[20] = -0.75 // first second
    left[150] = 1 // second second
    const buffer: AudioBufferLike = {
      numberOfChannels: 2,
      length: 200,
      sampleRate,
      getChannelData: (c) => (c === 0 ? left : right)
    }
    const peaks = computePeaks(buffer, 1) // 1 bucket per second => 2 buckets
    expect(Array.from(peaks)).toEqual([-0.75, 0.5, 0, 1])
  })
})
