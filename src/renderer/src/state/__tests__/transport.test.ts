import { describe as suite, expect, test } from 'vitest'
import { PPQ } from '@core/model/timebase'
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
