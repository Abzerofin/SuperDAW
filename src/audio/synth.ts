import { synthDefaults, WAVE_TYPES } from '@core/model/effects'
import type { NoteSchedule } from './scheduling'

/**
 * The built-in polyphonic synth voice: two detuned oscillators → lowpass →
 * ADSR gain, into `dest`. Shared between the live engine and the offline
 * mixdown renderer so both render identically. Returns the oscillators so
 * the live engine can track/stop them; offline rendering ignores them.
 */
export function buildSynthVoice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  s: NoteSchedule,
  synthParams: Readonly<Record<string, number>>,
  onVoiceEnded?: (osc: OscillatorNode) => void
): OscillatorNode[] {
  const sp = { ...synthDefaults(), ...synthParams }
  const freq = 440 * Math.pow(2, (s.pitch - 69) / 12)
  const peak = 0.22 * s.velocity
  const sustain = peak * sp.sustain
  const attackEnd = s.startSec + sp.attack
  const decayEnd = Math.min(s.endSec, attackEnd + sp.decay)
  const releaseEnd = s.endSec + sp.release

  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = Math.min(16000, Math.max(40, freq * sp.cutoff))
  filter.Q.value = 0.7

  const env = ctx.createGain()
  env.gain.setValueAtTime(0, s.startSec)
  env.gain.linearRampToValueAtTime(peak, attackEnd)
  env.gain.linearRampToValueAtTime(sustain, decayEnd)
  env.gain.setValueAtTime(sustain, s.endSec)
  env.gain.linearRampToValueAtTime(0.0001, releaseEnd)

  filter.connect(env)
  env.connect(dest)

  const waveType = WAVE_TYPES[Math.round(sp.wave)] ?? 'sawtooth'
  const voices: OscillatorNode[] = []
  for (const detune of [-sp.detune, sp.detune]) {
    const osc = ctx.createOscillator()
    osc.type = waveType
    osc.frequency.value = freq
    osc.detune.value = detune
    osc.connect(filter)
    osc.onended = () => {
      onVoiceEnded?.(osc)
      osc.disconnect()
      filter.disconnect()
      env.disconnect()
    }
    osc.start(s.startSec)
    osc.stop(releaseEnd + 0.01)
    voices.push(osc)
  }
  return voices
}

/** A live (open-ended) synth voice: sounding until released or stolen. */
export interface LiveVoiceHandle {
  /**
   * Note-off: cancel pending envelope events from `when`, ramp to silence
   * over the release param, stop the oscillators after. Idempotent; a
   * no-op after stop().
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
 * scheduled by the returned handle when the key comes up. Pure ctx/dest
 * function like its sibling, so the engine stays the only place that knows
 * about track chains.
 */
export function buildLiveSynthVoice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  pitch: number,
  /** Normalized 0..1 from MIDI velocity. */
  velocity: number,
  synthParams: Readonly<Record<string, number>>,
  onEnded?: () => void
): LiveVoiceHandle {
  const sp = { ...synthDefaults(), ...synthParams }
  const freq = 440 * Math.pow(2, (pitch - 69) / 12)
  const peak = 0.22 * velocity
  const now = ctx.currentTime

  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = Math.min(16000, Math.max(40, freq * sp.cutoff))
  filter.Q.value = 0.7

  const env = ctx.createGain()
  env.gain.setValueAtTime(0, now)
  env.gain.linearRampToValueAtTime(peak, now + sp.attack)
  env.gain.linearRampToValueAtTime(peak * sp.sustain, now + sp.attack + sp.decay)

  filter.connect(env)
  env.connect(dest)

  const waveType = WAVE_TYPES[Math.round(sp.wave)] ?? 'sawtooth'
  const oscs: OscillatorNode[] = []
  let endedFired = false
  for (const detune of [-sp.detune, sp.detune]) {
    const osc = ctx.createOscillator()
    osc.type = waveType
    osc.frequency.value = freq
    osc.detune.value = detune
    osc.connect(filter)
    osc.onended = () => {
      osc.disconnect()
      filter.disconnect()
      env.disconnect()
      if (!endedFired) {
        endedFired = true
        onEnded?.()
      }
    }
    osc.start(now)
    // No stop scheduled — the handle schedules it at release/steal time.
    oscs.push(osc)
  }

  /** 'held' → ('released' | 'stopped'); stop() may override a long release. */
  let phase: 'held' | 'released' | 'stopped' = 'held'
  const endAt = (when: number, fadeSec: number): void => {
    // cancelAndHold keeps the ramp continuous from wherever the envelope
    // is; the fallback pins the CURRENT value, close enough when `when`
    // is now (which it always is for live input).
    const gain = env.gain as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam }
    if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(when)
    else {
      gain.cancelScheduledValues(when)
      gain.setValueAtTime(gain.value, when)
    }
    gain.linearRampToValueAtTime(0.0001, when + fadeSec)
    for (const osc of oscs) {
      // Re-calling stop() replaces a previously scheduled stop time.
      try {
        osc.stop(when + fadeSec + 0.02)
      } catch {
        // never started (impossible here) — nothing to do
      }
    }
  }

  return {
    release: (when = ctx.currentTime) => {
      if (phase !== 'held') return
      phase = 'released'
      endAt(Math.max(when, ctx.currentTime), sp.release)
    },
    stop: () => {
      if (phase === 'stopped') return
      phase = 'stopped'
      endAt(ctx.currentTime, 0.015)
    }
  }
}
