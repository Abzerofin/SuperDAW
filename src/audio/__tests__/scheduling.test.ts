import { describe as suite, expect, test } from 'vitest'
import type { Clip, ProjectState, Track } from '@core/model/types'
import { createEmptyProject } from '@core/model/types'
import { PPQ } from '@core/model/timebase'
import { apply } from '@core/ops/apply'
import { beatIndexAt, clipFadeRamps, clipSegments, effectiveFades, fadeCurve, metronomeClicks, scheduleClips, scheduleNotes, ticksPerSecond, trackLoopRepeatState, trackLoopSpan } from '../scheduling'
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
    parentId: null,
    frozenAssetId: null,
    volume: 1,
    pan: 0,
    synth: {}
  }
  let s = createEmptyProject('Test')
  s = { ...s, tempo: TEMPO }
  s = apply(s, { type: 'track/create', track, index: 0, clips: [], automation: [], notes: [], plugins: [] })
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
      fadeIn: 0,

      fadeOut: 0,

      reverse: false,

      pitch: 0,

      stretch: 1,
      loopLength: 0,
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

  test('warped clips read the stretched copy at the pitch-only rate', () => {
    // warp + stretch 2 + pitch +12: buffer = 4× the source (2 · 2^(12/12)),
    // read at rate 2 — so the timeline sees length × 2 (stretch alone) and
    // the pitch rides the resample without re-timing anything.
    const s = stateWith([
      { start: 0, duration: PPQ * 4, offset: 960, stretch: 2, pitch: 12, warp: true }
    ])
    const [sched] = scheduleClips(s, tenSecondAsset, 0, 100)
    expect(sched.warpFactor).toBeCloseTo(4)
    expect(sched.rate).toBeCloseTo(2)
    // Offset ticks map through the pitch-only rate into WARPED seconds.
    expect(sched.offsetSec).toBeCloseTo((960 / TPS) * 2)
    // 2 timeline seconds consume 4 buffer seconds at rate 2 — well inside
    // the 40 warped seconds the 10 s source stretches to.
    expect(sched.durationSec).toBeCloseTo(4)
  })

  test('a tape clip with the same numbers still couples pitch and time', () => {
    const s = stateWith([{ start: 0, duration: PPQ * 4, stretch: 2, pitch: 12 }])
    const [sched] = scheduleClips(s, tenSecondAsset, 0, 100)
    expect(sched.warpFactor).toBe(1)
    expect(sched.rate).toBeCloseTo(1) // 2^(12/12) / 2
  })


  test('pitching up an octave reads the buffer twice as fast', () => {
    const s = stateWith([{ start: 0, duration: PPQ * 4, pitch: 12 }])
    const [sched] = scheduleClips(s, tenSecondAsset, 0, 100)
    expect(sched.rate).toBeCloseTo(2)
    // 2 s of timeline at double rate consumes 4 s of material...
    expect(sched.durationSec).toBeCloseTo(4)
    // ...and still occupies exactly the clip's 2 s window.
    expect(sched.durationSec / sched.rate).toBeCloseTo(2)
  })

  test('stretching to 2x plays at half speed and covers the same window', () => {
    const s = stateWith([{ start: 0, duration: PPQ * 4, stretch: 2 }])
    const [sched] = scheduleClips(s, tenSecondAsset, 0, 100)
    expect(sched.rate).toBeCloseTo(0.5)
    expect(sched.durationSec).toBeCloseTo(1) // only 1 s of material fills 2 s
    expect(sched.durationSec / sched.rate).toBeCloseTo(2)
  })

  test('pitch and stretch combine into one resampling rate', () => {
    const s = stateWith([{ start: 0, duration: PPQ * 4, pitch: 12, stretch: 2 }])
    const [sched] = scheduleClips(s, tenSecondAsset, 0, 100)
    expect(sched.rate).toBeCloseTo(1) // +1 octave and half speed cancel out
  })

  test('a reversed clip reads the mirrored region, counted from the buffer end', () => {
    // clip trimmed to start 1 s into a 10 s asset, 2 s long
    const s = stateWith([{ start: 0, duration: PPQ * 4, offset: Math.round(1 * TPS), reverse: true }])
    const [sched] = scheduleClips(s, tenSecondAsset, 0, 100)
    expect(sched.reverse).toBe(true)
    // region [1s, 3s] mirrors to [10-3, 10-1] = start at 7 s in the reversed copy
    expect(sched.offsetSec).toBeCloseTo(7)
    expect(sched.durationSec).toBeCloseTo(2)
  })

  test('resuming mid-clip skips proportionally more material when resampled', () => {
    // anchor 1 beat (0.5 s) into a double-rate clip: 1 s of material consumed
    const s = stateWith([{ start: 0, duration: PPQ * 4, pitch: 12 }])
    const [sched] = scheduleClips(s, tenSecondAsset, PPQ, 100)
    expect(sched.offsetSec).toBeCloseTo(1)
    expect(sched.durationSec).toBeCloseTo(3) // 1.5 s of window left at rate 2
  })

  test('a reversed clip resuming mid-clip advances into the mirrored region', () => {
    const s = stateWith([{ start: 0, duration: PPQ * 4, reverse: true }])
    const [sched] = scheduleClips(s, tenSecondAsset, PPQ, 100)
    // region [0,2] mirrors to start 8 s in; half a second already played
    expect(sched.offsetSec).toBeCloseTo(8.5)
    expect(sched.durationSec).toBeCloseTo(1.5)
  })

  test('slowing a clip past the end of its source is clamped, not stretched past it', () => {
    // 10 s asset played at 0.25x would need 40 s of material for a 40 s window
    const s = stateWith([{ start: 0, duration: PPQ * 80, stretch: 4 }])
    const [sched] = scheduleClips(s, tenSecondAsset, 0, 0)
    expect(sched.durationSec).toBeLessThanOrEqual(10)
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
        parentId: null,
        frozenAssetId: null,
        volume: 1,
        pan: 0,
        synth: {}
      },
      index: 0,
      clips: [],
      automation: [],
      notes: [],
      plugins: []
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
        color: null,
        fadeIn: 0,
        fadeOut: 0,
        reverse: false,
        pitch: 0,
        stretch: 1,
        loopLength: 0
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
      { id: 'ended', start: 0, duration: PPQ },
      { id: 'overhang', start: PPQ, duration: PPQ * 4 }
    ])
    expect(scheduleNotes(s, PPQ * 3, 100)).toHaveLength(0)

    const fromStart = scheduleNotes(s, 0, 100)
    const overhang = fromStart.find((n) => n.startSec > 100)!
    expect(overhang.endSec).toBeCloseTo(101) // clip end at 1 s, not note end at 2.5 s
  })

  test('notes on audio tracks or dead clips are ignored', () => {
    const s = midiState(0, PPQ * 4, [{ id: 'n1', start: 0, duration: PPQ }])
    const dead = apply(s, { type: 'clip/delete', clipId: 'mc1' })
    expect(scheduleNotes(dead, 0, 0)).toHaveLength(0)
  })

  test('untilTicks cuts notes at a loop region boundary', () => {
    const s = midiState(0, PPQ * 8, [
      { id: 'inside', start: 0, duration: PPQ * 4 }, // straddles the boundary
      { id: 'after', start: PPQ * 6, duration: PPQ } // starts past it
    ])
    const scheds = scheduleNotes(s, 0, 100, PPQ * 2)
    expect(scheds).toHaveLength(1)
    expect(scheds[0].endSec).toBeCloseTo(101) // cut at the region end (2 beats = 1 s)
  })
})

suite('clip looping', () => {
  test('clipSegments tiles the clip; final repeat is partial; non-looped is one window', () => {
    const base = {
      id: 'c',
      trackId: 't1',
      name: 'c',
      start: 960,
      duration: PPQ * 4, // 3840
      assetId: 'a1',
      offset: 0,
      color: null,
      fadeIn: 0,
      fadeOut: 0,
      reverse: false,
      pitch: 0,
      stretch: 1,
      loopLength: 0
    }
    expect(clipSegments(base)).toEqual([{ start: 960, duration: 3840 }])
    // 3840 over a 1500-tick period: 1500 + 1500 + 840
    expect(clipSegments({ ...base, loopLength: 1500 })).toEqual([
      { start: 960, duration: 1500 },
      { start: 2460, duration: 1500 },
      { start: 3960, duration: 840 }
    ])
    // Period >= duration behaves like no loop.
    expect(clipSegments({ ...base, loopLength: 4000 })).toEqual([{ start: 960, duration: 3840 }])
  })

  test('a looped audio clip schedules one source per repeat, all from the same offset', () => {
    // 2-beat material looped across 4 beats: two full repeats.
    const s = stateWith([{ start: 0, duration: PPQ * 4, loopLength: PPQ * 2, offset: PPQ }])
    const scheds = scheduleClips(s, tenSecondAsset, 0, 100)
    expect(scheds).toHaveLength(2)
    expect(scheds[0].when).toBeCloseTo(100)
    expect(scheds[1].when).toBeCloseTo(101) // 2 beats = 1 s later
    // Every repeat replays from the clip's material offset (1 beat = 0.5 s).
    expect(scheds[0].offsetSec).toBeCloseTo(0.5)
    expect(scheds[1].offsetSec).toBeCloseTo(0.5)
    expect(scheds[0].durationSec).toBeCloseTo(1)
    expect(scheds[1].durationSec).toBeCloseTo(1)
  })

  test('starting mid-repeat plays the tail of that repeat, then full repeats', () => {
    const s = stateWith([{ start: 0, duration: PPQ * 4, loopLength: PPQ * 2 }])
    // Anchor 1 beat in: half of repeat 1 remains, then repeat 2 in full.
    const scheds = scheduleClips(s, tenSecondAsset, PPQ, 100)
    expect(scheds).toHaveLength(2)
    expect(scheds[0].when).toBeCloseTo(100)
    expect(scheds[0].offsetSec).toBeCloseTo(0.5) // skipped 1 beat of material
    expect(scheds[0].durationSec).toBeCloseTo(0.5)
    expect(scheds[1].when).toBeCloseTo(100.5)
    expect(scheds[1].offsetSec).toBeCloseTo(0)
    expect(scheds[1].durationSec).toBeCloseTo(1)
  })

  test('looped MIDI clip repeats its notes each iteration and cuts them at the period', () => {
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
        parentId: null,
        frozenAssetId: null,
        volume: 1,
        pan: 0,
        synth: {}
      },
      index: 0,
      clips: [],
      automation: [],
      notes: [],
      plugins: []
    })
    s = apply(s, {
      type: 'clip/create',
      clip: {
        id: 'mc1',
        trackId: 'm1',
        name: 'MC',
        start: 0,
        duration: PPQ * 4,
        assetId: null,
        offset: 0,
        color: null,
        fadeIn: 0,
        fadeOut: 0,
        reverse: false,
        pitch: 0,
        stretch: 1,
        loopLength: PPQ * 2
      },
      notes: [
        // At the loop start, and one crossing the period boundary (gets cut).
        { id: 'n1', clipId: 'mc1', pitch: 60, start: 0, duration: PPQ, velocity: 100 },
        { id: 'n2', clipId: 'mc1', pitch: 64, start: PPQ * 1.5, duration: PPQ, velocity: 100 }
      ]
    })
    const notes = scheduleNotes(s, 0, 100)
    // Each of the 2 notes plays twice (2 repeats over 4 beats).
    expect(notes).toHaveLength(4)
    const starts = notes.map((n) => n.startSec)
    expect(starts[0]).toBeCloseTo(100) // n1, repeat 1
    expect(starts[1]).toBeCloseTo(100.75) // n2, repeat 1
    expect(starts[2]).toBeCloseTo(101) // n1, repeat 2
    expect(starts[3]).toBeCloseTo(101.75) // n2, repeat 2
    // n2 is cut at its repeat's end (period boundary), not the clip end.
    const n2First = notes[1]
    expect(n2First.endSec).toBeCloseTo(101) // cut at 2-beat boundary
  })

  test('a stamp plays its source loop, and follows edits made to it', () => {
    let s = createEmptyProject('Test')
    s = { ...s, tempo: TEMPO }
    s = apply(s, {
      type: 'track/create',
      track: {
        id: 'm1',
        kind: 'drum',
        name: 'D',
        color: '#fff',
        muted: false,
        soloed: false,
        parentId: null,
        frozenAssetId: null,
        volume: 1,
        pan: 0,
        synth: {}
      },
      index: 0,
      clips: [],
      automation: [],
      notes: [],
      plugins: []
    })
    const loop: Clip = {
      id: 'loopA',
      trackId: 'm1',
      name: 'A',
      start: 0,
      duration: PPQ * 4,
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
    s = apply(s, {
      type: 'clip/create',
      clip: loop,
      notes: [{ id: 'k1', clipId: 'loopA', pitch: 36, start: 0, duration: PPQ, velocity: 100 }]
    })
    // Stamped a bar later: no notes of its own, just a pointer at the loop.
    s = apply(s, {
      type: 'clip/create',
      clip: { ...loop, id: 'stamp1', sourceClipId: 'loopA', start: PPQ * 4 },
      notes: []
    })

    const first = scheduleNotes(s, 0, 100)
    expect(first).toHaveLength(2) // the loop and its stamp both sound
    expect(first[0].startSec).toBeCloseTo(100) // loop at bar 1
    expect(first[1].startSec).toBeCloseTo(102) // stamp at bar 2 (4 beats = 2 s)
    expect(first.map((n) => n.pitch)).toEqual([36, 36])

    // Editing the LOOP is heard in the stamp — the point of stamping.
    s = apply(s, {
      type: 'note/add',
      note: { id: 'k2', clipId: 'loopA', pitch: 42, start: PPQ * 2, duration: PPQ, velocity: 100 }
    })
    const after = scheduleNotes(s, 0, 100)
    expect(after).toHaveLength(4)
    expect(after.map((n) => [n.pitch, Math.round(n.startSec * 100) / 100])).toEqual([
      [36, 100],
      [42, 101],
      [36, 102],
      [42, 103]
    ])

    // A stamp whose source is deleted plays nothing, like a clip whose
    // asset never arrived — no broken state to repair.
    const orphaned = apply(s, { type: 'clip/delete', clipId: 'loopA' })
    expect(scheduleNotes(orphaned, 0, 100)).toHaveLength(0)
  })

  test('a pattern is bank material: it never sounds, and outlives its clips', () => {
    let s = createEmptyProject('Test')
    s = { ...s, tempo: TEMPO }
    s = apply(s, {
      type: 'track/create',
      track: {
        id: 'm1',
        kind: 'drum',
        name: 'D',
        color: '#fff',
        muted: false,
        soloed: false,
        parentId: null,
        frozenAssetId: null,
        volume: 1,
        pan: 0,
        synth: {}
      },
      index: 0,
      clips: [],
      automation: [],
      notes: [],
      plugins: []
    })
    const pattern: Clip = {
      id: 'patA',
      trackId: 'm1',
      name: 'A',
      isPattern: true,
      start: 0,
      duration: PPQ * 4,
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
    s = apply(s, {
      type: 'clip/createMany',
      clips: [
        pattern,
        { ...pattern, id: 'stampA', isPattern: false, sourceClipId: 'patA', start: PPQ * 4 }
      ],
      notes: [{ id: 'k1', clipId: 'patA', pitch: 36, start: 0, duration: PPQ, velocity: 100 }]
    })

    // Only the STAMP sounds — the pattern itself is nowhere on the timeline
    // and must not play at its meaningless `start`.
    const played = scheduleNotes(s, 0, 100)
    expect(played).toHaveLength(1)
    expect(played[0].startSec).toBeCloseTo(102)

    // Deleting the clip on the track leaves the pattern and its notes
    // intact — the dependency runs clip → pattern, never the other way.
    const afterDelete = apply(s, { type: 'clip/delete', clipId: 'stampA' })
    expect(afterDelete.clips['patA']).toBeDefined()
    expect(afterDelete.notes['k1']).toBeDefined()
    expect(scheduleNotes(afterDelete, 0, 100)).toHaveLength(0) // nothing placed

    // …so it can simply be stamped again and plays exactly as before.
    const restamped = apply(afterDelete, {
      type: 'clip/create',
      clip: { ...pattern, id: 'stampB', isPattern: false, sourceClipId: 'patA', start: PPQ * 8 },
      notes: []
    })
    const again = scheduleNotes(restamped, 0, 100)
    expect(again).toHaveLength(1)
    expect(again[0].pitch).toBe(36)
    expect(again[0].startSec).toBeCloseTo(104)
  })
})

suite('loop-region bounded passes', () => {
  test('untilTicks trims a clip source at the region end', () => {
    // 4-beat (2 s) clip, region ends after 1 beat (0.5 s)
    const s = stateWith([{ start: 0, duration: PPQ * 4 }])
    const [sched] = scheduleClips(s, tenSecondAsset, 0, 100, PPQ)
    expect(sched.durationSec).toBeCloseTo(0.5)
  })

  test('clips starting beyond the region are not scheduled at all', () => {
    const s = stateWith([{ start: PPQ * 4, duration: PPQ * 4 }])
    expect(scheduleClips(s, tenSecondAsset, 0, 100, PPQ * 2)).toHaveLength(0)
  })

  test('an iteration anchored at the region start plays it from the top', () => {
    // region [1 beat, 3 beats): the clip covers it entirely
    const s = stateWith([{ start: 0, duration: PPQ * 8 }])
    const [sched] = scheduleClips(s, tenSecondAsset, PPQ, 500, PPQ * 3)
    expect(sched.when).toBeCloseTo(500)
    expect(sched.offsetSec).toBeCloseTo(0.5) // 1 beat into the source
    expect(sched.durationSec).toBeCloseTo(1) // 2 beats of material
  })
})

suite('windowed passes', () => {
  test('the initial window includes sounding and upcoming sources, and never cuts them', () => {
    const s = stateWith([
      { start: 0, duration: PPQ * 4 }, // already sounding at the anchor
      { start: PPQ * 2, duration: PPQ * 8 }, // starts inside, ends past the horizon
      { start: PPQ * 8, duration: PPQ * 4 } // starts beyond the horizon
    ])
    const scheds = scheduleClips(s, tenSecondAsset, PPQ, 100, Number.POSITIVE_INFINITY, {
      startBeforeTicks: PPQ * 8
    })
    expect(scheds.map((x) => x.clipId)).toEqual(['c0', 'c1'])
    // The sounding clip resumes mid-material exactly as an unbounded pass would.
    expect(scheds[0].offsetSec).toBeCloseTo(0.5)
    // The horizon bounds STARTS only: c1 plays its full material, no cut.
    expect(scheds[1].durationSec).toBeCloseTo((PPQ * 8) / TPS)
  })

  test('top-up slices partition the timeline — every source queued exactly once', () => {
    const s = stateWith([
      { start: 0, duration: PPQ * 2 },
      { start: PPQ * 4, duration: PPQ * 2 }, // starts exactly on the slice boundary
      { start: PPQ * 6, duration: PPQ * 2 }
    ])
    const first = scheduleClips(s, tenSecondAsset, 0, 100, Number.POSITIVE_INFINITY, {
      startBeforeTicks: PPQ * 4
    })
    const second = scheduleClips(s, tenSecondAsset, 0, 100, Number.POSITIVE_INFINITY, {
      startFromTicks: PPQ * 4,
      startBeforeTicks: PPQ * 8
    })
    expect(first.map((x) => x.clipId)).toEqual(['c0'])
    expect(second.map((x) => x.clipId)).toEqual(['c1', 'c2'])
    // A top-up slice never re-queues material already sounding at the anchor.
    expect(second.every((x) => x.when >= 100 + (PPQ * 4) / TPS)).toBe(true)
  })

  test('a looped clip is admitted repeat by repeat, each in its own slice', () => {
    const s = stateWith([{ start: 0, duration: PPQ * 8, loopLength: PPQ * 2 }])
    const first = scheduleClips(s, tenSecondAsset, 0, 100, Number.POSITIVE_INFINITY, {
      startBeforeTicks: PPQ * 4
    })
    const rest = scheduleClips(s, tenSecondAsset, 0, 100, Number.POSITIVE_INFINITY, {
      startFromTicks: PPQ * 4,
      startBeforeTicks: PPQ * 16
    })
    expect(first).toHaveLength(2) // repeats at 0 and 2 beats
    expect(rest).toHaveLength(2) // repeats at 4 and 6 beats
    expect(rest[0].when).toBeCloseTo(102)
    expect(rest[1].when).toBeCloseTo(103)
  })

  test('a note starting inside the window rings to its natural end, never re-attacked', () => {
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
        parentId: null,
        frozenAssetId: null,
        volume: 1,
        pan: 0,
        synth: {}
      },
      index: 0,
      clips: [],
      automation: [],
      notes: [],
      plugins: []
    })
    s = apply(s, {
      type: 'clip/create',
      clip: {
        id: 'mc1',
        trackId: 'm1',
        name: 'MC',
        start: 0,
        duration: PPQ * 8,
        assetId: null,
        offset: 0,
        color: null,
        fadeIn: 0,
        fadeOut: 0,
        reverse: false,
        pitch: 0,
        stretch: 1,
        loopLength: 0
      },
      // Starts at 1.5 s, crosses the 2 s horizon, ends at 3.5 s.
      notes: [{ id: 'n1', clipId: 'mc1', pitch: 60, start: PPQ * 3, duration: PPQ * 4, velocity: 100 }]
    })
    const first = scheduleNotes(s, 0, 100, Number.POSITIVE_INFINITY, {
      startBeforeTicks: PPQ * 4
    })
    expect(first).toHaveLength(1)
    expect(first[0].startSec).toBeCloseTo(101.5)
    expect(first[0].endSec).toBeCloseTo(103.5) // full duration, no cut at the horizon
    // The next slice must not re-attack it.
    const next = scheduleNotes(s, 0, 100, Number.POSITIVE_INFINITY, {
      startFromTicks: PPQ * 4,
      startBeforeTicks: PPQ * 8
    })
    expect(next).toHaveLength(0)
  })

  test('a frozen render belongs to the initial window only and is never cut', () => {
    let s = stateWith([{ start: 0, duration: PPQ * 4 }])
    s = apply(s, { type: 'track/freeze', trackId: 't1', assetId: 'fz' })
    const sec = (id: string): number => (id === 'fz' ? 6 : 10)
    const initial = scheduleClips(s, sec, 0, 100, Number.POSITIVE_INFINITY, {
      startBeforeTicks: PPQ * 4
    })
    expect(initial.map((x) => x.assetId)).toEqual(['fz'])
    expect(initial[0].durationSec).toBeCloseTo(6)
    const topUp = scheduleClips(s, sec, 0, 100, Number.POSITIVE_INFINITY, {
      startFromTicks: PPQ * 4,
      startBeforeTicks: PPQ * 8
    })
    expect(topUp).toHaveLength(0)
  })
})

suite('frozen tracks', () => {
  function frozenState(): ProjectState {
    let s = stateWith([{ start: 0, duration: PPQ * 4 }])
    s = apply(s, { type: 'track/freeze', trackId: 't1', assetId: 'frozenAsset' })
    return s
  }

  test('a frozen track plays its render from tick 0 and its live clips are skipped', () => {
    const scheds = scheduleClips(frozenState(), (id) => (id === 'frozenAsset' ? 6 : 10), 0, 100)
    expect(scheds).toHaveLength(1)
    expect(scheds[0].assetId).toBe('frozenAsset')
    expect(scheds[0].when).toBeCloseTo(100)
    expect(scheds[0].durationSec).toBeCloseTo(6)
  })

  test('anchoring mid-project resumes the frozen render at the right offset', () => {
    const [sched] = scheduleClips(frozenState(), () => 6, PPQ * 2, 100)
    expect(sched.offsetSec).toBeCloseTo(1)
    expect(sched.durationSec).toBeCloseTo(5)
  })

  test('a bounded pass cuts the frozen render at the region end', () => {
    const [sched] = scheduleClips(frozenState(), () => 6, 0, 100, PPQ * 2)
    expect(sched.durationSec).toBeCloseTo(1) // 2 beats
  })
})

suite('clip fades', () => {
  const fadedClip = (): Clip => ({
    id: 'cf',
    trackId: 't1',
    name: 'F',
    start: PPQ * 2, // 1 s
    duration: PPQ * 4, // 2 s
    assetId: 'a1',
    offset: 0,
    color: null,
    reverse: false,
    pitch: 0,
    stretch: 1,
    loopLength: 0,
    fadeIn: PPQ, // 0.5 s
    fadeOut: PPQ * 2 // 1 s
  })

  test('effectiveFades clamps stale oversized values against the duration', () => {
    const c = { ...fadedClip(), duration: PPQ, fadeIn: PPQ * 3, fadeOut: PPQ * 2 }
    const { fadeInTicks, fadeOutTicks } = effectiveFades(c)
    expect(fadeInTicks).toBe(PPQ)
    expect(fadeOutTicks).toBe(0)
  })

  test('clipFadeRamps maps windows to absolute clock seconds', () => {
    const ramps = clipFadeRamps(fadedClip(), TEMPO, 0, 100)
    expect(ramps).toHaveLength(2)
    expect(ramps[0]).toMatchObject({ from: 0, to: 1 })
    expect(ramps[0].startSec).toBeCloseTo(101)
    expect(ramps[0].endSec).toBeCloseTo(101.5)
    expect(ramps[1]).toMatchObject({ from: 1, to: 0 })
    expect(ramps[1].startSec).toBeCloseTo(102)
    expect(ramps[1].endSec).toBeCloseTo(103)
  })

  test('fadeCurve is smooth, monotonic and hits both endpoints', () => {
    const curve = fadeCurve(0, 1)
    expect(curve[0]).toBeCloseTo(0)
    expect(curve[curve.length - 1]).toBeCloseTo(1)
    for (let i = 1; i < curve.length; i++) expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1])
    expect(curve[(curve.length - 1) / 2]).toBeCloseTo(0.5)
  })

  test('a curve resumed mid-fade starts from the interrupted phase', () => {
    const resumed = fadeCurve(0, 1, 0.5)
    expect(resumed[0]).toBeCloseTo(0.5)
    expect(resumed[resumed.length - 1]).toBeCloseTo(1)
  })
})

suite('metronomeClicks', () => {
  test('emits beat-aligned clicks with downbeats every bar', () => {
    const s = stateWith([])
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

suite('track loops', () => {
  test('span covers the extent of the track clips', () => {
    const s = stateWith([
      { start: 960, duration: 960 },
      { start: 3840, duration: PPQ * 2 }
    ])
    expect(trackLoopSpan(s, 't1')).toEqual({ start: 960, end: 3840 + PPQ * 2 })
    expect(trackLoopSpan(s, 'missing')).toBeNull()
  })

  test('repeat state shifts only the looped track and drops automation', () => {
    let s = stateWith([{ start: 960, duration: 960 }])
    s = apply(s, {
      type: 'automation/add',
      point: { id: 'p1', trackId: 't1', param: 'volume', ticks: 0, value: 0.5 }
    })
    const shifted = trackLoopRepeatState(s, 't1', 1000)
    expect(shifted.clips['c0'].start).toBe(1960)
    expect(Object.keys(shifted.tracks)).toEqual(['t1'])
    expect(Object.keys(shifted.automation)).toHaveLength(0)
    // The original state is untouched (pure derivation).
    expect(s.clips['c0'].start).toBe(960)
  })

  test('a ghost repeat schedules the same material one period later', () => {
    const s = stateWith([{ start: 0, duration: PPQ * 4, offset: 960 }])
    const period = PPQ * 4
    const [base] = scheduleClips(s, tenSecondAsset, 0, 100)
    const [ghost] = scheduleClips(trackLoopRepeatState(s, 't1', period), tenSecondAsset, 0, 100)
    expect(ghost.when).toBeCloseTo(base.when + period / TPS)
    expect(ghost.offsetSec).toBeCloseTo(base.offsetSec)
    expect(ghost.durationSec).toBeCloseTo(base.durationSec)
  })
})

suite('take groups (comping) in the schedulers', () => {
  test('inactive audio takes are silent; the active one plays', () => {
    const s = stateWith([
      { start: 0, takeGroupId: 'tg1', takeActive: true },
      { start: 0, takeGroupId: 'tg1' },
      { start: 0, takeGroupId: 'tg1' }
    ])
    const scheduled = scheduleClips(s, tenSecondAsset, 0, 100)
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0].clipId).toBe('c0')
  })

  test('a clip outside any group plays regardless of other groups', () => {
    const s = stateWith([
      { start: 0, takeGroupId: 'tg1' }, // inactive take: silent
      { start: 0 } // ordinary clip
    ])
    const scheduled = scheduleClips(s, tenSecondAsset, 0, 100)
    expect(scheduled.map((x) => x.clipId)).toEqual(['c1'])
  })

  test('several members claiming active ALL play (divergence tolerated)', () => {
    const s = stateWith([
      { start: 0, takeGroupId: 'tg1', takeActive: true },
      { start: 0, takeGroupId: 'tg1', takeActive: true }
    ])
    expect(scheduleClips(s, tenSecondAsset, 0, 100)).toHaveLength(2)
  })

  test('inactive MIDI takes schedule no notes; the active one does', () => {
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
        parentId: null,
        frozenAssetId: null,
        volume: 1,
        pan: 0,
        synth: {}
      },
      index: 0,
      clips: [],
      automation: [],
      notes: [],
      plugins: []
    })
    const midiClip = (id: string, active: boolean): Clip => ({
      id,
      trackId: 'm1',
      name: id,
      start: 0,
      duration: PPQ * 4,
      assetId: null,
      offset: 0,
      color: null,
      fadeIn: 0,
      fadeOut: 0,
      reverse: false,
      pitch: 0,
      stretch: 1,
      loopLength: 0,
      takeGroupId: 'tg1',
      ...(active ? { takeActive: true } : {})
    })
    s = apply(s, {
      type: 'clip/create',
      clip: midiClip('mcA', true),
      notes: [{ id: 'nA', clipId: 'mcA', pitch: 60, start: 0, duration: PPQ, velocity: 100 }]
    })
    s = apply(s, {
      type: 'clip/create',
      clip: midiClip('mcB', false),
      notes: [{ id: 'nB', clipId: 'mcB', pitch: 64, start: 0, duration: PPQ, velocity: 100 }]
    })
    const notes = scheduleNotes(s, 0, 100)
    expect(notes).toHaveLength(1)
    expect(notes[0].clipId).toBe('mcA')
    expect(notes[0].pitch).toBe(60)
  })

  test('trackLoopSpan ignores inactive takes (they are silent material)', () => {
    const s = stateWith([
      { start: 0, duration: PPQ * 2, takeGroupId: 'tg1', takeActive: true },
      // A longer inactive take must not stretch the loop over silence.
      { start: 0, duration: PPQ * 16, takeGroupId: 'tg1' }
    ])
    expect(trackLoopSpan(s, 't1')).toEqual({ start: 0, end: PPQ * 2 })
  })
})

suite('computePeaks', () => {
  test('captures min/max per bucket across channels', () => {
    const sampleRate = 100
    const left = new Float32Array(200)
    const right = new Float32Array(200)
    left[10] = 0.5
    right[20] = -0.75
    left[150] = 1
    const buffer: AudioBufferLike = {
      numberOfChannels: 2,
      length: 200,
      sampleRate,
      getChannelData: (c) => (c === 0 ? left : right)
    }
    const peaks = computePeaks(buffer, 1)
    expect(Array.from(peaks)).toEqual([-0.75, 0.5, 0, 1])
  })
})
