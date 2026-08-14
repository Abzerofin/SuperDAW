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
  /** Web Audio's exponential ramp — endpoints must be non-zero, same sign. */
  | { kind: 'exponentialRamp'; value: number; endTime: number }
  | { kind: 'setTarget'; value: number; time: number; timeConstant: number }
  | { kind: 'setCurve'; curve: Float32Array; time: number; duration: number }
  | { kind: 'cancel'; afterTime: number }

/**
 * Graph primitives. 'gain' and 'stereoPanner' are the mixer's own; the
 * DSP kinds arrive with the phase-2 ports (biquad first — six of the
 * eleven builtin effects are pure biquad chains). Options at creation
 * (and via configureNode) carry the non-param attributes — a biquad's
 * `type` — which Web Audio also treats as instant plain attributes.
 */
export type NodeKind =
  | 'gain'
  | 'stereoPanner'
  | 'biquad'
  | 'delay'
  | 'compressor'
  | 'convolver'
  | 'oscillator'

export type NodeOptions = Record<string, number | string>

/**
 * Param names are per-kind: 'gain' (gain), 'pan' (stereoPanner),
 * 'frequency' | 'Q' | 'gain' | 'detune' (biquad, Web Audio semantics —
 * lowpass/highpass read Q in dB). Unknown names are ignored, matching
 * the reducer's drop-don't-throw hygiene.
 */
export type ParamName = string

export interface StreamInfo {
  sampleRate: number
  outputChannels: number
}

/**
 * A device the active backend can open (§6). Native ids are stable and
 * labels always present; Web Audio's are origin-scoped hashes whose
 * labels stay hidden until a capture grant — which is why selections are
 * persisted per backend rather than translated between them.
 */
export interface DeviceInfo {
  readonly id: string
  readonly label: string
  readonly kind: 'input' | 'output'
  readonly isDefault: boolean
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
  /**
   * Sustain loop in BUFFER seconds — playback wraps from `endSec` back to
   * `startSec` instead of ending (Web Audio's loop/loopStart/loopEnd).
   * The voice then runs until stopped.
   */
  loop?: { startSec: number; endSec: number }
  destination: BackendNodeId
}
