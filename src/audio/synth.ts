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
