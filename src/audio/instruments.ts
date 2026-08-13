import {
  DRUM_PADS,
  SLICE_BASE_PITCH,
  drumPadForPitch,
  instrumentKindOf,
  synthDefaults
} from '@core/model/effects'
import { sliceRegions } from '@core/model/slices'
import type { NoteSchedule } from './scheduling'
import { buildLiveSynthVoice, buildSynthVoice, type LiveVoiceHandle } from './synth'

/**
 * The built-in instruments beyond the analog synth: a SAMPLER (an asset
 * played chromatically from a root note, or as transient slices mapped
 * across the keys) and a DRUM SYNTH (eight synthesized pads on the GM drum
 * pitches). Like synth.ts, every builder is a pure (ctx, dest) function
 * shared verbatim by the live engine and the offline renderer, so bounces
 * and freezes sound exactly like playback.
 *
 * `buildInstrumentVoice` / `buildLiveInstrumentVoice` are the single
 * dispatch points: they read the track's `instrument` param and delegate,
 * so the engine keeps exactly one call site per path.
 */

/** What the sampler needs of an asset: decoded audio + slice boundaries. */
export interface InstrumentSample {
  readonly buffer: AudioBuffer
  /** Transient onsets in buffer seconds (slice boundaries in SLICES mode). */
  readonly onsets: readonly number[]
}

/** Voice headroom, matching the analog synth's 0.22 scale. */
const SAMPLER_PEAK = 0.9
const DRUM_PEAK = 0.5

// ---------------------------------------------------------------- sampler

interface SampleRegion {
  readonly startSec: number
  readonly endSec: number
  readonly rate: number
}

/** The buffer region and playback rate a pitch addresses, or null = silent. */
function samplerRegion(
  sp: Record<string, number>,
  sample: InstrumentSample,
  pitch: number
): SampleRegion | null {
  const bufferSec = sample.buffer.duration
  if (!(bufferSec > 0)) return null
  if (Math.round(sp.smpMode) === 1) {
    const regions = sliceRegions(sample.onsets, bufferSec)
    const region = regions[Math.round(pitch) - SLICE_BASE_PITCH]
    return region ? { startSec: region.startSec, endSec: region.endSec, rate: 1 } : null
  }
  const startSec = Math.min(sp.smpStart, sp.smpEnd) * bufferSec
  const endSec = Math.max(sp.smpEnd * bufferSec, startSec + 0.01)
  return { startSec, endSec, rate: Math.pow(2, (pitch - sp.smpRoot) / 12) }
}

function buildSamplerVoice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  s: NoteSchedule,
  sp: Record<string, number>,
  sample: InstrumentSample,
  onVoiceEnded?: (source: AudioScheduledSourceNode) => void
): AudioScheduledSourceNode[] {
  const region = samplerRegion(sp, sample, s.pitch)
  if (!region) return []
  const looping = Math.round(sp.smpMode) === 0 && sp.smpLoop >= 0.5

  const peak = SAMPLER_PEAK * s.velocity * sp.smpGain
  const sustain = peak * sp.smpSustain
  const attackEnd = s.startSec + sp.smpAttack
  const decayEnd = Math.min(s.endSec, attackEnd + sp.smpDecay)
  const releaseEnd = s.endSec + sp.smpRelease

  const env = ctx.createGain()
  env.gain.setValueAtTime(0, s.startSec)
  env.gain.linearRampToValueAtTime(peak, attackEnd)
  env.gain.linearRampToValueAtTime(sustain, decayEnd)
  env.gain.setValueAtTime(sustain, s.endSec)
  env.gain.linearRampToValueAtTime(0.0001, releaseEnd)
  env.connect(dest)

  const source = ctx.createBufferSource()
  source.buffer = sample.buffer
  if (region.rate !== 1) source.playbackRate.value = region.rate
  source.connect(env)
  source.onended = () => {
    onVoiceEnded?.(source)
    source.disconnect()
    env.disconnect()
  }
  const regionLen = region.endSec - region.startSec
  if (looping) {
    source.loop = true
    source.loopStart = region.startSec
    source.loopEnd = region.endSec
    source.start(s.startSec, region.startSec)
    source.stop(releaseEnd + 0.01)
  } else {
    // The voice ends at note-release or when the region runs dry at this
    // rate — whichever comes first.
    const wantedBufferSec = (releaseEnd - s.startSec) * region.rate
    source.start(s.startSec, region.startSec, Math.min(regionLen, wantedBufferSec))
  }
  return [source]
}

function buildLiveSamplerVoice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  pitch: number,
  velocity: number,
  sp: Record<string, number>,
  sample: InstrumentSample,
  onEnded?: () => void
): LiveVoiceHandle {
  const region = samplerRegion(sp, sample, pitch)
  if (!region) return { sustains: false, release: () => onEnded?.(), stop: () => onEnded?.() }
  const looping = Math.round(sp.smpMode) === 0 && sp.smpLoop >= 0.5
  const now = ctx.currentTime
  const peak = SAMPLER_PEAK * velocity * sp.smpGain

  const env = ctx.createGain()
  env.gain.setValueAtTime(0, now)
  env.gain.linearRampToValueAtTime(peak, now + sp.smpAttack)
  env.gain.linearRampToValueAtTime(peak * sp.smpSustain, now + sp.smpAttack + sp.smpDecay)
  env.connect(dest)

  const source = ctx.createBufferSource()
  source.buffer = sample.buffer
  if (region.rate !== 1) source.playbackRate.value = region.rate
  source.connect(env)
  let endedFired = false
  source.onended = () => {
    source.disconnect()
    env.disconnect()
    if (!endedFired) {
      endedFired = true
      onEnded?.()
    }
  }
  if (looping) {
    source.loop = true
    source.loopStart = region.startSec
    source.loopEnd = region.endSec
    source.start(now, region.startSec)
  } else {
    source.start(now, region.startSec, region.endSec - region.startSec)
  }

  let phase: 'held' | 'released' | 'stopped' = 'held'
  const endAt = (when: number, fadeSec: number): void => {
    const gain = env.gain as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam }
    if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(when)
    else {
      gain.cancelScheduledValues(when)
      gain.setValueAtTime(gain.value, when)
    }
    gain.linearRampToValueAtTime(0.0001, when + fadeSec)
    try {
      source.stop(when + fadeSec + 0.02)
    } catch {
      // already ended naturally — nothing to do
    }
  }
  return {
    // A looping region plays forever; a one-shot region runs out on its own.
    sustains: looping,
    release: (when = ctx.currentTime) => {
      if (phase !== 'held') return
      phase = 'released'
      endAt(Math.max(when, ctx.currentTime), sp.smpRelease)
    },
    stop: () => {
      if (phase === 'stopped') return
      phase = 'stopped'
      endAt(ctx.currentTime, 0.015)
    }
  }
}

// -------------------------------------------------------------- drum synth

/** One second of white noise, shared per context (hats fire constantly). */
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>()

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const cached = noiseBuffers.get(ctx)
  if (cached) return cached
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate), ctx.sampleRate)
  const data = buffer.getChannelData(0)
  // Seeded (mulberry32), NOT Math.random(): the same project must render
  // the same bytes on every run and every machine — freezes and bounces
  // are shared with collaborators, and the engine parity harness (and the
  // future native backend's numerical verification) diffs renders exactly.
  // Noise is noise; only reproducibility changes.
  let seed = 0x9e3779b9 ^ Math.round(ctx.sampleRate)
  for (let i = 0; i < data.length; i++) {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    data[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1
  }
  noiseBuffers.set(ctx, buffer)
  return buffer
}

interface DrumVoiceParts {
  readonly sources: AudioScheduledSourceNode[]
  /** The voice's output gain — the live wrapper's kill switch. */
  readonly out: GainNode
  readonly endSec: number
}

/** Ramp a gain from `peak` at t0 down to silence over `decaySec`. */
function decayEnv(
  ctx: BaseAudioContext,
  t0: number,
  peak: number,
  decaySec: number
): GainNode {
  const env = ctx.createGain()
  // An exponential ramp is undefined from 0 — floor the start value.
  env.gain.setValueAtTime(Math.max(0.0015, peak), t0)
  env.gain.exponentialRampToValueAtTime(0.001, t0 + decaySec)
  return env
}

function noiseHit(
  ctx: BaseAudioContext,
  t0: number,
  filterType: BiquadFilterType,
  freq: number,
  q: number,
  peak: number,
  decaySec: number,
  out: GainNode
): { source: AudioBufferSourceNode; env: GainNode } {
  const source = ctx.createBufferSource()
  source.buffer = noiseBuffer(ctx)
  const filter = ctx.createBiquadFilter()
  filter.type = filterType
  filter.frequency.value = freq
  filter.Q.value = q
  const env = decayEnv(ctx, t0, peak, decaySec)
  source.connect(filter)
  filter.connect(env)
  env.connect(out)
  source.start(t0, 0, decaySec + 0.05)
  return { source, env }
}

function oscHit(
  ctx: BaseAudioContext,
  t0: number,
  type: OscillatorType,
  freq: number,
  peak: number,
  decaySec: number,
  out: GainNode
): { osc: OscillatorNode; env: GainNode } {
  const osc = ctx.createOscillator()
  osc.type = type
  osc.frequency.value = freq
  const env = decayEnv(ctx, t0, peak, decaySec)
  osc.connect(env)
  env.connect(out)
  osc.start(t0)
  osc.stop(t0 + decaySec + 0.05)
  return { osc, env }
}

/**
 * One synthesized drum hit into `out`. `tune` transposes (semitones),
 * `decay` scales each pad's natural length, `tone` morphs the pad's
 * character (kick click, snare noise/body balance, hat/cymbal brightness,
 * clap filter), and the pad's `level` is applied by the caller on `out`.
 */
function buildDrumHit(
  ctx: BaseAudioContext,
  t0: number,
  padKey: string,
  tune: number,
  decay: number,
  tone: number,
  out: GainNode
): { sources: AudioScheduledSourceNode[]; endSec: number } {
  const k = Math.pow(2, tune / 12)
  const sources: AudioScheduledSourceNode[] = []
  let endSec = t0 + 0.3

  switch (padKey) {
    case 'kick': {
      const dur = 0.4 * decay
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(160 * k, t0)
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, 44 * k), t0 + 0.11)
      const env = decayEnv(ctx, t0, 1, dur)
      osc.connect(env)
      env.connect(out)
      osc.start(t0)
      osc.stop(t0 + dur + 0.05)
      sources.push(osc)
      if (tone > 0.02) {
        const click = noiseHit(ctx, t0, 'highpass', 1500, 0.7, tone * 0.6, 0.02, out)
        sources.push(click.source)
      }
      endSec = t0 + dur + 0.05
      break
    }
    case 'snare': {
      const dur = 0.2 * decay
      const body = oscHit(ctx, t0, 'triangle', 176 * k, (1 - tone * 0.5) * 0.8, 0.11 * decay, out)
      body.osc.frequency.exponentialRampToValueAtTime(Math.max(30, 155 * k), t0 + 0.08)
      const noise = noiseHit(ctx, t0, 'highpass', 1400 * k, 0.7, 0.4 + tone * 0.6, dur, out)
      sources.push(body.osc, noise.source)
      endSec = t0 + dur + 0.05
      break
    }
    case 'clap': {
      const dur = 0.28 * decay
      const source = ctx.createBufferSource()
      source.buffer = noiseBuffer(ctx)
      const filter = ctx.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.value = (800 + tone * 1600) * k
      filter.Q.value = 1.4
      // Three quick re-attacks then the tail — the classic clap stutter.
      const env = ctx.createGain()
      env.gain.setValueAtTime(0, t0)
      for (let i = 0; i < 3; i++) {
        const at = t0 + i * 0.011
        env.gain.linearRampToValueAtTime(1, at + 0.002)
        env.gain.linearRampToValueAtTime(0.25, at + 0.01)
      }
      env.gain.linearRampToValueAtTime(0.9, t0 + 0.036)
      env.gain.exponentialRampToValueAtTime(0.001, t0 + dur)
      source.connect(filter)
      filter.connect(env)
      env.connect(out)
      source.start(t0, 0, dur + 0.05)
      sources.push(source)
      endSec = t0 + dur + 0.05
      break
    }
    case 'hatc':
    case 'hato': {
      const dur = (padKey === 'hatc' ? 0.055 : 0.4) * decay
      const noise = noiseHit(ctx, t0, 'highpass', 5000 + tone * 5000, 0.7, 0.8, dur, out)
      sources.push(noise.source)
      endSec = t0 + dur + 0.05
      break
    }
    case 'toml':
    case 'tomh': {
      const base = (padKey === 'toml' ? 105 : 172) * k
      const dur = 0.3 * decay
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(base * 1.6, t0)
      osc.frequency.exponentialRampToValueAtTime(base, t0 + 0.04)
      const env = decayEnv(ctx, t0, 0.9, dur)
      osc.connect(env)
      env.connect(out)
      osc.start(t0)
      osc.stop(t0 + dur + 0.05)
      const skin = noiseHit(ctx, t0, 'lowpass', 900, 0.7, tone * 0.3, 0.03, out)
      sources.push(osc, skin.source)
      endSec = t0 + dur + 0.05
      break
    }
    case 'ride': {
      const dur = 0.7 * decay
      const noise = noiseHit(ctx, t0, 'highpass', 6000 + tone * 4000, 0.7, 0.5, dur, out)
      sources.push(noise.source)
      // Two inharmonic squares give the metallic ping.
      for (const freq of [523.7, 812.3]) {
        const ping = oscHit(ctx, t0, 'square', freq * k, 0.12, dur * 0.6, out)
        sources.push(ping.osc)
      }
      endSec = t0 + dur + 0.05
      break
    }
  }
  return { sources, endSec }
}

function buildDrumVoice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t0: number,
  pitch: number,
  velocity: number,
  sp: Record<string, number>
): DrumVoiceParts | null {
  const pad = drumPadForPitch(pitch)
  if (!pad) return null
  const level = sp[`${pad.key}Level`] ?? 1
  if (level <= 0) return null
  const out = ctx.createGain()
  out.gain.value = DRUM_PEAK * level * velocity
  out.connect(dest)
  const hit = buildDrumHit(
    ctx,
    t0,
    pad.key,
    sp[`${pad.key}Tune`] ?? 0,
    sp[`${pad.key}Decay`] ?? 1,
    sp[`${pad.key}Tone`] ?? 0.5,
    out
  )
  if (hit.sources.length === 0) {
    out.disconnect()
    return null
  }
  return { sources: hit.sources, out, endSec: hit.endSec }
}

/** Wire teardown: disconnect the voice graph after the LAST source ends. */
function teardownAfterAll(
  parts: DrumVoiceParts,
  onVoiceEnded?: (source: AudioScheduledSourceNode) => void
): void {
  let remaining = parts.sources.length
  for (const source of parts.sources) {
    source.onended = () => {
      onVoiceEnded?.(source)
      source.disconnect()
      if (--remaining === 0) parts.out.disconnect()
    }
  }
}

// -------------------------------------------------------------- dispatch

/**
 * A scheduled note on whatever instrument the track's synth record selects.
 * The analog synth path is byte-for-byte the existing buildSynthVoice; the
 * sampler needs its sample resolved by the caller (null = not loaded /
 * still transferring = silent, exactly like a clip whose asset is absent).
 */
export function buildInstrumentVoice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  s: NoteSchedule,
  synthParams: Readonly<Record<string, number>>,
  sample: InstrumentSample | null,
  onVoiceEnded?: (source: AudioScheduledSourceNode) => void
): AudioScheduledSourceNode[] {
  const kind = instrumentKindOf(synthParams)
  if (kind === 'analog') return buildSynthVoice(ctx, dest, s, synthParams, onVoiceEnded)
  const sp = { ...synthDefaults(), ...synthParams }
  if (kind === 'sampler') {
    return sample ? buildSamplerVoice(ctx, dest, s, sp, sample, onVoiceEnded) : []
  }
  const parts = buildDrumVoice(ctx, dest, s.startSec, s.pitch, s.velocity, sp)
  if (!parts) return []
  teardownAfterAll(parts, onVoiceEnded)
  return parts.sources
}

/**
 * The live (open-ended) variant for MIDI input and pad performance. Drum
 * hits are one-shots: release is a no-op and only stop() (voice stealing /
 * teardown) cuts them short.
 */
export function buildLiveInstrumentVoice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  pitch: number,
  velocity: number,
  synthParams: Readonly<Record<string, number>>,
  sample: InstrumentSample | null,
  onEnded?: () => void
): LiveVoiceHandle {
  const kind = instrumentKindOf(synthParams)
  if (kind === 'analog') {
    return buildLiveSynthVoice(ctx, dest, pitch, velocity, synthParams, onEnded)
  }
  const sp = { ...synthDefaults(), ...synthParams }
  if (kind === 'sampler') {
    if (!sample) return { sustains: false, release: () => onEnded?.(), stop: () => onEnded?.() }
    return buildLiveSamplerVoice(ctx, dest, pitch, velocity, sp, sample, onEnded)
  }
  return buildLiveDrumVoice(ctx, dest, pitch, velocity, sp, onEnded)
}

function buildLiveDrumVoice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  pitch: number,
  velocity: number,
  sp: Record<string, number>,
  onEnded?: () => void
): LiveVoiceHandle {
  const parts = buildDrumVoice(ctx, dest, ctx.currentTime, pitch, velocity, sp)
  if (!parts) return { sustains: false, release: () => onEnded?.(), stop: () => onEnded?.() }
  let remaining = parts.sources.length
  let endedFired = false
  for (const source of parts.sources) {
    source.onended = () => {
      source.disconnect()
      if (--remaining === 0) {
        parts.out.disconnect()
        if (!endedFired) {
          endedFired = true
          onEnded?.()
        }
      }
    }
  }
  return {
    // Every hit is a fixed-length decay — it always ends by itself.
    sustains: false,
    // One-shots: a lifted key does not cut a cymbal.
    release: () => {},
    stop: () => {
      const now = ctx.currentTime
      parts.out.gain.setTargetAtTime(0.0001, now, 0.008)
      for (const source of parts.sources) {
        try {
          source.stop(now + 0.03)
        } catch {
          // already stopped
        }
      }
    }
  }
}

/** GM pitches the drum synth responds to — the step sequencer's row set. */
export const DRUM_PAD_PITCHES: readonly number[] = DRUM_PADS.map((pad) => pad.pitch)
