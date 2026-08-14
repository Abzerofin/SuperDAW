import {
  DRUM_PADS,
  SLICE_BASE_PITCH,
  drumPadForPitch,
  instrumentKindOf,
  synthDefaults
} from '@core/model/effects'
import { sliceRegions } from '@core/model/slices'
import type { BackendNodeId, IAudioBackend, ParamEvent, VoiceId } from './backend'
import { makeNoise, noiseBufferId } from './impulse'
import type { NoteSchedule } from './scheduling'
import {
  buildLiveSynthVoice,
  buildSynthVoice,
  type BuiltVoice,
  type LiveVoiceHandle
} from './synth'

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

/**
 * What the sampler needs of an asset: a REGISTERED buffer (the seam's
 * currency, so the voice plays it on either backend), its length, and the
 * slice boundaries.
 */
export interface InstrumentSample {
  /** Registered backend buffer id; null while the asset is unavailable. */
  readonly bufferId: string | null
  readonly durationSec: number
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
  const bufferSec = sample.durationSec
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
  backend: IAudioBackend,
  dest: BackendNodeId,
  s: NoteSchedule,
  sp: Record<string, number>,
  sample: InstrumentSample
): BuiltVoice {
  const empty: BuiltVoice = { voices: [], dispose: () => {} }
  const region = samplerRegion(sp, sample, s.pitch)
  if (!region || !sample.bufferId) return empty
  const looping = Math.round(sp.smpMode) === 0 && sp.smpLoop >= 0.5

  const peak = SAMPLER_PEAK * s.velocity * sp.smpGain
  const sustain = peak * sp.smpSustain
  const attackEnd = s.startSec + sp.smpAttack
  const decayEnd = Math.min(s.endSec, attackEnd + sp.smpDecay)
  const releaseEnd = s.endSec + sp.smpRelease

  const env = backend.createNode('gain')
  backend.scheduleParam(env, 'gain', [
    { kind: 'setValue', value: 0, time: s.startSec },
    { kind: 'linearRamp', value: peak, endTime: attackEnd },
    { kind: 'linearRamp', value: sustain, endTime: decayEnd },
    { kind: 'setValue', value: sustain, time: s.endSec },
    { kind: 'linearRamp', value: 0.0001, endTime: releaseEnd }
  ])
  backend.connect(env, dest)

  const regionLen = region.endSec - region.startSec
  const voice = backend.play({
    bufferId: sample.bufferId,
    when: s.startSec,
    offsetSec: region.startSec,
    rate: region.rate,
    destination: env,
    ...(looping
      ? { loop: { startSec: region.startSec, endSec: region.endSec } }
      : // The voice ends at note-release or when the region runs dry at
        // this rate — whichever comes first.
        {
          durationSec: Math.min(regionLen, (releaseEnd - s.startSec) * region.rate)
        })
  })
  if (voice === null) {
    backend.disposeNode(env)
    return empty
  }
  // A looped voice would otherwise never stop: end it with the release.
  if (looping) backend.stopVoice(voice, releaseEnd + 0.01)
  return { voices: [voice], dispose: () => backend.disposeNode(env) }
}

function buildLiveSamplerVoice(
  backend: IAudioBackend,
  dest: BackendNodeId,
  pitch: number,
  velocity: number,
  sp: Record<string, number>,
  sample: InstrumentSample,
  onEnded?: () => void
): LiveVoiceHandle {
  const silent: LiveVoiceHandle = {
    sustains: false,
    release: () => onEnded?.(),
    stop: () => onEnded?.()
  }
  const region = samplerRegion(sp, sample, pitch)
  if (!region || !sample.bufferId) return silent
  const looping = Math.round(sp.smpMode) === 0 && sp.smpLoop >= 0.5
  const now = backend.now()
  const peak = SAMPLER_PEAK * velocity * sp.smpGain

  const env = backend.createNode('gain')
  backend.scheduleParam(env, 'gain', [
    { kind: 'setValue', value: 0, time: now },
    { kind: 'linearRamp', value: peak, endTime: now + sp.smpAttack },
    { kind: 'linearRamp', value: peak * sp.smpSustain, endTime: now + sp.smpAttack + sp.smpDecay }
  ])
  backend.connect(env, dest)

  const voice = backend.play({
    bufferId: sample.bufferId,
    when: now,
    offsetSec: region.startSec,
    rate: region.rate,
    destination: env,
    ...(looping
      ? { loop: { startSec: region.startSec, endSec: region.endSec } }
      : { durationSec: region.endSec - region.startSec })
  })
  if (voice === null) {
    backend.disposeNode(env)
    return silent
  }

  let endedFired = false
  const unsubscribe = backend.onVoiceEnded((id) => {
    if (id !== voice) return
    unsubscribe()
    backend.disposeNode(env)
    if (!endedFired) {
      endedFired = true
      onEnded?.()
    }
  })

  let phase: 'held' | 'released' | 'stopped' = 'held'
  const endAt = (when: number, fadeSec: number): void => {
    backend.scheduleParam(env, 'gain', [
      { kind: 'cancel', afterTime: when },
      { kind: 'linearRamp', value: 0.0001, endTime: when + fadeSec }
    ])
    backend.stopVoice(voice, when + fadeSec + 0.02)
  }
  return {
    // A looping region plays forever; a one-shot region runs out on its own.
    sustains: looping,
    release: (when = backend.now()) => {
      if (phase !== 'held') return
      phase = 'released'
      endAt(Math.max(when, backend.now()), sp.smpRelease)
    },
    stop: () => {
      if (phase === 'stopped') return
      phase = 'stopped'
      endAt(backend.now(), 0.015)
    }
  }
}

// -------------------------------------------------------------- drum synth

/**
 * The shared noise buffer, registered with the backend on first use (hats
 * fire constantly, so one registration serves every hit). Generation is
 * pure and seeded — see audio/impulse.ts.
 */
function ensureNoise(backend: IAudioBackend): string {
  const sampleRate = backend.start().sampleRate
  const id = noiseBufferId(sampleRate)
  if (!backend.hasBuffer(id)) backend.registerBuffer(id, makeNoise(sampleRate), sampleRate)
  return id
}

/** Ramp a gain from `peak` at t0 down to silence over `decaySec`. */
function decayEnv(
  backend: IAudioBackend,
  t0: number,
  peak: number,
  decaySec: number
): BackendNodeId {
  const env = backend.createNode('gain')
  // An exponential ramp is undefined from 0 — floor the start value.
  backend.scheduleParam(env, 'gain', [
    { kind: 'setValue', value: Math.max(0.0015, peak), time: t0 },
    { kind: 'exponentialRamp', value: 0.001, endTime: t0 + decaySec }
  ])
  return env
}

/** A filtered burst of the shared noise — hats, snare rattle, kick click. */
function noiseHit(
  backend: IAudioBackend,
  t0: number,
  filterType: 'lowpass' | 'highpass' | 'bandpass',
  freq: number,
  q: number,
  peak: number,
  decaySec: number,
  out: BackendNodeId,
  parts: DrumParts
): void {
  const filter = backend.createNode('biquad', { type: filterType })
  backend.scheduleParam(filter, 'frequency', [{ kind: 'setValue', value: freq, time: 0 }])
  backend.scheduleParam(filter, 'Q', [{ kind: 'setValue', value: q, time: 0 }])
  const env = decayEnv(backend, t0, peak, decaySec)
  backend.connect(filter, env)
  backend.connect(env, out)
  const voice = backend.play({
    bufferId: ensureNoise(backend),
    when: t0,
    offsetSec: 0,
    durationSec: decaySec + 0.05,
    destination: filter
  })
  if (voice !== null) parts.voices.push(voice)
  parts.nodes.push(filter, env)
}

/** A pitched oscillator burst under a decay envelope. */
function oscHit(
  backend: IAudioBackend,
  t0: number,
  type: 'sine' | 'square' | 'triangle' | 'sawtooth',
  freq: number,
  peak: number,
  decaySec: number,
  out: BackendNodeId,
  parts: DrumParts
): BackendNodeId {
  const osc = backend.createNode('oscillator', { type })
  backend.scheduleParam(osc, 'frequency', [{ kind: 'setValue', value: freq, time: 0 }])
  const env = decayEnv(backend, t0, peak, decaySec)
  backend.connect(osc, env)
  backend.connect(env, out)
  parts.voices.push(backend.scheduleSource(osc, t0, t0 + decaySec + 0.05))
  parts.nodes.push(osc, env)
  return osc
}

/** Everything one drum hit created, for tracking and teardown. */
interface DrumParts {
  voices: VoiceId[]
  nodes: BackendNodeId[]
}

/**
 * One synthesized drum hit into `out`. `tune` transposes (semitones),
 * `decay` scales each pad's natural length, `tone` morphs the pad's
 * character (kick click, snare noise/body balance, hat/cymbal brightness,
 * clap filter), and the pad's `level` is applied by the caller on `out`.
 */
function buildDrumHit(
  backend: IAudioBackend,
  t0: number,
  padKey: string,
  tune: number,
  decay: number,
  tone: number,
  out: BackendNodeId,
  parts: DrumParts
): number {
  const k = Math.pow(2, tune / 12)
  let endSec = t0 + 0.3

  switch (padKey) {
    case 'kick': {
      const dur = 0.4 * decay
      // A sine whose pitch drops fast — the thump.
      const osc = oscHit(backend, t0, 'sine', 160 * k, 1, dur, out, parts)
      backend.scheduleParam(osc, 'frequency', [
        { kind: 'setValue', value: 160 * k, time: t0 },
        { kind: 'exponentialRamp', value: Math.max(20, 44 * k), endTime: t0 + 0.11 }
      ])
      if (tone > 0.02) {
        noiseHit(backend, t0, 'highpass', 1500, 0.7, tone * 0.6, 0.02, out, parts)
      }
      endSec = t0 + dur + 0.05
      break
    }
    case 'snare': {
      const dur = 0.2 * decay
      const body = oscHit(
        backend,
        t0,
        'triangle',
        176 * k,
        (1 - tone * 0.5) * 0.8,
        0.11 * decay,
        out,
        parts
      )
      // Anchored at t0, like the kick and toms. This anchor used to be
      // missing, which left the ramp's previous event at oscHit's
      // setValue at time 0 — a pitch drop nominally spanning the whole
      // song. Chromium hid that: it does not evaluate a source's param
      // timeline before the source renders, so the ramp was implicitly
      // anchored to the render quantum containing the hit (the body
      // started up to 0.7 Hz flat, inaudible). The native engine reads
      // the timeline literally, so the body had already arrived at
      // 155 Hz — every native snare was flat-pitched. Anchoring is the
      // shape BOTH backends agree on; `crossBackendParity.test.ts` pins
      // it. Web Audio output shifts very slightly, hence the
      // regenerated parity baseline.
      backend.scheduleParam(body, 'frequency', [
        { kind: 'setValue', value: 176 * k, time: t0 },
        { kind: 'exponentialRamp', value: Math.max(30, 155 * k), endTime: t0 + 0.08 }
      ])
      noiseHit(backend, t0, 'highpass', 1400 * k, 0.7, 0.4 + tone * 0.6, dur, out, parts)
      endSec = t0 + dur + 0.05
      break
    }
    case 'clap': {
      const dur = 0.28 * decay
      const filter = backend.createNode('biquad', { type: 'bandpass' })
      backend.scheduleParam(filter, 'frequency', [
        { kind: 'setValue', value: (800 + tone * 1600) * k, time: 0 }
      ])
      backend.scheduleParam(filter, 'Q', [{ kind: 'setValue', value: 1.4, time: 0 }])
      // Three quick re-attacks then the tail — the classic clap stutter.
      const env = backend.createNode('gain')
      const events: ParamEvent[] = [{ kind: 'setValue', value: 0, time: t0 }]
      for (let i = 0; i < 3; i++) {
        const at = t0 + i * 0.011
        events.push({ kind: 'linearRamp', value: 1, endTime: at + 0.002 })
        events.push({ kind: 'linearRamp', value: 0.25, endTime: at + 0.01 })
      }
      events.push({ kind: 'linearRamp', value: 0.9, endTime: t0 + 0.036 })
      events.push({ kind: 'exponentialRamp', value: 0.001, endTime: t0 + dur })
      backend.scheduleParam(env, 'gain', events)
      backend.connect(filter, env)
      backend.connect(env, out)
      const voice = backend.play({
        bufferId: ensureNoise(backend),
        when: t0,
        offsetSec: 0,
        durationSec: dur + 0.05,
        destination: filter
      })
      if (voice !== null) parts.voices.push(voice)
      parts.nodes.push(filter, env)
      endSec = t0 + dur + 0.05
      break
    }
    case 'hatc':
    case 'hato': {
      const dur = (padKey === 'hatc' ? 0.055 : 0.4) * decay
      noiseHit(backend, t0, 'highpass', 5000 + tone * 5000, 0.7, 0.8, dur, out, parts)
      endSec = t0 + dur + 0.05
      break
    }
    case 'toml':
    case 'tomh': {
      const base = (padKey === 'toml' ? 105 : 172) * k
      const dur = 0.3 * decay
      const osc = oscHit(backend, t0, 'sine', base * 1.6, 0.9, dur, out, parts)
      backend.scheduleParam(osc, 'frequency', [
        { kind: 'setValue', value: base * 1.6, time: t0 },
        { kind: 'exponentialRamp', value: base, endTime: t0 + 0.04 }
      ])
      noiseHit(backend, t0, 'lowpass', 900, 0.7, tone * 0.3, 0.03, out, parts)
      endSec = t0 + dur + 0.05
      break
    }
    case 'ride': {
      const dur = 0.7 * decay
      noiseHit(backend, t0, 'highpass', 6000 + tone * 4000, 0.7, 0.5, dur, out, parts)
      // Two inharmonic squares give the metallic ping.
      for (const freq of [523.7, 812.3]) {
        oscHit(backend, t0, 'square', freq * k, 0.12, dur * 0.6, out, parts)
      }
      endSec = t0 + dur + 0.05
      break
    }
  }
  return endSec
}

/** A drum voice: the pad's hit under its level/velocity output gain. */
function buildDrumVoice(
  backend: IAudioBackend,
  dest: BackendNodeId,
  t0: number,
  pitch: number,
  velocity: number,
  sp: Record<string, number>
): { parts: DrumParts; out: BackendNodeId; endSec: number } | null {
  const pad = drumPadForPitch(pitch)
  if (!pad) return null
  const level = sp[`${pad.key}Level`] ?? 1
  if (level <= 0) return null
  const out = backend.createNode('gain')
  backend.scheduleParam(out, 'gain', [
    { kind: 'setValue', value: DRUM_PEAK * level * velocity, time: 0 }
  ])
  backend.connect(out, dest)
  const parts: DrumParts = { voices: [], nodes: [out] }
  const endSec = buildDrumHit(
    backend,
    t0,
    pad.key,
    sp[`${pad.key}Tune`] ?? 0,
    sp[`${pad.key}Decay`] ?? 1,
    sp[`${pad.key}Tone`] ?? 0.5,
    out,
    parts
  )
  if (parts.voices.length === 0) {
    for (const node of parts.nodes) backend.disposeNode(node)
    return null
  }
  return { parts, out, endSec }
}

// -------------------------------------------------------------- dispatch

/**
 * A scheduled note on whatever instrument the track's synth record selects.
 * The analog synth path is byte-for-byte the existing buildSynthVoice; the
 * sampler needs its sample resolved by the caller (null = not loaded /
 * still transferring = silent, exactly like a clip whose asset is absent).
 */
export function buildInstrumentVoice(
  backend: IAudioBackend,
  dest: BackendNodeId,
  s: NoteSchedule,
  synthParams: Readonly<Record<string, number>>,
  sample: InstrumentSample | null
): BuiltVoice {
  const kind = instrumentKindOf(synthParams)
  if (kind === 'analog') return buildSynthVoice(backend, dest, s, synthParams)
  const sp = { ...synthDefaults(), ...synthParams }
  if (kind === 'sampler') {
    return sample
      ? buildSamplerVoice(backend, dest, s, sp, sample)
      : { voices: [], dispose: () => {} }
  }
  const built = buildDrumVoice(backend, dest, s.startSec, s.pitch, s.velocity, sp)
  if (!built) return { voices: [], dispose: () => {} }
  return {
    voices: built.parts.voices,
    dispose: () => {
      for (const node of built.parts.nodes) backend.disposeNode(node)
    }
  }
}

/**
 * The live (open-ended) variant for MIDI input and pad performance. Drum
 * hits are one-shots: release is a no-op and only stop() (voice stealing /
 * teardown) cuts them short.
 */
export function buildLiveInstrumentVoice(
  backend: IAudioBackend,
  dest: BackendNodeId,
  pitch: number,
  velocity: number,
  synthParams: Readonly<Record<string, number>>,
  sample: InstrumentSample | null,
  onEnded?: () => void
): LiveVoiceHandle {
  const kind = instrumentKindOf(synthParams)
  if (kind === 'analog') {
    return buildLiveSynthVoice(backend, dest, pitch, velocity, synthParams, onEnded)
  }
  const sp = { ...synthDefaults(), ...synthParams }
  if (kind === 'sampler') {
    if (!sample) {
      return { sustains: false, release: () => onEnded?.(), stop: () => onEnded?.() }
    }
    return buildLiveSamplerVoice(backend, dest, pitch, velocity, sp, sample, onEnded)
  }
  return buildLiveDrumVoice(backend, dest, pitch, velocity, sp, onEnded)
}

function buildLiveDrumVoice(
  backend: IAudioBackend,
  dest: BackendNodeId,
  pitch: number,
  velocity: number,
  sp: Record<string, number>,
  onEnded?: () => void
): LiveVoiceHandle {
  const built = buildDrumVoice(backend, dest, backend.now(), pitch, velocity, sp)
  if (!built) return { sustains: false, release: () => onEnded?.(), stop: () => onEnded?.() }
  const { parts, out } = built
  let remaining = parts.voices.length
  let endedFired = false
  const unsubscribe = backend.onVoiceEnded((id) => {
    if (!parts.voices.includes(id)) return
    if (--remaining > 0) return
    unsubscribe()
    for (const node of parts.nodes) backend.disposeNode(node)
    if (!endedFired) {
      endedFired = true
      onEnded?.()
    }
  })
  return {
    // Every hit is a fixed-length decay — it always ends by itself.
    sustains: false,
    // One-shots: a lifted key does not cut a cymbal.
    release: () => {},
    stop: () => {
      const now = backend.now()
      backend.scheduleParam(out, 'gain', [
        { kind: 'setTarget', value: 0.0001, time: now, timeConstant: 0.008 }
      ])
      for (const voice of parts.voices) backend.stopVoice(voice, now + 0.03)
    }
  }
}

/** GM pitches the drum synth responds to — the step sequencer's row set. */
export const DRUM_PAD_PITCHES: readonly number[] = DRUM_PADS.map((pad) => pad.pitch)
