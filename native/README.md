# Native modules

## `vst3host` — VST3 discovery and metadata (Windows)

Phase 1 of VST3 hosting: finds installed `.vst3` bundles and reads the
identity of the audio-processor classes they export. It deliberately does
**not** process audio yet — it only produces the fields that map onto a
`PluginDescriptor` (format/uid/name/vendor/version), so the existing
registry, resolution ladder and missing-plugin placeholder can work
against real plugins before the real-time audio bridge exists.

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
- `processBuffer(path, uid, { channels, sampleRate, blockSize? })
  -> { channels, inputChannels, outputChannels } | { error }` — runs a
  whole buffer through one plugin, offline.

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
