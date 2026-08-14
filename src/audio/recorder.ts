/**
 * Raw PCM capture: chunks stream in from an input handle and accumulate;
 * stop() concatenates per channel.
 *
 * How the chunks are PRODUCED is the backend's business (a capture
 * AudioWorklet on Web Audio, the duplex stream's own callback natively) —
 * this side only ever sees `Float32Array[]` plus the stream time of each
 * batch's first frame, which is what places a take sample-accurately
 * instead of guessing when capture actually spun up.
 *
 * The handle is normally a channel-selection tap (audio/input.ts
 * semantics), so a recorder captures exactly the channels the track is set
 * to and the same selection can feed monitoring. Recording itself never
 * routes to the speakers; monitoring is a separate, explicit connection.
 */

import type { InputHandle } from './backendTypes'

export interface Recording {
  readonly channels: Float32Array[]
  readonly sampleRate: number
  readonly seconds: number
  /** Stream time of the first captured sample; null if none arrived. */
  readonly startSec: number | null
  /** Frames of silence padded in for capture the backend could not keep
   *  up with — 0 on a healthy take. */
  readonly droppedFrames: number
}

export class Recorder {
  private chunks: Float32Array[][] = [] // [chunkIndex][channel]
  private startSec: number | null = null
  /** Stream time the next chunk is expected to start at. */
  private nextSec: number | null = null
  private droppedFrames = 0
  private sampleRate = 0
  private unsubscribe: (() => Promise<void>) | null = null

  get isCapturing(): boolean {
    return this.unsubscribe !== null
  }

  /** `input` is the live input to capture (a channel selection, normally). */
  start(input: InputHandle): void {
    if (this.unsubscribe) throw new Error('Already recording')
    this.chunks = []
    this.startSec = null
    this.nextSec = null
    this.droppedFrames = 0
    this.sampleRate = input.sampleRate
    this.unsubscribe = input.capture((chunk, firstFrameTime) => this.push(chunk, firstFrameTime))
  }

  private push(chunk: Float32Array[], firstFrameTime: number): void {
    const frames = chunk[0]?.length ?? 0
    if (frames === 0) return
    if (this.startSec === null) {
      this.startSec = firstFrameTime
    } else if (this.nextSec !== null && this.sampleRate > 0) {
      // A chunk arriving later than the last one ended means the backend
      // dropped capture it could not hand over in time. Pad the hole with
      // silence rather than splicing: a take with an audible gap is
      // obvious, a take whose second half runs early is not.
      const missing = Math.round((firstFrameTime - this.nextSec) * this.sampleRate)
      if (missing > 0) {
        this.chunks.push(chunk.map(() => new Float32Array(missing)))
        this.droppedFrames += missing
      }
    }
    this.chunks.push(chunk)
    if (this.sampleRate > 0) this.nextSec = firstFrameTime + frames / this.sampleRate
  }

  /**
   * End the take. Awaits the backend's flush, so audio captured before
   * Stop but still in flight lands in the take instead of being clipped
   * off it — batching means there is ALWAYS some.
   */
  async stop(): Promise<Recording | null> {
    // Only our own subscription is cut: the input belongs to the caller
    // (it may still be feeding a monitor path).
    const unsubscribe = this.unsubscribe
    this.unsubscribe = null
    await unsubscribe?.()

    const chunks = this.chunks
    const startSec = this.startSec
    const sampleRate = this.sampleRate
    const droppedFrames = this.droppedFrames
    this.chunks = []
    this.startSec = null
    this.nextSec = null
    this.droppedFrames = 0
    if (chunks.length === 0 || sampleRate <= 0) return null

    const channelCount = Math.max(...chunks.map((c) => c.length))
    const frames = chunks.reduce((sum, c) => sum + (c[0]?.length ?? 0), 0)
    const channels: Float32Array[] = []
    for (let ch = 0; ch < channelCount; ch++) {
      const merged = new Float32Array(frames)
      let offset = 0
      for (const chunk of chunks) {
        const data = chunk[ch] ?? chunk[0]
        if (data) merged.set(data, offset)
        offset += chunk[0]?.length ?? 0
      }
      channels.push(merged)
    }
    return { channels, sampleRate, seconds: frames / sampleRate, startSec, droppedFrames }
  }
}
