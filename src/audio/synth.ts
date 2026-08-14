import { synthDefaults, WAVE_TYPES } from '@core/model/effects'
import type { BackendNodeId, IAudioBackend, VoiceId } from './backend'
import type { NoteSchedule } from './scheduling'

/**
 * The built-in polyphonic synth voice: two detuned oscillators → lowpass →
 * ADSR gain, into `dest`. Built from BACKEND PRIMITIVES, so one definition
 * runs on Web Audio and the native engine alike, and the live engine and
 * the offline mixdown renderer still render identically.
 */

/**
 * A scheduled instrument voice: the backend voices it owns (so the engine
 * can track and stop them) plus the teardown for its whole node graph,
 * which the engine runs once every voice has ended.
 */
export interface BuiltVoice {
  readonly voices: VoiceId[]
  dispose(): void
}

export function buildSynthVoice(
  backend: IAudioBackend,
  dest: BackendNodeId,
  s: NoteSchedule,
  synthParams: Readonly<Record<string, number>>
): BuiltVoice {
  const sp = { ...synthDefaults(), ...synthParams }
  const freq = 440 * Math.pow(2, (s.pitch - 69) / 12)
  const peak = 0.22 * s.velocity
  const sustain = peak * sp.sustain
  const attackEnd = s.startSec + sp.attack
  const decayEnd = Math.min(s.endSec, attackEnd + sp.decay)
  const releaseEnd = s.endSec + sp.release

  const filter = backend.createNode('biquad', { type: 'lowpass' })
  backend.scheduleParam(filter, 'frequency', [
    { kind: 'setValue', value: Math.min(16000, Math.max(40, freq * sp.cutoff)), time: 0 }
  ])
  backend.scheduleParam(filter, 'Q', [{ kind: 'setValue', value: 0.7, time: 0 }])

  const env = backend.createNode('gain')
  backend.scheduleParam(env, 'gain', [
    { kind: 'setValue', value: 0, time: s.startSec },
    { kind: 'linearRamp', value: peak, endTime: attackEnd },
    { kind: 'linearRamp', value: sustain, endTime: decayEnd },
    { kind: 'setValue', value: sustain, time: s.endSec },
    { kind: 'linearRamp', value: 0.0001, endTime: releaseEnd }
  ])

  backend.connect(filter, env)
  backend.connect(env, dest)

  const waveType = WAVE_TYPES[Math.round(sp.wave)] ?? 'sawtooth'
  const oscs: BackendNodeId[] = []
  const voices: VoiceId[] = []
  for (const detune of [-sp.detune, sp.detune]) {
    const osc = backend.createNode('oscillator', { type: waveType })
    backend.scheduleParam(osc, 'frequency', [{ kind: 'setValue', value: freq, time: 0 }])
    backend.scheduleParam(osc, 'detune', [{ kind: 'setValue', value: detune, time: 0 }])
    backend.connect(osc, filter)
    voices.push(backend.scheduleSource(osc, s.startSec, releaseEnd + 0.01))
    oscs.push(osc)
  }

  return {
    voices,
    dispose() {
      for (const osc of oscs) backend.disposeNode(osc)
      backend.disposeNode(filter)
      backend.disposeNode(env)
    }
  }
}

/** A live (open-ended) synth voice: sounding until released or stolen. */
export interface LiveVoiceHandle {
  /**
   * True when the voice has NO end of its own — it holds its sustain level
   * (or loops) until release()/stop() is called. Anything that triggers a
   * voice without a note-off to follow (a one-shot pad) must schedule an
   * end for these, or the note sounds until the app closes.
   */
  readonly sustains: boolean
  /**
   * Note-off: ramp to silence over the release param from `when`, and end
   * the voices after. Idempotent; a no-op after stop().
   */
  release(when?: number): void
  /** Hard stop with a short anti-click fade — voice stealing / teardown. */
  stop(): void
}

/**
 * The same instrument as buildSynthVoice — identical tone (two detuned
 * oscillators → lowpass → ADSR gain, same defaults merge) — but built for
 * a note whose END is unknown: a key held down on a MIDI keyboard. The
 * envelope schedules only attack → decay → sustain; the release ramp is
 * scheduled by the returned handle when the key comes up.
 */
export function buildLiveSynthVoice(
  backend: IAudioBackend,
  dest: BackendNodeId,
  pitch: number,
  /** Normalized 0..1 from MIDI velocity. */
  velocity: number,
  synthParams: Readonly<Record<string, number>>,
  onEnded?: () => void
): LiveVoiceHandle {
  const sp = { ...synthDefaults(), ...synthParams }
  const freq = 440 * Math.pow(2, (pitch - 69) / 12)
  const peak = 0.22 * velocity
  const now = backend.now()

  const filter = backend.createNode('biquad', { type: 'lowpass' })
  backend.scheduleParam(filter, 'frequency', [
    { kind: 'setValue', value: Math.min(16000, Math.max(40, freq * sp.cutoff)), time: 0 }
  ])
  backend.scheduleParam(filter, 'Q', [{ kind: 'setValue', value: 0.7, time: 0 }])

  const env = backend.createNode('gain')
  backend.scheduleParam(env, 'gain', [
    { kind: 'setValue', value: 0, time: now },
    { kind: 'linearRamp', value: peak, endTime: now + sp.attack },
    { kind: 'linearRamp', value: peak * sp.sustain, endTime: now + sp.attack + sp.decay }
  ])

  backend.connect(filter, env)
  backend.connect(env, dest)

  const waveType = WAVE_TYPES[Math.round(sp.wave)] ?? 'sawtooth'
  const oscs: BackendNodeId[] = []
  const voices: VoiceId[] = []
  for (const detune of [-sp.detune, sp.detune]) {
    const osc = backend.createNode('oscillator', { type: waveType })
    backend.scheduleParam(osc, 'frequency', [{ kind: 'setValue', value: freq, time: 0 }])
    backend.scheduleParam(osc, 'detune', [{ kind: 'setValue', value: detune, time: 0 }])
    backend.connect(osc, filter)
    // No end scheduled — the handle ends them at release/steal time.
    voices.push(backend.scheduleSource(osc, now))
    oscs.push(osc)
  }

  let remaining = voices.length
  let endedFired = false
  const unsubscribe = backend.onVoiceEnded((id) => {
    if (!voices.includes(id)) return
    if (--remaining > 0) return
    unsubscribe()
    for (const osc of oscs) backend.disposeNode(osc)
    backend.disposeNode(filter)
    backend.disposeNode(env)
    if (!endedFired) {
      endedFired = true
      onEnded?.()
    }
  })

  /** 'held' → ('released' | 'stopped'); stop() may override a long release. */
  let phase: 'held' | 'released' | 'stopped' = 'held'
  const endAt = (when: number, fadeSec: number): void => {
    // Cancel what the envelope had queued from `when`, hold the level it
    // has reached, then ramp down — the seam's events say this directly.
    backend.scheduleParam(env, 'gain', [
      { kind: 'cancel', afterTime: when },
      { kind: 'linearRamp', value: 0.0001, endTime: when + fadeSec }
    ])
    for (const voice of voices) backend.stopVoice(voice, when + fadeSec + 0.02)
  }

  return {
    // Oscillators run until stopped: this voice never ends by itself.
    sustains: true,
    release: (when = backend.now()) => {
      if (phase !== 'held') return
      phase = 'released'
      endAt(Math.max(when, backend.now()), sp.release)
    },
    stop: () => {
      if (phase === 'stopped') return
      phase = 'stopped'
      endAt(backend.now(), 0.015)
    }
  }
}
