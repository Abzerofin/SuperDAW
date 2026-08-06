/**
 * Raw PCM capture from any AudioNode via an AudioWorklet. Chunks stream to
 * the main thread and accumulate; stop() concatenates per channel.
 *
 * The caller supplies the input node — normally a channel-selection tap
 * (audio/input.ts) — so a recorder captures exactly the channels the track
 * is set to, and the same tap can feed monitoring. Recording itself never
 * routes to the speakers; monitoring is a separate, explicit connection.
 */

const WORKLET_SOURCE = `
class SuperdawCapture extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (input.length > 0) {
      this.port.postMessage(input.map((channel) => channel.slice(0)))
    }
    return true
  }
}
registerProcessor('superdaw-capture', SuperdawCapture)
`

let workletReady: Promise<void> | null = null

function ensureWorklet(ctx: AudioContext): Promise<void> {
  if (!workletReady) {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
    workletReady = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url))
  }
  return workletReady
}

export interface Recording {
  readonly channels: Float32Array[]
  readonly sampleRate: number
  readonly seconds: number
}

export class Recorder {
  private chunks: Float32Array[][] = [] // [chunkIndex][channel]
  private input: AudioNode | null = null
  private capture: AudioWorkletNode | null = null
  private sink: GainNode | null = null
  private ctx: AudioContext | null = null

  get isCapturing(): boolean {
    return this.capture !== null
  }

  /** `input` is the node to capture (a channel-selection tap, or any node). */
  async start(ctx: AudioContext, input: AudioNode): Promise<void> {
    if (this.capture) throw new Error('Already recording')
    await ensureWorklet(ctx)
    this.ctx = ctx
    this.chunks = []
    this.input = input
    this.capture = new AudioWorkletNode(ctx, 'superdaw-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1
    })
    this.capture.port.onmessage = (event: MessageEvent<Float32Array[]>) => {
      this.chunks.push(event.data)
    }
    // A silent sink keeps the worklet pulled by the graph without being audible.
    this.sink = ctx.createGain()
    this.sink.gain.value = 0
    this.input.connect(this.capture)
    this.capture.connect(this.sink)
    this.sink.connect(ctx.destination)
  }

  stop(): Recording | null {
    const ctx = this.ctx
    if (!this.capture || !ctx) return null
    this.capture.port.onmessage = null
    // Only our own edge is cut: the input node belongs to the caller (it may
    // still be feeding a monitor path).
    try {
      this.input?.disconnect(this.capture)
    } catch {
      // already disconnected — fine
    }
    this.capture.disconnect()
    this.sink?.disconnect()
    this.input = null
    this.capture = null
    this.sink = null
    this.ctx = null

    const chunks = this.chunks
    this.chunks = []
    if (chunks.length === 0) return null

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
    return { channels, sampleRate: ctx.sampleRate, seconds: frames / ctx.sampleRate }
  }
}
