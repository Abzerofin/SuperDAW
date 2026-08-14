/**
 * The wire contract between the renderer's NativeAudioBackend proxy and
 * the audio utilityProcess session (docs/NATIVE_AUDIO_BACKEND.md §5).
 * Everything is structured-clone-friendly by construction; control
 * messages are one-way (ids are caller-minted), and the only upstream
 * traffic is the periodic frame — clock, ended voices, tap snapshots,
 * health counters — at UI cadence, never per audio block.
 */

import type { DeviceInfo, NodeKind, NodeOptions, ParamEvent, ParamName } from './backendTypes'

export interface HostStartOptions {
  deviceId?: string | null
  bufferFrames?: number
  exclusive?: boolean
}

/**
 * The native engine's internal block, and therefore the largest chunk an
 * external plugin is ever handed in one process() call. Must match
 * sdengine::kBlockFrames in native/audiohost/src/engine.h.
 */
export const AUDIO_BLOCK_FRAMES = 128

/** Renderer → host. */
export type HostCommand =
  | { t: 'start'; opts: HostStartOptions }
  | { t: 'stop' }
  /** Re-enumerate and push a fresh `devices` event. */
  | { t: 'refreshDevices' }
  /** Reopen the stream on another output device (null = system default). */
  | { t: 'setOutputDevice'; deviceId: string | null }
  | { t: 'createNode'; id: number; kind: NodeKind; opts?: NodeOptions }
  /**
   * An `external` node's plugin. Sent BEFORE the createNode it belongs to
   * would otherwise be, because opening a VST3 is slow and can fail: the
   * host loads it, then creates the node bound (or not) to a slot, then
   * answers with `externalReady`. Identity is the descriptor uid — the
   * renderer never learns, and never sends, a filesystem path.
   */
  | {
      t: 'openExternal'
      id: number
      uid: string
      stateBlob?: string | null
      channels?: number
    }
  /** Normalized 0..1 values keyed by the plugin's own parameter ids. */
  | { t: 'setPluginParams'; node: number; params: Record<string, number> }
  | { t: 'configureNode'; id: number; opts: NodeOptions }
  | { t: 'connect'; from: number; to: number }
  | { t: 'connectParam'; from: number; to: number; param: ParamName }
  | { t: 'disconnectParam'; from: number; to: number; param: ParamName }
  | { t: 'disconnect'; from: number; to?: number }
  | { t: 'disposeNode'; id: number }
  | { t: 'scheduleParam'; node: number; param: ParamName; events: ParamEvent[] }
  | { t: 'registerBuffer'; id: string; sampleRate: number; channels: Float32Array[] }
  | { t: 'releaseBuffer'; id: string }
  | {
      t: 'play'
      id: number
      bufferId: string
      when: number
      offsetSec?: number
      durationSec?: number
      rate?: number
      loop?: { startSec: number; endSec: number }
      destination: number
    }
  | { t: 'scheduleSource'; id: number; node: number; when: number; stopAt?: number }
  | { t: 'stopVoice'; id: number; atTime?: number }
  | { t: 'createTap'; id: number; node: number; frames: number }
  | { t: 'disposeTap'; id: number }

export interface HostStreamInfo {
  sampleRate: number
  outputChannels: number
  periodFrames: number
  periodCount: number
  exclusive: boolean
}

/** Host → renderer. */
export type HostEvent =
  | { t: 'started'; info: HostStreamInfo; latencySec: number }
  | { t: 'startFailed'; message: string }
  /**
   * The device list, PUSHED rather than answered: keeping every message
   * one-way means the proxy can serve enumerateDevices() from cache
   * without an RPC round-trip inside the UI's path.
   */
  | { t: 'devices'; devices: DeviceInfo[] }
  /**
   * The answer to `openExternal`. `ok: false` means the insert is
   * bypassing — no host, plugin not installed, or the plugin refused to
   * load — which the renderer reports once rather than retrying.
   * `latencySamples` is what plugin-delay compensation compensates.
   */
  | {
      t: 'externalReady'
      node: number
      ok: boolean
      latencySamples: number
      message?: string
    }
  | {
      t: 'frame'
      /** Stream time when the frame was assembled (the clock base). */
      now: number
      latencySec: number
      ended: number[]
      taps: Record<number, Float32Array>
      xruns: number
    }

/** Cadence of the upstream frame (clock resync, meters, ended voices). */
export const HOST_FRAME_INTERVAL_MS = 33

/**
 * MAIN → audio process, over the utilityProcess's own parentPort rather
 * than the renderer's port. A plugin's filesystem path is main's to know:
 * it comes from main's scanner and must never reach the renderer or the
 * document, so the audio process is told directly.
 */
export interface HostPluginIndex {
  t: 'plugins'
  /** descriptor uid → installed bundle path. */
  paths: Record<string, string>
}

/** The MessagePort surface both ends actually use (works for Electron's
 *  MessagePortMain-in-utilityProcess and the DOM MessagePort alike). */
export interface PortLike {
  postMessage(message: unknown): void
  onMessage(listener: (data: unknown) => void): void
  start?(): void
}
