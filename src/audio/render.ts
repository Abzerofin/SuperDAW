import type { ProjectState, TrackId } from '@core/model/types'
import {
  automationOf,
  automationValueAt,
  clipsOfTrack,
  isTrackAudible,
  pluginsOfTrack
} from '@core/model/types'
import { applyClipFades } from './fades'
import { pluginRegistry } from './pluginRegistry'
import { buildSynthVoice } from './synth'
import { scheduleClips, scheduleNotes, ticksPerSecond } from './scheduling'
import { encodeWavPcm16 } from './wav'

/**
 * Offline rendering. Rebuilds the live engine's routing graph inside an
 * OfflineAudioContext — sources → inserts → automation → fader (mute/solo)
 * → pan → folder bus… → master — using the exact same pure scheduling
 * math and the same effect/synth/fade builders, so bounces sound like
 * playback. Frozen tracks render their frozen asset, exactly as live.
 *
 * `renderTrackFreeze` is the freeze path: ONE track, pre-fader (sources →
 * inserts → volume automation only), so the frozen render can replace the
 * track's live processing while fader/pan/mute/solo stay interactive.
 */

interface AssetSourceLike {
  get(id: string): { buffer: AudioBuffer | null } | undefined
  getSeconds(id: string): number | null
  /** Mirrored copy for reversed clips (cached per asset by the store). */
  reversedBuffer?(
    id: string,
    create: (channels: Float32Array[], sampleRate: number) => AudioBuffer
  ): AudioBuffer | null
}

/** Seconds of reverb/delay tail appended after the last clip ends. */
const TAIL_SEC = 3
const SAMPLE_RATE = 44100

/** Timeline end in ticks (0 for an empty project). */
export function projectEndTicks(state: ProjectState): number {
  return Object.values(state.clips).reduce((max, c) => Math.max(max, c.start + c.duration), 0)
}

/** Build a track's insert path into `ctx`: input → enabled resolvable plugins → out. */
function buildInserts(ctx: BaseAudioContext, state: ProjectState, trackId: TrackId, input: AudioNode): AudioNode {
  let prev: AudioNode = input
  for (const instance of pluginsOfTrack(state, trackId)) {
    if (!instance.enabled) continue
    const resolved = pluginRegistry.resolve(instance.descriptor)
    if (!resolved) continue // MISSING on this client: bypass, as in live playback
    const nodes = resolved.provider.create(ctx)
    nodes.apply(instance.params, 0)
    prev.connect(nodes.input)
    prev = nodes.output
  }
  return prev
}

/** Compile a track's volume automation onto a gain node from t=0. */
function applyVolumeAutomation(auto: GainNode, state: ProjectState, trackId: TrackId, tps: number): void {
  const points = automationOf(state, trackId, 'volume')
  auto.gain.setValueAtTime(automationValueAt(points, 0), 0)
  for (const point of points) {
    if (point.ticks <= 0) continue
    auto.gain.linearRampToValueAtTime(point.value, point.ticks / tps)
  }
}

/** Schedule clip sources (with fades) and synth notes into per-track inputs. */
function scheduleSources(
  ctx: BaseAudioContext,
  state: ProjectState,
  assets: AssetSourceLike,
  inputs: Map<TrackId, AudioNode>
): void {
  // One fade envelope per clip, shared by its audio source and its synth
  // voices so MIDI and audio taper identically (and identically to playback).
  const fadeGains = new Map<string, GainNode>()
  const destinationFor = (clipId: string, trackId: TrackId): AudioNode | undefined => {
    const chainInput = inputs.get(trackId)
    const clip = state.clips[clipId]
    if (!chainInput || !clip || (clip.fadeIn <= 0 && clip.fadeOut <= 0)) return chainInput
    let gain = fadeGains.get(clipId)
    if (!gain) {
      gain = ctx.createGain()
      gain.connect(chainInput)
      applyClipFades(gain.gain, clip, state.tempo, 0, 0)
      fadeGains.set(clipId, gain)
    }
    return gain
  }

  for (const s of scheduleClips(state, (id) => assets.getSeconds(id), 0, 0)) {
    const plain = assets.get(s.assetId)?.buffer
    // Reversed clips read the mirrored copy, exactly as in live playback.
    const buffer = s.reverse
      ? (assets.reversedBuffer?.(s.assetId, (channels, sampleRate) => {
          const b = ctx.createBuffer(channels.length, channels[0].length, sampleRate)
          channels.forEach((data, ch) => b.copyToChannel(data as Float32Array<ArrayBuffer>, ch))
          return b
        }) ?? null)
      : plain
    const dest = destinationFor(s.clipId, s.trackId)
    if (!buffer || !dest) continue
    const source = ctx.createBufferSource()
    source.buffer = buffer
    if (s.rate !== 1) source.playbackRate.value = s.rate
    source.connect(dest)
    source.start(s.when, s.offsetSec, s.durationSec)
  }
  for (const s of scheduleNotes(state, 0, 0)) {
    const dest = destinationFor(s.clipId, s.trackId)
    if (!dest) continue
    buildSynthVoice(ctx, dest, s, state.tracks[s.trackId]?.synth ?? {})
  }
}

export async function renderMixdown(
  state: ProjectState,
  assets: AssetSourceLike
): Promise<Uint8Array | null> {
  const endTicks = projectEndTicks(state)
  if (endTicks <= 0) return null
  const tps = ticksPerSecond(state.tempo)
  const lengthSec = endTicks / tps + TAIL_SEC
  const ctx = new OfflineAudioContext(2, Math.ceil(lengthSec * SAMPLE_RATE), SAMPLE_RATE)

  const master = ctx.createGain()
  master.gain.value = state.masterVolume
  master.connect(ctx.destination)

  // First pass: build every track's chain (folders included — they are buses).
  const inputs = new Map<TrackId, AudioNode>()
  const panners = new Map<TrackId, StereoPannerNode>()
  for (const trackId of Object.keys(state.tracks)) {
    const track = state.tracks[trackId]
    const input = ctx.createGain()
    const auto = ctx.createGain()
    const fader = ctx.createGain()
    const panner = ctx.createStereoPanner()
    fader.gain.value = isTrackAudible(state, trackId) ? track.volume : 0
    panner.pan.value = track.pan

    // Frozen tracks bypass inserts and neutralize volume automation — both
    // are already baked into the frozen render.
    const chainOut = track.frozenAssetId ? input : buildInserts(ctx, state, trackId, input)
    chainOut.connect(auto)
    auto.connect(fader)
    fader.connect(panner)
    if (track.frozenAssetId) auto.gain.value = 1
    else applyVolumeAutomation(auto, state, trackId, tps)

    // Pan automation owns the panner when present (0..1 → -1..1), as live.
    const panPoints = automationOf(state, trackId, 'pan')
    if (panPoints.length > 0) {
      panner.pan.setValueAtTime(automationValueAt(panPoints, 0) * 2 - 1, 0)
      for (const point of panPoints) {
        if (point.ticks <= 0) continue
        panner.pan.linearRampToValueAtTime(point.value * 2 - 1, point.ticks / tps)
      }
    }

    inputs.set(trackId, input)
    panners.set(trackId, panner)
  }
  // Second pass: route each panner to its folder bus (or master).
  for (const trackId of Object.keys(state.tracks)) {
    const parentId = state.tracks[trackId].parentId
    const parentInput = parentId !== null ? inputs.get(parentId) : undefined
    panners.get(trackId)!.connect(parentInput ?? master)
  }

  scheduleSources(ctx, state, assets, inputs)

  const rendered = await ctx.startRendering()
  const channels: Float32Array[] = []
  for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
    channels.push(rendered.getChannelData(ch))
  }
  return encodeWavPcm16(channels, rendered.sampleRate)
}

/**
 * Render ONE track for freezing: sources → inserts → volume automation,
 * WITHOUT fader/pan/mute/solo (those stay live on the frozen track) and
 * without the master chain. Returns null for a track with no content.
 * Must be called BEFORE dispatching track/freeze (the track still plays
 * live here, so scheduling maths treat it normally).
 */
export async function renderTrackFreeze(
  state: ProjectState,
  trackId: TrackId,
  assets: AssetSourceLike
): Promise<AudioBuffer | null> {
  const endTicks = clipsOfTrack(state, trackId).reduce(
    (max, c) => Math.max(max, c.start + c.duration),
    0
  )
  if (endTicks <= 0) return null
  const tps = ticksPerSecond(state.tempo)
  const lengthSec = endTicks / tps + TAIL_SEC
  const ctx = new OfflineAudioContext(2, Math.ceil(lengthSec * SAMPLE_RATE), SAMPLE_RATE)

  const input = ctx.createGain()
  const auto = ctx.createGain()
  buildInserts(ctx, state, trackId, input).connect(auto)
  auto.connect(ctx.destination)
  applyVolumeAutomation(auto, state, trackId, tps)

  const inputs = new Map<TrackId, AudioNode>([[trackId, input]])
  scheduleSources(ctx, state, assets, inputs)

  return ctx.startRendering()
}
