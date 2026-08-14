/**
 * The audio utilityProcess's session logic: HostCommand messages in,
 * addon calls down, periodic frames back (docs/NATIVE_AUDIO_BACKEND.md
 * §5). Deliberately Electron-free — the worker entry (audioHostWorker)
 * glues process.parentPort and the addon path around this, and the
 * integration test drives the identical session over a plain
 * MessageChannel against the real addon, renderOffline standing in for
 * the device.
 */

import type {
  HostCommand,
  HostEvent,
  HostStartOptions,
  PortLike
} from '../audio/hostProtocol'
import {
  HOST_CAPTURE_INTERVAL_MS,
  HOST_CAPTURE_RING_SECONDS,
  HOST_FRAME_INTERVAL_MS
} from '../audio/hostProtocol'

/** The native addon surface the session drives (native/audiohost). */
export interface AudiohostAddon {
  init(): string
  start(opts: {
    deviceId?: string | null
    bufferFrames?: number
    exclusive?: boolean
    input?: boolean
    inputDeviceId?: string | null
  }): {
    sampleRate: number
    outputChannels: number
    periodFrames: number
    periodCount: number
    exclusive: boolean
    inputChannels: number
  }
  stop(): void
  enumerateDevices(): Array<{ id: string; label: string; kind: 'input' | 'output'; isDefault: boolean }>
  now(): number
  latencySec(): number
  inputLatencySec(): number
  inputChannels(): number
  stats(): { xruns: number }
  createNode(id: number, kind: string, opts?: Record<string, number | string>): void
  configureNode(id: number, opts: Record<string, number | string>): void
  connect(from: number, to: number): void
  connectParam(from: number, to: number, param: string): void
  disconnectParam(from: number, to: number, param: string): void
  disconnect(from: number, to?: number): void
  disposeNode(id: number): void
  scheduleParam(node: number, param: string, events: unknown[]): void
  registerBuffer(id: string, channels: Float32Array[], sampleRate: number): void
  releaseBuffer(id: string): void
  play(spec: Record<string, unknown>): boolean
  scheduleSource(voiceId: number, node: number, when: number, stopAt?: number): void
  stopVoice(id: number, atTime?: number): void
  createTap(id: number, node: number, frames: number): void
  disposeTap(id: number): void
  readTap(id: number, out: Float32Array): boolean
  drainEnded(): number[]
  setInputCapture(node: number, enabled: boolean, capacityFrames: number): void
  drainCapture(): Array<{ node: number; startSec: number; channels: Float32Array[] }>
  /** Verification hook (tests/parity): stereo interleaved render. `input`
   *  stands where the duplex callback's capture side would be. */
  renderOffline(
    startTime: number,
    frames: number,
    sampleRate: number,
    input?: Float32Array,
    inputChannels?: number
  ): Float32Array
}

export interface AudioHostSession {
  dispose(): void
}

export function createAudioHostSession(
  addon: AudiohostAddon,
  port: PortLike,
  options: {
    /** Test seam: frames on demand instead of a timer (default: timer). */
    manualFrames?: boolean
  } = {}
): AudioHostSession & { pumpFrame(): void; pumpCapture(): void } {
  addon.init()
  const taps = new Map<number, number>() // tap id → frames
  let frameTimer: ReturnType<typeof setInterval> | null = null
  let captureTimer: ReturnType<typeof setInterval> | null = null

  const post = (event: HostEvent): void => port.postMessage(event)

  const pumpFrame = (): void => {
    const tapData: Record<number, Float32Array> = {}
    for (const [id, frames] of taps) {
      const out = new Float32Array(frames)
      if (addon.readTap(id, out)) tapData[id] = out
    }
    post({
      t: 'frame',
      now: addon.now(),
      latencySec: addon.latencySec(),
      inputLatencySec: addon.inputLatencySec(),
      ended: addon.drainEnded(),
      taps: tapData,
      xruns: addon.stats().xruns
    })
  }

  /** Drain the addon's capture rings onto the wire (see §5's latency table:
   *  batched at UI cadence, never at callback cadence). */
  const pumpCapture = (): void => {
    const chunks = addon.drainCapture()
    if (chunks.length > 0) post({ t: 'capture', chunks })
  }

  const pushDevices = (): void => {
    try {
      post({ t: 'devices', devices: addon.enumerateDevices() })
    } catch {
      // enumeration can fail transiently on a device storm — the next
      // refresh picks it up; never take the audio process down for it.
    }
  }

  /** Remembered so a device switch can reopen with the same settings. */
  let lastStart: HostStartOptions = {}
  /** Live input nodes, by node id → the channel selection they asked for. */
  const inputs = new Map<number, { mode: 'mono' | 'stereo'; channel: number }>()
  /** Of those, the ones actually recording (the drain timer's reason to run). */
  const capturing = new Set<number>()
  /** Capture device the duplex stream is currently open on. */
  let inputDeviceId: string | null = null
  /** Granted stream rate — sizes the capture rings. */
  let streamSampleRate = 48000

  const start = (opts: HostStartOptions, announce = true): boolean => {
    lastStart = opts
    try {
      const info = addon.start({
        deviceId: opts.deviceId ?? null,
        bufferFrames: opts.bufferFrames,
        exclusive: opts.exclusive,
        input: opts.input,
        inputDeviceId: opts.inputDeviceId ?? null
      })
      streamSampleRate = info.sampleRate
      if (announce) post({ t: 'started', info, latencySec: addon.latencySec() })
      pushDevices()
      if (!options.manualFrames && frameTimer === null) {
        frameTimer = setInterval(pumpFrame, HOST_FRAME_INTERVAL_MS)
      }
      return true
    } catch (error) {
      post({
        t: 'startFailed',
        message: error instanceof Error ? error.message : String(error)
      })
      return false
    }
  }

  /**
   * Bring the stream in line with what the inputs need. There is exactly
   * ONE duplex device, so the FIRST open decides which capture device the
   * session uses — a later track naming a different one reads the same
   * hardware rather than thrashing the stream (and every other track's
   * audio) on every arm. Playback-only is restored once the last input
   * closes, so the OS's microphone-in-use indicator tells the truth.
   */
  const syncInputStream = (wantDeviceId: string | null): void => {
    const want = inputs.size > 0
    const have = addon.inputChannels() > 0
    if (want === have && (!want || wantDeviceId === inputDeviceId)) return
    if (want && have) return // already duplex: keep the device the session opened
    inputDeviceId = want ? wantDeviceId : null
    // Not announced as 'started': the renderer's boot handshake already
    // settled, and a second 'started' would look like a fresh stream.
    start({ ...lastStart, input: want, inputDeviceId }, false)
  }

  port.onMessage((data) => {
    const c = data as HostCommand
    switch (c.t) {
      case 'start':
        start(c.opts)
        break
      case 'stop':
        if (frameTimer !== null) clearInterval(frameTimer)
        frameTimer = null
        if (captureTimer !== null) clearInterval(captureTimer)
        captureTimer = null
        inputs.clear()
        capturing.clear()
        inputDeviceId = null
        addon.stop()
        break
      case 'refreshDevices':
        pushDevices()
        break
      case 'setOutputDevice':
        // WASAPI has no live sink switch: reopen on the new device. The
        // graph and its buffers live in the engine, not the stream, so
        // they survive — only the device handle changes.
        start({ ...lastStart, deviceId: c.deviceId })
        break
      case 'createNode':
        addon.createNode(c.id, c.kind, c.opts)
        break
      case 'configureNode':
        addon.configureNode(c.id, c.opts)
        break
      case 'connect':
        addon.connect(c.from, c.to)
        break
      case 'connectParam':
        addon.connectParam(c.from, c.to, c.param)
        break
      case 'disconnectParam':
        addon.disconnectParam(c.from, c.to, c.param)
        break
      case 'disconnect':
        addon.disconnect(c.from, c.to)
        break
      case 'disposeNode':
        addon.disposeNode(c.id)
        break
      case 'scheduleParam':
        addon.scheduleParam(c.node, c.param, c.events)
        break
      case 'registerBuffer':
        addon.registerBuffer(c.id, c.channels, c.sampleRate)
        break
      case 'releaseBuffer':
        addon.releaseBuffer(c.id)
        break
      case 'play':
        addon.play({
          id: c.id,
          bufferId: c.bufferId,
          when: c.when,
          offsetSec: c.offsetSec,
          durationSec: c.durationSec,
          rate: c.rate,
          loop: c.loop,
          destination: c.destination
        })
        break
      case 'scheduleSource':
        addon.scheduleSource(c.id, c.node, c.when, c.stopAt)
        break
      case 'stopVoice':
        addon.stopVoice(c.id, c.atTime)
        break
      case 'createTap':
        taps.set(c.id, c.frames)
        addon.createTap(c.id, c.node, c.frames)
        break
      case 'disposeTap':
        taps.delete(c.id)
        addon.disposeTap(c.id)
        break
      case 'openInput': {
        inputs.set(c.node, { mode: c.mode, channel: c.channel })
        syncInputStream(c.deviceId ?? null)
        const channelCount = addon.inputChannels()
        if (channelCount === 0) {
          // The addon already fell back to playback-only, so there is
          // nothing to undo — just say so and let the caller report it.
          inputs.delete(c.node)
          inputDeviceId = null
          post({
            t: 'inputOpened',
            node: c.node,
            ok: false,
            channelCount: 0,
            message: 'no audio input device is available'
          })
          break
        }
        addon.createNode(c.node, 'input', { mode: c.mode, channel: c.channel })
        post({ t: 'inputOpened', node: c.node, ok: true, channelCount })
        break
      }
      case 'closeInput': {
        if (!inputs.delete(c.node)) break
        addon.setInputCapture(c.node, false, 0)
        addon.disposeNode(c.node)
        capturing.delete(c.node)
        if (capturing.size === 0 && captureTimer !== null) {
          clearInterval(captureTimer)
          captureTimer = null
        }
        syncInputStream(null)
        break
      }
      case 'setInputCapture': {
        if (!c.enabled) {
          // Drain BEFORE disabling and acknowledge after, so a recorder
          // stopping mid-batch still gets everything it captured. The
          // port keeps order, so the ack cannot overtake the audio.
          pumpCapture()
          capturing.delete(c.node)
          if (capturing.size === 0 && captureTimer !== null) {
            clearInterval(captureTimer)
            captureTimer = null
          }
          if (inputs.has(c.node)) addon.setInputCapture(c.node, false, 0)
          post({ t: 'inputFlushed', node: c.node })
          break
        }
        if (!inputs.has(c.node)) break
        addon.setInputCapture(
          c.node,
          true,
          Math.round(HOST_CAPTURE_RING_SECONDS * streamSampleRate)
        )
        capturing.add(c.node)
        if (!options.manualFrames && captureTimer === null) {
          captureTimer = setInterval(pumpCapture, HOST_CAPTURE_INTERVAL_MS)
        }
        break
      }
    }
  })
  port.start?.()

  return {
    pumpFrame,
    pumpCapture,
    dispose() {
      if (frameTimer !== null) clearInterval(frameTimer)
      frameTimer = null
      if (captureTimer !== null) clearInterval(captureTimer)
      captureTimer = null
      try {
        addon.stop()
      } catch {
        // device was never started — fine
      }
    }
  }
}
