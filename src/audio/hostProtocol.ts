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

/** Renderer → host. */
export type HostCommand =
  | { t: 'start'; opts: HostStartOptions }
  | { t: 'stop' }
  /** Re-enumerate and push a fresh `devices` event. */
  | { t: 'refreshDevices' }
  /** Reopen the stream on another output device (null = system default). */
  | { t: 'setOutputDevice'; deviceId: string | null }
  | { t: 'createNode'; id: number; kind: NodeKind; opts?: NodeOptions }
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

/** The MessagePort surface both ends actually use (works for Electron's
 *  MessagePortMain-in-utilityProcess and the DOM MessagePort alike). */
export interface PortLike {
  postMessage(message: unknown): void
  onMessage(listener: (data: unknown) => void): void
  start?(): void
}
