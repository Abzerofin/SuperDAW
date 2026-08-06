/**
 * Lightweight diagnostics sampling for the health panel. Read-only
 * observers over existing systems — nothing here mutates anything.
 *
 * "CPU" is an event-loop-lag proxy (browsers expose no real CPU meter):
 * a 500 ms heartbeat measures how late it fires; sustained lateness means
 * the main thread is saturated. Honest, cheap, and good enough to spot
 * trouble.
 */

const INTERVAL_MS = 500
const WINDOW = 10

class HealthSampler {
  private lags: number[] = []
  private last = 0
  private timer: ReturnType<typeof setInterval> | null = null

  /** Average main-thread lag over the last ~5 s, in ms. */
  get loopLagMs(): number {
    if (this.lags.length === 0) return 0
    return this.lags.reduce((a, b) => a + b, 0) / this.lags.length
  }

  /** JS heap in MB, or null where performance.memory is unavailable. */
  get heapMb(): number | null {
    const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory
    return memory ? memory.usedJSHeapSize / (1024 * 1024) : null
  }

  start(): void {
    if (this.timer !== null) return
    this.last = performance.now()
    this.timer = setInterval(() => {
      const now = performance.now()
      const lag = Math.max(0, now - this.last - INTERVAL_MS)
      this.last = now
      this.lags.push(lag)
      if (this.lags.length > WINDOW) this.lags.shift()
    }, INTERVAL_MS)
  }
}

export const healthSampler = new HealthSampler()
