import type { AutomationPoint, PluginInstance, ProjectState, TrackId } from '@core/model/types'
import type { PluginDescriptor } from '@core/plugins/descriptor'
import {
  automationOf,
  automationValueAt,
  clipsOfTrack,
  clipWarpFactor,
  isTrackAudible,
  pluginsOfTrack,
  routesOfTrack
} from '@core/model/types'
import { denormalizeParam } from '@core/model/effects'
import { paramDefsOf } from '@core/plugins/builtin'
import { WebAudioBackend } from './backend'
import { applyClipFades } from './fades'
import { buildInstrumentVoice, type InstrumentSample } from './instruments'
import { onsetsForPeaks } from './onsets'
import { pluginRegistry } from './pluginRegistry'
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
  get(id: string): {
    buffer: AudioBuffer | null
    /** Peak envelope — the sampler's slice boundaries derive from it. */
    peaks?: Float32Array | null
    peaksPerSecond?: number
  } | undefined
  getSeconds(id: string): number | null
  /** Mirrored copy for reversed clips (cached per asset by the store). */
  reversedBuffer?(
    id: string,
    create: (channels: Float32Array[], sampleRate: number) => AudioBuffer
  ): AudioBuffer | null
  /** Stretched channels for warped clips — sync read of the store's cache. */
  warpedChannels?(id: string, factor: number): Float32Array[] | null
  /** Compute (and cache) a warped variant — renders pre-warm through this. */
  ensureWarped?(id: string, factor: number): Promise<Float32Array[] | null>
}

/**
 * Compute every warped variant the state's clips play BEFORE the graph is
 * built — the schedule pass is synchronous, so the phase-vocoder work
 * (async, sliced) must already be in the cache when it runs. Absent
 * methods (test fakes) leave warped clips silent, like a missing asset.
 */
async function prewarmWarpedClips(state: ProjectState, assets: AssetSourceLike): Promise<void> {
  if (!assets.ensureWarped) return
  const wanted = new Map<string, [string, number]>()
  for (const clip of Object.values(state.clips)) {
    const factor = clipWarpFactor(clip)
    if (clip.assetId !== null && factor !== 1) {
      wanted.set(`${clip.assetId}@${factor}`, [clip.assetId, factor])
    }
  }
  for (const [assetId, factor] of wanted.values()) {
    await assets.ensureWarped(assetId, factor)
  }
}

/** Resolve a track's sampler sample, mirroring the live engine exactly. */
function samplerSampleFor(
  assets: AssetSourceLike,
  track: { samplerAssetId?: string | null } | undefined
): InstrumentSample | null {
  const assetId = track?.samplerAssetId ?? null
  if (!assetId) return null
  const asset = assets.get(assetId)
  if (!asset?.buffer) return null
  return {
    buffer: asset.buffer,
    onsets: onsetsForPeaks(asset.peaks ?? null, asset.peaksPerSecond ?? 0)
  }
}

/**
 * Out-of-process plugin host (VST3 etc). External plugins cannot run in
 * the renderer's audio graph, so freezing hands their audio to whoever
 * can. Injected rather than imported so `src/audio` stays free of Electron
 * and the browser build simply passes nothing (external inserts bypass,
 * exactly as a missing plugin does).
 */
export interface ExternalPluginHost {
  /** Can this client render this descriptor out of process? */
  has(descriptor: PluginDescriptor): boolean
  /** Offline-process; null = failed, and the insert bypasses. */
  process(
    instance: PluginInstance,
    channels: Float32Array[],
    sampleRate: number
  ): Promise<Float32Array[] | null>
  /**
   * A PERSISTENT plugin for live playback, whose state carries across
   * calls so consecutive chunks continue each other's tails. Takes the
   * whole PluginInstance because the document's stateBlob must be
   * restored into the plugin at open time. Absent on hosts that only do
   * one-shot work.
   */
  open?(
    instance: PluginInstance,
    sampleRate: number,
    channels: number
  ): Promise<ExternalInstance | null>
}

/** A live plugin held open across chunks. Callers MUST close it. */
export interface ExternalInstance {
  process(
    channels: Float32Array[],
    params: Readonly<Record<string, number>>
  ): Promise<Float32Array[] | null>
  close(): void
}

/** Seconds of reverb/delay tail appended after the last clip ends. */
const TAIL_SEC = 3
/**
 * FALLBACK offline render rate, used only when no live AudioContext exists
 * to follow. Callers pass the live context's rate: assets are decoded AT
 * that rate, so rendering at it reads them 1:1 — bounces round-trip
 * without the decode-rate → render-rate second resample that a hardcoded
 * rate forced on every machine whose device does not run at 44.1 kHz.
 */
export const RENDER_SAMPLE_RATE = 44100

/** Timeline end in ticks (0 for an empty project). */
export function projectEndTicks(state: ProjectState): number {
  return Object.values(state.clips).reduce((max, c) => Math.max(max, c.start + c.duration), 0)
}

/**
 * Build a track's insert path into `ctx`: input → enabled resolvable
 * plugins → out. A track with routing-graph edges wires those instead
 * (fan-out/fan-in sum natively); unresolvable or bypassed nodes short
 * through, mirroring the live engine exactly.
 */
function buildInserts(
  ctx: BaseAudioContext,
  state: ProjectState,
  trackId: TrackId,
  input: AudioNode,
  /** Timeline tick at ctx time 0 — anchors insert-param automation. */
  anchorTicks = 0
): AudioNode {
  // A per-render backend adapter over this offline context: the builders
  // (backend-primitive filters included) run through the identical seam
  // the live engine uses, so bounces keep matching playback.
  const rb = new WebAudioBackend({ contextFactory: () => ctx as AudioContext })
  const escapes = rb.webAudio
  const localNodes = (instance: PluginInstance): { input: AudioNode; output: AudioNode } | null => {
    const resolved = pluginRegistry.resolve(instance.descriptor)
    if (!resolved) return null // MISSING on this client: bypass, as in live playback
    const nodes = resolved.provider.create(rb)
    if (!nodes) return null
    nodes.apply(instance.params, 0)
    applyInsertAutomation(nodes, state, instance, anchorTicks)
    return { input: escapes.nodeOf(nodes.input), output: escapes.nodeOf(nodes.output) }
  }

  const routes = routesOfTrack(state, trackId)
  if (routes.length > 0) {
    const out = ctx.createGain()
    const ports = new Map<string, { inlet: GainNode; outlet: GainNode }>()
    for (const instance of pluginsOfTrack(state, trackId)) {
      const inlet = ctx.createGain()
      const outlet = ctx.createGain()
      const nodes = instance.enabled ? localNodes(instance) : null
      if (nodes) {
        inlet.connect(nodes.input)
        nodes.output.connect(outlet)
      } else {
        inlet.connect(outlet)
      }
      ports.set(instance.id, { inlet, outlet })
    }
    for (const route of routes) {
      const from = route.from === 'in' ? input : ports.get(route.from)?.outlet
      const to = route.to === 'out' ? out : ports.get(route.to)?.inlet
      if (from && to) from.connect(to)
    }
    return out
  }

  let prev: AudioNode = input
  for (const instance of pluginsOfTrack(state, trackId)) {
    if (!instance.enabled) continue
    const nodes = localNodes(instance)
    if (!nodes) continue
    prev.connect(nodes.input)
    prev = nodes.output
  }
  return prev
}

/**
 * Sampled insert-param automation for an offline render, mirroring the
 * live engine's 50 ms cadence (PluginNodes.apply smoothing turns steps
 * into glides). Sampling stops after the last point — curves hold their
 * final value — so cost is bounded by the automated region, not the song.
 */
function applyInsertAutomation(
  nodes: { apply(params: Readonly<Record<string, number>>, when: number): void },
  state: ProjectState,
  instance: PluginInstance,
  anchorTicks: number
): void {
  const byParam = new Map<string, AutomationPoint[]>()
  for (const point of Object.values(state.automation)) {
    if (point.instanceId !== instance.id) continue
    const list = byParam.get(point.param)
    if (list) list.push(point)
    else byParam.set(point.param, [point])
  }
  if (byParam.size === 0) return
  const tps = ticksPerSecond(state.tempo)
  let lastTicks = anchorTicks
  for (const list of byParam.values()) {
    list.sort((a, b) => a.ticks - b.ticks)
    lastTicks = Math.max(lastTicks, list[list.length - 1].ticks)
  }
  const defs = paramDefsOf(instance.descriptor)
  const stepTicks = tps * 0.05
  for (let ticks = anchorTicks; ticks <= lastTicks + stepTicks; ticks += stepTicks) {
    const merged: Record<string, number> = { ...instance.params }
    for (const [param, points] of byParam) {
      const v = automationValueAt(points, ticks)
      const def = defs?.[param]
      merged[param] = def ? denormalizeParam(def, v) : v
    }
    nodes.apply(merged, (ticks - anchorTicks) / tps)
  }
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

/**
 * Schedule clip sources (with fades) and synth notes into per-track inputs.
 *
 * `fromTicks`/`atSec`/`untilTicks` describe a WINDOW of the timeline, so
 * the same code renders a whole track (0, 0, ∞) and a two-second slice for
 * live preview. Sources are stateless, which is why a window can be
 * rendered independently and still be sample-exact.
 */
function scheduleSources(
  ctx: BaseAudioContext,
  state: ProjectState,
  assets: AssetSourceLike,
  inputs: Map<TrackId, AudioNode>,
  fromTicks = 0,
  atSec = 0,
  untilTicks?: number
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
      applyClipFades(gain.gain, clip, state.tempo, fromTicks, atSec)
      fadeGains.set(clipId, gain)
    }
    return gain
  }

  const makeBuffer = (channels: readonly Float32Array[], sampleRate: number): AudioBuffer => {
    const b = ctx.createBuffer(channels.length, channels[0].length, sampleRate)
    channels.forEach((data, ch) => b.copyToChannel(data as Float32Array<ArrayBuffer>, ch))
    return b
  }
  const mirror = (data: Float32Array): Float32Array => {
    const out = new Float32Array(data.length)
    for (let i = 0, j = data.length - 1; i < data.length; i++, j--) out[i] = data[j]
    return out
  }
  for (const s of scheduleClips(
    state,
    (id) => assets.getSeconds(id),
    fromTicks,
    atSec,
    untilTicks
  )) {
    const plain = assets.get(s.assetId)?.buffer
    let buffer: AudioBuffer | null
    if (s.warpFactor !== 1) {
      // Warped clips read the pre-stretched copy (pre-warmed by the async
      // entry points); reversal mirrors the WARPED material, as live.
      const channels = assets.warpedChannels?.(s.assetId, s.warpFactor) ?? null
      buffer =
        channels && plain
          ? makeBuffer(s.reverse ? channels.map(mirror) : channels, plain.sampleRate)
          : null
    } else if (s.reverse) {
      // Reversed clips read the mirrored copy, exactly as in live playback.
      buffer = assets.reversedBuffer?.(s.assetId, makeBuffer) ?? null
    } else {
      buffer = plain ?? null
    }
    const dest = destinationFor(s.clipId, s.trackId)
    if (!buffer || !dest) continue
    const source = ctx.createBufferSource()
    source.buffer = buffer
    if (s.rate !== 1) source.playbackRate.value = s.rate
    source.connect(dest)
    source.start(s.when, s.offsetSec, s.durationSec)
  }
  for (const s of scheduleNotes(state, fromTicks, atSec, untilTicks)) {
    const dest = destinationFor(s.clipId, s.trackId)
    if (!dest) continue
    const track = state.tracks[s.trackId]
    buildInstrumentVoice(ctx, dest, s, track?.synth ?? {}, samplerSampleFor(assets, track))
  }
}

/** Offline mixdown to encoded 16-bit WAV bytes. */
export async function renderMixdown(
  state: ProjectState,
  assets: AssetSourceLike,
  sampleRate = RENDER_SAMPLE_RATE
): Promise<Uint8Array | null> {
  const mixed = await renderMixdownChannels(state, assets, sampleRate)
  return mixed ? encodeWavPcm16(mixed.channels, mixed.sampleRate) : null
}

/** Offline mixdown to raw per-channel samples (for non-WAV encoders). */
export async function renderMixdownChannels(
  state: ProjectState,
  assets: AssetSourceLike,
  sampleRate = RENDER_SAMPLE_RATE
): Promise<{ channels: Float32Array[]; sampleRate: number } | null> {
  const endTicks = projectEndTicks(state)
  if (endTicks <= 0) return null
  const tps = ticksPerSecond(state.tempo)
  const lengthSec = endTicks / tps + TAIL_SEC
  const ctx = new OfflineAudioContext(2, Math.ceil(lengthSec * sampleRate), sampleRate)

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

  await prewarmWarpedClips(state, assets)
  scheduleSources(ctx, state, assets, inputs)

  const rendered = await ctx.startRendering()
  const channels: Float32Array[] = []
  for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
    channels.push(rendered.getChannelData(ch))
  }
  return { channels, sampleRate: rendered.sampleRate }
}

/**
 * The state a one-track render actually renders: `trackId` soloed and
 * nothing muted, so its folder buses (and, for folders, descendants)
 * apply exactly as heard. Exported so callers evaluating that render
 * (e.g. the export bypass warning) reason over the identical state.
 */
export function soloTrackState(state: ProjectState, trackId: TrackId): ProjectState {
  const tracks = Object.fromEntries(
    Object.entries(state.tracks).map(([id, track]) => [
      id,
      { ...track, soloed: id === trackId, muted: false }
    ])
  )
  return { ...state, tracks }
}

/**
 * One track's contribution to the master, rendered offline: the mixdown
 * of the project with the track SOLOED (and nothing muted), so its folder
 * buses, automation and the master volume all apply exactly as heard.
 * Null for an empty project or an unknown track.
 */
export function renderTrackChannels(
  state: ProjectState,
  trackId: TrackId,
  assets: AssetSourceLike,
  sampleRate = RENDER_SAMPLE_RATE
): Promise<{ channels: Float32Array[]; sampleRate: number } | null> {
  if (!state.tracks[trackId]) return Promise.resolve(null)
  return renderMixdownChannels(soloTrackState(state, trackId), assets, sampleRate)
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
  assets: AssetSourceLike,
  external?: ExternalPluginHost,
  sampleRate = RENDER_SAMPLE_RATE
): Promise<AudioBuffer | null> {
  const endTicks = clipsOfTrack(state, trackId).reduce(
    (max, c) => Math.max(max, c.start + c.duration),
    0
  )
  if (endTicks <= 0) return null
  const tps = ticksPerSecond(state.tempo)
  const lengthSec = endTicks / tps + TAIL_SEC
  const frames = Math.ceil(lengthSec * sampleRate)

  const externalInserts = external
    ? pluginsOfTrack(state, trackId).filter(
        (i) => i.enabled && !pluginRegistry.resolve(i.descriptor) && external.has(i.descriptor)
      )
    : []

  await prewarmWarpedClips(state, assets)

  // Fast path: nothing needs the out-of-process host, so the whole chain
  // is one Web Audio pass exactly as before. Graph-routed tracks take it
  // too — segmenting assumes a LINEAR chain, so their external inserts
  // pass through in the graph (same audible result as live playback).
  if (externalInserts.length === 0 || routesOfTrack(state, trackId).length > 0) {
    const ctx = new OfflineAudioContext(2, frames, sampleRate)
    const input = ctx.createGain()
    const auto = ctx.createGain()
    buildInserts(ctx, state, trackId, input).connect(auto)
    auto.connect(ctx.destination)
    applyVolumeAutomation(auto, state, trackId, tps)
    const inputs = new Map<TrackId, AudioNode>([[trackId, input]])
    scheduleSources(ctx, state, assets, inputs)
    return ctx.startRendering()
  }

  // External inserts cannot run in the renderer's audio graph, so the
  // chain is rendered in SEGMENTS: consecutive runs of same-kind inserts,
  // in rank order. Order is what must be preserved — an EQ before a
  // saturator does not sound like a saturator before an EQ.
  const sourcesCtx = new OfflineAudioContext(2, frames, sampleRate)
  const input = sourcesCtx.createGain()
  input.connect(sourcesCtx.destination)
  scheduleSources(sourcesCtx, state, assets, new Map([[trackId, input]]))
  let buffer = await sourcesCtx.startRendering()

  for (const segment of segmentInserts(state, trackId, external!)) {
    buffer = segment.external
      ? await processExternalSegment(buffer, segment.instances, external!)
      : await renderInsertSegment(buffer, segment.instances)
  }

  // Volume automation sits after the inserts, so it lands in its own
  // final pass rather than being folded into an arbitrary segment.
  return applyAutomationPass(buffer, state, trackId, tps)
}

/**
 * Leading audio rendered before a live-preview window and then discarded,
 * so time-based builtin effects (delay, reverb, compressor envelopes) have
 * warmed up by the time the kept region starts. Web Audio nodes cannot
 * carry state between OfflineAudioContexts the way a held VST3 instance
 * can, so this is how a window boundary avoids an audible discontinuity.
 */
export const PREVIEW_PREROLL_SEC = 0.5

/**
 * Can this track be previewed live?
 *
 * Only when every locally-resolvable insert comes BEFORE every external
 * one. Live preview renders the leading builtins offline and hands the
 * result to held VST3 instances; a builtin sitting AFTER an external would
 * have to be rendered per-window too, and would lose its tail at every
 * boundary. Rather than sound subtly wrong, such a track simply is not
 * previewed — freezing still renders it exactly.
 *
 * The common case passes: adding a plugin appends it at the end of the
 * chain, so VST3s naturally land last.
 */
export function canLivePreview(
  state: ProjectState,
  trackId: TrackId,
  external: ExternalPluginHost
): boolean {
  // Look-ahead preview windows a LINEAR chain; a routing graph has no
  // single "before the externals" cut, so graph tracks play dry live
  // (externals short through) and freeze for the exact sound.
  if (routesOfTrack(state, trackId).length > 0) return false
  let seenExternal = false
  let anyExternal = false
  for (const instance of pluginsOfTrack(state, trackId)) {
    if (!instance.enabled) continue
    const local = pluginRegistry.resolve(instance.descriptor) !== null
    const isExternal = !local && external.has(instance.descriptor)
    if (isExternal) {
      seenExternal = true
      anyExternal = true
    } else if (local && seenExternal) {
      return false // a builtin after an external: cannot window it cleanly
    }
  }
  return anyExternal
}

/**
 * Render ONE window of a track's sources plus its locally-resolvable
 * inserts, ready to hand to held external instances. Includes
 * PREVIEW_PREROLL_SEC of warm-up ahead of `fromTicks`, which is trimmed
 * off before returning, so the caller gets exactly the window it asked
 * for. Returns null if the window is empty.
 */
export async function renderPreviewWindow(
  state: ProjectState,
  trackId: TrackId,
  assets: AssetSourceLike,
  fromTicks: number,
  untilTicks: number,
  sampleRate = RENDER_SAMPLE_RATE
): Promise<AudioBuffer | null> {
  const tps = ticksPerSecond(state.tempo)
  const windowSec = (untilTicks - fromTicks) / tps
  if (windowSec <= 0) return null

  const preRollTicks = Math.min(fromTicks, Math.ceil(PREVIEW_PREROLL_SEC * tps))
  const preRollSec = preRollTicks / tps
  const totalFrames = Math.ceil((preRollSec + windowSec) * sampleRate)
  const ctx = new OfflineAudioContext(2, totalFrames, sampleRate)

  await prewarmWarpedClips(state, assets)
  const input = ctx.createGain()
  // Only the LOCAL inserts here; externals are applied afterwards by held
  // instances, which is the whole reason their state survives windows.
  buildInserts(ctx, state, trackId, input, fromTicks - preRollTicks).connect(ctx.destination)
  scheduleSources(
    ctx,
    state,
    assets,
    new Map([[trackId, input]]),
    fromTicks - preRollTicks,
    0,
    untilTicks
  )

  const rendered = await ctx.startRendering()
  const skip = Math.round(preRollSec * sampleRate)
  if (skip <= 0) return rendered

  const frames = rendered.length - skip
  if (frames <= 0) return null
  const trimmed = new OfflineAudioContext(
    rendered.numberOfChannels,
    frames,
    rendered.sampleRate
  ).createBuffer(rendered.numberOfChannels, frames, rendered.sampleRate)
  for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
    trimmed.getChannelData(ch).set(rendered.getChannelData(ch).subarray(skip))
  }
  return trimmed
}

/** One run of consecutive inserts that can be processed the same way. */
export interface InsertSegment {
  external: boolean
  instances: PluginInstance[]
}

/**
 * Split a track's enabled inserts into consecutive same-kind runs, in rank
 * order. Inserts that resolve locally are Web Audio; ones the native host
 * has are external; anything neither can run is dropped (bypassed), which
 * is the same thing live playback does.
 */
export function segmentInserts(
  state: ProjectState,
  trackId: TrackId,
  external: ExternalPluginHost
): InsertSegment[] {
  const segments: InsertSegment[] = []
  for (const instance of pluginsOfTrack(state, trackId)) {
    if (!instance.enabled) continue
    const local = pluginRegistry.resolve(instance.descriptor) !== null
    const isExternal = !local && external.has(instance.descriptor)
    if (!local && !isExternal) continue // missing on this client: bypass
    const last = segments[segments.length - 1]
    if (last && last.external === isExternal) last.instances.push(instance)
    else segments.push({ external: isExternal, instances: [instance] })
  }
  return segments
}

function bufferChannels(buffer: AudioBuffer): Float32Array[] {
  const channels: Float32Array[] = []
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) channels.push(buffer.getChannelData(ch))
  return channels
}

/** Run a buffer through external plugins in order, out of process. */
async function processExternalSegment(
  buffer: AudioBuffer,
  instances: PluginInstance[],
  external: ExternalPluginHost
): Promise<AudioBuffer> {
  let channels = bufferChannels(buffer)
  for (const instance of instances) {
    const processed = await external.process(instance, channels, buffer.sampleRate)
    // A failed plugin bypasses rather than aborting the freeze, matching
    // how a missing plugin behaves everywhere else.
    if (processed && processed.length > 0) channels = processed
  }
  const out = new OfflineAudioContext(
    channels.length,
    buffer.length,
    buffer.sampleRate
  ).createBuffer(channels.length, buffer.length, buffer.sampleRate)
  for (let ch = 0; ch < channels.length; ch++) {
    out.getChannelData(ch).set(channels[ch].subarray(0, buffer.length))
  }
  return out
}

/** Replay a buffer through a run of locally-resolvable inserts. */
async function renderInsertSegment(
  buffer: AudioBuffer,
  instances: PluginInstance[]
): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, buffer.length, buffer.sampleRate)
  const rb = new WebAudioBackend({ contextFactory: () => ctx as unknown as AudioContext })
  const escapes = rb.webAudio
  const source = ctx.createBufferSource()
  source.buffer = buffer
  let prev: AudioNode = source
  for (const instance of instances) {
    const resolved = pluginRegistry.resolve(instance.descriptor)
    if (!resolved) continue
    const nodes = resolved.provider.create(rb)
    if (!nodes) continue
    nodes.apply(instance.params, 0)
    prev.connect(escapes.nodeOf(nodes.input))
    prev = escapes.nodeOf(nodes.output)
  }
  prev.connect(ctx.destination)
  source.start(0)
  return ctx.startRendering()
}

async function applyAutomationPass(
  buffer: AudioBuffer,
  state: ProjectState,
  trackId: TrackId,
  tps: number
): Promise<AudioBuffer> {
  if (automationOf(state, trackId, 'volume').length === 0) return buffer
  const ctx = new OfflineAudioContext(2, buffer.length, buffer.sampleRate)
  const source = ctx.createBufferSource()
  source.buffer = buffer
  const auto = ctx.createGain()
  source.connect(auto)
  auto.connect(ctx.destination)
  applyVolumeAutomation(auto, state, trackId, tps)
  source.start(0)
  return ctx.startRendering()
}
