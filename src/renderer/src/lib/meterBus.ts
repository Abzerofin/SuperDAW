import { transport } from '@/state/transport'
import { recording } from '@/state/recording'
import { trackInputs } from '@/state/trackInputs'

/**
 * One shared animation-frame loop for every level meter in the app.
 *
 * Each meter used to run its own rAF loop forever — 100 tracks meant 100
 * concurrent callbacks polling analysers whether or not any audio could
 * possibly be flowing. The bus runs a single loop, and only while there is
 * something to show: the transport is rolling, a take is being captured,
 * an input is being monitored, or a meter is still decaying/holding its
 * peak. Once everything is silent for half a second the loop stops; any
 * transport/recording/input change wakes it again.
 *
 * A registered function paints its meter for the given timestamp and
 * returns whether it is still visually active (level, peak remnant or
 * flash pending). Paint straight to the DOM — never through React.
 */
type MeterFn = (now: number) => boolean

const IDLE_STOP_MS = 500

class MeterBus {
  private fns = new Set<MeterFn>()
  private raf = 0
  private idleSince = 0

  constructor() {
    // Wake sources: anything that could make audio flow again.
    transport.onEvent(() => this.wake())
    recording.subscribe(() => this.wake())
    trackInputs.subscribe(() => this.wake())
  }

  register(fn: MeterFn): () => void {
    this.fns.add(fn)
    this.wake()
    return () => {
      this.fns.delete(fn)
    }
  }

  wake = (): void => {
    this.idleSince = 0
    if (!this.raf && this.fns.size > 0) this.raf = requestAnimationFrame(this.tick)
  }

  private live(): boolean {
    return transport.isPlaying || recording.recording || trackInputs.anyMonitoring
  }

  private tick = (): void => {
    this.raf = 0
    if (this.fns.size === 0) return
    const now = performance.now()
    let active = false
    for (const fn of this.fns) {
      if (fn(now)) active = true
    }
    if (this.live() || active) {
      this.idleSince = 0
      this.raf = requestAnimationFrame(this.tick)
      return
    }
    // Everything silent: keep ticking briefly (cheap — every meter is at
    // zero and returns false immediately), then sleep until woken.
    if (this.idleSince === 0) this.idleSince = now
    if (now - this.idleSince < IDLE_STOP_MS) {
      this.raf = requestAnimationFrame(this.tick)
    }
  }
}

export const meterBus = new MeterBus()
