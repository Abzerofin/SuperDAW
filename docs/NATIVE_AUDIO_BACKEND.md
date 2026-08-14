# Native Low-Latency Audio Backend — Design

Status: DRAFT / design only — no implementation scheduled by this document
Scope: Windows first (the only packaged target today); interface designed to be portable
Audience: SuperDAW maintainers

---

## 1. Goals and non-goals

### Goals

1. **Producer-grade round-trip latency.** Target **< 10–12 ms** mic-to-ear
   (input capture → track inserts → output) at 48 kHz with a 128-frame
   buffer, on ordinary Windows audio interfaces, without ASIO drivers.
   Today's path (getUserMedia → `MediaStreamAudioSourceNode` → track chain →
   `AudioContext.destination`) typically lands at 30–80 ms depending on the
   machine — fine for arranging, unusable for tracking with monitoring.
2. **Automatic input-latency calibration.** Recording placement today
   compensates the output path automatically but leaves the input path to a
   manual `recordLatencyTrimMs` preference
   (`src/renderer/src/state/recording.ts:213-224`). A loopback measurement
   should replace the guesswork (section 7).
3. **A real backend seam.** Whatever route we take, `AudioEngine` should
   stop talking to `AudioContext` directly and talk to an `IAudioBackend`
   interface that Web Audio implements today and a native addon implements
   later. Phase 0 delivers this with zero native code (section 8).
4. **Bit-honest parity.** Playback through the native backend must be
   audibly identical to the Web Audio engine, verified by rendering the same
   project through both and diffing (section 8, parity harness).

### Non-goals

- **Offline export stays Web Audio.** `renderProject` /
  `renderTrackFreeze` run in an `OfflineAudioContext`
  (`src/audio/render.ts`) with no realtime deadline; there is no latency to
  win. They can stay on Web Audio permanently. (Consequence: the builtin
  DSP ports need a parity story, not a replacement story — bounces keep
  using the Web Audio graph until/unless we ever decide otherwise.)
- **The browser build is untouched.** The renderer must keep working in a
  plain browser (CLAUDE.md rule); the native backend is an Electron-only
  enhancement selected at runtime, exactly like the VST3 host is today
  (`window.superdaw?` guard pattern).
- **Live in-callback VST3 inserts are out of scope** for this document.
  The native backend makes them *tractable* later (section 5 note) but the
  windowed VST3 preview (`PREVIEW_WINDOW_SEC`, `src/audio/engine.ts:91`)
  and freeze pipeline stay as they are.
- **No plugin-delay compensation (PDC) in the first pass.** Nothing in the
  codebase does PDC today; the backend interface reserves room for reported
  node latency but implementing PDC is its own project.
- **macOS/Linux** are out of scope for the first implementation but the
  recommended library (section 4) covers CoreAudio/ALSA when the time comes.

---

## 2. Current coupling — what is portable and what is baked

Verified against the tree at `E:\SuperDAW` (v0.3.0).

### Already platform-free (survives any backend unchanged)

| Seam | Where | Why it survives |
| --- | --- | --- |
| Scheduling math | `src/audio/scheduling.ts` (`scheduleClips` :97-199, `scheduleNotes` :267-326, fades :328-384, metronome :396-417) | Pure functions from project state + anchor → absolute-clock second lists (`ClipSchedule {when, offsetSec, durationSec, rate, reverse}`). Any backend that can start a buffer at a clock time consumes these directly. |
| Transport clock | `Transport.setTimeSource` (`src/renderer/src/state/transport.ts:14-17`, :251-255) | The playhead already runs on an injected `TimeSource {now(): seconds}`; the engine installs `ctx.currentTime` at `ensureContext` (`src/audio/engine.ts:322`). A native stream clock is a drop-in. |
| Latency compensation | `Transport.setOutputLatency` / `displayTicks` (`transport.ts:199-207`), recording placement (`recording.ts:213-224`) | One number in, drawn playhead and take placement out. A native backend just reports a *better* number. |
| Engine boundary | `StoreLike` / `TransportLike` (`engine.ts:55-69`) | The engine consumes narrow interfaces, not app singletons. |
| Wire currency | `Float32Array[]` channels + `sampleRate` | Recorder output (`src/audio/recorder.ts:45-51`), external plugin host (`src/audio/render.ts:48-78`), WAV encode — all already speak raw planar floats. `AudioBufferLike` (`src/audio/assets.ts:14-19`) is the existing shim. |
| Out-of-process audio precedent | `ExternalPluginHost` injected via `setExternalHost` (`engine.ts:617-620`), implemented over Electron IPC (`src/renderer/src/state/externalPlugins.ts:244-317`) | Proves the engine tolerates an async, injected, process-remote audio service. |
| Native toolchain precedent | `native/vst3host` (Node-API C++, `binding.gyp`, 1155-line `vst3host.cc`, MSVC via node-gyp, packaged via `extraResources` `package.json:34-39`, resolved by `src/main/addonPath.ts:12-14`) | The exact build/packaging/loading path a native audio addon would reuse. `src/main/pluginScan.ts:214` additionally shows the `utilityProcess` crash-isolation pattern. |

### Web-Audio-baked (the migration cost)

- **The graph.** `AudioEngine` creates ~15 concrete node types inline:
  per-track `input → auto → fader → panner (+ analyser tap)` chains
  (`engine.ts:1607-1641`), serial insert wiring and free-form routing
  graphs (`wireInserts`/`wireGraph`, `engine.ts:1692-1769`), folder buses
  (`busFor` :1644-1649), master + master analyser (:313-319).
- **AudioParam semantics are load-bearing.** Volume/pan automation compiles
  to `setValueAtTime` + `linearRampToValueAtTime`
  (`engine.ts:1465-1495`), knob previews use `setTargetAtTime` with 15 ms
  smoothing (:434-454, `GAIN_SMOOTHING_SEC` :73), clip fades use
  `setValueCurveAtTime` with a documented fallback to linear ramps
  (`src/audio/fades.ts:31-47`), and teardown relies on
  `cancelScheduledValues` (:1443). Any native param system must reproduce
  these five event types and their interaction rules.
- **Builtin DSP is node-graph-only.** All 11 effect types
  (`src/core/model/effects.ts:7-18`) are built from Web Audio primitives in
  `src/audio/effects.ts` (BUILDERS :67-316): biquads (paraeq/eq3/filters),
  `DynamicsCompressorNode` (compressor :155, limiter :185), `DelayNode`
  (:211), `ConvolverNode` (reverb :245), `OscillatorNode` (LFO :287). The
  synth voice is oscillator + filter + envelope (`src/audio/synth.ts:43`),
  the metronome click is an inline oscillator (`engine.ts:1966`).
- **Metering is AnalyserNode-shaped.** Per-track peak meters
  (`engine.ts:485-495`), master meter (:498-507), plugin spectrum taps
  (`pluginAnalysis` :515-517), wire oscilloscopes (`graphSourceAnalyser`
  :526-542) — all poll `getFloatTimeDomainData` from rAF loops.
- **Monitoring passes a live `AudioNode` across the engine boundary**
  (`setMonitorSource`, `engine.ts:391-405`) — the one API in the engine
  whose *signature* cannot survive a process split.
- **Assets are `AudioBuffer`s** (`assets.ts:30`), decoded via
  `ctx.decodeAudioData` (`engine.ts:456-458`) at the live context's rate;
  the offline render deliberately follows that rate so buffers are read 1:1
  (`render.ts:83-89`). Decode rate == live rate == render rate is a
  deliberate invariant (section 6).
- **Devices are split across three web APIs**: output via
  `AudioContext.setSinkId` (`engine.ts:337-383`), input via getUserMedia
  constraints with `ideal` fallback (`trackInputs.ts:169-179`,
  `audioDevices.ts:119-122`), enumeration via
  `mediaDevices.enumerateDevices` with labels gated behind a mic grant
  (`audioDevices.ts:124-137`).
- **Input path**: getUserMedia stream → `MediaStreamAudioSourceNode`
  splitter/merger tap (`src/audio/input.ts:51-77`) → capture AudioWorklet
  (`src/audio/recorder.ts:11-43`). Everything downstream of the resulting
  `Recording {channels, sampleRate, startSec}` is already platform-free.

One engine property does the native design a huge favor: **playback is
scheduled ~4 s ahead and topped up every 250 ms**
(`SCHEDULE_LOOKAHEAD_SEC` / `SCHEDULE_INTERVAL_MS`, `engine.ts:79-80`).
The control plane is *not* deadline-critical — only the audio callback is.
That is what makes a cross-process backend viable at all (section 5).

---

## 3. The `IAudioBackend` seam

One interface, two implementations: `WebAudioBackend` (an adapter over
today's code, phase 0) and `NativeAudioBackend` (proxy to the addon,
phase 2). Everything is designed to be serializable — no live objects
cross the boundary — so the same interface works in-process (Web Audio)
and over a MessagePort (native).

```ts
// src/audio/backend.ts — sketch, names bikesheddable

export type BackendNodeId = number
export type VoiceId = number
export type TapId = number

/** Mirrors Web Audio AudioParam semantics 1:1 — the five calls the
 *  engine actually uses (engine.ts:1465-1495, :434-454, fades.ts:31-47,
 *  engine.ts:1443). Times are absolute stream-clock seconds. */
export type ParamEvent =
  | { kind: 'setValue';  value: number; time: number }
  | { kind: 'linearRamp'; value: number; endTime: number }        // linearRampToValueAtTime
  | { kind: 'setTarget'; value: number; time: number; timeConstant: number }
  | { kind: 'setCurve';  curve: Float32Array; time: number; duration: number }
  | { kind: 'cancel';    afterTime: number }                      // cancelScheduledValues

/** The graph primitives the current engine actually instantiates.
 *  'compressor' matches the Web Audio DynamicsCompressor algorithm (it is
 *  spec-defined, so a native port can be verified numerically). */
export type NodeKind =
  | 'gain' | 'stereoPanner' | 'biquad' | 'delay' | 'compressor'
  | 'convolver' | 'oscillator' | 'inputTap'   // channel-select from the live input
  | 'tap'                                      // analysis ring buffer (section below)

export interface StreamInfo {
  sampleRate: number
  bufferFrames: number          // callback quantum actually granted
  outputChannels: number
  inputChannels: number         // 0 when no input stream is open
}

export interface BackendLatencies {
  outputSec: number             // feeds Transport.setOutputLatency
  inputSec: number | null      // null = unknown (Web Audio backend)
}

export interface DeviceInfo {
  id: string                    // backend-native, stable across sessions
  label: string                 // ALWAYS present natively (no mic-grant gate)
  kind: 'input' | 'output'
  isDefault: boolean
  maxChannels: number
  sampleRates: number[]         // rates the device accepts (native only)
}

export interface PlaySpec {
  assetId: string               // registered buffer (or generated: click, etc.)
  when: number                  // absolute stream seconds — ClipSchedule.when
  offsetSec: number             //   "                    — ClipSchedule.offsetSec
  durationSec: number
  rate: number                  // resampling ratio — ClipSchedule.rate
  reverse: boolean
  destination: BackendNodeId    // track chain input
  /** Per-voice gain envelope (clip fades) — same ParamEvent currency. */
  envelope?: ParamEvent[]
}

export interface IAudioBackend {
  // ---- lifecycle ----
  start(opts: {
    outputDeviceId: string | null
    inputDeviceId: string | null      // null = no input stream
    requestedBufferFrames: number     // replaces latencyHint (engine.ts:302-306)
    requestedSampleRate: number | null
  }): Promise<StreamInfo>
  stop(): Promise<void>

  // ---- clock + latency (Transport seam survives verbatim) ----
  now(): number                        // stream time; installs as TimeSource
  latencies(): BackendLatencies

  // ---- graph ----
  createNode(kind: NodeKind, opts?: Record<string, number>): BackendNodeId
  connect(from: BackendNodeId, to: BackendNodeId): void
  disconnect(from: BackendNodeId, to?: BackendNodeId): void
  disposeNode(id: BackendNodeId): void
  /** Replace/merge the pending event queue for one param, Web Audio rules. */
  scheduleParam(node: BackendNodeId, param: string, events: ParamEvent[]): void

  // ---- buffers + voices (ClipSchedule consumer) ----
  registerBuffer(assetId: string, channels: Float32Array[], sampleRate: number): void
  releaseBuffer(assetId: string): void
  play(spec: PlaySpec): VoiceId
  stopVoice(id: VoiceId, atTime?: number): void
  stopVoicesTo(destination: BackendNodeId): void   // stopTrackSources equivalent

  // ---- analysis (replaces AnalyserNode polling) ----
  /** A tap keeps the last `frames` samples of the signal at `node` in a
   *  ring buffer. read() returns the latest window — for the native
   *  backend this is a snapshot shipped on the meter tick, for Web Audio
   *  it wraps getFloatTimeDomainData. Peak/RMS/FFT stay caller-side. */
  createTap(node: BackendNodeId, frames: number): TapId
  readTap(id: TapId, out: Float32Array): boolean   // false = no data yet
  disposeTap(id: TapId): void

  // ---- devices (unifies audioDevices.ts, section 6) ----
  enumerateDevices(): Promise<DeviceInfo[]>
  onDeviceChange(cb: () => void): () => void

  // ---- input (replaces getUserMedia path, section 7) ----
  /** Channel-select tap over the live input stream (input.ts semantics:
   *  mono duplicates one channel to both sides, stereo takes a pair).
   *  Returns a node connectable into a track chain (monitoring) and a
   *  capture subscription (recording). */
  openInput(config: { mode: 'mono' | 'stereo'; channel: number }): {
    node: BackendNodeId
    /** Chunks arrive off the audio thread; first chunk carries the stream
     *  time of its first frame — recorder.ts startSec semantics. */
    capture(cb: (chunk: Float32Array[], firstFrameTime: number) => void): () => void
    dispose(): void
  }
}
```

### What this maps onto, exactly

- `scheduleClipsPass` → `play()` per `ClipSchedule`; fade gains
  (`fadeNodes`) become the `envelope` field — the per-clip GainNode
  disappears as an object and becomes voice-internal state.
- `scheduleAutomationPass` → `scheduleParam(chain.auto, 'gain', [...])`
  with the identical setValue + linearRamp list.
- `chain()` → five `createNode` + four `connect` calls; `wireInserts` /
  `wireGraph` are connect/disconnect sequences, unchanged in shape.
- `trackLevel`/`meterLevel`/`graphSourceAnalyser` → taps. Peak scan stays
  exactly where it is (caller-side loop over the window); spectrum FFT for
  plugin analysis moves caller-side too (a small JS FFT over 1–2 k
  samples per frame is negligible).
- `setMonitorSource(trackId, node)` → `setMonitorInput(trackId, inputHandle)`
  — the one signature change; the engine connects `handle.node` to the
  chain input itself, so the "engine owns the connection" invariant
  (:385-405) survives.
- Effects: each `PluginNodes` builder gets a backend-primitive equivalent
  (`createNode('biquad')` etc.). `apply(params, when)` keeps its shape —
  it becomes `scheduleParam(..., [{kind:'setTarget', ...}])` calls.
- `decode()` stays Web Audio (renderer-side `decodeAudioData`); the native
  backend receives the decoded planar floats via `registerBuffer`.

### Deliberately absent

- No `AudioNode` objects cross the interface — only integer ids.
- No synchronous audio-thread callbacks into JS — capture chunks and tap
  snapshots are pushed at UI cadence, never at callback cadence.
- No per-block processing API. The backend is a *scheduled* engine, same
  as today; anything that needs per-block JS (future worklet-style DSP)
  is a later extension, not smuggled in now.

---

## 4. Native route evaluation

Constraints that frame the choice:

- **License: SuperDAW is GPL-3.0-or-later** (`package.json:7`). Anything
  we vendor must be GPL-compatible. The VST3 SDK is fine — it is
  dual-licensed GPLv3/proprietary, which is exactly why `native/vst3sdk`
  can sit in the tree. **The Steinberg ASIO SDK has no GPL option**: its
  proprietary license terms are famously incompatible with GPL
  distribution (this is why Audacity has never shipped ASIO builds).
  Shipping ASIO support in SuperDAW installers is therefore legally
  blocked regardless of engineering effort. WASAPI needs no SDK beyond
  the Windows headers we already build against.
- **Toolchain: the precedent is Node-API C++ via node-gyp/MSVC**
  (`native/vst3host/binding.gyp`), packaged as `extraResources` and
  resolved at runtime by `addonPath.ts`. A second addon that follows the
  same recipe is near-zero packaging risk; a new toolchain is not.

| Route | Language / build | License | Windows low-latency story | Fit |
| --- | --- | --- | --- | --- |
| **miniaudio** | Single-header C, compiles inside our existing node-gyp target — no external lib, no CMake | Public domain / MIT-0 (choice) | WASAPI backend with shared, **IAudioClient3 low-latency shared periods**, and **exclusive mode**; duplex (single callback delivering input + output); device enumeration + hotplug notifications; built-in resampler and decoders | **Best.** One `.h` dropped next to `vst3host.cc`-style code; we use the *device* layer (`ma_context`, `ma_device`) and write our own graph, because param semantics must match Web Audio (section 3) — miniaudio's own node-graph does not. |
| PortAudio | C library, CMake, links as a dependency | MIT-like | WASAPI shared + exclusive solid; ASIO backend exists but requires the ASIO SDK (blocked, above) | Capable but adds a real dependency build to a repo that currently compiles all native code from vendored sources in one gyp target. No capability we need that miniaudio lacks. |
| cubeb | C++ (Mozilla), CMake, geared to Firefox's needs | ISC | WASAPI shared; battle-tested for *reliability*, but exclusive-mode / minimum-period aggressiveness is not its design goal | Wrong optimization target — it exists to make browser audio robust, not to chase 3 ms periods. |
| Rust cpal via napi-rs | Rust toolchain + napi-rs bridge | Apache-2.0/MIT | WASAPI shared + exclusive | Fine library, but it imports an entire second native toolchain (rustc, cargo, napi-rs build glue) into a repo whose native precedent is C++/node-gyp, for no capability gain. Not justified. |

### Recommendation

**miniaudio device layer inside a new Node-API addon
(`native/audiohost`), built by the existing node-gyp/MSVC recipe; custom
graph/param/voice engine on top (C++, ~the same order of code as
`vst3host.cc`).** Windows path priority:

1. **WASAPI shared mode with IAudioClient3 low-latency periods** as the
   default — on most modern drivers this negotiates 2.67 ms (128-frame)
   periods *without* seizing the device from other applications.
2. **WASAPI exclusive mode as an opt-in "lowest latency" toggle** — worth
   having for tracking sessions, but it grabs the device: while active,
   nothing else on the machine (including any Chromium-owned output in our
   own renderer) can play to it. That is a UX cost, not just a technical
   one, which is why it should not be the default.
3. **ASIO: explicitly rejected** for shipped builds on license grounds
   (GPL incompatibility). Revisit only if the project ever relicenses, or
   for unofficial self-built binaries — neither is worth designing for.

---

## 5. Process placement and transport

### Why the renderer is out (today)

`docs/ARCHITECTURE.md:189-198` already states the constraint precisely:
the renderer runs `sandbox: true`, a sandboxed preload cannot `require()`
a native addon, and `SharedArrayBuffer` does not cross an Electron process
boundary — so the classic "native thread writes a SAB, an AudioWorklet
reads it" design is unavailable, and per-block IPC is far too slow (a
128-frame block at 48 kHz is 2.7 ms).

Relaxing the sandbox would let the addon live in-process with the engine
(zero-IPC control, direct memory for meters). It is the fallback if
control latency ever proves a problem, but it trades away renderer
sandboxing in an app that renders collaborator-supplied project content —
a bad default for a collaboration-first product. Not recommended.

### Recommended placement: a dedicated `utilityProcess`

Precedent: the VST3 scanner already runs in a `utilityProcess` precisely
for crash isolation (`src/main/pluginScan.ts:214`, rationale at :28). The
audio host gets the same treatment:

- **`audiohost.node` loads in a dedicated utilityProcess.** A driver bug
  or addon crash costs audio, not the app; main notices the exit,
  restarts the process, and the renderer engine falls back to the Web
  Audio backend until it returns.
- **The realtime thread lives entirely inside the addon.** miniaudio's
  device callback runs on an OS audio thread; it reads lock-free
  structures (voice lists, param event queues, graph topology snapshots)
  that the addon's JS-facing thread publishes. **No JS runs per block,
  in any process.**
- **Renderer ↔ audio process wire: a direct `MessagePort`.** Electron's
  `MessageChannelMain` lets main hand one port to the utilityProcess and
  the other to the renderer via `webContents.postMessage`, so control
  traffic skips main entirely. Payloads are structured-clone-friendly by
  design (section 3); `Float32Array`s transfer.

### The latency math that makes this safe

The wire question is only scary if audio-rate data crosses it. It never
does:

| Path | Deadline | Wire budget | Verdict |
| --- | --- | --- | --- |
| Audio callback (mix, monitor, capture) | 2.67 ms @128 / 5.33 ms @256 | **zero IPC** — all inside the addon's RT thread | safe by construction |
| Voice/param scheduling | events are timestamped ≥ 250 ms ahead; the engine keeps a 4 s horizon topped up every 250 ms (`engine.ts:79-80`) | MessagePort one-way, typically 0.1–1 ms, multi-ms tails under GC — three orders of magnitude inside budget | safe |
| Knob preview / monitoring toggle | perceptual (~10–30 ms tolerable; previews already smooth over 15 ms, `engine.ts:73`) | same wire | safe |
| Meters/taps | 30–60 Hz UI cadence; one pushed frame carrying all tap snapshots (a 1024-sample tap is 4 KB) | same wire | safe |
| Asset PCM | once per asset, off the hot path | transferred (or chunked) `Float32Array`s; a 4-minute stereo 48 k asset is ~92 MB — chunk it like the collaboration asset transfer already does | safe, memory cost noted in risks |

For contrast, the design this table forbids — shipping audio blocks over
IPC per callback — needs a request/response inside 2.67 ms (128) or
5.33 ms (256) with *zero* misses; Electron IPC tail latencies under GC or
load are 5–30 ms. That confirms ARCHITECTURE.md's judgment: per-block IPC
is not a viable transport, so the transport must never carry blocks.

### Interaction with the existing VST3 host

The addon lands in the same process family as `vst3host.node` (both are
Node-API, both resolvable by `addonPath.ts`). Longer term the audio
utilityProcess could load *both*, putting live VST3 processing one
lock-free queue away from the audio callback instead of behind the
2-second windowed preview — that is the door this design opens for
"live external inserts + PDC" later. Out of scope now; worth not
designing shut.

---

## 6. Sample rates and devices

### The decode-once invariant, natively

Today: assets decode at the live context rate, and offline renders run at
that same rate so buffers are read 1:1 (`render.ts:83-89`,
`engine.ts:456-458`). The invariant exists because Web Audio buffer
sources resample *implicitly and per-context* — keeping every rate equal
was the way to avoid a second, uncontrolled resample.

The native backend changes the economics: its voice reader **already
needs a high-quality fractional resampler**, because `ClipSchedule.rate`
(pitch/stretch, `scheduling.ts:35-36`) is arbitrary. Once that exists,
device-rate conversion is the *same multiply*: playing 44.1 k material on
a 48 k stream is `rate × (44100 / 48000)`. So:

- **Renderer side: the invariant stands unchanged.** Assets keep decoding
  at the Web Audio context rate; the offline render keeps following it;
  nothing about `assets.ts` moves.
- **Native side: `registerBuffer` carries `sampleRate` and the voice
  resamples.** A device switch that changes the stream rate (WASAPI
  exclusive is rate-restricted per device) requires *no re-decode and no
  re-registration* — voices just pick up a new ratio. The invariant
  becomes backend-internal instead of app-global.
- Resampler quality is a parity risk (section 8): windowed-sinc for
  voices, verified against Web Audio's output within tolerance.

### Device model unification

`audioDevices.ts` currently glues three web APIs with web-specific warts:
labels hidden until a mic grant (:124-137), `ideal`-constraint fallback
(:119-122), `devicechange` handling with loss notices (:85-97). The
native backend replaces the plumbing, not the store:

- `IAudioBackend.enumerateDevices()` returns both kinds with **stable
  native ids, labels always present, supported rates and channel counts**
  — no permission gate (Electron grants media perms itself anyway).
- `audioDevices.ts` stays the single store the UI reads, now sourcing
  from the *active backend*: web enumeration under `WebAudioBackend`
  (browser build unchanged), native enumeration under
  `NativeAudioBackend`. Loss handling and notices (:85-97) survive
  verbatim — `onDeviceChange` feeds the same `refresh(true)` path.
- **Persisted selections are namespaced per backend**
  (`{ web: {...}, native: {...} }` under the existing `audioDevices`
  appStorage key) — web `deviceId`s are origin-scoped hashes and cannot
  be mapped onto WASAPI ids, so translation is not attempted.
- Fallback semantics carry over: a vanished native device reverts to the
  system default with the same status-bar notice, matching the
  `ideal`-constraint philosophy.

---

## 7. Input, monitoring, and automatic latency calibration

### The win

Today's monitor path — getUserMedia capture pipeline →
`MediaStreamAudioSourceNode` → track chain → context output — stacks a
browser capture stack (typically 10–30 ms even with processing disabled,
`trackInputs.ts:169-179` disables EC/NS/AGC) on top of context output
latency. Native duplex collapses it: miniaudio's duplex mode delivers
input frames *in the same callback* that renders output, so monitoring
(input tap → track inserts → fader/pan → master) is pure in-callback DSP.

Round-trip at 48 kHz, 128-frame period, shared IAudioClient3 (converters
included, typical figures):

```
ADC + input period        ≈ 2.7 + ~1 ms
in-callback processing       < 1 period (budgeted)
output double-buffer + DAC ≈ 5.3 + ~1 ms
                          ─────────────
                          ≈ 10–11 ms      → inside the 10–12 ms goal
```

At 256 frames the same stack is ≈ 17–18 ms — which is why the target
requires the 128-frame path to actually negotiate, and why exclusive
mode remains the escape hatch on drivers whose shared minimum period is
10 ms.

Recording keeps its exact currency: `openInput(...).capture` delivers
`Float32Array[]` chunks plus the stream time of the first frame —
byte-for-byte the `Recording {channels, sampleRate, startSec}` contract
(`recorder.ts:45-51`), so take placement (`recording.ts:216-233`) does
not change shape. Capture chunks cross the MessagePort at UI cadence
(e.g. 100 ms batches), nowhere near the callback path.

### Automatic loopback calibration (the missing feature)

Today the input path's latency is a manual `recordLatencyTrimMs` trim
(`recording.ts:213-214`) — the platform reports output latency but not
input. Design:

1. **Stimulus.** Schedule a ~250 ms exponential sine sweep (chirp) at a
   known stream time `t0` on the output. A chirp's matched filter gives a
   sharp, noise-robust correlation peak; repeat 3× and median the results.
2. **Path.** User either connects an output channel to an input channel
   (cable / interface loopback), or does it acoustically speaker→mic
   (works, lower confidence — say so in the UI).
3. **Measure.** Capture input around `t0`; cross-correlate against the
   reference sweep. Peak lag = true round-trip in samples at the stream
   rate.
4. **Derive the trim.** Recording placement already subtracts the
   reported output latency (`recording.ts:213-224`), so
   `autoTrimSec = measuredRoundTrip − reportedOutputLatency` is precisely
   the unknown the manual trim approximates today. Write it into the same
   compensation slot; keep the manual field as an offset on top.
5. **Cache and invalidate.** Key the result by
   `(inputDeviceId, outputDeviceId, sampleRate, bufferFrames)`; a device
   or buffer-size change invalidates and the settings pane shows
   "unmeasured" again. Report confidence (peak-to-sidelobe ratio) and
   refuse to store a low-confidence result.

**This feature does not need the native backend.** Playing the sweep
through Web Audio and capturing through getUserMedia measures the *actual
current path*, which is exactly what recording compensation needs today.
That makes it Phase 1 — shippable value long before any native code
lands — and the native backend simply re-runs the same calibration on its
own path.

---

## 8. Migration phases

Each phase ships independently and leaves the product strictly no worse.

| Phase | Contents | Ships when | Effort (rough) |
| --- | --- | --- | --- |
| **0 — Seam extraction** (no native code) — ✅ **SHIPPED** (`audio/backend.ts`, engine ported; parity harness `audio/parity.ts` + committed baseline; command streams pinned in `audio/__tests__/backend.test.ts`. The remaining Web Audio touch-points are the documented `backend.webAudio` escapes: builtin effect builders + instrument voices (phase 2), monitor nodes + capture (phase 3), decode + UI-facing analysers) | Introduce `IAudioBackend` + `WebAudioBackend`; port `AudioEngine` off direct `AudioContext`/node usage (chains, inserts, params, voices+fades, taps, monitor handle). Build the **parity harness**: render fixture projects through the engine pre/post refactor and diff output; extend `ops.test`-style coverage to backend command streams. Browser build: unchanged by construction (it runs the same `WebAudioBackend`). | Zero user-visible change; existing tests + parity diffs green | 3–5 wks |
| **1 — Loopback latency calibration** (no native code) — ✅ **SHIPPED** (`audio/calibration.ts` / `calibrationRun.ts` / `state/latencyCalibration.ts`) | Settings ▸ Audio "Measure round-trip latency" per section 7, implemented on the current Web Audio + getUserMedia path; auto-trim feeds `recording.ts` compensation; manual trim becomes an offset | Recorded takes land on the grid without hand-tuning | 1–2 wks |
| **2 — Native playback backend** — 🚧 **IN PROGRESS** (shipped: `native/audiohost` addon with miniaudio 0.11.25 vendored, WASAPI-only, device layer verified on hardware via `smoketest.js`; the C++ graph/param/voice engine implementing the seam's semantics — Web Audio param timeline, equal-power pan, sample-accurate integer-frame voice scheduling, taps, ended ring — verified numerically via `enginetest.js` + `renderOffline`; caller-minted ids so the whole command surface is one-way/serializable; the utilityProcess + direct-MessagePort transport per §5 (`main/audioHost.ts` spawn/channel/exit-watch, `main/audioHostWorker.ts` entry, Electron-free `main/audioHostSession.ts`), the renderer `NativeAudioBackend` proxy (`audio/nativeBackend.ts` — frame-based clock/taps/ended, local id minting) with the boot flow, launch-scoped Settings ▸ Audio ▸ Audio system toggle and crash fallback in `state/nativeAudio.ts` + `engine.resetBackend`; the whole renderer→port→session→engine path is pinned by `main/__tests__/audioHostSession.test.ts` against the real addon. DSP ports — **all 11 builtin effects run on BOTH backends from one definition**, no Web Audio escapes left in any builder: the filter family on a spec-exact `biquad` primitive (`nativeBiquad.test.ts`, 15 checks vs an independent transcription); `delay` on a ring primitive whose read/write split reproduces Web Audio's in-cycle feedback rule (`nativeDelay.test.ts`, sample-exact echo train); compressor + limiter on a `compressor` primitive matched to MEASURED Chromium behavior (`nativeCompressor.test.ts`, 23 checks — see the parity-drift risk row); reverb on a `convolver` primitive doing uniform partitioned overlap-save convolution, which being exact math matches sample-for-sample (`nativeReverbLfo.test.ts`) once Chromium's default IR NORMALIZATION is reproduced — another measured-not-assumed law, `10^(−58/20) · (44100/rate) / rms`; and the LFO on an `oscillator` primitive plus the seam's new audio-rate param modulation (`connectParam`, Web Audio's node→AudioParam edge). The oscillator is now BAND-LIMITED, which was the prerequisite for any audio-rate use (a naive saw at a musical pitch folds everything above Nyquist back as inharmonic junk): additive wavetables, one per octave, built once at engine construction via inverse FFT and crossfaded by frequency (`nativeOscillator.test.ts` pins harmonic amplitudes against measured Chromium values and probes BETWEEN harmonics, where a naive shape's aliasing would show). Measuring the real node also explained its amplitudes: every table shares one normalization scale chosen so the fullest peaks at 1.0, which is why saw and square read 0.8483× the ideal series (1/1.179, the Gibbs overshoot for a jump of 2) while sine and triangle read 1.0×. Residual: the near-Nyquist range crossover is our own formula rather than Chromium's, so the topmost harmonic or two taper slightly differently — inaudible, and confined to content above ~16 kHz. **All three built-in instruments are ported too** — the analog synth, the sampler and the drum kit build from backend primitives in both their scheduled and live (held-key) forms, so MIDI tracks sound under the native backend. That needed three capabilities beyond DSP: scheduled-source lifecycle (`scheduleSource` — start/stop/ended for GENERATED voices, which buffer voices already had), buffer loop points (the sampler's sustain loop) and exponential param ramps (every drum decay, the kick/tom pitch drops). Tests: `nativeSynth.test.ts`, `nativeSamplerDrums.test.ts`. Device selection is unified per §6 (`enumerateDevices`/`onDeviceChange` on the seam, the host PUSHING its list so the proxy answers from cache, selections namespaced per backend since a Web Audio deviceId and a WASAPI endpoint id have no honest translation). The parity run is `crossBackendParity.test.ts` — composition rather than per-primitive: gain chains, fan-in sums, the mixer's track→panner→bus topology, insert chains, reverb's parallel dry path and a full voice path. It caught a real bug on its first run: Web Audio's StereoPanner has two laws and the native engine applied the stereo one to mono material, making hard-panned mono clips 2× too loud) | `native/audiohost` addon (miniaudio device layer, custom graph/param/voice engine, WASAPI shared-IAudioClient3 default + exclusive toggle); audio utilityProcess + MessagePort transport; asset PCM registration with eviction mirroring the existing asset-eviction policy; builtin DSP ports (biquads, spec-matched compressor, delay, partitioned convolution reverb, LFO, synth voice, click) each verified against Web Audio via the phase-0 parity harness; devices/meters unified per sections 3+6. Behind **Settings ▸ Audio ▸ Audio system: Web Audio / Native**, default Web Audio; Electron-only (`window.superdaw?` guard). | Playback through native is parity-clean; toggle flips live with automatic fallback on addon crash | 8–12 wks |
| **3 — Native duplex input** — 🚧 **IN PROGRESS**. Shipped: the addon opens a DUPLEX `ma_device` on demand (`input: true` → `ma_device_type_duplex`, capture channels `0` so a multi-input interface presents all of them), delivering capture frames in the SAME callback that renders output — monitoring is pure in-callback DSP, no second stream and no IPC. A new `input` node kind reproduces `audio/input.ts`'s selection rule exactly (mono duplicates one channel to both sides, stereo takes the pair, out-of-range clamps), including the non-obvious parity detail that its output is ALWAYS 2-channel — the Web Audio tap's merger is a 2-channel node even in mono mode, so a hard-panned monitor must read StereoPanner's stereo law on both backends or it would be half as loud natively (`nativeInput.test.ts` pins the 2× directly). Capture rides a lock-free ring per input node, sized and allocated on the JS thread (the convolver's discipline), drained in 100 ms batches; a reader that falls a whole ring behind loses the OLDEST frames and says so through a jump in the batch's start time, which the recorder pads with silence rather than splicing — a take with a hole is obvious, a take whose second half runs early is not. The seam gained `openInput(config) → {node, channelCount, sampleRate, capture(), dispose()}`, implemented on BOTH backends: Web Audio moved its getUserMedia + stream pool + capture worklet behind it (so `audio/recorder.ts` is now a pure chunks→`Recording` accumulator that both backends feed), and the native proxy round-trips one `openInput`/`inputOpened` pair — the one honest RPC, since opening may have to reopen the stream in duplex and the caller cannot know the channel count until it does. That reopen is why the stream clock now carries a `timeBase` across device handles: WASAPI cannot re-point a live stream, and the transport and every scheduled voice read that clock. `setMonitorSource(trackId, node)` became **`setMonitorInput(trackId, handle)`** — the signature the design flagged as unable to survive the process split; the engine still connects `handle.node` itself, so "the engine owns the connection" holds, while the handle's lifetime stays with `trackInputs`. Calibration re-runs natively unchanged because `calibrationRun.ts` now drives the seam instead of an `AudioContext`; its stimulus plays into a new `outputNode()` (post-fader), which is why the native engine now pre-creates node 0 = output and node 1 = master. Consequences worth knowing: ONE capture device per native session (the first open decides it — per-track selection picks CHANNELS on it, and a later track naming a different device reads the same hardware rather than thrashing the stream on every arm), and the capture side is released when the last input closes, so the OS microphone indicator tells the truth. Remaining: measure mic-to-ear on reference hardware (this machine's shared minimum period is 10 ms, so it cannot demonstrate the 128-frame path), and the UI-facing AnalyserNode surface (plugin spectrum, wire scopes) is still dark natively. | Duplex stream, `openInput` channel taps, in-callback monitoring, capture→`Recording` path, calibration re-run natively; per-track monitor latency finally in the target band | Mic-to-ear < 12 ms measured on reference hardware | 3–4 wks |
| **4 — Default flip + hardening** — 🟡 **PARTIAL**: the xrun health signal is wired (`engine.xruns()` → the status-bar health panel, absent under Web Audio which exposes no such counter), and the live-VST3 door is documented below. The DEFAULT FLIP itself is deliberately NOT done: the exit criterion is a release cycle of real-world soak, which no amount of local testing substitutes for. With phase 3 landed the remaining blocker is soak plus the dark analysis panes (plugin spectrum, wire scopes), which are a visible downgrade to make the default. | Native becomes the Windows default (Web Audio stays as automatic fallback and the browser path); telemetry-free health signals (xrun counters in the meter frame) surface in the status bar; document the door to live VST3-in-callback + PDC as the follow-on project | A release cycle of soak with no elevated crash/fallback rate | 2–3 wks |

### Risks

| Risk | Phase | Severity | Mitigation |
| --- | --- | --- | --- |
| Parity drift — native playback sounds different from bounces (which stay Web Audio) | 2 | High | Parity harness from phase 0: fixture renders diffed numerically per DSP port; tolerance-tested resampler. Treat any audible diff as a release blocker. **Finding (compressor port):** "spec-matched" was optimistic — the spec fixes the shape, not the numbers, and Chromium's `DynamicsCompressorNode` applies an undocumented AUTOMATIC MAKEUP GAIN (+8.2 dB below threshold at −24/12/4), so a textbook compressor would have been audibly wrong. The law was recovered by measuring the real node across a (threshold, knee, ratio) grid and confirmed as `(1/saturate(1))^0.6` over an exponential knee whose `k` solves for slope continuity — predicted vs measured agreeing to three decimals. The native port now matches the STATIC curve within 0.35 dB (`nativeCompressor.test.ts` asserts against the measured Chromium numbers, not against the same formulas the port uses). Residual gap: transient shape, since Chromium's envelope has an adaptive-release refinement this port does not reproduce. Anything else claiming "spec-defined" deserves the same measure-first treatment. |
| Seam refactor regressions (graph lifecycle, teardown, loop scheduling edge cases) | 0 | High | Phase 0 changes no behavior by contract; parity renders pre/post; the windowed-scheduler invariants in `scheduling.ts` stay pure and tested. |
| Driver zoo: shared-mode minimum periods vary wildly; exclusive mode fails or misbehaves per device | 2–3 | High | Negotiate down gracefully (report the *granted* `bufferFrames`); exclusive is opt-in; Web Audio fallback always one toggle away. |
| Addon crash takes down audio mid-session | 2+ | Medium | utilityProcess isolation (pluginScan precedent); supervised restart; automatic fallback to `WebAudioBackend` with a status-bar notice — never a popup. |
| Control-plane jank (renderer GC tail) starves the top-up | 2 | Low | 4 s horizon vs 250 ms cadence = 16× slack; the addon flags horizon underrun in the meter frame so we would *see* it before users hear it. |
| Memory: PCM resident in renderer (AudioBuffers) *and* audio process | 2 | Medium | Reuse the existing asset-eviction policy in the audio process; register lazily (only assets referenced by clips); chunked transfer. |
| Exclusive mode silences other apps / our own renderer audio | 3 | Medium | Shared IAudioClient3 default; exclusive clearly labeled; all app audio already flows through the engine (no stray `<audio>` paths found). |
| Dual-backend maintenance burden — every engine feature lands twice | forever | Medium | The seam keeps feature logic (scheduling, ops, fades math) single-sourced; only DSP primitives and transport are per-backend. Accept it as the cost of keeping export + browser on Web Audio. |
| GPL/ASIO temptation | 4+ | Low | Decided here: no ASIO in shipped builds (`package.json:7` GPL-3.0-or-later vs Steinberg ASIO SDK terms). Documented so it is not re-litigated per release. |

---

## Appendix: things this design deliberately does not change

- `scheduleClips`/`scheduleNotes`/`clipFadeRamps`/`metronomeClicks` — the
  pure scheduling core is the shared brain of both backends, untouched.
- `Transport` — gains nothing but a better clock and a better latency
  number through seams it already has (`setTimeSource`,
  `setOutputLatency`).
- The op/dispatch discipline — the backend is downstream of project
  state exactly as the engine is today; nothing here touches documents,
  sync, or collaboration.
- `ExternalPluginHost` / freeze / windowed VST3 preview — untouched until
  the explicitly-out-of-scope live-inserts follow-on.
- Offline export and the browser build — Web Audio, permanently and by
  design respectively.
