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
import { HOST_FRAME_INTERVAL_MS } from '../audio/hostProtocol'

/** The native addon surface the session drives (native/audiohost). */
export interface AudiohostAddon {
  init(): string
  start(opts: {
    deviceId?: string | null
    bufferFrames?: number
    exclusive?: boolean
  }): { sampleRate: number; outputChannels: number; periodFrames: number; periodCount: number; exclusive: boolean }
  stop(): void
  enumerateDevices(): Array<{ id: string; label: string; kind: 'input' | 'output'; isDefault: boolean }>
  now(): number
  latencySec(): number
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
  /** Verification hook (tests/parity): stereo interleaved render. */
  renderOffline(startTime: number, frames: number, sampleRate: number): Float32Array
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
): AudioHostSession & { pumpFrame(): void } {
  addon.init()
  const taps = new Map<number, number>() // tap id → frames
  let frameTimer: ReturnType<typeof setInterval> | null = null

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
      ended: addon.drainEnded(),
      taps: tapData,
      xruns: addon.stats().xruns
    })
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

  const start = (opts: HostStartOptions): void => {
    lastStart = opts
    try {
      const info = addon.start({
        deviceId: opts.deviceId ?? null,
        bufferFrames: opts.bufferFrames,
        exclusive: opts.exclusive
      })
      post({ t: 'started', info, latencySec: addon.latencySec() })
      pushDevices()
      if (!options.manualFrames && frameTimer === null) {
        frameTimer = setInterval(pumpFrame, HOST_FRAME_INTERVAL_MS)
      }
    } catch (error) {
      post({
        t: 'startFailed',
        message: error instanceof Error ? error.message : String(error)
      })
    }
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
    }
  })
  port.start?.()

  return {
    pumpFrame,
    dispose() {
      if (frameTimer !== null) clearInterval(frameTimer)
      frameTimer = null
      try {
        addon.stop()
      } catch {
        // device was never started — fine
      }
    }
  }
}
