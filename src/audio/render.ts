import type { ProjectState } from '@core/model/types'
import { automationOf, automationValueAt, pluginsOfTrack } from '@core/model/types'
import { pluginRegistry } from './pluginRegistry'
import { buildSynthVoice } from './synth'
import { scheduleClips, scheduleNotes, ticksPerSecond } from './scheduling'
import { encodeWavPcm16 } from './wav'

/**
 * Offline WAV mixdown. Rebuilds the live engine's routing graph inside an
 * OfflineAudioContext — sources → inserts → automation → fader (mute/solo)
 * → pan → master — using the exact same pure scheduling math and the same
 * effect/synth builders, so the bounce sounds like playback.
 */

interface AssetSourceLike {
  get(id: string): { buffer: AudioBuffer | null } | undefined
  getSeconds(id: string): number | null
}

/** Seconds of reverb/delay tail appended after the last clip ends. */
const TAIL_SEC = 3
const SAMPLE_RATE = 44100

/** Timeline end in ticks (0 for an empty project). */
export function projectEndTicks(state: ProjectState): number {
  return Object.values(state.clips).reduce((max, c) => Math.max(max, c.start + c.duration), 0)
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

  const anySolo = Object.values(state.tracks).some((t) => t.soloed)
  const chains = new Map<string, GainNode>() // trackId -> chain input

  for (const trackId of Object.keys(state.tracks)) {
    const track = state.tracks[trackId]
    const input = ctx.createGain()
    const auto = ctx.createGain()
    const fader = ctx.createGain()
    const panner = ctx.createStereoPanner()
    const audible = !(track.muted || (anySolo && !track.soloed))
    fader.gain.value = audible ? track.volume : 0
    panner.pan.value = track.pan

    // Insert chain: input → enabled plugins by rank → auto. Plugins this
    // client can't resolve are bypassed, exactly as in live playback.
    let prev: AudioNode = input
    for (const instance of pluginsOfTrack(state, trackId)) {
      if (!instance.enabled) continue
      const resolved = pluginRegistry.resolve(instance.descriptor)
      if (!resolved) continue
      const nodes = resolved.provider.create(ctx)
      nodes.apply(instance.params, 0)
      prev.connect(nodes.input)
      prev = nodes.output
    }
    prev.connect(auto)
    auto.connect(fader)
    fader.connect(panner)
    panner.connect(master)

    // Volume automation compiled to linear ramps from t=0.
    const points = automationOf(state, trackId, 'volume')
    auto.gain.setValueAtTime(automationValueAt(points, 0), 0)
    for (const point of points) {
      if (point.ticks <= 0) continue
      auto.gain.linearRampToValueAtTime(point.value, point.ticks / tps)
    }

    chains.set(trackId, input)
  }

  for (const s of scheduleClips(state, (id) => assets.getSeconds(id), 0, 0)) {
    const buffer = assets.get(s.assetId)?.buffer
    const dest = chains.get(s.trackId)
    if (!buffer || !dest) continue
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(dest)
    source.start(s.when, s.offsetSec, s.durationSec)
  }

  for (const s of scheduleNotes(state, 0, 0)) {
    const dest = chains.get(s.trackId)
    if (!dest) continue
    buildSynthVoice(ctx, dest, s, state.tracks[s.trackId]?.synth ?? {})
  }

  const rendered = await ctx.startRendering()
  const channels: Float32Array[] = []
  for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
    channels.push(rendered.getChannelData(ch))
  }
  return encodeWavPcm16(channels, rendered.sampleRate)
}
