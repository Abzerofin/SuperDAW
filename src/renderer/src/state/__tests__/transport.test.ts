import { afterEach, beforeEach, describe as suite, expect, test } from 'vitest'
import { PPQ } from '@core/model/timebase'
import type { Clip, Track } from '@core/model/types'
import { projectStore } from '../projectStore'
import { Transport } from '../transport'

// The transport drives its display updates from animation frames (browser
// only). These tests read positions directly, so a no-op frame clock is
// enough to let play() run under Node.
const frames = globalThis as unknown as {
  requestAnimationFrame?: (cb: FrameRequestCallback) => number
  cancelAnimationFrame?: (handle: number) => void
}
frames.requestAnimationFrame ??= () => 0
frames.cancelAnimationFrame ??= () => undefined

/**
 * The cycle region's position math. A fake clock stands in for the audio
 * clock so wrapping can be checked exactly rather than in real time.
 */
function transportAt(): { transport: Transport; advance: (seconds: number) => void } {
  let now = 0
  const transport = new Transport()
  transport.setTimeSource({ now: () => now })
  return { transport, advance: (seconds) => { now += seconds } }
}

// The store defaults to 120 BPM: 1 beat = 960 ticks = 0.5 s.
const BEAT = PPQ

suite('latency-compensated display position', () => {
  test('the drawn playhead lags the raw clock by the output latency', () => {
    const { transport, advance } = transportAt()
    transport.setOutputLatency(0.5) // half a second = 1 beat at 120 BPM
    transport.play()
    advance(2)
    expect(transport.positionTicks()).toBeCloseTo(BEAT * 4)
    expect(transport.displayTicks()).toBeCloseTo(BEAT * 3)
    // Edits at the playhead land where the user SEES the playhead.
    expect(transport.editTicks()).toBeCloseTo(BEAT * 3)
  })

  test('display is clamped at play start — no backwards hop', () => {
    const { transport, advance } = transportAt()
    transport.setOutputLatency(0.5)
    transport.setPosition(BEAT * 2)
    transport.play()
    advance(0.1) // less than the latency has elapsed
    expect(transport.displayTicks()).toBeCloseTo(BEAT * 2)
    // With no latency reported, display IS the raw position.
    transport.setOutputLatency(0)
    expect(transport.displayTicks()).toBeCloseTo(transport.positionTicks())
  })

  test('display wraps through the cycle region on the delayed clock', () => {
    const { transport, advance } = transportAt()
    transport.setOutputLatency(0.5)
    transport.setLoopRegion(0, BEAT * 4) // 2 s
    transport.play()
    advance(2.25) // raw has wrapped to half a beat in...
    expect(transport.positionTicks()).toBeCloseTo(BEAT * 0.5)
    // ...but the ears are still hearing the end of the region.
    expect(transport.displayTicks()).toBeCloseTo(BEAT * 3.5)
  })
})

suite('transport loop region', () => {
  test('playback wraps back into the region at its end', () => {
    const { transport, advance } = transportAt()
    transport.setLoopRegion(0, BEAT * 4) // 4 beats = 2 s
    transport.play()

    advance(1)
    expect(transport.positionTicks()).toBeCloseTo(BEAT * 2)
    advance(1.5) // 2.5 s total: half a beat past the wrap
    expect(transport.positionTicks()).toBeCloseTo(BEAT)
    advance(2) // exactly one more cycle later — same place
    expect(transport.positionTicks()).toBeCloseTo(BEAT)
  })

  test('a run-up before the region plays once, then cycles inside it', () => {
    const { transport, advance } = transportAt()
    transport.setLoopRegion(BEAT * 4, BEAT * 8)
    transport.setPosition(0)
    transport.play()

    advance(1) // still in the run-up
    expect(transport.positionTicks()).toBeCloseTo(BEAT * 2)
    advance(1.5) // past the region end (4 s in) -> folded back in
    expect(transport.positionTicks()).toBeCloseTo(BEAT * 5)
  })

  test('disabling the loop keeps the region but stops wrapping', () => {
    const { transport, advance } = transportAt()
    transport.setLoopRegion(0, BEAT * 2)
    transport.setLoopEnabled(false)
    transport.play()
    advance(2)
    expect(transport.activeLoop()).toBeNull()
    expect(transport.loopRegion).toEqual({ start: 0, end: BEAT * 2 })
    expect(transport.positionTicks()).toBeCloseTo(BEAT * 4) // ran straight past
  })

  test('clearing removes the region entirely', () => {
    const { transport } = transportAt()
    transport.setLoopRegion(0, BEAT * 2)
    transport.clearLoop()
    expect(transport.loopRegion).toBeNull()
    expect(transport.activeLoop()).toBeNull()
  })

  test('a degenerate drag is not a region', () => {
    const { transport } = transportAt()
    transport.setLoopRegion(480, 480)
    expect(transport.loopRegion).toBeNull()
  })

  test('the region is normalised however it was dragged', () => {
    const { transport } = transportAt()
    transport.setLoopRegion(BEAT * 6, BEAT * 2) // dragged right-to-left
    expect(transport.loopRegion).toEqual({ start: BEAT * 2, end: BEAT * 6 })
  })

  test('stopped playback reports the plain position, never a wrapped one', () => {
    const { transport } = transportAt()
    transport.setLoopRegion(0, BEAT)
    transport.setPosition(BEAT * 10)
    expect(transport.positionTicks()).toBe(BEAT * 10)
  })
})

/**
 * The song loop wraps at the end of what is AUDIBLE, so soloing a section
 * cycles that section and muting a long tail stops the loop waiting for
 * silence. These drive the real store, since the answer comes from
 * mute/solo/folder state rather than from the transport alone.
 */
suite('song loop over audible material', () => {
  function track(id: string, patch: Partial<Track> = {}): Track {
    return {
      id,
      kind: 'audio',
      name: id,
      color: '#5b8def',
      muted: false,
      soloed: false,
      parentId: null,
      frozenAssetId: null,
      volume: 1,
      pan: 0,
      synth: {},
      ...patch
    }
  }
  function clip(id: string, trackId: string, start: number, duration: number): Clip {
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

  /** Short track A (2 beats) and long track B (8 beats). */
  function twoTracks(): void {
    for (const id of ['a', 'b']) {
      projectStore.dispatch({
        type: 'track/create',
        track: track(id),
        index: 0,
        clips: [],
        automation: [],
        notes: [],
        plugins: []
      })
    }
    projectStore.dispatch({ type: 'clip/create', clip: clip('ca', 'a', 0, BEAT * 2), notes: [] })
    projectStore.dispatch({ type: 'clip/create', clip: clip('cb', 'b', 0, BEAT * 8), notes: [] })
  }

  // The store singleton boots with the demo project; each test wants only
  // the two tracks it builds.
  const clearTracks = (): void => {
    for (const id of Object.keys(projectStore.state.tracks)) {
      projectStore.dispatch({ type: 'track/delete', trackId: id })
    }
  }
  beforeEach(clearTracks)
  afterEach(clearTracks)

  test('the whole song loops when nothing is muted or soloed', () => {
    twoTracks()
    const { transport } = transportAt()
    transport.setSongLoop(true)
    expect(transport.activeLoop()).toEqual({ start: 0, end: BEAT * 8 })
  })

  test('muting the long track shortens the loop to what is left', () => {
    twoTracks()
    const { transport } = transportAt()
    transport.setSongLoop(true)
    projectStore.dispatch({ type: 'track/setMute', trackId: 'b', muted: true })
    expect(transport.activeLoop()).toEqual({ start: 0, end: BEAT * 2 })
  })

  test('soloing the short track loops just that track', () => {
    twoTracks()
    const { transport } = transportAt()
    transport.setSongLoop(true)
    projectStore.dispatch({ type: 'track/setSolo', trackId: 'a', soloed: true })
    expect(transport.activeLoop()).toEqual({ start: 0, end: BEAT * 2 })
    // Un-soloing hands the rest of the song back.
    projectStore.dispatch({ type: 'track/setSolo', trackId: 'a', soloed: false })
    expect(transport.activeLoop()).toEqual({ start: 0, end: BEAT * 8 })
  })

  test('an explicit cycle region still wins over the song loop', () => {
    twoTracks()
    const { transport } = transportAt()
    transport.setSongLoop(true)
    transport.setLoopRegion(BEAT, BEAT * 3)
    projectStore.dispatch({ type: 'track/setMute', trackId: 'b', muted: true })
    expect(transport.activeLoop()).toEqual({ start: BEAT, end: BEAT * 3 })
  })

  test('playback wraps at the soloed material’s end, not the song’s', () => {
    twoTracks()
    const { transport, advance } = transportAt()
    transport.setSongLoop(true)
    projectStore.dispatch({ type: 'track/setSolo', trackId: 'a', soloed: true })
    transport.play()
    advance(1.5) // 3 beats of linear time through a 2-beat loop
    expect(transport.positionTicks()).toBeCloseTo(BEAT)
  })

  test('muting everything leaves nothing to cycle', () => {
    twoTracks()
    const { transport } = transportAt()
    transport.setSongLoop(true)
    for (const id of ['a', 'b']) {
      projectStore.dispatch({ type: 'track/setMute', trackId: id, muted: true })
    }
    expect(transport.activeLoop()).toBeNull()
  })
})

suite('edit marker', () => {
  test('edits follow the playhead until a marker is pinned', () => {
    const { transport, advance } = transportAt()
    transport.play()
    advance(1)
    expect(transport.markerTicks).toBeNull()
    expect(transport.editTicks()).toBeCloseTo(BEAT * 2)

    transport.setMarker(BEAT * 7)
    expect(transport.editTicks()).toBe(BEAT * 7)
  })

  test('the marker stays put while the playhead keeps moving', () => {
    const { transport, advance } = transportAt()
    transport.setMarker(BEAT * 3)
    transport.play()
    advance(4)

    expect(transport.positionTicks()).toBeCloseTo(BEAT * 8)
    expect(transport.editTicks()).toBe(BEAT * 3) // the whole point
  })

  test('clearing hands the edit point back to the playhead', () => {
    const { transport, advance } = transportAt()
    transport.setMarker(BEAT * 3)
    transport.play()
    advance(1)
    transport.clearMarker()

    expect(transport.markerTicks).toBeNull()
    expect(transport.editTicks()).toBeCloseTo(BEAT * 2)
  })

  test('the marker is clamped to the start of the timeline', () => {
    const { transport } = transportAt()
    transport.setMarker(-500)
    expect(transport.markerTicks).toBe(0)
  })
})

/**
 * Switching cycling off mid-playback must leave the playhead where it is
 * AUDIBLY, not where a never-wrapped timeline would have reached. The wrap
 * lives only in positionTicks()'s return value, so these guard the one
 * ordering that matters: sample the position BEFORE mutating loop state.
 */
suite('changing the loop during playback', () => {
  test('disabling cycling mid-playback keeps the wrapped position', () => {
    const { transport, advance } = transportAt()
    transport.setLoopRegion(0, BEAT * 4)
    transport.play()
    advance(5) // 10 beats of linear time = 2 beats into the third pass

    expect(transport.positionTicks()).toBeCloseTo(BEAT * 2)
    transport.setLoopEnabled(false)
    expect(transport.positionTicks()).toBeCloseTo(BEAT * 2) // not BEAT * 10

    advance(0.5) // and it carries on linearly from there
    expect(transport.positionTicks()).toBeCloseTo(BEAT * 3)
  })

  test('clearing the region mid-playback keeps the wrapped position', () => {
    const { transport, advance } = transportAt()
    transport.setLoopRegion(0, BEAT * 4)
    transport.play()
    advance(5)

    transport.clearLoop()
    expect(transport.positionTicks()).toBeCloseTo(BEAT * 2)
  })

  test('stopping after cycling leaves the playhead inside the loop', () => {
    const { transport, advance } = transportAt()
    transport.setLoopRegion(0, BEAT * 4)
    transport.play()
    advance(5)
    transport.setLoopEnabled(false)
    transport.stop()

    expect(transport.positionTicks()).toBeCloseTo(BEAT * 2)
  })

  test('moving the region mid-playback re-bases on the audible position', () => {
    const { transport, advance } = transportAt()
    transport.setLoopRegion(0, BEAT * 4)
    transport.play()
    advance(5) // audibly at BEAT * 2

    // The new region starts after that point, so the playhead keeps its
    // place and plays a run-up into it rather than teleporting.
    transport.setLoopRegion(BEAT * 8, BEAT * 12)
    expect(transport.positionTicks()).toBeCloseTo(BEAT * 2)
  })
})
