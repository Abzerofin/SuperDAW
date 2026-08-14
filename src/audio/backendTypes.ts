/**
 * The backend seam's serializable currency (docs/NATIVE_AUDIO_BACKEND.md
 * §3), split from backend.ts so DOM-free programs — the audio
 * utilityProcess session in src/main — can speak the wire protocol
 * without dragging Web Audio types into their typecheck.
 */

export type BackendNodeId = number
export type VoiceId = number
export type TapId = number

/**
 * Mirrors Web Audio AudioParam semantics 1:1 — the five calls the engine
 * actually uses. Times are absolute stream-clock seconds.
 */
export type ParamEvent =
  | { kind: 'setValue'; value: number; time: number }
  | { kind: 'linearRamp'; value: number; endTime: number }
  | { kind: 'setTarget'; value: number; time: number; timeConstant: number }
  | { kind: 'setCurve'; curve: Float32Array; time: number; duration: number }
  | { kind: 'cancel'; afterTime: number }

/** Graph primitives the engine instantiates itself (see backend.ts). */
export type NodeKind = 'gain' | 'stereoPanner'

export interface StreamInfo {
  sampleRate: number
  outputChannels: number
}

export interface BackendLatencies {
  /** Seconds the heard output lags the stream clock (feeds the playhead). */
  outputSec: number
  /** null = unknown (the Web Audio backend cannot measure its input path). */
  inputSec: number | null
}

export interface PlaySpec {
  /** A buffer previously registered/adopted under this id. */
  bufferId: string
  /** Absolute stream time to start at (clamped to now by implementations). */
  when: number
  offsetSec?: number
  /** Omitted = play the buffer to its end. */
  durationSec?: number
  /** Resampling ratio (pitch and stretch combined). Default 1. */
  rate?: number
  destination: BackendNodeId
}
