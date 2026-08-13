/**
 * The engine parity harness (docs/NATIVE_AUDIO_BACKEND.md §8).
 *
 * Renders a deterministic fixture project through the LIVE AudioEngine —
 * driven exactly as the app drives it, but against a patched
 * OfflineAudioContext — and reduces the output to comparable numbers.
 *
 * Comparison is TOLERANCE-based, not bit-exact: with the full fixture's
 * node count, Chromium's mixer sums fan-ins in varying order, so repeated
 * renders of the identical graph differ by up to 1 ULP of float32
 * (~1.2e-7) in a few percent of samples. That noise floor is four orders
 * of magnitude below any real behavior change (a gain error, a missing
 * source, a timing shift), so PARITY_TOLERANCE separates them cleanly.
 * Every DSP noise source is seeded (drum noise, reverb impulse) — which
 * the render paths need anyway: freezes and bounces are shared artifacts
 * and must not vary per run.
 *
 * Two comparison layers:
 *  - compareRuns(a, b): raw sample diff of two in-session renders.
 *  - envelopeOf(result) vs the repo-stored baseline (parityBaseline.ts):
 *    per-block RMS + peak, compact enough to commit, sensitive enough to
 *    catch real regressions across sessions and refactors.
 *
 * Browser-only (needs OfflineAudioContext); never imported by the app.
 * Run from the dev page:
 *
 *   const { runEngineParity } = await import('/@fs/<repo>/src/audio/parity.ts')
 *   await runEngineParity()
 */

import type { ProjectState, Track, Clip, Note } from '@core/model/types'
import { createEmptyProject } from '@core/model/types'
import { PPQ } from '@core/model/timebase'
import { synthDefaults, effectDefaults, DRUM_INSTRUMENT_INDEX, INSTRUMENT_KINDS } from '@core/model/effects'
import { builtinEffectDescriptor } from '@core/plugins/builtin'
import { AssetStore } from './assets'
import { AudioEngine } from './engine'

export const PARITY_SAMPLE_RATE = 48000
export const PARITY_SECONDS = 3

/** Deterministic PRNG so generated "recordings" never vary run to run. */
function makeRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function toneBuffer(
  ctx: BaseAudioContext,
  seconds: number,
  build: (t: number, channel: number) => number
): AudioBuffer {
  const length = Math.round(seconds * ctx.sampleRate)
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < length; i++) data[i] = build(i / ctx.sampleRate, ch)
  }
  return buffer
}

interface Fixture {
  readonly state: ProjectState
  readonly assets: AssetStore
}

/**
 * A project that exercises every audible engine path in under 3 seconds:
 * plain/faded/reversed/pitched/tiled audio clips, a folder bus, analog
 * synth + drum + sampler notes, a linear insert chain (EQ3 → compressor),
 * a graph-routed track, volume + pan automation, a muted track (must
 * contribute silence), asymmetric pans and a non-unity master.
 */
export function buildParityFixture(ctx: BaseAudioContext): Fixture {
  const assets = new AssetStore()
  const random = makeRandom(20260813)

  // Two deterministic assets: a pure tone and band-limited-ish noise.
  const tone = toneBuffer(ctx, 1, (t, ch) =>
    0.5 * Math.sin(2 * Math.PI * (ch === 0 ? 330 : 331) * t)
  )
  const noiseData = new Float32Array(Math.round(0.5 * ctx.sampleRate))
  for (let i = 0; i < noiseData.length; i++) noiseData[i] = (random() * 2 - 1) * 0.4
  const noise = toneBuffer(ctx, 0.5, (t) => noiseData[Math.round(t * ctx.sampleRate)] ?? 0)

  const toneAsset = assets.restore('ast-parity-tone', 'tone', 'audio', 'wav', new Uint8Array(4), tone)
  const noiseAsset = assets.restore('ast-parity-noise', 'noise', 'audio', 'wav', new Uint8Array(4), noise)

  const base = createEmptyProject('Parity fixture')
  const beat = PPQ // one beat at 120 bpm = 0.5 s
  const track = (over: Partial<Track> & { id: string; kind: Track['kind'] }): Track => ({
    name: over.id,
    color: '#808080',
    muted: false,
    soloed: false,
    volume: 1,
    pan: 0,
    synth: {},
    parentId: null,
    frozenAssetId: null,
    ...over
  })
  const clip = (over: Partial<Clip> & { id: string; trackId: string; start: number; duration: number }): Clip => ({
    name: over.id,
    assetId: null,
    offset: 0,
    color: null,
    fadeIn: 0,
    fadeOut: 0,
    reverse: false,
    pitch: 0,
    stretch: 1,
    loopLength: 0,
    ...over
  })
  const note = (over: Partial<Note> & { id: string; clipId: string; pitch: number; start: number; duration: number }): Note => ({
    velocity: 100,
    ...over
  })

  const tracks: Track[] = [
    track({ id: 'trk-folder', kind: 'folder', volume: 0.9, pan: 0.2 }),
    track({ id: 'trk-audio', kind: 'audio', parentId: 'trk-folder', volume: 0.8, pan: -0.4 }),
    track({ id: 'trk-warped', kind: 'audio', volume: 0.7, pan: 0.3 }),
    track({ id: 'trk-muted', kind: 'audio', muted: true }),
    track({ id: 'trk-synth', kind: 'midi', synth: synthDefaults(), volume: 0.6 }),
    track({
      id: 'trk-drums',
      kind: 'drum',
      synth: { ...synthDefaults(), instrument: DRUM_INSTRUMENT_INDEX },
      volume: 0.8,
      pan: -0.1
    }),
    track({
      id: 'trk-sampler',
      kind: 'midi',
      synth: { ...synthDefaults(), instrument: INSTRUMENT_KINDS.indexOf('sampler') },
      samplerAssetId: noiseAsset.id,
      volume: 0.5,
      pan: 0.5
    }),
    track({ id: 'trk-graph', kind: 'audio', volume: 0.9 })
  ]

  const clips: Clip[] = [
    // Plain, with both fades — through the folder bus.
    clip({ id: 'clp-a', trackId: 'trk-audio', start: 0, duration: 2 * beat, assetId: toneAsset.id, fadeIn: PPQ / 4, fadeOut: PPQ / 2 }),
    // Reversed + pitched + stretched + trimmed into the material.
    clip({ id: 'clp-b', trackId: 'trk-warped', start: beat, duration: beat, assetId: toneAsset.id, offset: PPQ / 8, reverse: true, pitch: 3, stretch: 1.25 }),
    // Tiled (per-clip loop): three repeats of the noise.
    clip({ id: 'clp-c', trackId: 'trk-warped', start: 3 * beat, duration: 2 * beat, assetId: noiseAsset.id, loopLength: (2 * beat) / 3 }),
    // On the muted track: must never be heard.
    clip({ id: 'clp-mute', trackId: 'trk-muted', start: 0, duration: 4 * beat, assetId: toneAsset.id }),
    // Note clips.
    clip({ id: 'clp-syn', trackId: 'trk-synth', start: 0, duration: 4 * beat }),
    clip({ id: 'clp-drm', trackId: 'trk-drums', start: 0, duration: 4 * beat }),
    clip({ id: 'clp-smp', trackId: 'trk-sampler', start: 2 * beat, duration: 2 * beat }),
    // Graph-routed track's source.
    clip({ id: 'clp-g', trackId: 'trk-graph', start: 2 * beat, duration: beat, assetId: toneAsset.id })
  ]

  const notes: Note[] = [
    note({ id: 'not-1', clipId: 'clp-syn', pitch: 60, start: 0, duration: beat }),
    note({ id: 'not-2', clipId: 'clp-syn', pitch: 64, start: beat, duration: beat / 2, velocity: 80 }),
    note({ id: 'not-3', clipId: 'clp-syn', pitch: 67, start: 2 * beat, duration: 2 * beat, velocity: 110 }),
    note({ id: 'not-d1', clipId: 'clp-drm', pitch: 36, start: 0, duration: beat / 4 }),
    note({ id: 'not-d2', clipId: 'clp-drm', pitch: 38, start: beat, duration: beat / 4, velocity: 90 }),
    note({ id: 'not-d3', clipId: 'clp-drm', pitch: 42, start: beat / 2, duration: beat / 4, velocity: 70 }),
    note({ id: 'not-s1', clipId: 'clp-smp', pitch: 60, start: 0, duration: beat }),
    note({ id: 'not-s2', clipId: 'clp-smp', pitch: 67, start: beat, duration: beat / 2 })
  ]

  const state: ProjectState = {
    ...base,
    tempo: 120,
    masterVolume: 0.9,
    tracks: Object.fromEntries(tracks.map((t) => [t.id, t])),
    trackOrder: tracks.map((t) => t.id),
    clips: Object.fromEntries(clips.map((c) => [c.id, c])),
    notes: Object.fromEntries(notes.map((n) => [n.id, n])),
    plugins: {
      // Linear chain on the synth track: EQ3 (rank 0) → compressor (rank 1).
      'plg-eq': {
        id: 'plg-eq',
        trackId: 'trk-synth',
        descriptor: builtinEffectDescriptor('eq3'),
        enabled: true,
        rank: 0,
        params: { ...effectDefaults('eq3'), low: -3, high: 4 },
        stateBlob: null
      },
      'plg-comp': {
        id: 'plg-comp',
        trackId: 'trk-synth',
        descriptor: builtinEffectDescriptor('compressor'),
        enabled: true,
        rank: 1,
        params: { ...effectDefaults('compressor'), threshold: -30, ratio: 6 },
        stateBlob: null
      },
      // A disabled insert: must be bypassed, not silent.
      'plg-off': {
        id: 'plg-off',
        trackId: 'trk-warped',
        descriptor: builtinEffectDescriptor('delay'),
        enabled: false,
        rank: 0,
        params: effectDefaults('delay'),
        stateBlob: null
      },
      // Reverb (convolution over the seeded impulse) after the bypass.
      'plg-rev': {
        id: 'plg-rev',
        trackId: 'trk-warped',
        descriptor: builtinEffectDescriptor('reverb'),
        enabled: true,
        rank: 1,
        params: effectDefaults('reverb'),
        stateBlob: null
      },
      // The graph-routed track's one node.
      'plg-flt': {
        id: 'plg-flt',
        trackId: 'trk-graph',
        descriptor: builtinEffectDescriptor('lowpass'),
        enabled: true,
        rank: 0,
        params: { ...effectDefaults('lowpass'), freq: 900 },
        stateBlob: null
      }
    },
    routes: {
      // in → filter → out, plus a dry parallel wire in → out (fan-in sums).
      'rte-1': { id: 'rte-1', trackId: 'trk-graph', from: 'in', to: 'plg-flt' },
      'rte-2': { id: 'rte-2', trackId: 'trk-graph', from: 'plg-flt', to: 'out' },
      'rte-3': { id: 'rte-3', trackId: 'trk-graph', from: 'in', to: 'out' }
    },
    automation: {
      // Volume dip on the audio track (multiplies the fader).
      'aut-1': { id: 'aut-1', trackId: 'trk-audio', param: 'volume', ticks: 0, value: 1 },
      'aut-2': { id: 'aut-2', trackId: 'trk-audio', param: 'volume', ticks: 2 * beat, value: 0.3 },
      'aut-3': { id: 'aut-3', trackId: 'trk-audio', param: 'volume', ticks: 4 * beat, value: 0.8 },
      // Pan sweep on the warped track (owns the panner during playback).
      'aut-4': { id: 'aut-4', trackId: 'trk-warped', param: 'pan', ticks: 0, value: 0 },
      'aut-5': { id: 'aut-5', trackId: 'trk-warped', param: 'pan', ticks: 4 * beat, value: 1 },
      // Insert-param curve (sampled by the FX timer live; ignored offline —
      // present so the scheduling paths that index it are exercised).
      'aut-6': { id: 'aut-6', trackId: 'trk-synth', param: 'threshold', instanceId: 'plg-comp', ticks: 0, value: 0.4 },
      'aut-7': { id: 'aut-7', trackId: 'trk-synth', param: 'threshold', instanceId: 'plg-comp', ticks: 4 * beat, value: 0.8 }
    }
  }

  return { state, assets }
}

export interface ParityResult {
  readonly sampleRate: number
  readonly frames: number
  /** FNV-1a over each channel's exact float bit patterns. */
  readonly channelHashes: string[]
  readonly channelRms: number[]
  readonly maxAbs: number
  /** Raw channel data — only when requested (debugging diffs). */
  channels?: Float32Array[]
}

function fnv1a(data: Float32Array): string {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  let hash = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Drive a fresh AudioEngine over the fixture against an OfflineAudioContext
 * and reduce the render. The context is patched to look running (offline
 * contexts report 'suspended' until rendering starts, and resume() rejects)
 * so the engine's ordinary play path runs unmodified.
 */
export async function runEngineParity(
  /** Debug bisection: keep only tracks this accepts (default: all). */
  keepTrack?: (trackId: string) => boolean,
  /** Include raw channel data in the result (debugging diffs). */
  captureChannels = false
): Promise<ParityResult> {
  const ctx = new OfflineAudioContext(2, PARITY_SECONDS * PARITY_SAMPLE_RATE, PARITY_SAMPLE_RATE)
  Object.defineProperty(ctx, 'state', { get: () => 'running' })
  ;(ctx as unknown as { resume(): Promise<void> }).resume = () => Promise.resolve()

  let { state, assets } = buildParityFixture(ctx)
  if (keepTrack) {
    const tracks = Object.fromEntries(Object.entries(state.tracks).filter(([id]) => keepTrack(id)))
    const clips = Object.fromEntries(
      Object.entries(state.clips).filter(([, c]) => tracks[c.trackId])
    )
    state = {
      ...state,
      tracks,
      trackOrder: state.trackOrder.filter((id) => tracks[id]),
      clips,
      notes: Object.fromEntries(Object.entries(state.notes).filter(([, n]) => clips[n.clipId])),
      plugins: Object.fromEntries(
        Object.entries(state.plugins).filter(([, p]) => tracks[p.trackId])
      ),
      routes: Object.fromEntries(Object.entries(state.routes).filter(([, r]) => tracks[r.trackId])),
      automation: Object.fromEntries(
        Object.entries(state.automation).filter(([, a]) => tracks[a.trackId])
      )
    }
  }
  const listeners: Array<(event: 'play' | 'stop' | 'seek') => void> = []
  const transport = {
    isPlaying: true,
    positionTicks: () => 0,
    onEvent(listener: (event: 'play' | 'stop' | 'seek') => void) {
      listeners.push(listener)
      return () => {}
    },
    setTimeSource() {},
    setOutputLatency() {},
    activeLoop: () => null
  }
  const store = { state, subscribe: () => () => {} }
  const engine = new AudioEngine(store, transport, assets)
  engine.setContextFactory(() => ctx as unknown as AudioContext)

  for (const listener of listeners) listener('play')
  // restart() resolves over a microtask chain (no preview host attached);
  // one macrotask hop guarantees scheduling completed before rendering.
  await new Promise((resolve) => setTimeout(resolve, 30))
  // Freeze the engine's timers into no-ops: rendering below runs faster
  // than wall time, and a live top-up mid-render would be nondeterministic.
  transport.isPlaying = false

  const rendered = await ctx.startRendering()
  const channelHashes: string[] = []
  const channelRms: number[] = []
  let maxAbs = 0
  for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
    const data = rendered.getChannelData(ch)
    channelHashes.push(fnv1a(data))
    let sum = 0
    for (let i = 0; i < data.length; i++) {
      const v = data[i]
      sum += v * v
      const a = Math.abs(v)
      if (a > maxAbs) maxAbs = a
    }
    channelRms.push(Math.sqrt(sum / data.length))
  }
  const result: ParityResult = {
    sampleRate: rendered.sampleRate,
    frames: rendered.length,
    channelHashes,
    channelRms,
    maxAbs
  }
  if (captureChannels) {
    result.channels = []
    for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
      result.channels.push(new Float32Array(rendered.getChannelData(ch)))
    }
  }
  return result
}

// ------------------------------------------------------------- comparison

/** Max |a−b| per sample that still counts as "the same render" (see top). */
export const PARITY_TOLERANCE = 1e-5

/** Raw sample comparison of two captured runs (channels must be present). */
export function compareRuns(
  a: ParityResult,
  b: ParityResult
): { maxDiff: number; differing: number; pass: boolean } {
  if (!a.channels || !b.channels) throw new Error('capture channels on both runs')
  let maxDiff = 0
  let differing = 0
  for (let ch = 0; ch < a.channels.length; ch++) {
    const x = a.channels[ch]
    const y = b.channels[ch]
    for (let i = 0; i < x.length; i++) {
      const d = Math.abs(x[i] - y[i])
      if (d > 0) {
        differing++
        if (d > maxDiff) maxDiff = d
      }
    }
  }
  return { maxDiff, differing, pass: maxDiff <= PARITY_TOLERANCE }
}

export const ENVELOPE_BLOCK = 128

export interface ParityEnvelope {
  readonly blockSize: number
  readonly sampleRate: number
  /** Per channel: [rms0, peak0, rms1, peak1, ...] over each block. */
  readonly channels: number[][]
}

/**
 * Compact per-block RMS + peak fingerprint — 128-sample blocks resolve a
 * sub-3 ms timing shift while staying small enough to commit as the repo
 * baseline. Values rounded so ULP jitter can never move them.
 */
export function envelopeOf(result: ParityResult): ParityEnvelope {
  if (!result.channels) throw new Error('capture channels to build an envelope')
  const channels: number[][] = []
  for (const data of result.channels) {
    const stats: number[] = []
    for (let start = 0; start < data.length; start += ENVELOPE_BLOCK) {
      const end = Math.min(data.length, start + ENVELOPE_BLOCK)
      let sum = 0
      let peak = 0
      for (let i = start; i < end; i++) {
        const v = data[i]
        sum += v * v
        const a = Math.abs(v)
        if (a > peak) peak = a
      }
      stats.push(
        Math.round(Math.sqrt(sum / (end - start)) * 1e6) / 1e6,
        Math.round(peak * 1e6) / 1e6
      )
    }
    channels.push(stats)
  }
  return { blockSize: ENVELOPE_BLOCK, sampleRate: result.sampleRate, channels }
}

/** Envelope tolerance: generous against ULP noise, tiny against real change. */
export const ENVELOPE_TOLERANCE = 1e-4

/** Render the fixture and check it against the committed baseline. */
export async function verifyAgainstBaseline(): Promise<{
  maxDelta: number
  at: number
  pass: boolean
}> {
  const { PARITY_BASELINE } = await import('./parityBaseline')
  const run = await runEngineParity(undefined, true)
  return compareEnvelopes(PARITY_BASELINE, envelopeOf(run))
}

export function compareEnvelopes(
  a: ParityEnvelope,
  b: ParityEnvelope
): { maxDelta: number; at: number; pass: boolean } {
  if (a.blockSize !== b.blockSize || a.channels.length !== b.channels.length) {
    return { maxDelta: Number.POSITIVE_INFINITY, at: -1, pass: false }
  }
  let maxDelta = 0
  let at = -1
  for (let ch = 0; ch < a.channels.length; ch++) {
    const x = a.channels[ch]
    const y = b.channels[ch]
    if (x.length !== y.length) return { maxDelta: Number.POSITIVE_INFINITY, at: -1, pass: false }
    for (let i = 0; i < x.length; i++) {
      const d = Math.abs(x[i] - y[i])
      if (d > maxDelta) {
        maxDelta = d
        at = i
      }
    }
  }
  return { maxDelta, at, pass: maxDelta <= ENVELOPE_TOLERANCE }
}
