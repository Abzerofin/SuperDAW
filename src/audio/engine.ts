import type { Clip, ClipId, PluginInstance, PluginInstanceId, ProjectState, Route, Track, TrackId } from '@core/model/types'
import {
  automationValueAt,
  isNoteTrackKind,
  isTrackAudible,
  isTrackSelfOrDescendant,
  MASTER_BUS_ID,
  pluginsOfTrack,
  routesOfTrack
} from '@core/model/types'
import type { AutomationPoint } from '@core/model/types'
import { ticksPerBar, ticksPerBeat } from '@core/model/timebase'
import { denormalizeParam, synthIsAudible } from '@core/model/effects'
import { paramDefsOf } from '@core/plugins/builtin'
import type { AssetEvent, AssetStore } from './assets'
import {
  WebAudioBackend,
  type BackendNodeId,
  type DeviceInfo,
  type IAudioBackend,
  type InputHandle,
  type InputOpenConfig,
  type ParamEvent,
  type TapId,
  type VoiceId
} from './backend'
import { externalInsertProvider } from './externalInsert'
import { clipFadeEvents } from './fades'
import { buildInstrumentVoice, buildLiveInstrumentVoice, type InstrumentSample } from './instruments'
import { LivePreview } from './livePreview'
import { assetOnsetSeconds } from './loopMeta'
import { computePdc, pdcDelaysOf } from './pdc'
import {
  pluginRegistry,
  type PluginAnalysis,
  type PluginNodes,
  type PluginProvider
} from './pluginRegistry'
import type { ExternalPluginHost } from './render'
import type { LiveVoiceHandle } from './synth'
import {
  beatIndexAt,
  metronomeClicks,
  padClipRepeatState,
  scheduleClips,
  scheduleNotes,
  ticksPerSecond,
  trackLoopRepeatState,
  trackLoopSpan,
  type ScheduleWindow
} from './scheduling'

/**
 * The audio engine: owns the AudioContext and all routing.
 *
 *   clip sources ─▶ autoGain ─▶ fader ─▶ panner ─▶ master ─▶ analyser ─▶ out
 *                  (automation)  (volume ×        (masterVolume)
 *                                 mute/solo)
 *
 * Deliberately independent of React and of the collaboration layer: it
 * consumes the project store, transport, and asset store through the
 * narrow structural interfaces below. Mixer changes are gain-level (not
 * schedule-level), so they are seamless mid-playback; volume automation
 * is compiled to Web Audio linear ramps on the autoGain node, so curves
 * are sample-accurate regardless of UI frame rate.
 *
 * Scheduling strategy: playback is WINDOWED — a pass queues only sources
 * starting inside a ~4 s lookahead horizon, and a timer extends the
 * horizon in slices (see ScheduleWindow). A source starting inside the
 * window plays to its natural end, so nothing is ever split across a
 * horizon seam; the song's size stops mattering to play/seek cost. Edits
 * tear down and re-queue only the tracks they touch. The cycle region
 * keeps its own machinery: whole iterations are queued pass-by-pass at
 * their exact wrap times. The metronome uses a small lookahead loop since
 * it is unbounded. AudioWorklet DSP comes later with per-strip metering
 * needs; native nodes are the right tool for clip playback.
 */

interface StoreLike {
  readonly state: ProjectState
  subscribe(listener: () => void): () => void
}

interface TransportLike {
  readonly isPlaying: boolean
  positionTicks(): number
  onEvent(listener: (event: 'play' | 'stop' | 'seek') => void): () => void
  setTimeSource(source: { now(): number }): void
  /** Told the live output-path latency so the drawn playhead can lag to match. */
  setOutputLatency(seconds: number): void
  /** The cycle region when looping is on, else null. */
  activeLoop(): { start: number; end: number } | null
}

const METRO_LOOKAHEAD_SEC = 0.15
const METRO_INTERVAL_MS = 40
const GAIN_SMOOTHING_SEC = 0.015
/**
 * How far ahead audio is queued — the linear lookahead window, loop
 * iterations and track-loop repeats all share this horizon — and how often
 * it is topped up.
 */
const SCHEDULE_LOOKAHEAD_SEC = 4
const SCHEDULE_INTERVAL_MS = 250
/**
 * Insert-effect parameter automation is applied by sampling the curves on
 * this cadence and pushing values through PluginNodes.apply (whose 20 ms
 * smoothing turns the steps into inaudible glides). Time-driven rather
 * than pre-scheduled: builtin nodes expose no per-param AudioParam handles
 * to ramp, and sampling live state makes mid-play edits just work.
 */
const FX_AUTO_INTERVAL_MS = 50

/**
 * Held live-input voices across all tracks before the oldest is stolen.
 * Each voice is 4 nodes; 32 is far beyond ten fingers + sustained chords,
 * yet keeps a stuck controller from flooding the graph.
 */
const LIVE_VOICE_CAP = 32

/**
 * How long a ONE-SHOT trigger lets a never-ending instrument ring before
 * releasing it for you. A one-shot (a non-gated pad) has no note-off
 * coming, so a sustaining voice — the analog synth, a looping sampler —
 * would otherwise sound forever. Long enough to read as "let it ring",
 * short enough that a mis-set pad is not a stuck note.
 */
const ONE_SHOT_HOLD_SEC = 2

/**
 * One held live voice. `autoOff` is the one-shot safety timer (see
 * ONE_SHOT_HOLD_SEC); it must be cleared with the voice or a later,
 * unrelated note on the same pitch would be cut short by it.
 */
interface LiveVoiceEntry {
  readonly handle: LiveVoiceHandle
  readonly seq: number
  autoOff: ReturnType<typeof setTimeout> | null
}

/** Deregister a live voice, cancelling its one-shot timer. */
function dropLiveVoice(voices: Map<number, LiveVoiceEntry>, key: number): void {
  const entry = voices.get(key)
  if (entry && entry.autoOff !== null) clearTimeout(entry.autoOff)
  voices.delete(key)
}

/**
 * Ceiling on plugin-delay compensation. Well past any real plugin (a
 * linear-phase mastering EQ reports ~8 k samples, 0.17 s at 48 kHz) and
 * short enough that a plugin misreporting its latency cannot silently
 * push the whole mix seconds behind the playhead.
 */
const PDC_MAX_SEC = 0.5

/** Seconds of finished VST3 audio produced per window. Also the latency. */
const PREVIEW_WINDOW_SEC = 2
/** How far ahead of the playhead preview audio is kept queued. */
const PREVIEW_LOOKAHEAD_SEC = 4
const PREVIEW_INTERVAL_MS = 250

interface AutomationIndex {
  /** Track volume curves (points without an instanceId), sorted by ticks. */
  readonly volumeByTrack: Map<TrackId, AutomationPoint[]>
  /** Track pan curves, sorted by ticks. */
  readonly panByTrack: Map<TrackId, AutomationPoint[]>
  /** Insert-parameter curves per instance and param, sorted by ticks. */
  readonly byInstance: Map<PluginInstanceId, Map<string, AutomationPoint[]>>
}

const NO_POINTS: AutomationPoint[] = []

/** True when two versions of a clip schedule identical audio — only cosmetic
 *  fields (name, color) differ between them. */
function clipAudiblySame(a: Clip, b: Clip): boolean {
  return (
    a.trackId === b.trackId &&
    a.start === b.start &&
    a.duration === b.duration &&
    a.assetId === b.assetId &&
    a.offset === b.offset &&
    a.reverse === b.reverse &&
    a.pitch === b.pitch &&
    a.stretch === b.stretch &&
    a.loopLength === b.loopLength &&
    a.fadeIn === b.fadeIn &&
    a.fadeOut === b.fadeOut &&
    // Take state decides whether the clip sounds at all — switching the
    // active take mid-playback must re-queue the track.
    (a.takeGroupId ?? null) === (b.takeGroupId ?? null) &&
    (a.takeActive === true) === (b.takeActive === true)
  )
}

interface TrackChain {
  /**
   * Where sources and synth voices connect — a PDC compensator feeding
   * `input`. It delays only the track's OWN material: children arrive at
   * `input` directly and carry their own compensation (src/audio/pdc.ts).
   * Zero delay is an exact passthrough on both backends, which is what it
   * is for every project with no latent plugin in it.
   */
  source: BackendNodeId
  /** Head of the insert chain; also the folder bus children feed. */
  input: BackendNodeId
  auto: BackendNodeId
  fader: BackendNodeId
  panner: BackendNodeId
  /** PDC on the finished signal, between `panner` and the bus. */
  out: BackendNodeId
  /** Side-tap off the panner for the track's level meter (never in the path). */
  tap: TapId
  meterBuf: Float32Array
  /** Folder bus this chain's output feeds (null = master). Folders ARE buses. */
  parentId: TrackId | null
  /** Seconds of capacity the two compensators have been given so far. */
  pdcCapacitySec: number
  /** Last delay written to each, so an unchanged plan writes nothing. */
  pdcSourceSec: number
  pdcOutSec: number
}

/** Master-meter tap length (frequency resolution is irrelevant to a peak). */
const MASTER_TAP_FRAMES = 2048
/** Track-meter tap length — a 4× cheaper scan than the old 1024. */
const TRACK_TAP_FRAMES = 256
/**
 * Loudness-tap ring length: ~85 ms at 48 kHz, comfortably more than one
 * display frame even at 30 fps, so consecutive reads of new-samples-only
 * (readMasterLoudness) never miss audio under normal painting cadence.
 */
const LOUDNESS_TAP_FRAMES = 4096
/**
 * Master spectrum tap FFT length: ~11.7 Hz bins at 48 kHz, enough low-end
 * detail for a log 20 Hz–20 kHz analyzer without smearing the picture.
 */
const SPECTRUM_TAP_FFT = 4096

/**
 * One meter poll's worth of numbers, filled in place (see trackMeter).
 * `peak` is the largest absolute sample in the tap window and may exceed
 * 1 on an over; `rms` is the window's root-mean-square (always ≤ peak).
 */
export interface MeterReading {
  peak: number
  rms: number
}

/** Peak and RMS of a tap window in one pass — no allocation, no clamp. */
function scanMeter(buf: Float32Array, out: MeterReading): void {
  let peak = 0
  let sum = 0
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i]
    const a = v < 0 ? -v : v
    if (a > peak) peak = a
    sum += v * v
  }
  out.peak = peak
  out.rms = buf.length > 0 ? Math.sqrt(sum / buf.length) : 0
}

export class AudioEngine {
  /**
   * The seam (docs/NATIVE_AUDIO_BACKEND.md §3): every node, voice, param
   * ramp and tap goes through this. `backend.webAudio` is the documented
   * phase-0 escape hatch — the builtin effect builders, instrument voices,
   * monitor nodes and decode still speak Web Audio until their phases port
   * them; each use below is deliberate and grep-able.
   */
  private backend: IAudioBackend | null = null
  private masterTap: TapId | null = null
  private meterBuf: Float32Array | null = null
  /**
   * Where every root track, folder bus and pad one-shot actually lands:
   * the head of the MASTER insert chain (inserts whose trackId is
   * MASTER_BUS_ID), which feeds masterNode (the masterVolume fader). With
   * no master inserts it is a bare pass-through, so the graph is exactly
   * what it was before master effects existed.
   */
  private masterBusInput: BackendNodeId | null = null
  /**
   * Per-channel master tap feeding the live LUFS readout. BS.1770 sums
   * each channel's energy, and the seam's tap (an AnalyserNode) downmixes
   * to mono — which would read ~3 LU low on correlated stereo — so this
   * rides the webAudio escape's UI-facing analyser surface (like the wire
   * oscilloscopes): a splitter into one analyser per channel, built
   * lazily on first read, forgotten with the backend. On backends without
   * the escape the readout simply hides (readMasterLoudness → null).
   */
  private loudnessTap: {
    split: ChannelSplitterNode
    analysers: AnalyserNode[]
    bufs: Float32Array[]
    /** Context time of the previous read — the new-samples cursor. */
    lastSec: number
  } | null = null
  /**
   * Master spectrum tap feeding the transport bar's analyzer popover: one
   * AnalyserNode on the same node the master meter taps (post master
   * inserts, post masterVolume), riding the webAudio escape's UI-facing
   * analyser surface like the loudness tap above. Built lazily on first
   * ask, forgotten with the backend; null on backends without the escape,
   * so the popover shows a note instead of a dead canvas.
   */
  private spectrumTap: AnalyserNode | null = null
  private chains = new Map<TrackId, TrackChain>()
  private fxNodes = new Map<PluginInstanceId, PluginNodes>()
  /**
   * Live SIDECHAIN key edges: source track's panner → the insert's key
   * inlet, per instance (see syncSidechains). Tracked so a retargeted or
   * cleared key can sever exactly its old edge — everything else about
   * these edges dies naturally with the nodes on either end.
   */
  private keyEdges = new Map<PluginInstanceId, { sourceTrackId: TrackId; keyInput: BackendNodeId }>()
  /**
   * The stateBlob each EXTERNAL insert was opened with. A GUI-only
   * plugin's edits exist nowhere else, and a running instance cannot be
   * told about them, so a changed blob means reopening (liveNodesFor).
   * Builtins never appear here — their state is entirely in `params`.
   */
  private fxStateBlobs = new Map<PluginInstanceId, string | null>()
  /**
   * Per-instance inlet/outlet gains for GRAPH-routed tracks. Routing edges
   * connect outlets to inlets; a bypassed/missing plugin just shorts its
   * inlet to its outlet, so every graph shape degrades gracefully.
   */
  private graphPorts = new Map<PluginInstanceId, { inlet: BackendNodeId; outlet: BackendNodeId }>()
  /** Everything currently scheduled: clip voices AND adopted synth voices. */
  private sources = new Set<VoiceId>()
  /** The same voices indexed by track, so an edit can tear down ONE track. */
  private sourcesByTrack = new Map<TrackId, Set<VoiceId>>()
  /** Per-voice bookkeeping run when the backend reports the voice ended. */
  private voiceCleanups = new Map<VoiceId, () => void>()
  /** Per-clip fade envelope gains, with the clock time their pass ends
   *  (Infinity for open-ended passes) so loop iterations can be swept, and
   *  their track so scoped reschedules can tear them down. */
  private fadeNodes = new Map<BackendNodeId, { endSec: number; trackId: TrackId }>()
  /**
   * Live input monitors feeding track chains, by track. Only the backend
   * NODE is held: the input handle itself belongs to whoever opened it
   * (renderer/state/trackInputs), and the engine owns nothing but the
   * connection — see setMonitorInput.
   */
  private monitors = new Map<TrackId, BackendNodeId>()

  /**
   * Live (MIDI-played) synth voices, held-keys only, keyed by pitch.
   * Independent of the transport — playing along while stopped is the
   * point — so they are deliberately NOT in sources/sourcesByTrack and
   * survive stopAllSources. They die with their track (syncMixer's
   * removed-track pass) or when the track's synth is toggled off.
   */
  private liveVoices = new Map<TrackId, Map<number, LiveVoiceEntry>>()
  /** Monotonic voice age, so the cap steals the OLDEST voice. */
  private liveVoiceSeq = 0

  /**
   * Live VST3 preview. Tracks in `previewTracks` have their clips and
   * synth voices SUPPRESSED — their audio arrives instead as finished
   * windows produced out of process, injected post-inserts at `auto` (the
   * builtins are already baked into each window).
   */
  private preview: LivePreview | null = null
  /**
   * The out-of-process plugin host, kept beside the preview it feeds: on a
   * backend that can host external plugins IN its callback it becomes the
   * availability index for live inserts instead, and no preview runs.
   */
  private externalHost: ExternalPluginHost | null = null
  /** Total compensation the mix now carries (src/audio/pdc.ts). */
  private pdcTotalSec = 0
  /** Unsubscribe from the backend's plugin-latency reports. */
  private externalLatencyOff: (() => void) | null = null
  private previewTracks = new Set<TrackId>()
  /** Next window start, per track: timeline ticks and its clock time. */
  private previewNextTicks = new Map<TrackId, number>()
  private previewNextSec = new Map<TrackId, number>()
  private previewTimer: ReturnType<typeof setInterval> | null = null
  private previewFilling = false
  /** Bumped on teardown so an in-flight render cannot schedule stale audio. */
  private previewGeneration = 0

  private anchorTicks = 0
  private anchorSec = 0

  /** Desired output device; null = system default. Applied when the ctx exists. */
  private outputDeviceId: string | null = null

  private metroEnabled = false
  private metroListeners = new Set<() => void>()
  private metroTimer: ReturnType<typeof setInterval> | null = null
  /** Clock time the next un-queued loop iteration starts; null = not cycling. */
  private loopNextIterationSec: number | null = null
  /**
   * Linear playback's lookahead horizon: sources starting before this tick
   * have been queued, and the scheduler timer advances it. Null while
   * cycling (loop iterations own the lookahead there) or stopped.
   */
  private windowUntilTicks: number | null = null
  /** Tops up the lookahead: loop iterations while cycling, else the window. */
  private schedTimer: ReturnType<typeof setInterval> | null = null
  /**
   * Per-user track loops: each track in the set repeats its own material
   * indefinitely while every other track plays the timeline as written —
   * for auditioning a melody against the rest of the song. Ephemeral, never
   * part of the document. Replaced (not mutated) on change so React
   * subscribers can snapshot it.
   */
  private trackLoops: ReadonlySet<TrackId> = new Set()
  private trackLoopListeners = new Set<() => void>()
  private trackLoopTimer: ReturnType<typeof setInterval> | null = null
  /** Next un-queued ghost-repeat index per looping track. */
  private trackLoopNextRepeat = new Map<TrackId, number>()
  /** Samples insert-param automation while playing (see FX_AUTO_INTERVAL_MS). */
  private fxAutoTimer: ReturnType<typeof setInterval> | null = null
  private nextBeatIndex = 0
  /** The metronome's own anchor — re-based on each loop wrap. */
  private metroAnchorTicks = 0
  private metroAnchorSec = 0
  private lastMetroPosition = 0

  private prevTracks: ProjectState['tracks']
  private prevClips: ProjectState['clips']
  private prevTempo: number
  private prevAutomation: ProjectState['automation']
  private prevMasterVolume: number
  private prevNotes: ProjectState['notes']
  private prevPlugins: ProjectState['plugins']
  private prevRoutes: ProjectState['routes']

  /**
   * Automation grouped once per document change instead of re-scanning and
   * re-sorting the whole record per track per call: resetAutomation was
   * O(tracks × points) and the 20 Hz FX sampler rebuilt (and re-sorted!)
   * every group on every tick — millions of wasted visits per second at
   * scale, i.e. steady GC pressure exactly where buffer underruns hurt.
   */
  private automationIndexSource: ProjectState['automation'] | null = null
  private automationIndexCache: AutomationIndex = {
    volumeByTrack: new Map(),
    panByTrack: new Map(),
    byInstance: new Map()
  }

  private automationIndex(): AutomationIndex {
    const automation = this.store.state.automation
    if (this.automationIndexSource === automation) return this.automationIndexCache
    const volumeByTrack = new Map<TrackId, AutomationPoint[]>()
    const panByTrack = new Map<TrackId, AutomationPoint[]>()
    const byInstance = new Map<PluginInstanceId, Map<string, AutomationPoint[]>>()
    for (const point of Object.values(automation)) {
      if (point.instanceId !== undefined) {
        let params = byInstance.get(point.instanceId)
        if (!params) byInstance.set(point.instanceId, (params = new Map()))
        const list = params.get(point.param)
        if (list) list.push(point)
        else params.set(point.param, [point])
        continue
      }
      const map = point.param === 'volume' ? volumeByTrack : point.param === 'pan' ? panByTrack : null
      if (!map) continue
      const list = map.get(point.trackId)
      if (list) list.push(point)
      else map.set(point.trackId, [point])
    }
    const byTicks = (a: AutomationPoint, b: AutomationPoint): number => a.ticks - b.ticks
    for (const list of volumeByTrack.values()) list.sort(byTicks)
    for (const list of panByTrack.values()) list.sort(byTicks)
    for (const params of byInstance.values()) {
      for (const list of params.values()) list.sort(byTicks)
    }
    this.automationIndexSource = automation
    this.automationIndexCache = { volumeByTrack, panByTrack, byInstance }
    return this.automationIndexCache
  }

  constructor(
    private store: StoreLike,
    private transport: TransportLike,
    private assets: AssetStore
  ) {
    this.prevTracks = store.state.tracks
    this.prevClips = store.state.clips
    this.prevTempo = store.state.tempo
    this.prevAutomation = store.state.automation
    this.prevMasterVolume = store.state.masterVolume
    this.prevNotes = store.state.notes
    this.prevPlugins = store.state.plugins
    this.prevRoutes = store.state.routes
    store.subscribe(this.onStateChanged)
    assets.subscribe(this.onAssetsChanged)
    transport.onEvent(this.onTransportEvent)
    // A provider registering later (plugin installed mid-session) rewires
    // chains so placeholders come alive without any document change.
    pluginRegistry.subscribe(() => {
      if (this.backend) this.syncPlugins()
    })
  }

  /**
   * The latency request used when the context is created — the platform's
   * buffer-size knob. Injected (the renderer wires it to its preferences)
   * so the engine stays free of app-state imports. Read lazily at
   * `ensureContext` time; once the context exists the hint is fixed for
   * the session, so a changed preference applies at the next launch.
   */
  private latencyHintProvider: (() => AudioContextLatencyCategory | number) | null = null

  setLatencyHintProvider(provider: () => AudioContextLatencyCategory | number): void {
    this.latencyHintProvider = provider
  }

  /**
   * Test seam: the parity harness (audio/parity.ts) injects a patched
   * OfflineAudioContext so a whole engine pass renders deterministically
   * and pre/post-refactor output can be diffed. Never used by the app.
   */
  private contextFactory: (() => AudioContext) | null = null

  setContextFactory(factory: () => AudioContext): void {
    this.contextFactory = factory
  }

  /**
   * Test seam: unit tests inject a MockBackend to assert the engine's
   * command streams headless. The app always runs the default (Web Audio).
   */
  private backendFactory: (() => IAudioBackend) | null = null

  setBackendFactory(factory: () => IAudioBackend): void {
    this.backendFactory = factory
  }

  /**
   * Tear the whole backend-scoped world down — chains, inserts, voices,
   * taps, monitors, adopted buffers — and forget the backend, so the next
   * ensureBackend() rebuilds against whatever the CURRENT factory
   * returns. This is the native backend's crash fallback: main notices
   * the audio utilityProcess exit, the renderer resets the factory to Web
   * Audio and calls this, and playback machinery reconstructs itself on
   * the next use (a status-bar notice tells the user — never a popup).
   */
  resetBackend(factory: (() => IAudioBackend) | null): void {
    this.stopAllSources()
    this.teardownPreview()
    this.stopScheduler()
    this.stopMetronome()
    this.stopTrackLoopScheduler()
    this.stopFxAutomation()
    this.stopPadScheduler()
    this.liveAllNotesOff()
    this.externalLatencyOff?.()
    this.externalLatencyOff = null
    this.pdcTotalSec = 0
    for (const entry of this.fxNodes.values()) entry.dispose()
    this.fxNodes.clear()
    this.fxStateBlobs.clear()
    this.keyEdges.clear()
    this.graphPorts.clear()
    this.chains.clear()
    this.inputWaveTaps.clear()
    this.monitors.clear()
    this.padSampleVoices.clear()
    this.padClipLoops.clear()
    this.voiceCleanups.clear()
    this.adoptedBufferSource.clear()
    this.warpedKeysByAsset.clear()
    this.masterTap = null
    this.meterBuf = null
    this.loudnessTap = null
    this.spectrumTap = null
    this.masterBusInput = null
    this.backend = null
    this.backendFactory = factory
  }

  /** Start the backend (idempotent). Safe pre-gesture; starts suspended. */
  private ensureBackend(): IAudioBackend {
    if (this.backend) return this.backend
    const backend = this.backendFactory
      ? this.backendFactory()
      : new WebAudioBackend({
          latencyHint: () => this.latencyHintProvider?.() ?? 'interactive',
          contextFactory: this.contextFactory ?? undefined
        })
    this.backend = backend
    backend.start()
    // A plugin cannot report its latency until it has loaded, so the
    // answer arrives after the node does — and changes the whole
    // compensation plan when it does.
    this.externalLatencyOff =
      backend.externalPlugins?.onLatencyChange(() => this.recomputePdc()) ?? null
    backend.scheduleParam(backend.masterNode(), 'gain', [
      { kind: 'setValue', value: this.store.state.masterVolume, time: 0 }
    ])
    this.masterTap = backend.createTap(backend.masterNode(), MASTER_TAP_FRAMES)
    this.meterBuf = new Float32Array(MASTER_TAP_FRAMES)
    // The master insert chain's head must exist before any busFor() call;
    // syncPlugins below wires the actual inserts between it and masterNode.
    this.masterBusInput = backend.createNode('gain')
    backend.connect(this.masterBusInput, backend.masterNode())
    // One engine-wide end listener: each voice registered its own cleanup.
    backend.onVoiceEnded((id) => {
      const cleanup = this.voiceCleanups.get(id)
      if (cleanup) {
        this.voiceCleanups.delete(id)
        cleanup()
      }
    })
    this.registerClickBuffers(backend)
    // From here on the playhead runs on the audio clock — no drift between
    // what the user sees and what they hear.
    this.transport.setTimeSource({ now: () => backend.now() })
    this.transport.setOutputLatency(this.outputLatencySec())
    this.syncMixer()
    this.syncPlugins()
    void this.applyOutputDevice()
    return backend
  }

  /**
   * Start the backend and, on Web Audio, wait out the autoplay policy —
   * a suspended context delivers neither audio nor a running clock, and
   * every caller here is acting on a user gesture. No-op natively.
   */
  async ensureStarted(): Promise<void> {
    const backend = this.ensureBackend()
    const ctx = backend.webAudio?.ctx
    if (ctx && ctx.state === 'suspended') await ctx.resume()
  }

  /** Stream time in seconds — the clock takes and MIDI timestamps anchor to. */
  now(): number {
    return this.ensureBackend().now()
  }

  /** The live stream's sample rate. */
  sampleRate(): number {
    return this.ensureBackend().start().sampleRate
  }

  /**
   * The rate assets are DECODED at, which offline renders follow so
   * buffers are read 1:1 (§6's decode-once invariant). Equals the stream
   * rate under Web Audio; under the native backend decoding runs on a
   * standalone context whose rate is the system default, and the invariant
   * that matters — decode rate == render rate — is what this reports.
   */
  decodeSampleRate(): number {
    const backend = this.ensureBackend()
    if (backend.webAudio) return backend.webAudio.ctx.sampleRate
    return this.ensureDecodeCtx().sampleRate
  }

  /**
   * Wrap raw PCM as an AudioBuffer for the asset store. Assets stay
   * AudioBuffers in the renderer whatever the backend is (§3: the native
   * side receives decoded planar floats), so this shares decode()'s door.
   */
  createBuffer(channels: readonly Float32Array[], sampleRate: number): AudioBuffer {
    const backend = this.ensureBackend()
    const ctx = backend.webAudio?.ctx ?? this.ensureDecodeCtx()
    const buffer = ctx.createBuffer(
      Math.max(1, channels.length),
      Math.max(1, channels[0]?.length ?? 1),
      sampleRate
    )
    channels.forEach((data, ch) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, ch))
    return buffer
  }

  /**
   * The live backend — for the loopback calibration runner, the one caller
   * that drives the backend directly (it plays a stimulus post-fader and
   * correlates what comes back).
   */
  activeBackend(): IAudioBackend {
    return this.ensureBackend()
  }

  // ---------- Output device ----------

  /**
   * Route audio to a specific output device (null = system default) via
   * AudioContext.setSinkId — live, no restart. Remembered even before the
   * context exists. Resolves false where unsupported or the device is gone.
   */
  async setOutputDevice(deviceId: string | null): Promise<boolean> {
    this.outputDeviceId = deviceId
    return this.applyOutputDevice()
  }

  /** Info for the audio settings panel; null until the backend started. */
  contextInfo(): {
    sampleRate: number
    outputChannels: number
    baseLatencySec: number | null
    outputLatencySec: number | null
  } | null {
    if (!this.backend?.running()) return null
    const info = this.backend.start()
    // The split readout (graph buffering vs device path) is a Web Audio
    // detail the settings pane displays; other backends report one number.
    const ctx = this.backend.webAudio?.ctx as (AudioContext & { outputLatency?: number }) | null
    return {
      sampleRate: info.sampleRate,
      outputChannels: info.outputChannels,
      baseLatencySec: typeof ctx?.baseLatency === 'number' ? ctx.baseLatency : null,
      outputLatencySec: typeof ctx?.outputLatency === 'number' ? ctx.outputLatency : null
    }
  }

  /**
   * Seconds the heard output lags the stream clock. The drawn playhead
   * and recorded-take placement both correct by this.
   *
   * Plugin-delay compensation is part of it: a latent insert puts the
   * whole mix that much behind the clock, and the playhead has to lag with
   * it or it would run ahead of what is audible. Zero unless something in
   * the project actually reports latency.
   */
  outputLatencySec(): number {
    return (this.backend?.latencies().outputSec ?? 0) + this.pdcTotalSec
  }

  /** Seconds of plugin-delay compensation the mix currently carries. */
  pdcLatencySec(): number {
    return this.pdcTotalSec
  }

  /**
   * Seconds a captured frame lags the stream clock, where the backend can
   * say — null under Web Audio, whose capture stack reports nothing. It is
   * a floor, not the whole story: the loopback measurement (§7) covers the
   * converters and the cable on top of it.
   */
  inputLatencySec(): number | null {
    return this.backend?.latencies().inputSec ?? null
  }

  /** Devices the ACTIVE backend can open (§6) — the store reads this. */
  async enumerateDevices(): Promise<DeviceInfo[]> {
    return this.ensureBackend().enumerateDevices()
  }

  /** Hot-plug notification from the active backend. */
  onDeviceChange(listener: () => void): () => void {
    return this.ensureBackend().onDeviceChange(listener)
  }

  /** Which backend is live, so selections persist under the right key. */
  backendKind(): 'web' | 'native' {
    return this.ensureBackend().webAudio ? 'web' : 'native'
  }

  /**
   * Dropouts the audio device has reported (native only; null under Web
   * Audio, which exposes no such counter). The design's phase-4 health
   * signal: a rising count means the callback missed its deadline, and
   * seeing it BEFORE users report crackles is the whole point.
   */
  xruns(): number | null {
    const backend = this.backend as (IAudioBackend & { xruns?: number }) | null
    return typeof backend?.xruns === 'number' ? backend.xruns : null
  }

  private async applyOutputDevice(): Promise<boolean> {
    if (!this.backend) return this.outputDeviceId === null
    return this.backend.setOutputDevice(this.outputDeviceId)
  }

  /**
   * Route live input into a track so the performer hears themselves —
   * through the track's own inserts, fader and pan, exactly like playback.
   * Pass null to stop monitoring.
   *
   * Takes an INPUT HANDLE, not a node: a live `AudioNode` is the one
   * signature that cannot survive the process split (§3), so the caller
   * opens the input through the backend and hands the handle over. The
   * engine still connects `handle.node` itself — it owns the connection,
   * so a deleted track can never leave a monitor dangling — while the
   * handle's lifetime stays with whoever opened it.
   */
  setMonitorInput(trackId: TrackId, input: InputHandle | null): void {
    const backend = this.ensureBackend()
    const previous = this.monitors.get(trackId)
    if (previous !== undefined) {
      backend.disconnect(previous, this.chain(trackId).input)
      this.monitors.delete(trackId)
    }
    if (input) {
      backend.connect(input.node, this.chain(trackId).input)
      this.monitors.set(trackId, input.node)
    }
  }

  /**
   * Open a live input on the active backend (§7). Web Audio opens a
   * getUserMedia capture and taps the chosen channels; the native backend
   * upgrades its stream to duplex and selects channels in the callback.
   * Either way the caller gets a node to monitor with and a capture
   * subscription to record from — the same selection feeding both.
   */
  async openInput(config: InputOpenConfig): Promise<InputHandle> {
    const backend = this.ensureBackend()
    await this.ensureStarted()
    return backend.openInput(config)
  }

  isMonitoring(trackId: TrackId): boolean {
    return this.monitors.has(trackId)
  }

  // ---------- Live instrument (MIDI input → per-track synth) ----------

  /**
   * Start a live synth voice on a MIDI track — the note-on half of playing
   * the track's instrument from a MIDI keyboard, routed through the
   * track's own inserts, fader and pan exactly like scheduled playback.
   * Retriggering a held pitch releases the old voice politely; past
   * LIVE_VOICE_CAP the oldest held voice anywhere is stolen. Transport
   * state is irrelevant: auditioning while stopped is the normal case.
   *
   * `oneShot` marks a trigger with NO note-off coming (a non-gated pad).
   * Instruments that end by themselves ring out; one that would sustain
   * forever gets released after ONE_SHOT_HOLD_SEC, because nothing else
   * ever will.
   */
  liveNoteOn(
    trackId: TrackId,
    pitch: number,
    velocity: number,
    options: { oneShot?: boolean } = {}
  ): void {
    const track = this.store.state.tracks[trackId]
    // A frozen track's instrument is baked into its render; a removed or
    // bypassed synth is silent for scheduled notes and must be live too.
    if (!track || !isNoteTrackKind(track.kind) || track.frozenAssetId !== null) return
    if (!synthIsAudible(track.synth)) return
    const backend = this.ensureBackend()
    this.resumeOutput()

    const key = Math.min(127, Math.max(0, Math.round(pitch)))
    let voices = this.liveVoices.get(trackId)
    if (!voices) this.liveVoices.set(trackId, (voices = new Map()))
    const held = voices.get(key)
    if (held) {
      held.handle.release()
      dropLiveVoice(voices, key)
    }
    this.stealOldestLiveVoiceIfFull()

    const seq = ++this.liveVoiceSeq
    const handle = buildLiveInstrumentVoice(
      backend,
      this.chain(trackId).source,
      key,
      Math.min(1, Math.max(0, velocity)),
      track.synth,
      this.samplerSampleFor(track),
      () => {
        // Belt and braces: released/stolen voices are already deregistered.
        const current = this.liveVoices.get(trackId)
        if (current?.get(key)?.seq === seq) dropLiveVoice(current, key)
      }
    )
    const entry: LiveVoiceEntry = { handle, seq, autoOff: null }
    if (options.oneShot && handle.sustains) {
      entry.autoOff = setTimeout(() => {
        if (this.liveVoices.get(trackId)?.get(key)?.seq === seq) this.liveNoteOff(trackId, key)
      }, ONE_SHOT_HOLD_SEC * 1000)
    }
    voices.set(key, entry)
  }

  /** The note-off half: begin the release ramp of a held live voice. */
  liveNoteOff(trackId: TrackId, pitch: number): void {
    const voices = this.liveVoices.get(trackId)
    const key = Math.min(127, Math.max(0, Math.round(pitch)))
    const held = voices?.get(key)
    if (!voices || !held) return
    held.handle.release()
    dropLiveVoice(voices, key)
  }

  /**
   * Kill every held live voice (one track, or all) — hard, near-instant.
   * This is the panic button: whenever the path a held note took can no
   * longer deliver its note-off (a MIDI device unplugged, the window
   * losing focus, a track removed), the voices it opened end here.
   */
  liveAllNotesOff(trackId?: TrackId): void {
    const maps =
      trackId !== undefined
        ? ([this.liveVoices.get(trackId)].filter(Boolean) as Map<number, LiveVoiceEntry>[])
        : [...this.liveVoices.values()]
    for (const voices of maps) {
      for (const [key] of [...voices]) {
        voices.get(key)?.handle.stop()
        dropLiveVoice(voices, key)
      }
    }
    if (trackId !== undefined) this.liveVoices.delete(trackId)
    else this.liveVoices.clear()
  }

  private stealOldestLiveVoiceIfFull(): void {
    let total = 0
    let oldest: { voices: Map<number, LiveVoiceEntry>; key: number; seq: number } | null = null
    for (const voices of this.liveVoices.values()) {
      for (const [key, voice] of voices) {
        total++
        if (oldest === null || voice.seq < oldest.seq) oldest = { voices, key, seq: voice.seq }
      }
    }
    if (total < LIVE_VOICE_CAP || oldest === null) return
    oldest.voices.get(oldest.key)?.handle.stop()
    dropLiveVoice(oldest.voices, oldest.key)
  }

  // ---------- Performance pads ----------
  //
  // TRIGGERING pads is ephemeral per-user performance (like the playhead),
  // never document state. Sample pads fire straight into the master bus —
  // a pad is not tied to any track. Note pads go through liveNoteOn (the
  // MIDI-keyboard path). Clip pads queue bar-quantized repeats of one clip
  // through the ordinary schedule math over a derived state, exactly the
  // track-loop trick, so launches carry inserts, fades and routing.

  private padSampleVoices = new Map<string, { voice: VoiceId; gain: BackendNodeId }>()
  private padClipLoops = new Map<
    ClipId,
    { startTicks: number; nextRepeat: number; sources: Set<VoiceId> }
  >()
  private padTimer: ReturnType<typeof setInterval> | null = null
  private padListeners = new Set<() => void>()
  private padVersion = 0

  /** Fire a sample pad. Retriggering cuts the previous hit (natural pad feel). */
  playPadSample(padId: string, assetId: string): void {
    const backend = this.ensureBackend()
    this.resumeOutput()
    this.stopPadSample(padId, true)
    const bufferId = this.ensureBufferRegistered(assetId, false)
    if (!bufferId) return
    const gain = backend.createNode('gain')
    backend.scheduleParam(gain, 'gain', [{ kind: 'setValue', value: 0.9, time: 0 }])
    // Through the master bus, so pad one-shots run the master insert chain.
    backend.connect(gain, this.masterBusInput ?? backend.masterNode())
    const voice = backend.play({ bufferId, when: 0, destination: gain })
    if (voice === null) {
      backend.disposeNode(gain)
      return
    }
    this.voiceCleanups.set(voice, () => {
      backend.disposeNode(gain)
      if (this.padSampleVoices.get(padId)?.voice === voice) {
        this.padSampleVoices.delete(padId)
        this.emitPads()
      }
    })
    this.padSampleVoices.set(padId, { voice, gain })
    this.emitPads()
  }

  /** Release a gated sample pad (or cut it before a retrigger). */
  stopPadSample(padId: string, hard = false): void {
    const voice = this.padSampleVoices.get(padId)
    const backend = this.backend
    if (!voice || !backend) return
    const now = backend.now()
    backend.scheduleParam(voice.gain, 'gain', [
      { kind: 'setTarget', value: 0.0001, time: now, timeConstant: hard ? 0.005 : 0.02 }
    ])
    backend.stopVoice(voice.voice, now + 0.08)
    this.padSampleVoices.delete(padId)
    this.emitPads()
  }

  padSampleActive(padId: string): boolean {
    return this.padSampleVoices.has(padId)
  }

  /**
   * Launch a clip pad: the clip's material repeats every clip-length from
   * the NEXT BAR boundary until stopped — the launchpad gesture. Requires
   * a rolling transport (the caller starts it); inactive while the cycle
   * region runs, the same rule track loops follow.
   */
  launchClipLoop(clipId: ClipId): boolean {
    const state = this.store.state
    const clip = state.clips[clipId]
    if (!clip || clip.duration <= 0) return false
    if (this.padClipLoops.has(clipId)) return true
    if (!this.transport.isPlaying || this.transport.activeLoop()) return false
    this.ensureBackend()
    this.resumeOutput()
    const bar = ticksPerBar(state.timeSignature)
    const startTicks = Math.ceil(this.transport.positionTicks() / bar) * bar
    this.padClipLoops.set(clipId, { startTicks, nextRepeat: 0, sources: new Set() })
    this.startPadScheduler()
    this.topUpPadLoops()
    this.emitPads()
    return true
  }

  stopClipLoop(clipId: ClipId): void {
    const loop = this.padClipLoops.get(clipId)
    if (!loop) return
    this.padClipLoops.delete(clipId)
    const now = this.backend?.now() ?? 0
    for (const voice of [...loop.sources]) {
      this.backend?.stopVoice(voice, now + 0.02)
    }
    if (this.padClipLoops.size === 0) this.stopPadScheduler()
    this.emitPads()
  }

  stopAllClipLoops(): void {
    for (const clipId of [...this.padClipLoops.keys()]) this.stopClipLoop(clipId)
  }

  clipLoopActive(clipId: ClipId): boolean {
    return this.padClipLoops.has(clipId)
  }

  /** Pad activity (sample voices, clip loops) for the pad grid's lights. */
  subscribePads = (listener: () => void): (() => void) => {
    this.padListeners.add(listener)
    return () => this.padListeners.delete(listener)
  }

  padsVersion = (): number => this.padVersion

  private emitPads(): void {
    this.padVersion++
    for (const listener of this.padListeners) listener()
  }

  private startPadScheduler(): void {
    if (this.padTimer !== null) return
    this.padTimer = setInterval(() => {
      if (this.transport.isPlaying) this.topUpPadLoops()
    }, SCHEDULE_INTERVAL_MS)
  }

  private stopPadScheduler(): void {
    if (this.padTimer !== null) clearInterval(this.padTimer)
    this.padTimer = null
  }

  /** Queue upcoming repeats of each launched clip up to the lookahead. */
  private topUpPadLoops(): void {
    const backend = this.backend
    if (!backend || this.padClipLoops.size === 0 || this.transport.activeLoop()) return
    const state = this.store.state
    const tps = ticksPerSecond(state.tempo)
    const horizonTicks =
      this.anchorTicks + (backend.now() + SCHEDULE_LOOKAHEAD_SEC - this.anchorSec) * tps
    for (const [clipId, loop] of this.padClipLoops) {
      const clip = state.clips[clipId]
      const track = clip ? state.tracks[clip.trackId] : undefined
      // The clip or its track vanished (or froze) mid-set: the pad goes dark.
      if (!clip || !track || track.frozenAssetId !== null) {
        this.stopClipLoop(clipId)
        continue
      }
      const period = Math.max(1, clip.duration)
      let repeat = loop.nextRepeat
      let guard = 0
      while (loop.startTicks + repeat * period < horizonTicks && guard++ < 64) {
        const repeatState = padClipRepeatState(state, clipId, loop.startTicks + repeat * period)
        const fadeGains = new Map<string, BackendNodeId>()
        this.scheduleClipsPass(
          this.anchorTicks,
          this.anchorSec,
          Number.POSITIVE_INFINITY,
          fadeGains,
          repeatState,
          undefined,
          undefined,
          loop.sources
        )
        this.scheduleNotesPass(
          this.anchorTicks,
          this.anchorSec,
          Number.POSITIVE_INFINITY,
          fadeGains,
          repeatState,
          undefined,
          undefined,
          loop.sources
        )
        repeat++
      }
      loop.nextRepeat = repeat
    }
  }

  /** Live-preview a plugin knob while dragging (no op until release). */
  previewPluginParam(instanceId: PluginInstanceId, param: string, value: number): void {
    this.previewPluginParams(instanceId, { [param]: value })
  }

  /**
   * Live-preview several params at once — gestures like dragging an EQ
   * band point move freq and gain together (still no op until release).
   */
  previewPluginParams(
    instanceId: PluginInstanceId,
    partial: Readonly<Record<string, number>>
  ): void {
    const backend = this.backend
    const instance = this.store.state.plugins[instanceId]
    const entry = this.fxNodes.get(instanceId)
    if (backend && instance && entry) {
      entry.apply({ ...instance.params, ...partial }, backend.now())
    }
  }

  // ---------- Ephemeral previews (fader/knob drags before the op lands) ----------

  private smooth(node: BackendNodeId, param: 'gain' | 'pan', value: number): void {
    this.backend?.scheduleParam(node, param, [
      { kind: 'setTarget', value, time: this.backend.now(), timeConstant: GAIN_SMOOTHING_SEC }
    ])
  }

  previewTrackVolume(trackId: TrackId, volume: number): void {
    if (!this.backend) return
    this.smooth(this.chain(trackId).fader, 'gain', this.isAudible(trackId) ? volume : 0)
  }

  previewTrackPan(trackId: TrackId, pan: number): void {
    if (!this.backend) return
    this.smooth(this.chain(trackId).panner, 'pan', pan)
  }

  previewMasterVolume(volume: number): void {
    if (!this.backend) return
    this.smooth(this.backend.masterNode(), 'gain', volume)
  }

  /** Decode-only context for non-Web-Audio backends (never routed). */
  private decodeCtx: AudioContext | null = null

  private ensureDecodeCtx(): AudioContext {
    if (!this.decodeCtx) this.decodeCtx = new AudioContext()
    return this.decodeCtx
  }

  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    // Decode stays renderer-side Web Audio by design (§3: the native
    // backend receives decoded planar floats, never encoded bytes). Under
    // the native backend a standalone context does the decoding — it owns
    // no output and never joins any graph.
    const backend = this.ensureBackend()
    if (backend.webAudio) return backend.webAudio.ctx.decodeAudioData(data)
    return this.ensureDecodeCtx().decodeAudioData(data)
  }

  /** Autoplay policy: nudge a suspended Web Audio context (no-op natively). */
  private resumeOutput(): void {
    const ctx = this.backend?.webAudio?.ctx
    if (ctx && ctx.state === 'suspended') void ctx.resume()
  }

  /**
   * Register (adopt) an asset's decoded buffer — or its reversed mirror —
   * with the backend under a stable id. Adoption is zero-copy on the Web
   * Audio backend, so decoded memory stays bounded by assetMemory's
   * accounting; re-adoption after an eviction/re-decode is detected by
   * buffer identity.
   */
  private adoptedBufferSource = new Map<string, AudioBuffer>()

  /**
   * The eviction hook (called by the renderer's asset-memory policy right
   * beside AssetStore.evict): adopted backend buffers pin the decoded
   * memory the eviction is trying to free, so the two must release
   * together. Reversed mirrors follow the same keepReversed rule the
   * store's own cache applies.
   */
  /** Backend registrations of warped variants, per asset (for pruning). */
  private warpedKeysByAsset = new Map<string, Set<string>>()

  pruneAdoptedBuffers(
    evicted: ReadonlySet<string>,
    keepReversed: ReadonlySet<string>,
    keepWarped: ReadonlySet<string> = new Set()
  ): void {
    const backend = this.backend
    if (!backend) return
    for (const assetId of [...this.adoptedBufferSource.keys()]) {
      if (evicted.has(assetId)) {
        backend.releaseBuffer(assetId)
        backend.releaseBuffer(`${assetId}!r`)
        this.adoptedBufferSource.delete(assetId)
      } else if (!keepReversed.has(assetId)) {
        backend.releaseBuffer(`${assetId}!r`)
      }
    }
    for (const [assetId, keys] of [...this.warpedKeysByAsset]) {
      for (const key of [...keys]) {
        // Backend keys embed the same asset@factor identity the store's
        // warpCacheKeys carry; a key whose cache entry is being kept stays.
        const cacheKey = key.replace('!w', '@').replace(/!r$/, '')
        if (evicted.has(assetId) || !keepWarped.has(cacheKey)) {
          backend.releaseBuffer(key)
          keys.delete(key)
        }
      }
      if (keys.size === 0) this.warpedKeysByAsset.delete(assetId)
    }
  }

  private ensureBufferRegistered(
    assetId: string,
    reverse: boolean,
    warpFactor = 1
  ): string | null {
    const backend = this.ensureBackend()
    const asset = this.assets.get(assetId)
    if (!asset?.buffer) return null
    // Warped variants: registered (copied) from the store's stretched
    // channels; null = still computing, the clip stays silent and the
    // store's completion event re-queues it — transfer semantics.
    if (warpFactor !== 1) {
      const key = `${assetId}!w${warpFactor.toFixed(4)}${reverse ? '!r' : ''}`
      if (backend.hasBuffer(key)) return key
      const channels = this.assets.getWarpedChannels(assetId, warpFactor)
      if (!channels) return null
      const registered = reverse
        ? channels.map((data) => {
            const out = new Float32Array(data.length)
            for (let i = 0, j = data.length - 1; i < data.length; i++, j--) out[i] = data[j]
            return out
          })
        : channels
      backend.registerBuffer(key, registered, asset.buffer.sampleRate)
      let keys = this.warpedKeysByAsset.get(assetId)
      if (!keys) this.warpedKeysByAsset.set(assetId, (keys = new Set()))
      keys.add(key)
      return key
    }
    const key = reverse ? `${assetId}!r` : assetId
    if (backend.hasBuffer(key) && this.adoptedBufferSource.get(assetId) === asset.buffer) {
      return key
    }
    // Buffer changed identity (evicted + re-decoded): refresh both keys.
    if (this.adoptedBufferSource.get(assetId) !== asset.buffer) {
      backend.releaseBuffer(assetId)
      backend.releaseBuffer(`${assetId}!r`)
      this.adoptedBufferSource.set(assetId, asset.buffer)
    }
    const escapes = backend.webAudio
    if (!reverse) {
      if (escapes) escapes.adoptBuffer(key, asset.buffer)
      else {
        const channels: Float32Array[] = []
        for (let ch = 0; ch < asset.buffer.numberOfChannels; ch++) {
          channels.push(asset.buffer.getChannelData(ch))
        }
        backend.registerBuffer(key, channels, asset.buffer.sampleRate)
      }
      return key
    }
    if (escapes) {
      const mirrored = this.assets.reversedBuffer(assetId, (channels, sampleRate) => {
        const buffer = escapes.ctx.createBuffer(channels.length, channels[0].length, sampleRate)
        channels.forEach((data, ch) =>
          buffer.copyToChannel(data as Float32Array<ArrayBuffer>, ch)
        )
        return buffer
      })
      if (!mirrored) return null
      escapes.adoptBuffer(key, mirrored)
      return key
    }
    const flipped: Float32Array[] = []
    for (let ch = 0; ch < asset.buffer.numberOfChannels; ch++) {
      const source = asset.buffer.getChannelData(ch)
      const out = new Float32Array(source.length)
      for (let i = 0, j = source.length - 1; i < source.length; i++, j--) out[i] = source[j]
      flipped.push(out)
    }
    backend.registerBuffer(key, flipped, asset.buffer.sampleRate)
    return key
  }

  // ---------- Metronome ----------

  get metronomeEnabled(): boolean {
    return this.metroEnabled
  }

  setMetronome(enabled: boolean): void {
    if (this.metroEnabled === enabled) return
    this.metroEnabled = enabled
    if (enabled && this.transport.isPlaying) this.startMetronome()
    for (const listener of this.metroListeners) listener()
  }

  subscribeMetronome = (listener: () => void): (() => void) => {
    this.metroListeners.add(listener)
    return () => this.metroListeners.delete(listener)
  }

  // ---------- Metering ----------

  /**
   * Instantaneous peak level for one track, 0..1 (post fader and pan).
   * Zero when the engine is idle or the track has no chain yet — reading
   * it never creates one, so meters cost nothing on silent projects.
   */
  trackLevel(trackId: TrackId): number {
    const chain = this.chains.get(trackId)
    if (!chain || !this.backend) return 0
    if (!this.backend.readTap(chain.tap, chain.meterBuf)) return 0
    let peak = 0
    for (let i = 0; i < chain.meterBuf.length; i++) {
      const v = Math.abs(chain.meterBuf[i])
      if (v > peak) peak = v
    }
    return Math.min(1, peak)
  }

  /** Instantaneous master peak level, 0..1. Zero when the engine is idle. */
  meterLevel(): number {
    if (this.masterTap === null || !this.meterBuf || !this.backend) return 0
    if (!this.backend.readTap(this.masterTap, this.meterBuf)) return 0
    let peak = 0
    for (let i = 0; i < this.meterBuf.length; i++) {
      const v = Math.abs(this.meterBuf[i])
      if (v > peak) peak = v
    }
    return Math.min(1, peak)
  }

  /**
   * The master samples that arrived since the previous call, per channel
   * — the live LUFS readout's feed. Reading never creates the backend
   * (metering stays free on idle projects); null when there is no backend
   * yet or it cannot expose raw samples (native path), in which case the
   * readout hides rather than showing garbage. Single consumer: the
   * new-samples cursor is one context-time watermark, and the returned
   * arrays are views into internal buffers, valid until the next call.
   * Reads further apart than the tap ring (~85 ms) lose the overflow —
   * acceptable for a meter, never wrong-valued.
   */
  readMasterLoudness(): { channels: readonly Float32Array[]; sampleRate: number } | null {
    const backend = this.backend
    const escapes = backend?.webAudio
    if (!backend || !escapes) return null
    const ctx = escapes.ctx
    if (!this.loudnessTap) {
      const split = ctx.createChannelSplitter(2)
      escapes.nodeOf(backend.masterNode()).connect(split)
      const analysers = [0, 1].map((channel) => {
        const analyser = ctx.createAnalyser()
        analyser.fftSize = LOUDNESS_TAP_FRAMES
        split.connect(analyser, channel)
        return analyser
      })
      this.loudnessTap = {
        split,
        analysers,
        bufs: analysers.map(() => new Float32Array(LOUDNESS_TAP_FRAMES)),
        lastSec: ctx.currentTime
      }
    }
    const tap = this.loudnessTap
    const now = ctx.currentTime
    const frames = Math.min(
      LOUDNESS_TAP_FRAMES,
      Math.max(0, Math.round((now - tap.lastSec) * ctx.sampleRate))
    )
    tap.lastSec = now
    const channels = tap.analysers.map((analyser, i) => {
      analyser.getFloatTimeDomainData(tap.bufs[i] as Float32Array<ArrayBuffer>)
      // The analyser ring holds the LATEST window; the new samples are its tail.
      return tap.bufs[i].subarray(LOUDNESS_TAP_FRAMES - frames)
    })
    return { channels, sampleRate: ctx.sampleRate }
  }

  /**
   * The master-bus AnalyserNode behind the transport bar's spectrum
   * popover — post master inserts and masterVolume, the exact signal the
   * master meter shows. Lazily created on first ask and never polled by
   * the engine itself: the popover's own rAF loop reads it only while
   * open, so a closed analyzer costs nothing. Asking never creates the
   * backend; null when there is none yet or it cannot expose Web Audio
   * nodes (native path), in which case the popover explains itself
   * instead of drawing a dead canvas.
   */
  masterSpectrumAnalyser(): AnalyserNode | null {
    const backend = this.backend
    const escapes = backend?.webAudio
    if (!backend || !escapes) return null
    if (!this.spectrumTap) {
      const analyser = escapes.ctx.createAnalyser()
      analyser.fftSize = SPECTRUM_TAP_FFT
      // Smoothed enough to read as a curve, quick enough to track the mix.
      analyser.smoothingTimeConstant = 0.72
      escapes.nodeOf(backend.masterNode()).connect(analyser)
      this.spectrumTap = analyser
    }
    return this.spectrumTap
  }

  /**
   * Peak + RMS for one track's tap window, into a caller-owned reading so
   * a meter polling every frame allocates nothing. Both values come from
   * the SAME single pass over the same buffer trackLevel scans, and the
   * peak is deliberately UNCLAMPED: the mixer's clip indicators latch on
   * `peak > 1` (a true inter-window over of 0 dBFS), which a 0..1 clamp
   * would erase. Zeroes when the engine is idle or the track has no chain.
   */
  trackMeter(trackId: TrackId, out: MeterReading): void {
    const chain = this.chains.get(trackId)
    if (!chain || !this.backend || !this.backend.readTap(chain.tap, chain.meterBuf)) {
      out.peak = 0
      out.rms = 0
      return
    }
    scanMeter(chain.meterBuf, out)
  }

  /** Master-bus peak + RMS — same contract as trackMeter. */
  masterMeter(out: MeterReading): void {
    if (
      this.masterTap === null ||
      !this.meterBuf ||
      !this.backend ||
      !this.backend.readTap(this.masterTap, this.meterBuf)
    ) {
      out.peak = 0
      out.rms = 0
      return
    }
    scanMeter(this.meterBuf, out)
  }

  /**
   * Live analysis handle for a plugin instance (spectrum tap, gain
   * reduction…), or null while its nodes are not in the graph (context not
   * started, plugin bypassed, track frozen). Read-only; polled by the FX
   * cards' rAF loops, never through React state.
   */
  pluginAnalysis(instanceId: PluginInstanceId): PluginAnalysis | null {
    return this.fxNodes.get(instanceId)?.analysis ?? null
  }

  /**
   * Time-domain analyser for a routing-graph wire's SOURCE: an insert's
   * output rides its existing internal analyser tap; the 'in' terminal
   * gets a lazy tap on the track chain's input, keyed by the input node
   * id so a chain rebuild simply mints a fresh tap. Feeds the graph
   * view's wire oscilloscopes; costs nothing until the view asks.
   *
   * UI-facing AnalyserNode contract — a Web Audio escape until phase 2's
   * tap system replaces plugin/wire analysis app-wide.
   */
  private inputWaveTaps = new Map<BackendNodeId, AnalyserNode>()

  graphSourceAnalyser(trackId: TrackId, from: 'in' | PluginInstanceId): AnalyserNode | null {
    if (from !== 'in') return this.fxNodes.get(from)?.analysis?.spectrum ?? null
    const escapes = this.backend?.webAudio
    if (!escapes) return null
    const chain = this.chains.get(trackId)
    if (!chain) return null
    let tap = this.inputWaveTaps.get(chain.input)
    if (!tap) {
      tap = escapes.ctx.createAnalyser()
      tap.fftSize = 1024
      escapes.nodeOf(chain.input).connect(tap)
      this.inputWaveTaps.set(chain.input, tap)
    }
    return tap
  }

  // ---------- Transport / state reactions ----------

  private onTransportEvent = (event: 'play' | 'stop' | 'seek'): void => {
    // Launched clip loops are anchored to the roll they were launched in;
    // a stop ends the set and a seek invalidates their scheduled repeats.
    if (event === 'stop' || event === 'seek') this.stopAllClipLoops()
    if (event === 'stop') {
      this.stopAllSources()
      this.teardownPreview()
      this.stopMetronome()
      this.stopScheduler()
      this.stopTrackLoopScheduler()
      this.stopFxAutomation()
      return
    }
    if (event === 'seek' && !this.transport.isPlaying) return

    const backend = this.ensureBackend()
    const go = (): void => {
      // Refresh per play/seek: outputLatency changes with output devices.
      this.transport.setOutputLatency(this.outputLatencySec())
      void this.restart(() => {
        // The scheduler always runs while playing — it keeps the lookahead
        // (window or loop iterations) topped up. The other helpers run only
        // while their precondition holds; unconditional intervals were 50+
        // main-thread wakeups per second doing nothing on a plain play.
        this.startScheduler()
        if (this.metroEnabled) this.startMetronome()
        else this.stopMetronome()
        if (this.trackLoops.size > 0) this.startTrackLoopScheduler()
        else this.stopTrackLoopScheduler()
        if (this.automationIndex().byInstance.size > 0) this.startFxAutomation()
        else this.stopFxAutomation()
      })
    }
    const ctx = backend.webAudio?.ctx
    if (ctx && ctx.state === 'suspended') void ctx.resume().then(go)
    else go()
  }

  /**
   * Re-queue everything from the current position. Preview audio must be
   * rendered BEFORE the anchor is taken, because producing the first
   * window costs real time — the render is then started at an offset so
   * the previewed track stays in sync with everything else rather than
   * arriving late by however long it took.
   */
  private async restart(after: () => void): Promise<void> {
    this.stopAllSources()
    // Disarm the lookahead until scheduleAll re-establishes it: rendering
    // the first preview window below yields to the event loop, and a
    // scheduler tick landing in that gap would queue sources against stale
    // horizons — sources the teardown above can no longer reach.
    this.windowUntilTicks = null
    this.loopNextIterationSec = null
    this.teardownPreview()
    const generation = this.previewGeneration
    const first = await this.preparePreview()
    // Stopped or superseded while rendering: drop it on the floor.
    if (generation !== this.previewGeneration || !this.backend) return
    this.reanchor()
    // Clear automation BEFORE the passes arm it: cancelScheduledValues
    // would otherwise wipe what they just queued.
    this.resetAutomation()
    this.scheduleAll()
    after()
    this.emitFirstPreviewWindows(first)
    this.startPreviewScheduler()
  }

  // ---------- Live VST3 preview ----------

  /**
   * Supply the out-of-process plugin host. Injected so this module stays
   * free of Electron; without it (browser build) external inserts simply
   * stay silent until the track is frozen, as before.
   */
  setExternalHost(host: ExternalPluginHost | null): void {
    this.teardownPreview()
    this.externalHost = host
    this.preview = host ? new LivePreview(this.store, this.assets, host) : null
    // A backend that hosts external plugins live makes every preview node
    // stale; rewire so those inserts become real chain members.
    this.syncPlugins()
  }

  /**
   * Open the plugins and render each eligible track's FIRST window, before
   * an anchor exists. Returns the buffers with the tick they start at, so
   * the caller can offset them against the anchor it then takes.
   */
  private async preparePreview(): Promise<Map<TrackId, { buffer: AudioBuffer; fromTicks: number }>> {
    const out = new Map<TrackId, { buffer: AudioBuffer; fromTicks: number }>()
    const backend = this.backend
    this.previewTracks = new Set()
    if (!backend || !this.preview || !this.transport.isPlaying) return out
    // Two live behaviours, and only ever one at a time: where the backend
    // can host external plugins in its own callback they are ordinary
    // inserts, so the 2-second windowed preview must stand down entirely
    // or the same plugin would be applied twice.
    if (this.hostsExternalPluginsLive()) return out
    // Preview windows advance linearly and cannot wrap, so while the cycle
    // region is active previewed tracks would sail past the loop end.
    // They play dry instead (builtins live, VST3 bypassed) — as before
    // this feature existed.
    if (this.transport.activeLoop()) return out

    const generation = this.previewGeneration
    const tracks = this.preview.eligibleTracks()
    if (tracks.length === 0) return out

    const fromTicks = this.transport.positionTicks()
    const untilTicks =
      fromTicks + Math.ceil(PREVIEW_WINDOW_SEC * ticksPerSecond(this.store.state.tempo))

    const sampleRate = backend.start().sampleRate
    for (const trackId of tracks) {
      // Plugins open at the LIVE stream rate, and preview windows are
      // rendered at the same rate (LivePreview keeps the two agreeing) —
      // the plugin sees material at its negotiated rate and the returned
      // windows play 1:1, no resample at either end.
      if (!(await this.preview.open(trackId, sampleRate))) continue
      const buffer = await this.preview.renderWindow(trackId, fromTicks, untilTicks)
      if (generation !== this.previewGeneration) return new Map()
      if (!buffer) continue
      // Only now is the track's own audio suppressed — if rendering failed
      // it must keep playing dry rather than fall silent.
      this.previewTracks.add(trackId)
      this.previewNextTicks.set(trackId, untilTicks)
      out.set(trackId, { buffer, fromTicks })
    }
    return out
  }

  /** Start the prepared windows, skipping whatever elapsed while rendering. */
  private emitFirstPreviewWindows(
    first: Map<TrackId, { buffer: AudioBuffer; fromTicks: number }>
  ): void {
    const tps = ticksPerSecond(this.store.state.tempo)
    for (const [trackId, { buffer, fromTicks }] of first) {
      const skipSec = Math.max(0, (this.anchorTicks - fromTicks) / tps)
      if (skipSec >= buffer.duration) continue // window entirely in the past
      this.schedulePreviewBuffer(trackId, buffer, this.anchorSec, skipSec)
      this.previewNextSec.set(trackId, this.anchorSec + (buffer.duration - skipSec))
    }
  }

  /** Unique ids for transient preview-window buffers (released on end). */
  private previewBufferSeq = 0

  private schedulePreviewBuffer(
    trackId: TrackId,
    buffer: AudioBuffer,
    when: number,
    offsetSec = 0
  ): void {
    const backend = this.backend
    if (!backend) return
    const bufferId = `pv!${trackId}!${this.previewBufferSeq++}`
    if (backend.webAudio) backend.webAudio.adoptBuffer(bufferId, buffer)
    else {
      const channels: Float32Array[] = []
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) channels.push(buffer.getChannelData(ch))
      backend.registerBuffer(bufferId, channels, buffer.sampleRate)
    }
    // Injected AFTER the inserts: the builtins are already baked into the
    // window, while `auto` still applies live volume automation.
    const voice = backend.play({ bufferId, when, offsetSec, destination: this.chain(trackId).auto })
    if (voice === null) {
      backend.releaseBuffer(bufferId)
      return
    }
    const byTrack = this.trackSources(trackId)
    this.sources.add(voice)
    byTrack.add(voice)
    this.voiceCleanups.set(voice, () => {
      this.sources.delete(voice)
      byTrack.delete(voice)
      backend.releaseBuffer(bufferId)
    })
  }

  private startPreviewScheduler(): void {
    if (this.previewTimer !== null || this.previewTracks.size === 0) return
    this.previewTimer = setInterval(() => void this.topUpPreview(), PREVIEW_INTERVAL_MS)
  }

  /** Render and queue windows until the lookahead horizon is covered. */
  private async topUpPreview(): Promise<void> {
    const backend = this.backend
    if (!backend || !this.preview || !this.transport.isPlaying) return
    // A loop region appeared mid-play: preview cannot wrap, so restart —
    // preparePreview will then decline and the tracks fall back to dry.
    if (this.transport.activeLoop()) {
      void this.restart(() => this.resyncMetronome())
      return
    }
    // Renders are slow; never let two overlap for the same window.
    if (this.previewFilling) return
    this.previewFilling = true
    const generation = this.previewGeneration
    try {
      const tps = ticksPerSecond(this.store.state.tempo)
      const windowTicks = Math.ceil(PREVIEW_WINDOW_SEC * tps)
      for (const trackId of this.previewTracks) {
        let guard = 0
        while (
          (this.previewNextSec.get(trackId) ?? 0) < backend.now() + PREVIEW_LOOKAHEAD_SEC &&
          guard++ < 4
        ) {
          const fromTicks = this.previewNextTicks.get(trackId) ?? 0
          const buffer = await this.preview.renderWindow(
            trackId,
            fromTicks,
            fromTicks + windowTicks
          )
          if (generation !== this.previewGeneration || !this.backend) return
          if (!buffer) break // past the end of the material
          const when = this.previewNextSec.get(trackId) ?? backend.now()
          // Falling behind: drop the window rather than schedule the past.
          if (when > backend.now()) this.schedulePreviewBuffer(trackId, buffer, when)
          this.previewNextSec.set(trackId, when + buffer.duration)
          this.previewNextTicks.set(trackId, fromTicks + windowTicks)
        }
      }
    } finally {
      this.previewFilling = false
    }
  }

  private teardownPreview(): void {
    this.previewGeneration++
    if (this.previewTimer !== null) clearInterval(this.previewTimer)
    this.previewTimer = null
    this.previewFilling = false
    this.previewTracks.clear()
    this.previewNextTicks.clear()
    this.previewNextSec.clear()
    this.preview?.closeAll()
  }

  /**
   * Keeps the lookahead topped up while playing: whole loop iterations
   * while cycling, otherwise the linear window. Only the horizon extends
   * here — already-queued sources keep their exact start times, so a timer
   * running late can never dent timing. Both modes are checked every tick
   * because the active mode can flip mid-play (loop toggles re-emit seek;
   * song-loop appears when clips land), and each top-up no-ops unless its
   * mode's state is armed.
   */
  private startScheduler(): void {
    if (this.schedTimer !== null) return
    this.schedTimer = setInterval(() => {
      if (!this.transport.isPlaying) return
      // Cheap, and keeps the drawn playhead honest if the output path's
      // latency drifts mid-play (device hand-offs, bluetooth renegotiation).
      this.transport.setOutputLatency(this.outputLatencySec())
      if (this.transport.activeLoop()) {
        this.topUpLoopIterations()
        this.resyncMetronomeIfWrapped()
      } else {
        this.topUpWindow()
      }
    }, SCHEDULE_INTERVAL_MS)
  }

  private stopScheduler(): void {
    if (this.schedTimer !== null) clearInterval(this.schedTimer)
    this.schedTimer = null
    this.loopNextIterationSec = null
    this.windowUntilTicks = null
  }

  // ---------- Track loops ----------

  isTrackLooping(trackId: TrackId): boolean {
    return this.trackLoops.has(trackId)
  }

  subscribeTrackLoops = (listener: () => void): (() => void) => {
    this.trackLoopListeners.add(listener)
    return () => this.trackLoopListeners.delete(listener)
  }

  /**
   * Toggle a track's own loop. Frozen tracks are left alone (their render
   * plays as one source from tick 0 and cannot be re-anchored per repeat).
   */
  setTrackLoop(trackId: TrackId, on: boolean): void {
    if (this.trackLoops.has(trackId) === on) return
    if (on && this.store.state.tracks[trackId]?.frozenAssetId) return
    const next = new Set(this.trackLoops)
    if (on) next.add(trackId)
    else next.delete(trackId)
    this.trackLoops = next
    for (const listener of this.trackLoopListeners) listener()
    if (this.transport.isPlaying && this.backend) {
      void this.restart(() => {})
      this.startTrackLoopScheduler()
    }
  }

  private startTrackLoopScheduler(): void {
    if (this.trackLoopTimer !== null) return
    this.trackLoopTimer = setInterval(() => {
      if (!this.transport.isPlaying) return
      this.topUpTrackLoops()
    }, SCHEDULE_INTERVAL_MS)
  }

  private stopTrackLoopScheduler(): void {
    if (this.trackLoopTimer !== null) clearInterval(this.trackLoopTimer)
    this.trackLoopTimer = null
    this.trackLoopNextRepeat.clear()
  }

  // ---------- Insert-parameter automation ----------

  private startFxAutomation(): void {
    if (this.fxAutoTimer !== null) return
    this.fxAutoTimer = setInterval(() => this.applyFxAutomation(), FX_AUTO_INTERVAL_MS)
  }

  private stopFxAutomation(): void {
    if (this.fxAutoTimer === null) return // never ran — nothing to settle
    clearInterval(this.fxAutoTimer)
    this.fxAutoTimer = null
    // Settle every automated insert back onto its stored params, so a
    // stopped transport leaves the knobs meaning what they say.
    const backend = this.backend
    if (!backend) return
    const state = this.store.state
    for (const instanceId of this.automationIndex().byInstance.keys()) {
      const instance = state.plugins[instanceId]
      if (instance) this.fxNodes.get(instance.id)?.apply(instance.params, backend.now())
    }
  }

  /** Push each automated insert param's curve value into its live nodes. */
  private applyFxAutomation(): void {
    const backend = this.backend
    if (!backend || !this.transport.isPlaying) return
    const state = this.store.state
    // Groups are prebuilt (and pre-sorted) once per document change — this
    // runs 20× a second and must not rescan the automation record.
    const groups = this.automationIndex().byInstance
    if (groups.size === 0) return
    const nowTicks = this.transport.positionTicks()
    for (const [instanceId, params] of groups) {
      const instance = state.plugins[instanceId]
      if (!instance || !instance.enabled) continue
      if (state.tracks[instance.trackId]?.frozenAssetId) continue // baked
      const entry = this.fxNodes.get(instanceId)
      if (!entry) continue // missing/external plugin: nothing live to drive
      const defs = paramDefsOf(instance.descriptor)
      const merged: Record<string, number> = { ...instance.params }
      for (const [param, points] of params) {
        const v = automationValueAt(points, nowTicks)
        const def = defs?.[param]
        merged[param] = def ? denormalizeParam(def, v) : v
      }
      entry.apply(merged, backend.now())
    }
  }

  /**
   * Queue ghost repeats of each looping track until the lookahead horizon
   * is covered. Each repeat is the ordinary schedule math run over a
   * derived state holding only that track's clips shifted one period later
   * — see trackLoopRepeatState. Inactive while the cycle region runs (the
   * region already repeats everything inside it).
   */
  private topUpTrackLoops(): void {
    const backend = this.backend
    if (!backend || this.trackLoops.size === 0 || this.transport.activeLoop()) return
    const state = this.store.state
    const tps = ticksPerSecond(state.tempo)
    const horizonTicks =
      this.anchorTicks + (backend.now() + SCHEDULE_LOOKAHEAD_SEC - this.anchorSec) * tps
    for (const trackId of this.trackLoops) {
      const track = state.tracks[trackId]
      if (!track || track.frozenAssetId !== null) continue
      const span = trackLoopSpan(state, trackId)
      if (!span) continue
      const period = span.end - span.start
      // First repeat still audible at the anchor — repeats fully in the
      // past schedule nothing, so skip straight past them.
      const firstLive = Math.max(
        1,
        Math.floor((this.anchorTicks - span.end) / period) + 1
      )
      let repeat = Math.max(this.trackLoopNextRepeat.get(trackId) ?? 1, firstLive)
      let guard = 0
      while (span.start + repeat * period < horizonTicks && guard++ < 64) {
        const repeatState = trackLoopRepeatState(state, trackId, repeat * period)
        const fadeGains = new Map<string, BackendNodeId>()
        this.scheduleClipsPass(
          this.anchorTicks,
          this.anchorSec,
          Number.POSITIVE_INFINITY,
          fadeGains,
          repeatState
        )
        this.scheduleNotesPass(
          this.anchorTicks,
          this.anchorSec,
          Number.POSITIVE_INFINITY,
          fadeGains,
          repeatState
        )
        repeat++
      }
      this.trackLoopNextRepeat.set(trackId, repeat)
    }
  }

  /**
   * The metronome counts beats linearly from its anchor, which a wrap
   * invalidates — re-anchor it to the (wrapped) position when the playhead
   * jumps back. Clicks are only queued ~150 ms ahead, so the correction is
   * inaudible.
   */
  private resyncMetronomeIfWrapped(): void {
    const backend = this.backend
    if (!backend || !this.metroEnabled) return
    const position = this.transport.positionTicks()
    if (position >= this.lastMetroPosition) {
      this.lastMetroPosition = position
      return
    }
    this.lastMetroPosition = position
    this.metroAnchorTicks = position
    this.metroAnchorSec = backend.now()
    this.nextBeatIndex = beatIndexAt(this.store.state, position)
  }

  private onStateChanged = (): void => {
    const state = this.store.state
    // Synth param edits must reschedule that track's voices (envelopes bake
    // params in); freeze flips swap a track between live processing and its
    // render.
    const synthEdited = new Set<TrackId>()
    const frozenFlipped = new Set<TrackId>()
    if (state.tracks !== this.prevTracks) {
      for (const [id, track] of Object.entries(state.tracks)) {
        const prev = this.prevTracks[id]
        if (
          prev &&
          (prev.synth !== track.synth ||
            (prev.samplerAssetId ?? null) !== (track.samplerAssetId ?? null))
        ) {
          synthEdited.add(id)
          // Removing/bypassing the instrument silences live voices too —
          // a keyboard must never keep sounding through a synth that is off.
          if (!synthIsAudible(track.synth)) this.liveAllNotesOff(id)
        }
        if (prev && prev.frozenAssetId !== track.frozenAssetId) frozenFlipped.add(id)
      }
    }
    const frozenChanged = frozenFlipped.size > 0
    if (state.tracks !== this.prevTracks || state.masterVolume !== this.prevMasterVolume) {
      this.prevTracks = state.tracks
      this.prevMasterVolume = state.masterVolume
      if (this.backend) {
        this.syncMixer()
        // Freeze/unfreeze re-wires inserts (bypass vs live) — only on the
        // tracks that actually flipped.
        if (frozenChanged) this.syncPluginsFor(frozenFlipped)
      }
    }
    // External-plugin edits change what preview windows SOUND like, so
    // they are audible edits. Builtin edits are not: their nodes apply
    // params live with smoothing and must not interrupt playback.
    //
    // Rewires are scoped to the tracks whose chain TOPOLOGY changed
    // (add/remove/enable/rank/descriptor). A param-only change pushes the
    // values into the live nodes directly; graph positions and state blobs
    // never touch the audio graph. One knob on track 3 must not tear down
    // and rebuild track 97's chain — mid-playback that connect/disconnect
    // storm is an audible glitch factory.
    let externalPluginChanged = false
    if (state.plugins !== this.prevPlugins) {
      const prev = this.prevPlugins
      const rewire = new Set<TrackId>()
      let sidechainChanged = false
      const now = this.backend?.now() ?? 0
      for (const [id, instance] of Object.entries(state.plugins)) {
        const before = prev[id]
        if (before === instance) continue
        if (instance.descriptor.format !== 'builtin') externalPluginChanged = true
        if (!before) {
          rewire.add(instance.trackId)
          continue
        }
        if (
          before.trackId !== instance.trackId ||
          before.enabled !== instance.enabled ||
          before.rank !== instance.rank ||
          before.descriptor !== instance.descriptor
        ) {
          rewire.add(before.trackId)
          rewire.add(instance.trackId)
        } else {
          if (before.params !== instance.params && this.backend) {
            // Remote peer edits and committed ops land here; local drags
            // already previewed the same values through the same call.
            this.fxNodes.get(id)?.apply(instance.params, now)
          }
          // A retargeted key is an edge change, not a chain topology
          // change — one sweep re-establishes exactly the key edges.
          if ((before.sidechainTrackId ?? null) !== (instance.sidechainTrackId ?? null)) {
            sidechainChanged = true
          }
        }
      }
      for (const [id, instance] of Object.entries(prev)) {
        if (!state.plugins[id]) {
          if (instance.descriptor.format !== 'builtin') externalPluginChanged = true
          rewire.add(instance.trackId)
        }
      }
      this.prevPlugins = state.plugins
      if (this.backend) {
        this.syncPluginsFor(rewire)
        // Rewired tracks already swept their edges inside syncPluginsFor;
        // this covers the retarget-only case, which rewires nothing.
        if (sidechainChanged && rewire.size === 0) this.syncSidechains()
      }
    }
    // Routing-graph edits rewire chains; on a track previewed through
    // external plugins they also change what the windows sound like.
    let routesChanged = false
    if (state.routes !== this.prevRoutes) {
      routesChanged = true
      const rewire = new Set<TrackId>()
      for (const [id, route] of Object.entries(state.routes)) {
        if (this.prevRoutes[id] !== route) rewire.add(route.trackId)
      }
      for (const [id, route] of Object.entries(this.prevRoutes)) {
        if (!state.routes[id]) rewire.add(route.trackId)
      }
      this.prevRoutes = state.routes
      if (this.backend) this.syncPluginsFor(rewire)
    }
    const automationEdited = state.automation !== this.prevAutomation
    this.prevAutomation = state.automation
    if (automationEdited && this.transport.isPlaying && this.backend) {
      this.rearmAutomation()
      // The first insert-param point mid-play needs the sampler running.
      if (this.automationIndex().byInstance.size > 0) this.startFxAutomation()
    }
    // Scope the reschedule to the tracks the edit audibly touches. Some
    // changes have no per-track scope — tempo rescales the whole time
    // mapping, freeze flips rewire chains and re-neutralize automation, and
    // edits under a live preview change what the rendered windows sound
    // like — so those restart everything.
    const fullRestart =
      state.tempo !== this.prevTempo ||
      frozenChanged ||
      ((externalPluginChanged || routesChanged) && this.preview !== null)
    const affected = new Set<TrackId>(synthEdited)
    if (state.clips !== this.prevClips && !fullRestart) {
      for (const [id, clip] of Object.entries(state.clips)) {
        const before = this.prevClips[id]
        if (before === clip) continue
        // Renames and recolors must never interrupt their track's audio.
        if (before && clipAudiblySame(before, clip)) continue
        affected.add(clip.trackId)
        if (before && before.trackId !== clip.trackId) affected.add(before.trackId)
      }
      for (const [id, clip] of Object.entries(this.prevClips)) {
        if (!state.clips[id]) affected.add(clip.trackId)
      }
    }
    if (state.notes !== this.prevNotes && !fullRestart) {
      for (const [id, note] of Object.entries(state.notes)) {
        const before = this.prevNotes[id]
        if (before === note) continue
        const clip = state.clips[note.clipId] ?? this.prevClips[note.clipId]
        if (clip) affected.add(clip.trackId)
        if (before && before.clipId !== note.clipId) {
          const prevClip = state.clips[before.clipId] ?? this.prevClips[before.clipId]
          if (prevClip) affected.add(prevClip.trackId)
        }
      }
      for (const [id, note] of Object.entries(this.prevNotes)) {
        if (state.notes[id]) continue
        const clip = state.clips[note.clipId] ?? this.prevClips[note.clipId]
        if (clip) affected.add(clip.trackId)
      }
    }
    this.prevClips = state.clips
    this.prevTempo = state.tempo
    this.prevNotes = state.notes
    // Reschedule only what audibly changed; unrelated ops must never
    // interrupt playback, and one track's edit must never glitch another's
    // audio. Already-rendered preview windows bake the OLD state in, so
    // the preview paths restart() to re-render them.
    if (this.transport.isPlaying && this.backend) {
      // restart() resets and re-arms automation itself, so a freeze flip
      // (whose baked automation must go neutral) needs nothing extra here.
      if (fullRestart) this.queueRestart()
      else if (affected.size > 0) this.queueRestart(affected)
    }
  }

  private onAssetsChanged = (event?: AssetEvent): void => {
    if (!this.transport.isPlaying || !this.backend) return
    // Eventless notifications are peak fills and project-switch clears:
    // drawing data, and a path that always stops the transport first.
    // Neither affects what is scheduled.
    if (!event || event.asset.buffer === null) return
    // A newly landed asset may belong to already-scheduled silent clips (or
    // a frozen track awaiting its render) — re-queue just those tracks.
    const state = this.store.state
    const affected = new Set<TrackId>()
    for (const clip of Object.values(state.clips)) {
      if (clip.assetId === event.asset.id) affected.add(clip.trackId)
    }
    for (const track of Object.values(state.tracks)) {
      if (track.frozenAssetId === event.asset.id) affected.add(track.id)
      // A sampler whose sample just landed starts sounding its notes.
      if (track.samplerAssetId === event.asset.id) affected.add(track.id)
    }
    if (affected.size > 0) this.queueRestart(affected)
  }

  /**
   * Coalesce reschedules: importing a folder of files fires an asset
   * registration plus ops PER FILE, and every one of those used to tear
   * down and rebuild every scheduled source in the song. At most one
   * reschedule per ~120 ms keeps a burst to a handful, while a lone edit
   * still responds immediately. Scopes union across the burst; a single
   * unscoped caller (tempo, freeze…) widens the whole flush to a full
   * restart.
   */
  private restartPending = false
  private lastRestartAt = 0
  /** Tracks the pending flush covers; null = restart everything. */
  private pendingRestartTracks: Set<TrackId> | null = null
  private queueRestart(tracks: ReadonlySet<TrackId> | null = null): void {
    if (this.restartPending) {
      if (tracks === null) this.pendingRestartTracks = null
      else if (this.pendingRestartTracks !== null) {
        for (const id of tracks) this.pendingRestartTracks.add(id)
      }
      return
    }
    this.restartPending = true
    this.pendingRestartTracks = tracks === null ? null : new Set(tracks)
    const since = performance.now() - this.lastRestartAt
    const delay = Math.max(0, 120 - since)
    setTimeout(() => {
      this.restartPending = false
      this.lastRestartAt = performance.now()
      const scoped = this.pendingRestartTracks
      this.pendingRestartTracks = null
      if (this.transport.isPlaying && this.backend) {
        if (scoped === null) void this.restart(() => this.resyncMetronome())
        else this.rescheduleTracks(scoped)
      }
    }, delay)
  }

  // ---------- Internals ----------

  private reanchor(): void {
    if (!this.backend) return
    this.anchorSec = this.backend.now()
    this.anchorTicks = this.transport.positionTicks()
    // A restart tore down every scheduled source, launched pad repeats
    // included. Rewind each loop's counter to the repeat sounding at the
    // new anchor — the schedule math picks it up mid-material — so a
    // document edit mid-set never silences a running launch.
    for (const [clipId, loop] of this.padClipLoops) {
      loop.sources.clear()
      const clip = this.store.state.clips[clipId]
      const period = Math.max(1, clip?.duration ?? 1)
      loop.nextRepeat = Math.max(0, Math.floor((this.anchorTicks - loop.startTicks) / period))
    }
  }

  /**
   * Queue the audio for one pass: from `fromTicks` at clock time `atSec`,
   * up to `untilTicks`. Loop iterations are just repeated passes anchored
   * at their exact wrap times, which is what makes cycling sample-accurate
   * instead of dependent on a timer firing on time.
   */
  private schedulePass(
    fromTicks: number,
    atSec: number,
    untilTicks: number,
    window?: ScheduleWindow
  ): void {
    // Clips and synth voices share one fade envelope per clip, so a MIDI
    // clip tapers exactly like an audio one.
    const fadeGains = new Map<string, BackendNodeId>()
    this.scheduleClipsPass(fromTicks, atSec, untilTicks, fadeGains, undefined, window)
    this.scheduleNotesPass(fromTicks, atSec, untilTicks, fadeGains, undefined, window)
    // Automation rides along so each loop iteration replays it. Windowed
    // top-up slices skip it: the initial pass already armed the whole
    // curve (AudioParam events are cheap — it is sources that are not).
    if (window?.startFromTicks === undefined) {
      this.scheduleAutomationPass(fromTicks, atSec, untilTicks)
    }
  }

  /**
   * The pass windows currently inside the lookahead — the same set
   * scheduleAll would queue. Used to re-arm automation alone, without
   * restarting clip sources (an automation edit must not glitch playback).
   */
  private upcomingPasses(): Array<[fromTicks: number, atSec: number, untilTicks: number]> {
    const backend = this.backend
    if (!backend) return []
    const loop = this.transport.activeLoop()
    if (!loop) return [[this.anchorTicks, this.anchorSec, Number.POSITIVE_INFINITY]]
    const tps = ticksPerSecond(this.store.state.tempo)
    const spanSec = (loop.end - loop.start) / tps
    const passes: Array<[number, number, number]> = [
      [this.anchorTicks, this.anchorSec, loop.end]
    ]
    if (spanSec <= 0) return passes
    const horizon = backend.now() + SCHEDULE_LOOKAHEAD_SEC
    let at = this.anchorSec + (loop.end - this.anchorTicks) / tps
    let guard = 0
    while (at < horizon && guard++ < 64) {
      passes.push([loop.start, at, loop.end])
      at += spanSec
    }
    return passes
  }

  /**
   * Where a clip's audio should be routed: through its fade envelope when
   * it has one (created lazily per pass), otherwise straight into the
   * track chain.
   */
  private destinationFor(
    clipId: string,
    trackId: TrackId,
    fadeGains: Map<string, BackendNodeId>,
    fromTicks: number,
    atSec: number,
    untilTicks: number,
    state: ProjectState = this.store.state
  ): BackendNodeId {
    const backend = this.backend!
    // Sources land on the chain's PDC compensator, not its insert head:
    // children of a folder feed `input` directly and must not pick up the
    // folder's own source compensation (src/audio/pdc.ts).
    const chainInput = this.chain(trackId).source
    // Looked up in the pass's own state: a track-loop ghost repeat carries
    // shifted clip positions, so its fades land on the repeat, not the
    // original.
    const clip = state.clips[clipId]
    if (!clip || (clip.fadeIn <= 0 && clip.fadeOut <= 0)) return chainInput
    let gain = fadeGains.get(clipId)
    if (gain === undefined) {
      gain = backend.createNode('gain')
      backend.connect(gain, chainInput)
      // Fades are relative to THIS pass's anchor, so a clip inside a loop
      // region tapers identically on every iteration.
      backend.scheduleParam(gain, 'gain', clipFadeEvents(clip, state.tempo, fromTicks, atSec))
      fadeGains.set(clipId, gain)
      const endSec = Number.isFinite(untilTicks)
        ? atSec + (untilTicks - fromTicks) / ticksPerSecond(state.tempo)
        : Number.POSITIVE_INFINITY
      this.fadeNodes.set(gain, { endSec, trackId })
    }
    return gain
  }

  /**
   * Everything upcoming: the current pass, plus — when cycling — as many
   * whole iterations as fit in the lookahead window. Called on play/seek
   * and on audible edits.
   */
  private scheduleAll(): void {
    this.trackLoopNextRepeat.clear()
    const loop = this.transport.activeLoop()
    if (!loop) {
      this.loopNextIterationSec = null
      // Linear playback: queue only the lookahead window; the scheduler
      // timer extends it. Automation is armed for the whole song here.
      const backend = this.backend!
      const tps = ticksPerSecond(this.store.state.tempo)
      const horizon = Math.ceil(
        this.anchorTicks + (backend.now() + SCHEDULE_LOOKAHEAD_SEC - this.anchorSec) * tps
      )
      this.windowUntilTicks = horizon
      this.schedulePass(this.anchorTicks, this.anchorSec, Number.POSITIVE_INFINITY, {
        startBeforeTicks: horizon
      })
      this.topUpTrackLoops()
      // Launched pad loops re-queue immediately too — a restart mid-set
      // must not leave a scheduler-tick of silence in a running launch.
      this.topUpPadLoops()
      return
    }
    this.windowUntilTicks = null
    const tps = ticksPerSecond(this.store.state.tempo)
    // The playhead may still be running up to the region; that part plays
    // once, and the first wrap happens when it reaches the region's end.
    this.schedulePass(this.anchorTicks, this.anchorSec, loop.end)
    this.loopNextIterationSec = this.anchorSec + (loop.end - this.anchorTicks) / tps
    this.topUpLoopIterations()
  }

  /** Queue whole iterations until the lookahead window is covered. */
  private topUpLoopIterations(): void {
    const backend = this.backend
    const loop = this.transport.activeLoop()
    if (!backend || !loop || this.loopNextIterationSec === null) return
    this.purgeExpiredFades(backend.now())
    const tps = ticksPerSecond(this.store.state.tempo)
    const spanSec = (loop.end - loop.start) / tps
    if (spanSec <= 0) return
    const horizon = backend.now() + SCHEDULE_LOOKAHEAD_SEC
    let guard = 0
    while (this.loopNextIterationSec < horizon && guard++ < 64) {
      this.schedulePass(loop.start, this.loopNextIterationSec, loop.end)
      this.loopNextIterationSec += spanSec
    }
  }

  /**
   * Extend the linear lookahead window. Each extension is one pass over the
   * document (scheduleClips/scheduleNotes scan every clip and note), so the
   * horizon advances in half-window steps rather than per tick — a busy
   * project is scanned every ~2 s, not four times a second.
   */
  private topUpWindow(): void {
    const backend = this.backend
    if (!backend || this.windowUntilTicks === null) return
    this.purgeExpiredFades(backend.now())
    const tps = ticksPerSecond(this.store.state.tempo)
    const untilSec = this.anchorSec + (this.windowUntilTicks - this.anchorTicks) / tps
    if (untilSec - backend.now() > SCHEDULE_LOOKAHEAD_SEC / 2) return
    const horizon = Math.ceil(
      this.anchorTicks + (backend.now() + SCHEDULE_LOOKAHEAD_SEC - this.anchorSec) * tps
    )
    if (horizon <= this.windowUntilTicks) return
    // Anchored at the ORIGINAL play anchor: `when` math stays one linear
    // mapping for the whole play, and the slice bounds partition the
    // timeline exactly — every source starts in exactly one slice.
    this.schedulePass(this.anchorTicks, this.anchorSec, Number.POSITIVE_INFINITY, {
      startFromTicks: this.windowUntilTicks,
      startBeforeTicks: horizon
    })
    this.windowUntilTicks = horizon
  }

  private scheduleClipsPass(
    fromTicks: number,
    atSec: number,
    untilTicks: number,
    fadeGains: Map<string, BackendNodeId>,
    state: ProjectState = this.store.state,
    window?: ScheduleWindow,
    only?: ReadonlySet<TrackId>,
    /** Also registers created voices here — pad clip-loops stop via this. */
    collect?: Set<VoiceId>
  ): void {
    const backend = this.backend
    if (!backend) return
    const schedules = scheduleClips(
      state,
      (id) => this.assets.getSeconds(id),
      fromTicks,
      atSec,
      untilTicks,
      window
    )
    for (const s of schedules) {
      // Scoped reschedules re-queue just the edited tracks' sources.
      if (only !== undefined && !only.has(s.trackId)) continue
      // Previewed tracks: their finished audio (inserts included) arrives
      // as rendered windows — playing the dry clip too would double it.
      if (this.previewTracks.has(s.trackId)) continue
      const bufferId = this.ensureBufferRegistered(s.assetId, s.reverse, s.warpFactor)
      if (!bufferId) continue
      const dest = this.destinationFor(
        s.clipId,
        s.trackId,
        fadeGains,
        fromTicks,
        atSec,
        untilTicks,
        state
      )
      // Resampling: pitch and stretch both land in `rate` (see clipRate).
      const voice = backend.play({
        bufferId,
        when: s.when,
        offsetSec: s.offsetSec,
        durationSec: s.durationSec,
        rate: s.rate,
        destination: dest
      })
      if (voice === null) continue
      const byTrack = this.trackSources(s.trackId)
      this.sources.add(voice)
      byTrack.add(voice)
      collect?.add(voice)
      this.voiceCleanups.set(voice, () => {
        this.sources.delete(voice)
        byTrack.delete(voice)
        collect?.delete(voice)
      })
    }
  }

  /**
   * Schedule synth voices for upcoming MIDI notes. Each voice: two detuned
   * saws → lowpass → ADSR gain, into the track chain (so fader, automation,
   * pan, mute/solo all apply). Envelope times are absolute clock times, so
   * voices are sample-accurate like clip sources.
   */
  private scheduleNotesPass(
    fromTicks: number,
    atSec: number,
    untilTicks: number,
    fadeGains: Map<string, BackendNodeId>,
    state: ProjectState = this.store.state,
    window?: ScheduleWindow,
    only?: ReadonlySet<TrackId>,
    /** Also registers created voices here — pad clip-loops stop via this. */
    collect?: Set<VoiceId>
  ): void {
    const backend = this.backend
    // Instrument voices are Web-Audio-built until the phase-2 DSP ports;
    // adopted as backend voices so teardown and bookkeeping stay uniform.
    const escapes = backend?.webAudio
    if (!backend || !escapes) return
    for (const s of scheduleNotes(state, fromTicks, atSec, untilTicks, window)) {
      if (only !== undefined && !only.has(s.trackId)) continue
      // Previewed tracks get their audio as rendered windows (synth included).
      if (this.previewTracks.has(s.trackId)) continue
      // Voices go through the clip's fade envelope, so MIDI tapers too.
      const dest = this.destinationFor(
        s.clipId,
        s.trackId,
        fadeGains,
        fromTicks,
        atSec,
        untilTicks,
        state
      )
      const byTrack = this.trackSources(s.trackId)
      const track = state.tracks[s.trackId]
      const built = buildInstrumentVoice(
        backend,
        dest,
        s,
        track?.synth ?? {},
        this.samplerSampleFor(track)
      )
      // The instrument owns a small graph (oscillators → filter → env);
      // it is torn down once every voice it minted has ended.
      let remaining = built.voices.length
      for (const voice of built.voices) {
        this.sources.add(voice)
        byTrack.add(voice)
        collect?.add(voice)
        this.voiceCleanups.set(voice, () => {
          this.sources.delete(voice)
          byTrack.delete(voice)
          collect?.delete(voice)
          if (--remaining === 0) built.dispose()
        })
      }
    }
  }

  /**
   * What the track's sampler instrument plays: decoded buffer + slice
   * onsets. Null until the asset lands/decodes — the voice is then silent,
   * exactly like a clip whose asset is still transferring, and
   * onAssetsChanged re-queues the track the moment it arrives.
   */
  private samplerSampleFor(track: Track | undefined): InstrumentSample | null {
    const assetId = track?.samplerAssetId ?? null
    if (!assetId) return null
    const asset = this.assets.get(assetId)
    if (!asset?.buffer) return null
    // The sampler plays it through the seam like any other buffer, so it
    // is registered (adopted zero-copy on Web Audio) exactly as clips are.
    const bufferId = this.ensureBufferRegistered(assetId, false)
    if (!bufferId) return null
    return {
      bufferId,
      durationSec: asset.buffer.duration,
      // File cue markers (authorial slice map) when present, else detected
      // transients — the shared seam keeps index-based slices consistent.
      onsets: assetOnsetSeconds(asset)
    }
  }

  /**
   * Drop every scheduled automation event from now, and settle the tracks
   * that have no automation at all onto their static values. Tracks that
   * DO have points get their curve re-armed per pass — see
   * scheduleAutomationPass — so cycling repeats the automation instead of
   * running off the end of the region and holding.
   */
  private resetAutomation(): void {
    const backend = this.backend
    if (!backend) return
    const state = this.store.state
    const index = this.automationIndex()
    const now = backend.now()
    for (const trackId of Object.keys(state.tracks)) {
      const chain = this.chain(trackId)
      backend.scheduleParam(chain.auto, 'gain', [{ kind: 'cancel', afterTime: now }])
      backend.scheduleParam(chain.panner, 'pan', [{ kind: 'cancel', afterTime: now }])
      // Frozen tracks baked their volume automation into the render.
      const points = state.tracks[trackId]?.frozenAssetId
        ? NO_POINTS
        : (index.volumeByTrack.get(trackId) ?? NO_POINTS)
      if (points.length === 0) {
        backend.scheduleParam(chain.auto, 'gain', [{ kind: 'setValue', value: 1, time: now }])
      }
      // Pan automation owns the panner while points exist (0..1 → -1..1);
      // when the last point is deleted mid-playback the knob takes back over.
      if ((index.panByTrack.get(trackId) ?? NO_POINTS).length === 0) {
        backend.scheduleParam(chain.panner, 'pan', [
          { kind: 'setValue', value: state.tracks[trackId]?.pan ?? 0, time: now }
        ])
      }
    }
  }

  /**
   * Compile volume + pan automation to linear ramps for ONE pass, on the
   * same footing as clips and notes: times are relative to this pass's
   * anchor, so every loop iteration replays the region's automation. Each
   * pass re-enters at the region's own start value — a wrap is a jump, not
   * a ramp from wherever the previous iteration ended.
   */
  private scheduleAutomationPass(fromTicks: number, atSec: number, untilTicks: number): void {
    const backend = this.backend
    if (!backend) return
    const state = this.store.state
    const index = this.automationIndex()
    const tps = ticksPerSecond(state.tempo)
    const rampTime = (ticks: number): number => atSec + (ticks - fromTicks) / tps

    for (const trackId of Object.keys(state.tracks)) {
      const points = state.tracks[trackId]?.frozenAssetId
        ? NO_POINTS
        : (index.volumeByTrack.get(trackId) ?? NO_POINTS)
      const panPoints = index.panByTrack.get(trackId) ?? NO_POINTS
      if (points.length === 0 && panPoints.length === 0) continue
      const chain = this.chain(trackId)

      if (points.length > 0) {
        const events: ParamEvent[] = [
          { kind: 'setValue', value: automationValueAt(points, fromTicks), time: atSec }
        ]
        for (const point of points) {
          if (point.ticks <= fromTicks || point.ticks > untilTicks) continue
          events.push({ kind: 'linearRamp', value: point.value, endTime: rampTime(point.ticks) })
        }
        backend.scheduleParam(chain.auto, 'gain', events)
      }

      if (panPoints.length > 0) {
        const events: ParamEvent[] = [
          {
            kind: 'setValue',
            value: automationValueAt(panPoints, fromTicks) * 2 - 1,
            time: atSec
          }
        ]
        for (const point of panPoints) {
          if (point.ticks <= fromTicks || point.ticks > untilTicks) continue
          events.push({
            kind: 'linearRamp',
            value: point.value * 2 - 1,
            endTime: rampTime(point.ticks)
          })
        }
        backend.scheduleParam(chain.panner, 'pan', events)
      }
    }
  }

  /** Wipe and re-arm automation across every pass already in the window. */
  private rearmAutomation(): void {
    this.resetAutomation()
    for (const [fromTicks, atSec, untilTicks] of this.upcomingPasses()) {
      this.scheduleAutomationPass(fromTicks, atSec, untilTicks)
    }
  }

  private trackSources(trackId: TrackId): Set<VoiceId> {
    let set = this.sourcesByTrack.get(trackId)
    if (!set) this.sourcesByTrack.set(trackId, (set = new Set()))
    return set
  }

  private stopAllSources(): void {
    const backend = this.backend
    for (const voice of this.sources) {
      // The end notification stays live: synth voices disconnect their
      // filter/env nodes in their own onended, which stopVoice preserves.
      backend?.stopVoice(voice)
    }
    this.sources.clear()
    this.sourcesByTrack.clear()
    for (const gain of this.fadeNodes.keys()) {
      backend?.disconnect(gain)
      backend?.disposeNode(gain)
    }
    this.fadeNodes.clear()
  }

  /**
   * Tear down ONE track's scheduled sources and fade envelopes, leaving
   * every other track's live graph untouched — the difference between an
   * edit glitching its own track and an edit glitching the whole mix.
   */
  private stopTrackSources(trackIds: ReadonlySet<TrackId>): void {
    const backend = this.backend
    for (const trackId of trackIds) {
      const set = this.sourcesByTrack.get(trackId)
      if (!set) continue
      for (const voice of set) {
        this.sources.delete(voice)
        backend?.stopVoice(voice)
      }
      this.sourcesByTrack.delete(trackId)
    }
    for (const [gain, info] of this.fadeNodes) {
      if (trackIds.has(info.trackId)) {
        backend?.disconnect(gain)
        backend?.disposeNode(gain)
        this.fadeNodes.delete(gain)
      }
    }
  }

  /**
   * Re-queue the given tracks' sources from the current position up to the
   * already-scheduled horizon, without touching any other track. Falls back
   * to a full restart in the modes with more bookkeeping than a track can
   * be carved out of: cycling (queued iterations) and live VST3 preview
   * (windows bake document state in and must re-render regardless).
   */
  private rescheduleTracks(trackIds: ReadonlySet<TrackId>): void {
    const backend = this.backend
    if (!backend || !this.transport.isPlaying) return
    if (this.windowUntilTicks === null || this.previewTracks.size > 0) {
      void this.restart(() => this.resyncMetronome())
      return
    }
    this.stopTrackSources(trackIds)
    // Anchored at NOW, not the play anchor: the schedule math treats
    // anything before its anchor as "already sounding" and offsets into the
    // material, which is exactly right for the edited clip under the
    // playhead — but only against a current-time anchor.
    const fromTicks = this.transport.positionTicks()
    const atSec = backend.now()
    const fadeGains = new Map<string, BackendNodeId>()
    const window: ScheduleWindow = { startBeforeTicks: this.windowUntilTicks }
    this.scheduleClipsPass(fromTicks, atSec, Number.POSITIVE_INFINITY, fadeGains, undefined, window, trackIds)
    this.scheduleNotesPass(fromTicks, atSec, Number.POSITIVE_INFINITY, fadeGains, undefined, window, trackIds)
    // A looping track's ghost repeats were torn down with it — re-queue.
    let loopsTouched = false
    for (const trackId of trackIds) {
      if (this.trackLoops.has(trackId)) {
        this.trackLoopNextRepeat.delete(trackId)
        loopsTouched = true
      }
    }
    if (loopsTouched) this.topUpTrackLoops()
  }

  /**
   * Drop fade gains whose pass is entirely in the past. Looped playback
   * mints fresh fade nodes per iteration; without this sweep an hour of
   * cycling a faded region accumulates thousands of connected gains.
   */
  private purgeExpiredFades(now: number): void {
    for (const [gain, { endSec }] of this.fadeNodes) {
      if (endSec < now - 0.5) {
        this.backend?.disconnect(gain)
        this.backend?.disposeNode(gain)
        this.fadeNodes.delete(gain)
      }
    }
  }

  private chain(trackId: TrackId): TrackChain {
    const existing = this.chains.get(trackId)
    if (existing) return existing
    const backend = this.ensureBackend()
    // The two PDC compensators are always present and start at zero delay,
    // which both backends pass through exactly. Always-present means a
    // latency change is a param write rather than a rewire — no rebuilding
    // the graph, and no already-scheduled voice left on an old node.
    const source = backend.createNode('pdc')
    const input = backend.createNode('gain')
    const auto = backend.createNode('gain')
    const fader = backend.createNode('gain')
    const panner = backend.createNode('stereoPanner')
    const out = backend.createNode('pdc')
    backend.scheduleParam(fader, 'gain', [
      { kind: 'setValue', value: this.effectiveGain(trackId), time: 0 }
    ])
    backend.scheduleParam(panner, 'pan', [
      { kind: 'setValue', value: this.store.state.tracks[trackId]?.pan ?? 0, time: 0 }
    ])
    backend.connect(source, input)
    backend.connect(input, auto)
    backend.connect(auto, fader)
    backend.connect(fader, panner)
    backend.connect(panner, out)
    const parentId = this.store.state.tracks[trackId]?.parentId ?? null
    backend.connect(out, this.busFor(parentId))
    // Metering is a side-tap: the tap has no onward connection, so it
    // observes the post-fader/pan signal without altering the path. A peak
    // meter needs no frequency resolution — 256 samples per read is a 4×
    // cheaper scan than the old 1024 across every track every frame.
    const tap = backend.createTap(panner, TRACK_TAP_FRAMES)
    const chain: TrackChain = {
      source,
      input,
      auto,
      fader,
      panner,
      out,
      tap,
      meterBuf: new Float32Array(TRACK_TAP_FRAMES),
      parentId,
      pdcCapacitySec: 0,
      pdcSourceSec: 0,
      pdcOutSec: 0
    }
    this.chains.set(trackId, chain)
    this.wireInserts(trackId, chain)
    return chain
  }

  /** Where a track's output goes: its folder's chain input, or the master bus. */
  private busFor(parentId: TrackId | null): BackendNodeId {
    if (parentId !== null && this.store.state.tracks[parentId]) {
      return this.chain(parentId).input
    }
    return this.masterBusInput ?? this.backend!.masterNode()
  }

  /**
   * Reconcile plugin node instances with document state and (re)wire each
   * track's insert path: input → enabled plugins in rank order → auto.
   * Node instances persist across unrelated changes so params don't
   * zipper. Unresolvable plugins (MISSING on this client) are bypassed —
   * a missing plugin never breaks playback or the project.
   */
  private syncPlugins(): void {
    if (!this.backend) return
    this.syncPluginsFor(new Set([...this.chains.keys(), MASTER_BUS_ID]))
  }

  /**
   * Scoped rewire: dispose nodes of removed instances (map-sized, cheap),
   * then rebuild the insert wiring ONLY for the given tracks. Everything
   * else keeps its live graph untouched — the difference between one
   * track's worth of connect calls and a full-project storm per edit.
   */
  private syncPluginsFor(trackIds: ReadonlySet<TrackId>): void {
    const backend = this.backend
    if (!backend || trackIds.size === 0) return
    const state = this.store.state
    for (const [instanceId, entry] of this.fxNodes) {
      if (!state.plugins[instanceId]) {
        entry.dispose() // the builder owns all its nodes, adopted included
        this.fxNodes.delete(instanceId)
        this.fxStateBlobs.delete(instanceId)
      }
    }
    for (const [instanceId, ports] of this.graphPorts) {
      if (!state.plugins[instanceId]) {
        backend.disconnect(ports.inlet)
        backend.disconnect(ports.outlet)
        backend.disposeNode(ports.inlet)
        backend.disposeNode(ports.outlet)
        this.graphPorts.delete(instanceId)
      }
    }
    for (const trackId of trackIds) {
      if (trackId === MASTER_BUS_ID) {
        this.wireMasterInserts()
        continue
      }
      const chain = this.chains.get(trackId)
      if (chain) this.wireInserts(trackId, chain)
    }
    // Rewiring may have rebuilt nodes that carry key inlets (and removed
    // instances drop out of the document) — re-derive the key edges.
    this.syncSidechains()
    // The insert set just changed, so the latency of at least one path
    // may have; the plan is cheap enough to redo whole.
    this.recomputePdc()
  }

  /**
   * Reconcile SIDECHAIN key edges with the document: for every live,
   * enabled insert with a key inlet and a usable `sidechainTrackId`,
   * exactly one edge source-panner → key inlet; nothing else. Post-fader
   * on purpose — the key follows what the source track actually plays
   * (its mute/solo/volume), which is what ducking against it means.
   * Unusable keys (stale track, would-be cycle, insert not live here)
   * simply have no edge: the duck idles at unity, nothing breaks.
   */
  private syncSidechains(): void {
    const backend = this.backend
    if (!backend) return
    const state = this.store.state
    const wanted = new Map<PluginInstanceId, { sourceTrackId: TrackId; keyInput: BackendNodeId }>()
    for (const instance of Object.values(state.plugins)) {
      const sourceId = instance.sidechainTrackId ?? null
      if (sourceId === null || !instance.enabled || !state.tracks[sourceId]) continue
      if (this.keyWouldCycle(instance.trackId, sourceId)) continue
      const keyInput = this.fxNodes.get(instance.id)?.keyInput
      if (keyInput === undefined) continue
      wanted.set(instance.id, { sourceTrackId: sourceId, keyInput })
    }
    // Sever tracked edges that no longer match — only where both ends are
    // still alive (dead nodes already took their edges with them).
    for (const [instanceId, edge] of this.keyEdges) {
      const want = wanted.get(instanceId)
      if (want && want.sourceTrackId === edge.sourceTrackId && want.keyInput === edge.keyInput) {
        continue
      }
      const chain = this.chains.get(edge.sourceTrackId)
      if (chain && this.fxNodes.get(instanceId)?.keyInput === edge.keyInput) {
        backend.disconnect(chain.panner, edge.keyInput)
      }
      this.keyEdges.delete(instanceId)
    }
    // Connect what should exist (idempotent per edge on the seam).
    for (const [instanceId, want] of wanted) {
      this.keyEdges.set(instanceId, want)
      backend.connect(this.chain(want.sourceTrackId).panner, want.keyInput)
    }
  }

  /**
   * Keying a track's insert from itself or an ANCESTOR bus would wire the
   * insert's own output back into its key — a feedback cycle. Checked at
   * wire time, not in the reducer, because a later `track/reorder` can
   * create the relation after a perfectly valid sidechain pick. A master
   * insert can never cycle: every tap is upstream of the master chain.
   */
  private keyWouldCycle(hostTrackId: TrackId, sourceId: TrackId): boolean {
    if (hostTrackId === MASTER_BUS_ID) return false
    return isTrackSelfOrDescendant(this.store.state, hostTrackId, sourceId)
  }

  /**
   * (Re)wire the MASTER insert chain: masterBusInput → enabled master
   * inserts in rank order → masterNode. The mirror of wireInserts' linear
   * path — master has no routing graph, no freeze and no automation lanes,
   * so the graph/frozen branches have nothing to mirror. Node instances
   * come from the same fxNodes reconciliation, so a master insert behaves
   * identically to the same plugin on a track.
   */
  private wireMasterInserts(): void {
    const backend = this.backend
    const input = this.masterBusInput
    if (!backend || input === null) return
    const now = backend.now()
    const inserts = pluginsOfTrack(this.store.state, MASTER_BUS_ID)
    backend.disconnect(input)
    for (const instance of inserts) {
      const entry = this.fxNodes.get(instance.id)
      if (entry) backend.disconnect(entry.output)
    }
    let prev: BackendNodeId = input
    for (const instance of inserts) {
      if (!instance.enabled) continue
      const entry = this.liveNodesFor(instance, now)
      if (!entry) continue // MISSING here: bypass until a provider appears
      backend.connect(prev, entry.input)
      prev = entry.output
    }
    backend.connect(prev, backend.masterNode())
  }

  private wireInserts(trackId: TrackId, chain: TrackChain): void {
    const backend = this.backend
    if (!backend) return
    const now = backend.now()
    const inserts = pluginsOfTrack(this.store.state, trackId)

    backend.disconnect(chain.input)
    // The blanket disconnect above also severed the wire-oscilloscope tap
    // (graphSourceAnalyser) if one exists — re-attach it, or the routing
    // view's scopes go flat after the first rewire and never recover.
    const inputTap = this.inputWaveTaps.get(chain.input)
    if (inputTap && backend.webAudio) {
      backend.webAudio.nodeOf(chain.input).connect(inputTap)
    }
    for (const instance of inserts) {
      const entry = this.fxNodes.get(instance.id)
      if (entry) backend.disconnect(entry.output)
      const ports = this.graphPorts.get(instance.id)
      if (ports) {
        backend.disconnect(ports.inlet)
        backend.disconnect(ports.outlet)
      }
    }

    // A frozen track's render already contains its inserts — bypass them
    // all (this is where the CPU is saved; nodes stay alive for unfreeze).
    if (this.store.state.tracks[trackId]?.frozenAssetId) {
      backend.connect(chain.input, chain.auto)
      return
    }

    const routes = routesOfTrack(this.store.state, trackId)
    if (routes.length > 0) {
      this.wireGraph(chain, inserts, routes, now)
      return
    }

    let prev: BackendNodeId = chain.input
    for (const instance of inserts) {
      if (!instance.enabled) continue
      const entry = this.liveNodesFor(instance, now)
      if (!entry) continue // MISSING here: bypass until a provider appears
      backend.connect(prev, entry.input)
      prev = entry.output
    }
    backend.connect(prev, chain.auto)
  }

  /**
   * GRAPH routing: edges connect instance outlets to inlets; 'in' is the
   * track source (chain.input) and 'out' the summing mix node (chain.auto —
   * Web Audio fan-in sums, fan-out is free). Bypassed, missing and
   * external (out-of-process) plugins short inlet→outlet, so signal always
   * flows along the drawn wires. A graph with no path in→out is honestly
   * silent — the editor warns.
   */
  private wireGraph(
    chain: TrackChain,
    inserts: PluginInstance[],
    routes: Route[],
    now: number
  ): void {
    const backend = this.backend!
    for (const instance of inserts) {
      let ports = this.graphPorts.get(instance.id)
      if (!ports) {
        ports = { inlet: backend.createNode('gain'), outlet: backend.createNode('gain') }
        this.graphPorts.set(instance.id, ports)
      }
      const entry = instance.enabled ? this.liveNodesFor(instance, now) : null
      if (entry) {
        backend.connect(ports.inlet, entry.input)
        backend.connect(entry.output, ports.outlet)
      } else {
        backend.connect(ports.inlet, ports.outlet)
      }
    }
    for (const route of routes) {
      const from = route.from === 'in' ? chain.input : this.graphPorts.get(route.from)?.outlet
      const to = route.to === 'out' ? chain.auto : this.graphPorts.get(route.to)?.inlet
      if (from !== undefined && to !== undefined) backend.connect(from, to)
    }
  }

  /**
   * The live nodes for an instance, created/applied on demand. Null =
   * not local, OR the provider cannot run on this backend (an effect
   * still needing Web Audio escapes, asked to run natively; an external
   * plugin on a backend that cannot host one) — all bypass identically.
   */
  private liveNodesFor(instance: PluginInstance, now: number): PluginNodes | null {
    const backend = this.backend
    if (!backend) return null
    // A GUI-only plugin's edits live ONLY in the opaque stateBlob, which a
    // running instance cannot be told about — it is restored at open. So a
    // blob that changed (an editor closed, a collaborator's preset load)
    // means reopening. Params never need this; they are pushed live.
    const blob = instance.stateBlob ?? null
    if (this.fxNodes.has(instance.id) && this.fxStateBlobs.has(instance.id)) {
      if (this.fxStateBlobs.get(instance.id) !== blob) {
        this.fxNodes.get(instance.id)!.dispose()
        this.fxNodes.delete(instance.id)
        this.fxStateBlobs.delete(instance.id)
      }
    }
    let entry = this.fxNodes.get(instance.id)
    if (!entry) {
      const provider =
        pluginRegistry.resolve(instance.descriptor)?.provider ??
        this.externalProviderFor(instance)
      if (!provider) return null
      const nodes = provider.create(backend)
      if (!nodes) return null
      entry = nodes
      this.fxNodes.set(instance.id, entry)
      if (provider !== pluginRegistry.resolve(instance.descriptor)?.provider) {
        this.fxStateBlobs.set(instance.id, blob)
      }
    }
    entry.apply(instance.params, now)
    return entry
  }

  /**
   * An installed external-format plugin (VST3) as an insert, when the
   * backend can host one in its own audio callback. Null everywhere else,
   * which is what keeps the freeze / windowed-preview route in charge
   * under Web Audio. Minted per instance because the plugin needs the
   * instance's stateBlob at open time (see audio/externalInsert.ts).
   */
  private externalProviderFor(instance: PluginInstance): PluginProvider | null {
    if (!this.backend?.externalPlugins) return null
    if (!this.externalHost?.has(instance.descriptor)) return null
    return externalInsertProvider(instance)
  }

  /** True when external inserts run live, so LivePreview must stand down. */
  private hostsExternalPluginsLive(): boolean {
    return this.backend?.externalPlugins != null && this.externalHost != null
  }

  // ---------- Plugin-delay compensation ----------

  /**
   * Samples one track's insert chain delays its signal by: the sum along a
   * linear chain, the longest path through a routing graph (parallel
   * branches are summed at `auto`, so the slowest one sets the arrival).
   * A frozen track bypasses its inserts entirely, so it delays nothing.
   */
  private chainLatencySamples(trackId: TrackId): number {
    const state = this.store.state
    if (!state.tracks[trackId] || state.tracks[trackId].frozenAssetId) return 0
    const inserts = pluginsOfTrack(state, trackId)
    const latencyOf = (instance: PluginInstance): number => {
      if (!instance.enabled) return 0
      const entry = this.fxNodes.get(instance.id)
      return Math.max(0, Math.round(entry?.latencySamples?.() ?? 0))
    }
    const routes = routesOfTrack(state, trackId)
    if (routes.length === 0) {
      let total = 0
      for (const instance of inserts) total += latencyOf(instance)
      return total
    }
    // Longest path from 'in' to 'out' over the drawn wires: parallel
    // branches sum at `auto`, so the slowest one decides when the track
    // has fully arrived. Memoized; null means "no path to out from here",
    // which is what a dead-end branch and a user-drawn loop both are.
    const byId = new Map(inserts.map((instance) => [instance.id, instance]))
    const outgoing = new Map<string, string[]>()
    for (const route of routes) {
      const list = outgoing.get(route.from)
      if (list) list.push(route.to)
      else outgoing.set(route.from, [route.to])
    }
    const best = new Map<string, number | null>()
    const visiting = new Set<string>()
    const longest = (node: string): number | null => {
      if (node === 'out') return 0
      const known = best.get(node)
      if (known !== undefined) return known
      if (visiting.has(node)) return null
      visiting.add(node)
      const instance = byId.get(node)
      const own = node === 'in' || !instance ? 0 : latencyOf(instance)
      let deepest: number | null = null
      for (const next of outgoing.get(node) ?? []) {
        const reach = longest(next)
        if (reach !== null) deepest = Math.max(deepest ?? 0, reach)
      }
      visiting.delete(node)
      const value = deepest === null ? null : own + deepest
      best.set(node, value)
      return value
    }
    return longest('in') ?? 0
  }

  /**
   * Recompute and push every compensator (src/audio/pdc.ts). Cheap and
   * idempotent — a param write per track — so it runs on anything that can
   * change the answer: the plugin set, a folder move, and the host
   * reporting a plugin's latency once it has actually loaded.
   */
  private recomputePdc(): void {
    const backend = this.backend
    if (!backend?.running()) return
    const state = this.store.state
    const plan = computePdc(
      [...this.chains.keys()].map((trackId) => ({
        id: trackId,
        parentId: state.tracks[trackId]?.parentId ?? null,
        latencySamples: this.chainLatencySamples(trackId)
      }))
    )
    const rate = backend.start().sampleRate || 48000
    for (const [trackId, chain] of this.chains) {
      const delays = pdcDelaysOf(plan, trackId)
      const needSec = Math.max(delays.sourceSamples, delays.outputSamples) / rate
      if (needSec > chain.pdcCapacitySec) {
        // Grow in doublings so a chain settles on a capacity instead of
        // rebuilding its line on every small change (recapacitating clears
        // it, which is a discontinuity).
        let capacity = Math.max(chain.pdcCapacitySec, 0.05)
        while (capacity < needSec) capacity *= 2
        capacity = Math.min(capacity, PDC_MAX_SEC)
        backend.configureNode(chain.source, { maxDelay: capacity })
        backend.configureNode(chain.out, { maxDelay: capacity })
        chain.pdcCapacitySec = capacity
      }
      const at = backend.now()
      // Only write what CHANGED: this runs on every plugin edit and every
      // folder move, and an AudioParam keeps every event it is given.
      const sourceSec = Math.min(delays.sourceSamples / rate, PDC_MAX_SEC)
      const outSec = Math.min(delays.outputSamples / rate, PDC_MAX_SEC)
      if (sourceSec !== chain.pdcSourceSec) {
        chain.pdcSourceSec = sourceSec
        backend.scheduleParam(chain.source, 'delayTime', [
          { kind: 'setValue', value: sourceSec, time: at }
        ])
      }
      if (outSec !== chain.pdcOutSec) {
        chain.pdcOutSec = outSec
        backend.scheduleParam(chain.out, 'delayTime', [
          { kind: 'setValue', value: outSec, time: at }
        ])
      }
    }
    // Master inserts delay every path equally, so they need no compensator
    // of their own — only the honest total, which lags the drawn playhead.
    this.pdcTotalSec = plan.totalSamples / rate + this.masterInsertLatencySamples() / rate
  }

  /** Reported latency of the enabled master inserts (chain sum, like a track's). */
  private masterInsertLatencySamples(): number {
    let total = 0
    for (const instance of pluginsOfTrack(this.store.state, MASTER_BUS_ID)) {
      if (!instance.enabled) continue
      const entry = this.fxNodes.get(instance.id)
      total += Math.max(0, Math.round(entry?.latencySamples?.() ?? 0))
    }
    return total
  }

  private isAudible(trackId: TrackId): boolean {
    return isTrackAudible(this.store.state, trackId)
  }

  /** Fader gain: track volume, or 0 when muted / not solo-relevant while solo is on. */
  private effectiveGain(trackId: TrackId): number {
    const track = this.store.state.tracks[trackId]
    if (!track) return 0
    return this.isAudible(trackId) ? track.volume : 0
  }

  /**
   * Solo/mute audibility for every track in one pass. isTrackAudible walks
   * subtrees per call — fine for a single fader, O(T²·depth) when syncMixer
   * asked it once per track on every track edit. The closure answers from
   * the soloed set and each track's own ancestor path instead.
   */
  private audibilityResolver(): (trackId: TrackId) => boolean {
    const state = this.store.state
    const solo = new Set<TrackId>()
    for (const track of Object.values(state.tracks)) {
      if (track.soloed) solo.add(track.id)
    }
    if (solo.size === 0) {
      return (trackId) => {
        const track = state.tracks[trackId]
        return track !== undefined && !track.muted
      }
    }
    // A soloed track keeps itself, its ancestor buses (they carry its
    // signal) and its whole subtree audible — same relation isTrackAudible
    // expresses pairwise.
    const closure = new Set<TrackId>()
    for (const id of solo) {
      let current: TrackId | null = id
      const seen = new Set<TrackId>()
      while (current !== null && !seen.has(current)) {
        closure.add(current)
        seen.add(current)
        current = state.tracks[current]?.parentId ?? null
      }
    }
    return (trackId) => {
      const track = state.tracks[trackId]
      if (!track || track.muted) return false
      if (closure.has(trackId)) return true
      let current: TrackId | null = track.parentId
      const seen = new Set<TrackId>()
      while (current !== null && !seen.has(current)) {
        if (solo.has(current)) return true
        seen.add(current)
        current = state.tracks[current]?.parentId ?? null
      }
      return false
    }
  }

  private syncMixer(): void {
    const backend = this.backend
    if (!backend) return
    this.smooth(backend.masterNode(), 'gain', this.store.state.masterVolume)
    const chainCount = this.chains.size
    const audible = this.audibilityResolver()
    const panAutomated = this.automationIndex().panByTrack
    for (const [trackId, chain] of this.chains) {
      const track = this.store.state.tracks[trackId]
      if (!track) {
        this.liveAllNotesOff(trackId)
        const monitor = this.monitors.get(trackId)
        if (monitor !== undefined) {
          // Only the edge is ours — the handle (and its device) belong to
          // whoever opened the input.
          backend.disconnect(monitor, chain.input)
          this.monitors.delete(trackId)
        }
        backend.disposeNode(chain.source)
        backend.disposeNode(chain.input)
        backend.disposeNode(chain.auto)
        backend.disposeNode(chain.fader)
        backend.disposeNode(chain.panner)
        backend.disposeNode(chain.out)
        backend.disposeTap(chain.tap)
        this.inputWaveTaps.delete(chain.input)
        for (const instance of Object.values(this.prevPlugins)) {
          if (instance.trackId === trackId) {
            const entry = this.fxNodes.get(instance.id)
            if (entry) {
              entry.dispose()
              this.fxNodes.delete(instance.id)
            }
          }
        }
        this.chains.delete(trackId)
        continue
      }
      this.smooth(chain.fader, 'gain', audible(trackId) ? track.volume : 0)
      // While pan automation is playing, its ramps own the panner.
      if (!(this.transport.isPlaying && (panAutomated.get(trackId)?.length ?? 0) > 0)) {
        this.smooth(chain.panner, 'pan', track.pan)
      }
    }
    for (const trackId of Object.keys(this.store.state.tracks)) {
      if (!this.chains.has(trackId)) this.chain(trackId)
    }
    // Re-route outputs whose folder changed (drag into/out of a folder).
    let rerouted = false
    for (const [trackId, chain] of this.chains) {
      const parentId = this.store.state.tracks[trackId]?.parentId ?? null
      if (parentId !== chain.parentId) {
        backend.disconnect(chain.out)
        backend.connect(chain.out, this.busFor(parentId))
        chain.parentId = parentId
        rerouted = true
      }
    }
    // A move changes which paths share a bus, so it changes the whole
    // compensation plan — as does any chain this pass just created.
    if (rerouted || this.chains.size !== chainCount) this.recomputePdc()
  }

  /**
   * Click a recording count-in of `bars` whole bars starting now, while
   * the transport is still stopped. Returns the count-in's length in
   * seconds — the moment the roll (and capture) should begin.
   */
  countInClicks(bars: number): number {
    const backend = this.ensureBackend()
    const state = this.store.state
    const beatsPerBar = state.timeSignature[0]
    const secPerBeat = ticksPerBeat(state.timeSignature) / ticksPerSecond(state.tempo)
    // Small offset so the first click isn't clipped by scheduling latency.
    const start = backend.now() + 0.06
    const total = bars * beatsPerBar
    for (let i = 0; i < total; i++) {
      this.scheduleClick(start + i * secPerBeat, i % beatsPerBar === 0)
    }
    return start + total * secPerBeat - backend.now()
  }

  private startMetronome(): void {
    this.resyncMetronome()
    if (this.metroTimer !== null) return
    this.metroTimer = setInterval(this.metroTick, METRO_INTERVAL_MS)
    this.metroTick()
  }

  private stopMetronome(): void {
    if (this.metroTimer !== null) clearInterval(this.metroTimer)
    this.metroTimer = null
  }

  private resyncMetronome(): void {
    const backend = this.backend
    if (!backend) return
    const position = this.transport.positionTicks()
    this.nextBeatIndex = beatIndexAt(this.store.state, position)
    // The metronome keeps its own anchor because cycling moves the playhead
    // backwards, which the clip anchor deliberately does not follow. Both
    // halves of that anchor must be sampled at the SAME instant: pairing
    // the wrapped position with the clip anchor's linear tick/second pair
    // offsets every click by however far the loop had already wrapped
    // (silent at play, wrong when the metronome is switched on mid-cycle).
    this.metroAnchorTicks = position
    this.metroAnchorSec = backend.now()
    this.lastMetroPosition = position
  }

  private metroTick = (): void => {
    const backend = this.backend
    if (!backend || !this.metroEnabled || !this.transport.isPlaying) return
    const now = backend.now()
    const { clicks, nextBeatIndex } = metronomeClicks(
      this.store.state,
      this.metroAnchorTicks,
      this.metroAnchorSec,
      this.nextBeatIndex,
      now - 0.01,
      now + METRO_LOOKAHEAD_SEC
    )
    this.nextBeatIndex = nextBeatIndex
    for (const click of clicks) this.scheduleClick(click.when, click.isDownbeat)
  }

  /**
   * The click, pre-rendered once per buffer (§3: "generated: click") —
   * byte-identical to the old inline oscillator: sin(2πft) under the
   * 0.5 → 0.001 exponential decay over 50 ms, held to the 60 ms stop.
   */
  private registerClickBuffers(backend: IAudioBackend): void {
    const { sampleRate } = backend.start()
    for (const [id, freq] of [
      ['sd!click!hi', 1320],
      ['sd!click!lo', 880]
    ] as const) {
      const length = Math.round(0.06 * sampleRate)
      const data = new Float32Array(length)
      for (let i = 0; i < length; i++) {
        const t = i / sampleRate
        const env = t < 0.05 ? 0.5 * Math.pow(0.001 / 0.5, t / 0.05) : 0.001
        data[i] = env * Math.sin(2 * Math.PI * freq * t)
      }
      backend.registerBuffer(id, [data], sampleRate)
    }
  }

  private scheduleClick(when: number, isDownbeat: boolean): void {
    const backend = this.backend
    if (!backend) return
    const voice = backend.play({
      bufferId: isDownbeat ? 'sd!click!hi' : 'sd!click!lo',
      when,
      destination: backend.masterNode()
    })
    if (voice === null) return
    // Tracked like every other source, so pressing stop also silences the
    // clicks already queued inside the lookahead window.
    this.sources.add(voice)
    this.voiceCleanups.set(voice, () => this.sources.delete(voice))
  }
}
