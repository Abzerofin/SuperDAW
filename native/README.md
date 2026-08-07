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
