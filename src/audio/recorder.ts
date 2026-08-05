/**
 * Raw PCM capture from a MediaStream via an AudioWorklet. Chunks stream to
 * the main thread and accumulate; stop() concatenates per channel. No
 * monitoring path (input is never routed to output — no feedback loops).
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
  private source: MediaStreamAudioSourceNode | null = null
  private capture: AudioWorkletNode | null = null
  private sink: GainNode | null = null
  private ctx: AudioContext | null = null

  get isCapturing(): boolean {
    return this.capture !== null
  }

  async start(ctx: AudioContext, stream: MediaStream): Promise<void> {
    if (this.capture) throw new Error('Already recording')
    await ensureWorklet(ctx)
    this.ctx = ctx
    this.chunks = []
    this.source = ctx.createMediaStreamSource(stream)
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
    this.source.connect(this.capture)
    this.capture.connect(this.sink)
    this.sink.connect(ctx.destination)
  }

  stop(): Recording | null {
    const ctx = this.ctx
    if (!this.capture || !ctx) return null
    this.capture.port.onmessage = null
    this.source?.disconnect()
    this.capture.disconnect()
    this.sink?.disconnect()
    this.source = null
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
