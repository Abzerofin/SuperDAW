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
import { AUDIO_BLOCK_FRAMES, HOST_FRAME_INTERVAL_MS } from '../audio/hostProtocol'
import { chunkFromBlob } from './vst3State'

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
  /** Take vst3host's realtime table; false = absent or ABI-mismatched. */
  attachVst3Bridge(bridge: unknown): boolean
  /** Verification hook (tests/parity): stereo interleaved render. */
  renderOffline(startTime: number, frames: number, sampleRate: number): Float32Array
}

/**
 * The slice of native/vst3host this process uses: plugins opened for
 * IN-CALLBACK processing, driven through the C bridge rather than through
 * JS. Loading it here — beside audiohost, in the audio utilityProcess — is
 * what turns the windowed VST3 preview into a live insert
 * (docs/NATIVE_AUDIO_BACKEND.md §5).
 */
export interface Vst3RealtimeAddon {
  realtimeBridge(): unknown
  openRealtime(
    path: string,
    uid: string,
    options: { sampleRate: number; blockSize?: number; channels?: number; state?: Buffer }
  ): {
    error?: string
    slot?: number
    latencySamples?: number
    inputChannels?: number
    outputChannels?: number
  }
  setRealtimeParams(slot: number, params: Record<string, number>): void
  closeRealtime(slot: number): { closed: boolean }
}

export interface AudioHostSession {
  dispose(): void
  /**
   * uid → bundle path, pushed by MAIN. Paths are main's to know: they are
   * machine-specific and must never enter the renderer or the document.
   */
  setPluginPaths(paths: Record<string, string>): void
}

export function createAudioHostSession(
  addon: AudiohostAddon,
  port: PortLike,
  options: {
    /** Test seam: frames on demand instead of a timer (default: timer). */
    manualFrames?: boolean
    /** Absent (browser-free tests, a missing build) = external inserts bypass. */
    vst3?: Vst3RealtimeAddon | null
    pluginPaths?: Record<string, string>
  } = {}
): AudioHostSession & { pumpFrame(): void } {
  addon.init()
  const taps = new Map<number, number>() // tap id → frames
  let frameTimer: ReturnType<typeof setInterval> | null = null

  const post = (event: HostEvent): void => port.postMessage(event)

  // ---- external plugins ----

  const vst3 = options.vst3 ?? null
  // Attached once: the table is static, and the engine re-checks its ABI.
  const bridgeOk = vst3 !== null && addon.attachVst3Bridge(vst3.realtimeBridge())
  let pluginPaths: Record<string, string> = options.pluginPaths ?? {}
  /** node id → what it was opened as, so a rate change can reopen it. */
  const externals = new Map<
    number,
    { slot: number; uid: string; stateBlob: string | null; channels: number }
  >()
  /** The rate held plugins were opened at (a device switch can change it). */
  let openedRate = 0

  const openExternal = (
    uid: string,
    stateBlob: string | null,
    channels: number,
    sampleRate: number
  ): { slot: number; latencySamples: number; message?: string } => {
    if (!vst3 || !bridgeOk) {
      return { slot: -1, latencySamples: 0, message: 'no realtime VST3 host in the audio process' }
    }
    const path = pluginPaths[uid]
    if (!path) return { slot: -1, latencySamples: 0, message: `plugin not installed: ${uid}` }
    try {
      const opened = vst3.openRealtime(path, uid, {
        sampleRate,
        // The engine hands whole blocks in one call and never more.
        blockSize: AUDIO_BLOCK_FRAMES,
        channels,
        state: chunkFromBlob(stateBlob)
      })
      if (opened.error !== undefined || opened.slot === undefined) {
        return { slot: -1, latencySamples: 0, message: opened.error ?? 'could not open plugin' }
      }
      return { slot: opened.slot, latencySamples: opened.latencySamples ?? 0 }
    } catch (error) {
      // A third-party binary throwing must not take the audio process down.
      return {
        slot: -1,
        latencySamples: 0,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }

  const closeExternal = (node: number): void => {
    const held = externals.get(node)
    if (!held) return
    externals.delete(node)
    if (held.slot >= 0) {
      try {
        vst3?.closeRealtime(held.slot)
      } catch {
        // teardown must not throw — the node is going away regardless
      }
    }
  }

  /**
   * A device switch can land on a different rate, and a plugin set up for
   * 48 kHz would then run at the wrong one. Reopen every held plugin at
   * the new rate; the graph keeps its nodes, only the slots change.
   */
  const reopenExternalsAt = (sampleRate: number): void => {
    if (sampleRate === openedRate) return
    openedRate = sampleRate
    for (const [node, held] of [...externals]) {
      if (held.slot >= 0) {
        try {
          vst3?.closeRealtime(held.slot)
        } catch {
          // fall through — we are replacing it anyway
        }
      }
      const opened = openExternal(held.uid, held.stateBlob, held.channels, sampleRate)
      externals.set(node, { ...held, slot: opened.slot })
      addon.configureNode(node, { slot: opened.slot })
      post({
        t: 'externalReady',
        node,
        ok: opened.slot >= 0,
        latencySamples: opened.latencySamples,
        message: opened.message
      })
    }
  }

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
      reopenExternalsAt(info.sampleRate)
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
      case 'openExternal': {
        // Synchronous on purpose: loading a plugin bundle is slow, but it
        // runs on THIS thread, never the audio callback, and keeping it in
        // message order is what lets the createNode that follows bind the
        // slot it just got. The frame pump stalls for the load; the
        // renderer's clock extrapolates across it and playback is
        // untouched.
        const stateBlob = c.stateBlob ?? null
        const channels = c.channels ?? 2
        const rate = openedRate > 0 ? openedRate : 48000
        openedRate = rate
        const opened = openExternal(c.uid, stateBlob, channels, rate)
        externals.set(c.id, { slot: opened.slot, uid: c.uid, stateBlob, channels })
        post({
          t: 'externalReady',
          node: c.id,
          ok: opened.slot >= 0,
          latencySamples: opened.latencySamples,
          message: opened.message
        })
        break
      }
      case 'setPluginParams': {
        const held = externals.get(c.node)
        if (held && held.slot >= 0) {
          try {
            vst3?.setRealtimeParams(held.slot, c.params)
          } catch {
            // a misbehaving plugin must not stop the command stream
          }
        }
        break
      }
      case 'createNode':
        addon.createNode(
          c.id,
          c.kind,
          // An external node binds to whatever slot its openExternal got.
          c.kind === 'external'
            ? { ...c.opts, slot: externals.get(c.id)?.slot ?? -1 }
            : c.opts
        )
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
        // Order matters: unbind the node from the slot before the plugin
        // goes away, so no block can reach a slot being torn down.
        if (externals.has(c.id)) addon.configureNode(c.id, { slot: -1 })
        addon.disposeNode(c.id)
        closeExternal(c.id)
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
    setPluginPaths(paths) {
      pluginPaths = paths
    },
    dispose() {
      if (frameTimer !== null) clearInterval(frameTimer)
      frameTimer = null
      try {
        addon.stop()
      } catch {
        // device was never started — fine
      }
      // Stop first, then release the plugins: closeRealtime waits out any
      // in-flight callback, and there is none once the device is down.
      for (const node of [...externals.keys()]) closeExternal(node)
    }
  }
}
