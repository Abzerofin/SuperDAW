# CLAP and AU hosting — design (C1 shipped; C2+ not yet built)

Status: **phase C1 is implemented** (scanner addon + browse/add
plumbing, see the C1 section); C2–C4 remain design. The document model already reserves both
formats (`PluginFormat = 'builtin' | 'vst2' | 'vst3' | 'clap' | 'au'` in
`src/core/plugins/descriptor.ts`), so nothing in the op pipeline, sync
protocol or `.sdaw` format changes when either lands — a CLAP descriptor
in a project file is already legal today and renders as an ordinary
placeholder on machines that cannot host it. What follows is the hosting
plan, phased the way the native audio backend was
(docs/NATIVE_AUDIO_BACKEND.md): each phase shippable, none blocking the
others.

## Why CLAP first

- **License.** CLAP is MIT-licensed (`clap` headers are a single-vendor
  C ABI, no SDK agreement, no GPL entanglement — the same reason ASIO
  was rejected for the native backend). VST2 is unlicensable for new
  hosts; AU is platform-locked (below).
- **ABI.** CLAP is a plain C ABI (`clap_plugin_entry` exported from a
  DLL/dylib), which drops cleanly into the existing native-addon
  toolchain (`native/`, Node-API + node-gyp) and the existing
  `vst3bridge.h` pattern — a C table passed between addons, callable
  from the realtime audio callback without entering a JS runtime.
- **Ecosystem.** Bitwig, Reaper, FL Studio and a growing set of vendors
  (u-he, Surge, Vital) ship CLAP builds; it is the only modern format a
  collaboration-first DAW can adopt without per-seat licensing
  questions, which matters here because SuperDAW's collaboration model
  already leans on "each machine runs its own installed copy"
  (ARCHITECTURE.md, plugin licensing).

## What already generalizes (no work needed)

These were built for VST3 but are format-agnostic by construction:

- **Identity/resolution.** Descriptors (format+uid+name+vendor+version,
  never paths), `matchDescriptor`'s exact/version/format ladder,
  `formatAlternatives()` asking before cross-format substitution — a
  CLAP build of a plugin the project references as VST3 surfaces as a
  'format' match and is offered, never auto-used.
- **Params.** `paramDefs` snapshots in the descriptor; reducer clamps
  without the plugin; placeholders render sliders; normalized-param
  percentage display (`isNormalizedParam`) — CLAP params are real-valued
  with min/max, so defs snapshot even better than VST3's normalized 0..1.
- **Placeholder / missing / declining flows**, the manifest, the status
  bar, "Find this plugin" (`pluginSearchUrl` already emits the format).
- **Freeze-based sharing**: a frozen track is an ordinary asset, so
  collaborators without the plugin hear identical audio — regardless of
  the insert's format.
- **The export honesty notice** (now format-aware only through
  `pluginRegistry.status`, so a new 'offline'-capable format joins it by
  registering in the same index).

## Phase C1 — scanner addon (`native/claphost`, scan only) — ✅ SHIPPED

The MIT CLAP headers are vendored at `native/clap/include` (with the
LICENSE; unlike the vst3sdk they are small enough to commit, so builds
need no fetch step). `native/claphost` is a minimal Node-API addon whose
`inspect(path)` mirrors vst3host's result shape exactly, which is what
lets ONE scan worker drive both formats: `pluginScanWorker` takes both
addon paths and the parent names each bundle's format
(`bundleFormat(path)` — the extension, the same rule discovery walks
by). Discovery matches `.clap` beside `.vst3`, the default folder list
gained the standard CLAP locations, and the cache/quarantine machinery
is untouched — a crashing CLAP quarantines exactly like a crashing
VST3. Scanned CLAPs surface in the "+" browser under a
"placeholder until hosting lands" heading and add as `format: 'clap'`
descriptors with no paramDefs (reading params would mean instantiating,
which scan-only never does); they are deliberately NOT fed to the
registry's external index, so their status stays honestly 'missing'
rather than claiming the 'offline' (freeze-able) contract C2 will earn.
A happy-path fixture (a real .clap built from the vendored headers) and
the addon's error paths are covered by `src/main/__tests__/claphost.test.ts`
plus the scanner-side unit tests. As designed below, everything else in
the section already held.

- `scan(path) → { plugins: [{ id, name, vendor, version, features }] }`:
  `LoadLibrary`/`dlopen` the `.clap`, resolve `clap_entry`, call
  `init(path)`, enumerate `clap_plugin_factory`, read
  `clap_plugin_descriptor` fields, `deinit`, unload. No instantiation.
- Reuses the EXISTING crash-safe scan machinery verbatim
  (`presume-guilty` persisted quarantine, mtime+size cache, hang
  timeout + respawn) — the scanner host doesn't care what format the
  bundle is; only the probe call differs.
- Default search paths: `%COMMONPROGRAMFILES%\CLAP`, `~/.clap`
  (per-user), plus the VST3 scanner's user-configured extra dirs.
- Output feeds the same external index `PluginRegistry.setExternalIndex`
  consumes today, keyed by descriptor — a scanned CLAP shows as
  status 'offline'-adjacent (see C2 note) and appears in the "+" browser
  with a CLAP tag, addable as a placeholder-backed insert immediately.

Uid convention: `clap:<clap_plugin_descriptor.id>` is NOT needed — the
descriptor's `format` field already scopes uids, so `uid = clap id`
verbatim (reverse-DNS strings like `com.u-he.diva`).

## Phase C2 — offline processing (freeze/mixdown parity with VST3)

Mirror the VST3 out-of-process path exactly, because every seam already
exists:

- `claphost` gains instantiate + `process()` over deinterleaved float32
  block buffers (CLAP's native audio layout — no conversion needed),
  driven from the main process like `ExternalPluginHost.process`.
- `renderTrackFreeze`'s segment renderer (`segmentInserts`) does not
  change: it segments by "who can host this insert", not by format.
  `ExternalPluginHost.has()` answers for both formats.
- State: CLAP `clap_plugin_state` save/load is a byte stream — it rides
  the existing opaque `stateBlob` envelope. The envelope writer/reader
  (`src/main/vst3State.ts`) generalizes by adding a format field to the
  envelope JSON; malformed blobs are already ignored by contract.
- Until C3, live playback uses the existing windowed look-ahead preview,
  which is host-agnostic (it renders through `ExternalPluginHost.open`).
- Status naming: at this point a scanned CLAP is a true 'offline'
  plugin, same word, same UI treatment, same freeze advice in the
  export notice.

## Phase C3 — live processing in the audio callback

The realtime path mirrors `vst3bridge.h` — this is deliberately a
SECOND C table (`clapbridge.h`) rather than a generalized one, because
the two ABIs differ in threading contracts and a shared abstraction
would obscure both:

- audiohost's utilityProcess loads `claphost` beside `vst3host`; the
  bridge table is passed as an opaque pointer with an ABI check on
  arrival (the addons build separately).
- Fixed slot array + per-slot busy flag taken before the pointer read —
  teardown waits out in-flight blocks (same rule as VST3 slots).
- CLAP threading maps cleanly: `process()` on the audio thread,
  params via `clap_host_params.request_flush` / the input-events queue —
  the existing lock-free param ring reuses unchanged.
- PDC: `clap_plugin_latency.get()` feeds the same `audio/pdc.ts` plan;
  latency-changed notifications ride `clap_host_latency.changed` into
  the existing `onLatencyChange` recompute.
- The engine's `externalInsertProvider` grows a format switch — the
  `PluginNodes` shape, graph wiring, bypass and reorder logic stay
  untouched.

## Phase C4 — editor embedding

CLAP GUI (`clap_plugin_gui`) with `CLAP_WINDOW_API_WIN32` maps onto the
existing docked-editor machinery (`EditorHost`, `vst3DockEditor` IPC,
rect tracking, failure → sliders fallback). Param sync is BETTER than
VST3's: CLAP mandates `clap_host_params.rescan`/param events for
GUI-driven changes, so the editor-param-snapshot dance
(`getEditorParams` on close, `restartComponent` nudges) simplifies to
listening to the event stream. Keep the close-time snapshot anyway —
belt and braces, and it keeps the collaborator-without-the-plugin
invariant airtight.

## AU (Audio Units) — platform-gated, not scheduled

AU hosting only exists on macOS (AudioToolbox / `AVAudioUnit`), and
SuperDAW currently builds and tests on Windows; there is no macOS CI or
dev machine in the loop. Decision:

- **Do nothing until a macOS port is real.** The document model already
  tolerates `format: 'au'` descriptors (they render as missing
  placeholders — correct), so projects authored elsewhere degrade
  gracefully today.
- When a macOS target exists, AUv2/v3 hosting slots into the same
  seams as C2/C3 (an `auhost` addon over AudioToolbox; AUv3 is
  out-of-process by design and matches the 'offline' path naturally).
  The scanner equivalent is `AVAudioUnitComponentManager` — no
  sacrificial process needed since enumeration doesn't load code.
- Cross-format resolution already handles the collaboration story: a
  macOS collaborator's AU insert shows on Windows as missing, with the
  CLAP/VST3 build of the same plugin offered via `formatAlternatives`.

## Order of work when picked up

C1 is a weekend-sized, zero-risk increment (scan + browse + placeholder
adds) and immediately useful — projects can reference CLAP plugins
before hosting lands. C2 unlocks freeze-based collaboration parity. C3
is the largest step and depends on nothing outside `native/`. C4 last.
