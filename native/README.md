# Native modules

## `vst3host` — VST3 discovery, offline audio, and editor hosting (Windows)

Finds installed `.vst3` bundles, reads the identity of the audio-processor
classes they export (the fields that map onto a `PluginDescriptor`:
format/uid/name/vendor/version), and hosts the plugins themselves:
whole-buffer offline processing (`processBuffer`), persistent instances
whose internal state carries across chunks for look-ahead playback
(`openInstance`/`processInstance`), component state capture, and the
plugins' own native editor windows (`openEditor`), floating or docked over
the app window. The one thing it does **not** do is stream audio in real
time inside the renderer's graph — see "Why offline first" below.

### Prerequisites

- Visual Studio 2022 with the **Desktop development with C++** workload
- CMake (`winget install Kitware.CMake`)
- Python (node-gyp requires it)

### Fetching the SDK

The Steinberg VST3 SDK is **not committed** — it is a ~243 MB third-party
dependency (MIT-licensed as of VST 3.8). Fetch it into `native/vst3sdk`:

```
git clone --recurse-submodules --depth 1 --shallow-submodules \
  https://github.com/steinbergmedia/vst3sdk.git native/vst3sdk
```

### Building

```
cd native/vst3host
npx node-gyp rebuild
```

### Smoke test

Scans this machine's VST3 folders and dumps what it can read:

```
node native/vst3host/smoketest.js
```

### API

- `scanPaths(): string[]` — standard VST3 install locations for this OS.
- `inspect(path): { path, error?, classes: [...] }` — a load failure is
  returned as **data**, never thrown: one broken plugin must not abort a
  scan or take the app down with it.
- `processBuffer(path, uid, { channels, sampleRate, blockSize?, params? })
  -> { channels, inputChannels, outputChannels } | { error }` — runs a
  whole buffer through one plugin, offline. `params` maps parameter id to
  a NORMALIZED 0..1 value, applied at sample 0 of each block.
- `parameters(path, uid) -> { parameters } | { error }` — the plugin's
  parameter list from its `IEditController`, including the plugin's own
  formatted `defaultDisplay` (the plugin owns the mapping from normalized
  to real units, so we never compute it).

For live playback, a plugin must stay alive between chunks:

- `openInstance(path, uid, { sampleRate, blockSize?, channels? })
  -> { handle, inputChannels, outputChannels } | { error }`
- `processInstance(handle, { channels, params? }) -> { channels } | { error }`
- `closeInstance(handle) -> { closed }`

The plugin's internal state CARRIES OVER between `processInstance` calls —
that is the entire point. Verified: feeding a burst then a chunk of pure
silence, MCharmVerb's tail bleeds into the silent chunk (rms 0.005129) and
MDelay's does too (0.000105), where creating the plugin per chunk yields
exact silence. Without this, live playback would click at every chunk
boundary as tails and delay lines reset.

Instances are keyed by an opaque handle and live until closed, so callers
must close them (a leaked instance holds the plugin loaded).

Filter by `canAutomate` for anything user-facing: MSaturator reports 154
non-read-only parameters but only 24 automatable ones — the rest are
internal state a generic parameter UI should not surface.

Not every plugin exposes parameters at all. Polyverse Wider reports zero:
its controls are GUI-only, with settings living in an opaque state chunk.
Such plugins can be added and processed, but only ever at their default
state until plugin GUI hosting or `IComponent::getState`/`setState`
round-tripping exists.

Bus layout is negotiated, not assumed: we request the arrangement matching
the input we have, then **read back** what the plugin actually accepted
(`getBusArrangement`) and size the output to that. A plugin is free to
refuse. Only main buses are active; sidechain/aux inputs stay silent.

### Why offline first

`processBuffer` deliberately processes a whole buffer rather than
streaming, because live playback hits a real architectural wall:

- The renderer runs with `sandbox: true` + `contextIsolation: true`, and a
  sandboxed preload **cannot `require()` a native addon**. So the VST3 code
  must live in the main process.
- `SharedArrayBuffer` cannot cross an Electron process boundary, which
  rules out the usual "native thread writes into a SAB that an
  AudioWorklet reads" design.
- Per-block IPC is not a substitute: a 128-frame block at 48 kHz is 2.7 ms,
  far below a reliable IPC round trip.

Offline processing needs none of that, and it is the shape the existing
freeze/mixdown path already wants (`renderTrackFreeze`,
`src/audio/render.ts`) — where ARCHITECTURE.md already calls freeze "the
plugin-compat foundation". Live playback requires either relaxing the
renderer sandbox or a shared-memory transport, and is its own decision.

### Audio test

Runs a sine through every installed effect and measures what came back —
compiling proves nothing about whether audio actually flows:

```
node native/vst3host/audiotest.js            # all effects
node native/vst3host/audiotest.js MSaturator # one
```
