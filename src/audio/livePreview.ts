import type { ProjectState, TrackId } from '@core/model/types'
import { pluginsOfTrack } from '@core/model/types'
import { pluginRegistry } from './pluginRegistry'
import { ticksPerSecond } from './scheduling'
import {
  canLivePreview,
  renderPreviewWindow,
  RENDER_SAMPLE_RATE,
  type ExternalInstance,
  type ExternalPluginHost
} from './render'

/**
 * Hearing VST3 inserts during ordinary playback.
 *
 * External plugins cannot join the renderer's audio graph (the renderer is
 * sandboxed and shared memory does not cross an Electron process
 * boundary), so their audio is produced AHEAD of the playhead instead:
 * each window of a track's sources is rendered offline, pushed through
 * plugins held open in the host process, and handed back for the engine to
 * schedule. Latency is one window; there is no live input monitoring.
 *
 * This class owns rendering and plugin lifetime only — the engine owns the
 * audio graph and decides when each returned buffer plays.
 */

interface AssetSourceLike {
  get(id: string): { buffer: AudioBuffer | null } | undefined
  getSeconds(id: string): number | null
  reversedBuffer?(
    id: string,
    create: (channels: Float32Array[], sampleRate: number) => AudioBuffer
  ): AudioBuffer | null
}

interface HeldInstance {
  instanceId: string
  live: ExternalInstance
}

export class LivePreview {
  /** Held plugins per track, in chain order. Closed on teardown. */
  private instances = new Map<TrackId, HeldInstance[]>()
  /** Inserts already reported as failing, so the log isn't per-window spam. */
  private reportedFailures = new Set<string>()
  /**
   * The rate everything previewed runs at, set at open(): plugins are
   * opened at it AND windows are rendered at it, so the two always agree.
   * The engine passes its live context rate — windows then play 1:1.
   */
  private sampleRate = RENDER_SAMPLE_RATE

  constructor(
    private store: { state: ProjectState },
    private assets: AssetSourceLike,
    private host: ExternalPluginHost
  ) {}

  /** Tracks whose VST3 inserts can be previewed as things stand. */
  eligibleTracks(): TrackId[] {
    const state = this.store.state
    return Object.keys(state.tracks).filter(
      (trackId) =>
        !state.tracks[trackId].frozenAssetId && // a frozen track already plays its render
        canLivePreview(state, trackId, this.host)
    )
  }

  /**
   * Hold open one plugin per external insert on this track. Idempotent, so
   * a re-render after a knob turn reuses the same instances and keeps
   * their tails continuous rather than reloading the plugin.
   */
  async open(trackId: TrackId, sampleRate: number): Promise<boolean> {
    this.sampleRate = sampleRate
    if (this.instances.has(trackId)) return true
    if (!this.host.open) return false
    const state = this.store.state
    const opened: HeldInstance[] = []
    for (const instance of pluginsOfTrack(state, trackId)) {
      if (!instance.enabled) continue
      if (pluginRegistry.resolve(instance.descriptor)) continue // a builtin: baked in
      if (!this.host.has(instance.descriptor)) continue // missing: bypassed
      const live = await this.host.open(instance, sampleRate, 2)
      if (!live) {
        // One plugin refusing to load must not silence the whole chain:
        // bypass IT (like a missing plugin) and keep the rest audible.
        console.warn(
          `VST3 "${instance.descriptor.name}" failed to open — this insert is bypassed during playback`
        )
        continue
      }
      opened.push({ instanceId: instance.id, live })
    }
    if (opened.length === 0) return false
    this.instances.set(trackId, opened)
    return true
  }

  /**
   * One window of finished audio for a track: sources plus builtins
   * rendered offline, then through each held plugin in chain order.
   * Null when there is nothing to play or a plugin failed.
   */
  async renderWindow(
    trackId: TrackId,
    fromTicks: number,
    untilTicks: number
  ): Promise<AudioBuffer | null> {
    const held = this.instances.get(trackId)
    if (!held || held.length === 0) return null

    // Plugin-delay compensation, done by feeding the plugins the future.
    //
    // A plugin that reports L samples of latency answers a window with the
    // response to material L earlier, which would put the whole previewed
    // track L late. Reading the DRY window L ahead cancels it exactly: the
    // plugin's output for [from + L, until + L) is the response to
    // [from, until), which is the window we wanted. The plugin's input
    // stream stays continuous because every window is shifted by the same
    // amount, so tails and delay lines carry across boundaries as before.
    //
    // The shift rounds to whole ticks, so it can be out by up to half a
    // tick (~0.3 ms at 120 bpm) — constant across windows, and far below
    // what the 2-second preview window itself costs. The native backend,
    // which runs these plugins in its own callback, compensates in samples
    // instead (src/audio/pdc.ts).
    const shiftTicks = Math.round(
      this.chainLatencySec(held) * ticksPerSecond(this.store.state.tempo)
    )
    const dry = await renderPreviewWindow(
      this.store.state,
      trackId,
      this.assets,
      fromTicks + shiftTicks,
      untilTicks + shiftTicks,
      this.sampleRate
    )
    if (!dry) return null

    let channels: Float32Array[] = []
    for (let ch = 0; ch < dry.numberOfChannels; ch++) channels.push(dry.getChannelData(ch))
    // Stereo in, stereo out: a mono render still feeds both sides so the
    // plugin sees the layout it negotiated.
    if (channels.length === 1) channels = [channels[0], channels[0]]

    // Params are read fresh each window (looked up by instance id, so a
    // skipped or since-removed insert can't shift them onto a neighbor);
    // a knob turn takes effect from the next window rather than needing
    // the plugin reopened.
    for (const { instanceId, live } of held) {
      const current = this.store.state.plugins[instanceId]
      if (!current || !current.enabled) continue // removed/bypassed mid-hold
      const processed = await live.process(channels, current.params)
      // A failed plugin bypasses rather than silencing the track, matching
      // every other place an insert cannot run.
      if (processed && processed.length > 0) {
        channels = processed
      } else if (!this.reportedFailures.has(instanceId)) {
        this.reportedFailures.add(instanceId)
        console.warn(
          `VST3 "${current.descriptor.name}" failed to process — this insert is bypassed during playback`
        )
      }
    }

    const out = new OfflineAudioContext(
      channels.length,
      dry.length,
      dry.sampleRate
    ).createBuffer(channels.length, dry.length, dry.sampleRate)
    for (let ch = 0; ch < channels.length; ch++) {
      out.getChannelData(ch).set(channels[ch].subarray(0, dry.length))
    }
    return out
  }

  /**
   * Total delay this track's held plugins report, in seconds. They run in
   * series, so their latencies add.
   */
  private chainLatencySec(held: readonly HeldInstance[]): number {
    let samples = 0
    for (const { live } of held) samples += Math.max(0, live.latencySamples)
    return samples / this.sampleRate
  }

  isOpen(trackId: TrackId): boolean {
    return this.instances.has(trackId)
  }

  /** Release every held plugin. A leaked handle keeps the plugin loaded. */
  closeAll(): void {
    for (const held of this.instances.values()) {
      for (const { live } of held) live.close()
    }
    this.instances.clear()
  }
}
