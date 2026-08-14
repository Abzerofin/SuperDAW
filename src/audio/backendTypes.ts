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
 *
 * 'pdc' and 'external' are phase-5's pair: an external-format plugin
 * running inside the audio callback, and the exact delay line that keeps
 * everything else aligned with the latency it reports. 'external' only
 * ever does anything on a backend whose `externalPlugins` is non-null;
 * elsewhere it is a passthrough, like any unavailable plugin.
 */
export type NodeKind =
  | 'gain'
  | 'stereoPanner'
  | 'biquad'
  | 'delay'
  | 'compressor'
  | 'convolver'
  | 'oscillator'
  /** Channel-select over the live capture stream (§7) — see openInput. */
  | 'input'
  | 'pdc'
  | 'external'

export type NodeOptions = Record<string, number | string>

/**
 * Param names are per-kind: 'gain' (gain), 'pan' (stereoPanner),
 * 'frequency' | 'Q' | 'gain' | 'detune' (biquad, Web Audio semantics —
 * lowpass/highpass read Q in dB), 'delayTime' (delay and pdc). Unknown
 * names are ignored, matching the reducer's drop-don't-throw hygiene.
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

/**
 * What to open on the capture side (§3's `openInput` config, plus the
 * device the caller resolved). Channel semantics are audio/input.ts's:
 * mono duplicates one channel to both sides, stereo takes a pair.
 */
export interface InputOpenConfig {
  readonly mode: 'mono' | 'stereo'
  /** 0-based index of the first hardware channel to take. */
  readonly channel: number
  /**
   * null = the backend's own default. Callers resolve "follow the global
   * setting" themselves — the seam never reads app state.
   */
  readonly deviceId?: string | null
}

/**
 * A live input: a node to connect (monitoring) and a capture subscription
 * (recording), off the SAME channel selection — so what a performer hears
 * is exactly what lands in the take.
 */
export interface InputHandle {
  /** Connectable into a track chain; the ENGINE owns that connection. */
  readonly node: BackendNodeId
  /** Channels the opened device offers (what the UI can choose from). */
  readonly channelCount: number
  /** Rate the chunks arrive at — the take's sample rate. */
  readonly sampleRate: number
  /**
   * Subscribe to capture. Chunks arrive off the audio thread at UI
   * cadence, each carrying the stream time of its FIRST frame — the
   * `Recording.startSec` currency (audio/recorder.ts). A second
   * subscription replaces the first.
   *
   * The returned unsubscribe RESOLVES once everything captured before it
   * was called has been delivered. Batching means audio is always in
   * flight — the native path hands over ~100 ms at a time — so hanging up
   * the instant Stop is pressed would clip the tail off every take.
   */
  capture(
    listener: (chunk: Float32Array[], firstFrameTime: number) => void
  ): () => Promise<void>
  /** Release the node, the capture and any device the handle opened. */
  dispose(): void
}

/**
 * What an `external` node needs to become a plugin: the descriptor's uid
 * and the instance's opaque GUI state. Never a filesystem path — the
 * renderer must not learn one (docs/ARCHITECTURE.md, plugin architecture),
 * so the host resolves the uid against the index MAIN pushes it.
 */
export interface ExternalPluginSpec {
  readonly uid: string
  readonly stateBlob?: string | null
  /** Channel count to negotiate with the plugin. Default 2. */
  readonly channels?: number
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
