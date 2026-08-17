# SuperDAW Architecture

SuperDAW is a collaboration-first professional DAW. This document describes
the systems that exist today and the architectural rules that keep future
milestones (audio engine, file bay, real-time collaboration) cleanly
attachable.

## Layering

```
src/core      Pure domain logic. No React, no DOM, no Electron imports.
src/renderer  React UI. Depends on core. Must run in a plain browser
              (Electron APIs are optional, accessed via window.superdaw?).
src/preload   Minimal contextBridge between renderer and main.
src/main      Electron shell. Window management only.
```

Peer layers: `src/audio` (engine), `src/core/session` (sync protocol,
transport-agnostic), and `src/net` (the CollabNetworking abstraction —
relay and LAN transports; the ONLY place the app touches a WebSocket).
All depend on `core` and nothing else in the app. `src/core/relay` holds
the internet relay's pure logic and wire contract, shared with the
standalone relay server in `server/` (a tiny Node process — no database,
sessions in memory only; see docs/NETWORKING.md). The LAN host transport
still lives in the Electron main process (`src/main/collabServer.ts`) and
only moves strings; all session logic runs against abstract MessageSinks.
Audio stays independent from collaboration.

## The operation pipeline (the load-bearing decision)

**Every mutation of project state is a serializable `Operation`** dispatched
through a single `ProjectStore` (`src/core/state/store.ts`). Nothing in the
app edits project state any other way.

```
UI action ──▶ Operation ──▶ ProjectStore.dispatch
                               │
                               ├─ apply(state, op)      pure reducer → new state
                               ├─ invert(state, op)     inverse op → undo stack
                               ├─ describe(state, op)   text → activity feed
                               └─ onOperation listeners → (future) network broadcast
```

Why this architecture:

- **Collaboration by construction.** Real-time sync is "send the op envelope
  to peers; peers dispatch it with source `'remote'` through the exact same
  reducer." Sync is event-based and minimal-bandwidth by design — entire
  project files are never transmitted.
- **Undo/redo for free.** `invert` derives the inverse op from pre-state;
  undo is just dispatching that op. Remote ops are deliberately not undoable
  locally (per-user undo semantics).
- **Activity feed as a byproduct.** The feed observes the op stream; there is
  no separate logging logic to keep in sync.
- **Convergence over strictness.** The reducer drops ops whose targets no
  longer exist (a peer may edit a clip another peer just deleted) instead of
  throwing, so all peers converge.

### Rules for operations

1. Operations are plain JSON-serializable data.
2. `apply` is pure and never mutates; unchanged state is returned by
   reference identity (used to detect no-ops).
3. Every op must have a correct `invert` — enforced by round-trip tests in
   `src/core/ops/__tests__/ops.test.ts`. Add a round-trip test with every
   new op type.
4. Ids (`newId`) are UUID-based so any peer can create entities without
   coordination.
5. One user gesture = one operation. A clip drag renders ephemeral previews
   locally and dispatches a single `clip/move` on release. Intermediate
   motion is presence data (future live-cursor channel), never document ops.

## Document state vs. ephemeral state

| | Lives in | Synchronized? |
|---|---|---|
| Tracks, clips, tempo, names | `ProjectStore` (core) | Yes — as ops |
| Selection, drag previews, scroll, zoom | renderer stores/components | No (presence channel later) |
| Playhead/transport | `src/renderer/src/state/transport.ts` | No (presence channel later) |

Keeping ephemeral state out of the document is what keeps the op stream lean
and the network invisible.

## Audio engine (`src/audio`)

Routing per track: sources (clips/synth, through per-clip fade gains) →
inserts → autoGain (automation) → fader (mute/solo) → panner → the track's
folder bus (folders ARE buses — children physically route through their
folder's chain) or master → analyser → output. Frozen tracks swap their
sources for the pre-rendered freeze asset and bypass inserts + volume
automation (both baked). The engine (`engine.ts`) is independent of React
and of the collaboration layer; it consumes the project store, transport,
and asset store through narrow structural interfaces.

- **Clock authority.** Once an `AudioContext` exists, the engine installs it
  as the transport's `TimeSource`, so the playhead and scheduled audio share
  one clock and cannot drift. Latency compensation rides on top: the DRAWN
  playhead (`transport.displayTicks`, also where playhead-anchored edits
  land) lags the raw clock by the reported output-path latency
  (baseLatency + outputLatency, refreshed live), and recorded takes are
  placed by their first captured sample's clock time — announced by the
  capture worklet — minus that latency, plus the input-path latency the
  platform does not report. That input number comes from loopback
  calibration (Settings ▸ Audio ▸ Measure round-trip latency): a chirp
  played at a known clock time, captured back through a cable or
  speaker→mic, located by FFT matched filter (`audio/calibration.ts`,
  pure + unit-tested; runtime in `calibrationRun.ts`, policy/persistence
  in `state/latencyCalibration.ts`). The stored ROUND TRIP is keyed by
  (input device, output device, sample rate, buffer preference) and reads
  as unmeasured when any change; the applied trim is derived live as
  `roundTrip − currentReportedOutputLatency`, and the manual trim
  (Settings ▸ Audio) survives as an offset on top. Confidence-gated: a
  detection without a clear correlation peak (or unstable across the three
  repeats) is refused, never stored. Scheduling always stays on the raw
  clock.
- **Scheduling** (`scheduling.ts`) is pure math — (state, anchor) → list of
  `(when, offset, duration)` — and fully unit-tested. Playback is
  windowed: a pass queues only sources STARTING inside a ~4 s lookahead
  horizon (`ScheduleWindow`), which a 4 Hz timer extends in slices; an
  admitted source plays to its natural end, so nothing is ever split or
  re-attacked at a horizon seam, and play/seek cost stops scaling with
  song length. Edits tear down and re-queue only the tracks they touch
  (sources are indexed per track); tempo changes, freeze flips and
  live-preview edits still restart the engine wholesale. The
  reference-equality checks on `state.clips`/`state.tempo` — plus an
  audible-fields comparison per clip — guarantee that unrelated ops
  (e.g. renames) never interrupt playback. The metronome uses a small
  lookahead loop because it is unbounded.
- **Mute/solo are gain-level**, not schedule-level, so toggling mid-playback
  is seamless (smoothed with `setTargetAtTime` to avoid clicks).
- **Live instrument path (MIDI).** `liveNoteOn/liveNoteOff/liveAllNotesOff`
  route OPEN-ENDED synth voices (same tone as scheduled playback — the
  voice builders in `synth.ts` are shared; the live variant holds its
  sustain until note-off releases it) into the track's chain, so inserts,
  fader, pan and bus routing all apply. Live voices are independent of the
  transport, capped at 32 with oldest-voice stealing, and die with their
  track or when its synth is switched off. Web MIDI enters through
  `renderer/state/midiInputs.ts` — feature-detected and lazy (plain
  browsers without the API boot untouched), omni-input default, per-track
  device/channel filters riding `trackInputs`, and an `inject()` method
  that runs the exact hardware code path so everything is testable without
  a keyboard. Events go to armed MIDI tracks, else the selected MIDI
  track. Electron grants the `midi` permission in `main/index.ts` (sysex
  denied); the browser build relies on Chrome's own prompt.
- **MIDI recording.** Armed MIDI tracks (the same ● as audio) capture note
  events during the roll — Web MIDI timestamps mapped onto the audio
  clock, placed against what the performer HEARD via output-latency
  compensation — and commit on stop as ONE `clip/create` per take
  (`clip/createMany` when several tracks stop together), built by the pure
  helper `core/ops/midiTake.buildMidiTakeOp`. No new op type, no asset:
  MIDI notes ARE document data (`assetId: null`). Held notes close at the
  take end, clips round up to whole bars (the .mid-import rule), empty
  takes dispatch nothing, and one undo removes the whole take. Record has
  a rebindable shortcut (`transport.record`, default R).
- **Assets** (`assets.ts`) live outside project state; the document
  references them by id only. This split is what later allows instant state
  sync while binaries transfer in the background. Waveform peaks are
  computed once per asset at 120 buckets/second. Decoded memory is
  BOUNDED: `renderer/state/assetMemory.ts` refcounts assets against the
  document (clips + bay + frozen tracks — the save-GC rule) and evicts
  decoded buffers of assets unreferenced past a grace period, plus
  reversed copies no clip plays reversed anymore. Encoded bytes are never
  evicted (they are what saves and transfers read); an undo that
  re-references an evicted asset re-decodes and rehydrates it, and the
  engine re-queues just those tracks.
- AudioWorklet is deliberately deferred: buffer sources + gain graphs are
  the right primitives for clip playback. Worklets arrive with custom DSP
  (mixing/metering) needs.

A long-standing limitation was closed in the `project/setTempo` reducer:
clip `offset` is ticks (tempo-relative), so a tempo change used to move
where trimmed audio starts in its source. The reducer now rescales
un-conformed audio clips' offsets by newTempo/oldTempo (the buffer-second
trim point is exactly invariant; conformed clips already cancel via their
stretch, and MIDI clips correctly stay musical), with the op's `offsets`
list carrying undo's exact pre-values since the derivation rounds to
integer ticks (`setTempoOffsetChanges` in core/ops/apply.ts).

## Plugin architecture (`src/core/plugins` + `src/audio/pluginRegistry.ts`)

**Identity lives in the document; availability is ephemeral.** An insert is
a `PluginInstance` whose `PluginDescriptor` (format/uid/vendor/name/version
— never a filesystem path) identifies the plugin. Each client resolves
descriptors against its own local `PluginRegistry`, so the same project can
run a plugin on one collaborator's machine while showing a placeholder on
another's — with zero document divergence. Placeholders still expose the
plugin's parameters (see "Parameter editing without the plugin" below).

- **Runtime status** (`local | offline | remote | proxy | missing`) is
  computed per client, never stored (`offline` = installed VST3 the main
  process can host out-of-process). A missing plugin bypasses cleanly (engine and
  offline render both skip unresolved inserts) and its instance stays fully
  intact — params, rank, opaque `stateBlob` — so it comes alive the moment
  a matching provider registers (the registry is observable; the engine
  rewires and placeholders swap to live controls automatically). `remote`
  (collaborator streams the processed audio) and `proxy` (rendered stand-in
  plays) are reserved states for the collaboration-streaming milestone; the
  state machine, UI and document model already accommodate them.
- **Parameter editing without the plugin.** Because the reducer clamps
  `plugin/setParam` against the descriptor's `paramDefs` alone — never
  against local availability — a client WITHOUT the plugin computes exactly
  the state a client with it computes. `PluginPlaceholder` therefore renders
  real param sliders from those defs; the op syncs like any other, and the
  engines that can run the plugin push the value into their live nodes (and
  into an open VST3 editor via `vst3:set-editor-param`). No local preview —
  there are no nodes here — so a drag commits on release like any other
  one-gesture-one-op edit. Read-only in three cases: no `paramDefs` snapshot
  (nothing trustworthy to draw), `proxy` (a rendered stand-in cannot answer
  to param changes), and when a peer has declined (below).
- **Normalized params read as percentages.** External formats report every
  parameter as a normalized 0..1 and own the mapping to real units, so
  `externalParamDefs` keeps the units in the LABEL. Rendering the raw value
  under that label gives "Threshold (dB)" above "0.50" — a number that looks
  wrong rather than normalized, and a machine without the plugin cannot ask
  it to format one. `isNormalizedParam` therefore drives a percentage
  readout (and percentage typed entry) while the STORED value stays 0..1,
  which is the plugin's contract. Decided at display time, not capture time,
  so projects saved earlier read correctly too, and narrowed to the exact
  shape `externalParamDefs` emits so a def with genuine units is untouched.
- **Editor param snapshots — why the document knows the truth.** A plugin's
  own GUI can change many parameters without emitting a `performEdit` for
  each; loading a preset is the everyday case. Those edits reach the opaque
  `stateBlob` and nothing else, so `instance.params` would keep reporting
  factory defaults — and a collaborator without the plugin, who can ONLY
  read the document, would see those defaults as if they were real. The
  addon's `getEditorParams` (native/vst3host, beside `setEditorParam`) reads
  the live `IEditController`, and main publishes it as a `plugin/setParams`
  when an editor opens and again beside the chunk when it closes — captured
  before teardown, so the two always describe the same instant. Announcing
  is free when it changes nothing: the reducer returns the identical state
  and `dispatch` drops the op before the undo stack or the wire. This is
  also what makes a complete snapshot safe against the blob: the offline
  host restores `stateBlob` and then applies `params` over it, so an
  accurate snapshot is a no-op rather than a preset-clobbering overwrite —
  which is precisely why params must never be eagerly filled with defaults.
- **Preset loads mid-session.** Open/close alone would leave a preset
  loaded from the plugin's own browser invisible until the editor closed —
  and since VST3s auto-dock, that can be the whole time a track is
  selected. VST3 already has the notification for this: a plugin reporting
  a wholesale change calls `IComponentHandler::restartComponent` with
  `kParamValuesChanged` ("as result of a program change… the host
  invalidates all caches of parameter values and asks the edit controller
  for the current values"). `EditorHost` used to swallow it; it now emits a
  `restart` event and main answers by re-reading and publishing, so the gap
  closes on the plugin's own signal rather than a poll. Only a nudge
  crosses the boundary — never values — because it can arrive on the
  plugin's UI thread mid-restart, so the queued call reads a settled
  controller. A plugin is right to stay SILENT when the host set the state
  (it already knows), so only changes the plugin makes itself notify;
  `native/vst3host/restartnotifytest.js` is the interactive probe.
- **Declining, scoped to non-owners.** Settings ▸ Collaboration →
  `acceptCollaboratorParamEdits` (default on) announces `acceptsParamEdits`
  through `PresenceData`; `collab.paramEditsPermitted()` reports it and the
  placeholder withdraws its controls. This can only ever affect people who
  do NOT have the plugin, because anyone who does gets `PluginSection` and
  never reaches the placeholder — their own copy, their own licence, their
  own full controls. Advisory by construction: the field is additive
  (silence reads as accepting, so mixed-version sessions keep working) and
  nothing is enforced in the reducer, which would break convergence. Plugin
  EULAs vary on whether a non-owner may drive a plugin at all; the launch
  acknowledgement and PLUGIN_LICENSE_TERMS.md put that on the user.
- **Builtins are plugins.** The eleven insert effects register as providers
  (`format: 'builtin'`, uid `superdaw.<type>`) and flow through the same
  descriptor → registry → provider pipeline external formats (VST2/VST3/
  CLAP/AU) will use. Their param defs stay in `core/model/effects.ts`;
  external plugins snapshot `paramDefs` into the descriptor so the reducer
  clamps deterministically on every peer regardless of who has the plugin.
- **No silent substitution.** Resolution ladder: exact (format+uid+version)
  → compatible version (same format+uid) → same vendor/name in another
  format, which `resolve()` never auto-uses — `formatAlternatives()` exists
  so the UI can ask the user first.
- **Descriptors are untrusted input.** A descriptor reaches this client
  from a COLLABORATOR's machine, so its fields are peer-controlled. The
  "Find this plugin" link on a missing insert is therefore built locally
  by `pluginSearchUrl()` — a fixed https origin with the identity as an
  encoded query — and never from a URL carried in the document, which
  would feed attacker-chosen strings (`file:`, protocol handlers,
  phishing) into Electron's `shell.openExternal`. Reading a URL out of the
  installed plugin is not an alternative: the machine that needs the link
  is by definition the one with no plugin to read.
- **The manifest is derived** (`pluginManifest(state)`): distinct
  descriptors in use, their instances and tracks, joined with local status
  in the status bar — never persisted, so it can't drift.
- **Chain order is one op.** A reorder drag previews locally and dispatches
  a single `plugin/reorder` carrying the track's whole insert order. It
  PERMUTES the chain's existing `rank` values rather than renumbering from
  zero, so the rank set is preserved and re-applying the previous order is
  an exact invert. Ids that are unknown or on another track are skipped,
  and chain members absent from `order` keep their relative place at the
  end — so an insert a peer added concurrently is never dropped.

The built-in instruments (analog synth, sampler, drum kit — see their own
section) still live on MIDI tracks (`Track.synth`); folding them into
instrument-plugin instances is a future, separate migration.

### External plugins (VST3) — live under the native backend, offline under Web Audio

VST3 hosting lives in a native addon (`native/vst3host`, Node-API so one
build loads in both Node and Electron). It cannot live in the renderer:
that runs `sandbox: true`, and a sandboxed preload cannot `require()` a
native addon. Nor can the renderer's Web Audio graph reach one across a
process boundary — `SharedArrayBuffer` does not cross it, so the usual
"native thread writes a SAB, an AudioWorklet reads it" design is
unavailable, and per-block IPC is far too slow (a 128-frame block at
48 kHz is 2.7 ms).

**Which is why there are two live behaviours, and which one you get
depends on the audio backend.** Under the native backend the audio
utilityProcess loads vst3host beside audiohost, so a plugin is one
lock-free slot from the realtime callback and runs as an ordinary insert
(next section). Under Web Audio — the default, the browser build, and
every offline render — nothing has changed: external inserts are rendered
at freeze time and previewed through the windowed look-ahead.

So under Web Audio, external inserts are **rendered at freeze time**, which is exactly what
freeze was already for. `renderTrackFreeze` takes an optional
`ExternalPluginHost` (injected, so `src/audio` stays free of Electron and
the browser build simply passes nothing). When any insert needs it, the
chain renders in SEGMENTS: consecutive runs of same-kind inserts, in rank
order — sources, then each segment through either Web Audio or the native
host, then volume automation last. Order is the property that matters, and
`segmentInserts` is unit-tested for it. With no external inserts the old
single-pass route is untouched.

The payoff is that this needs no new sync machinery: a frozen track is an
ordinary asset, so **a collaborator who does not own the plugin hears the
identical audio** through normal asset transfer. Until a track is frozen,
an external insert shows the same placeholder any unavailable plugin does.
The renderer never learns a plugin's filesystem path — it sends a
descriptor uid and main resolves it against its own scan.

**Exports never lie about it.** The mixdown path renders through Web Audio
only, so unfrozen external inserts are bypassed in a bounce — and the
export's one-shot status notice now says so, naming the affected tracks
(with freeze advice where freeze genuinely bakes them). No popup, no
silent dishonest bounce.

**Scanning is crash-safe by presumption of guilt.** Bundle inspection runs
in a sacrificial `utilityProcess` (hang timeout + respawn), results are
cached against an mtime+size stamp of the bundle's binary, and each bundle
is marked under-inspection IN PERSISTED STATE before its DLL loads — so a
plugin that takes the app down mid-scan is already quarantined at the next
launch instead of re-crashing the scanner forever. Quarantine clears via
Refresh Plugins. Plugin GUI state travels as an opaque `stateBlob`
envelope whose single writer/reader is `src/main/vst3State.ts`
(unit-tested against each other; malformed blobs from a hostile document
are ignored, never trusted). And loaded documents get the same hygiene as
routes: `format.ts` sanitizes every plugin instance field-by-field
(descriptor shape, params, blob, rank, track existence) so a doctored
`.sdaw` cannot smuggle malformed plugin state past the reducer.

### Live VST3 inserts in the callback, and plugin-delay compensation

Under the native backend the audio utilityProcess loads BOTH addons, so
the wall above moves: the plugin is in the same process as the realtime
thread, one lock-free slot away instead of behind two seconds of
look-ahead. Design detail lives in NATIVE_AUDIO_BACKEND.md §5; the parts
that shape the app:

- **The bridge is a plain C table** (`native/shared/vst3bridge.h`), not a
  Node-API call: an audio callback cannot enter a JS runtime at all. The
  table is passed between the two addons as an opaque pointer and its ABI
  is checked on arrival, because the addons are built separately and
  nothing otherwise guarantees they were built together. Realtime slots
  are a FIXED array with a per-slot busy flag the callback takes *before*
  it reads the pointer, so closing a plugin waits out an in-flight block
  instead of freeing memory under it.
- **An external insert is an ordinary insert.** It builds through the same
  `PluginNodes` shape the builtins use (`audio/externalInsert.ts`), so
  the engine's chain wiring, bypass, reorder and graph-routing logic are
  untouched. The provider is minted PER INSTANCE, not registered in the
  `PluginRegistry`: the plugin needs the instance's opaque `stateBlob` at
  open time, and the registry's question ("can this descriptor join the
  RENDERER's graph") is still honestly answered `no` — which is what keeps
  freeze, mixdown and the export bypass notice correct.
- **The renderer still never learns a path.** It sends a descriptor uid;
  MAIN pushes the uid → path index to the audio process over the
  utilityProcess's own port, never through the renderer.
- **GUI-only edits reopen the plugin.** Those live solely in the
  `stateBlob`, which a running instance cannot be told about (it is
  restored at open), so a changed blob disposes and rebuilds the insert.
  Params never need this — they are pushed live through a lock-free ring.
- **Plugin-delay compensation** (`audio/pdc.ts`) is new, and exists
  because a plugin can now report latency into a live graph at all. Each
  track chain carries two compensators: one on its own sources and one on
  its output. Two, because a folder's chain input is fed both by its own
  material and by its children, and those need different amounts — the
  children arrive already late by their own plugins. Builtins report
  ZERO, deliberately: they are Web Audio primitives and Web Audio
  compensates nothing for them (not even the compressor's internal 6 ms
  look-ahead), so claiming any here would make live playback disagree
  with a bounce. The total shows up in the engine's reported output
  latency, so the drawn playhead lags with the audio.
- **Licensing is unchanged by this**, and worth saying so explicitly since
  the audible effect moved. Nobody's plugin is operated across the
  network and no processed audio is streamed: a collaborator changes a
  value in the shared document and each machine's own installed copy
  reads it locally, exactly as before — only sooner. `Declining` (Settings
  ▸ Collaboration → `acceptCollaboratorParamEdits`) still applies
  unchanged; it withdraws the placeholder's controls on the non-owner's
  machine, which is upstream of any of this.
- **All three paths agree on alignment.** Live native compensates; freeze
  trims each plugin's reported latency off the head of its segment (a
  bug that had always been there quietly, and is only measurable now that
  latency is read at all); and the Web Audio preview reads its dry window
  that far ahead, which cancels the same delay. The tolerance differs —
  the preview shifts in whole ticks, the other two in samples.

## File Bay & persistence

The bay's folder/asset structure lives IN the project document
(`ProjectState.files`) — organizing files is a collaborative, undoable
edit like any other, driven by `file/*` ops (subtree deletes restore in
one undo; cycle-creating moves are rejected in the reducer). Bay entries
reference assets by id; deleting an entry never touches clips or asset
data. Which folder a user is browsing is ephemeral UI state. Import is
drag-drop OR the OS picker: an Import… toolbar button, a clickable empty
state, right-click menus on tiles/empty space, and a context menu on the
Files dock tab itself — the tab menu drives the bay's own actions through
a one-shot intent channel (`state/bayUi.ts`), so both entry points run
one definition.

Projects save as a single `.sdaw` file: a ZIP of `project.json` (document
+ asset manifest, `src/core/persistence/format.ts` — pure, validated,
version-gated) plus each referenced asset's original encoded bytes.
Unreferenced assets are garbage-collected at save time. Electron shows
native dialogs via IPC (`project:save` / `project:open`); the browser dev
build falls back to download/file-picker. Loading is NOT an operation —
`ProjectStore.loadProject` swaps the document and resets history; the
future network layer will move snapshots through its own join path.

Crash recovery (Electron only): while dirty, `lib/autosave.ts` snapshots
into ONE recovery slot in userData every 20 s (and on window hide) —
`project.json` rewritten when state changed, asset bytes written once each
(immutable by id), everything atomic (`main/recovery.ts`). Each snapshot
rotates the previous two document generations (`project.1.json`,
`project.2.json` — renames, never asset rewrites) and recovery loads the
newest generation that parses, so one corrupt write costs one interval,
not the session. Real saves keep the overwritten file's bytes as
`<name>.sdaw.bak` (best-effort, never blocks the save). The slot clears
on a real save or an explicit user discard — deliberately NOT on opening
another project, so a crashed session's work survives until acted on. The
home screen offers "Recover unsaved project", which loads through the
ordinary open pipeline, reattaches the original path and marks the result
dirty.

## Settings: two scopes, one rule each

Settings split by WHO a value describes, and each scope has exactly one
mutation path:

- **Project scope** (`ProjectState.settings`, `core/model/projectSettings.ts`)
  — decisions every collaborator shares because they are properties of the
  SONG: loudness target (LUFS, with platform presets), default clip
  micro-fades, quantize swing/strength, humanize amount, the default snap
  grid, the default export format. Mutated ONLY through the
  `project/updateSettings` op: a patch of absolute per-field values, so
  re-delivery is idempotent, undo restores the previous values of exactly
  the touched keys, and concurrent edits from two peers resolve per field
  by last-write-wins. The reducer sanitizes every patch deterministically
  (unknown keys dropped, values clamped — the same rule plugin params
  follow), and file loads run stored settings through the same normalizer,
  so a doctored .sdaw cannot smuggle bad values. Additive in format v3:
  older files simply gain defaults.
- **User scope** (`renderer/state/preferences.ts` and friends, via the
  appStorage seam) — personal or machine facts that would be wrong to sync:
  devices, theme, latency hint (the AudioContext buffer-size request,
  injected into the engine as a provider so `src/audio` stays free of app
  state), count-in, tempo-conform policy, autosave cadence, display name,
  UI scale, and the keymap (`state/keymap.ts`: a typed roster of actions
  with default combos + fixed aliases; user overrides persist as
  `appStorage.keymap`, and both the global handler and the piano roll
  resolve keydowns through `keymap.resolve`, so a rebinding applies
  everywhere from one definition — Settings ▸ Keyboard Shortcuts).

Both scopes are edited in one place: the Settings window's Project pane is
the ONE pane that edits the document (each control dispatches a
`project/updateSettings` patch — undoable, in the activity feed, synced),
every other pane edits app state. Export consumes the project's
`exportFormat`/`exportBitDepth` (WAV 16/24-bit or MP3), and each mixdown
measures its integrated loudness (BS.1770, `src/audio/loudness.ts` — pure
math, unit-tested against the spec's calibration tone) and reports the
distance to `loudnessTargetLufs` as a one-shot status-bar notice.

Session templates (`core/persistence/projectTemplate.ts`, `.sdtpl` files)
capture a project's SETUP — track tree, mixer/synth state, insert chains by
descriptor, routing graphs, tempo/signature, project settings — and no
content. Instantiation ("New from template…") validates field-by-field like
the project format and mints fresh ids, so two projects from one template
can never collide (the duplicate-track rule). See docs/SETTINGS_AUDIT.md
for the full audit.

The project's `defaultGrid` seeds each user's ephemeral grid choice at
load; live switching stays per-user, exactly like zoom.

## App-level state (settings, recents, shell)

Everything that describes the APP rather than a project — audio device
selection, the recent-projects index, the home/editor shell state — lives
outside the document and outside `.sdaw` files. Persistence goes through
one seam (`renderer/state/appStorage.ts`): Electron stores a JSON file in
`userData` via `appdata:get/set` IPC; the browser build falls back to
localStorage. A future account system is one new backend behind that seam.

- **Recent projects** (`state/recentProjects.ts`) power the home screen.
  Metadata (name, tempo, signature, duration, track count) is captured
  from the already-loaded `ProjectState` on every save/open — the index
  never parses project files.
- **Audio devices** (`state/audioDevices.ts`): output switches live via
  `AudioContext.setSinkId`; the recorder passes the chosen input as an
  `ideal` deviceId so the platform falls back gracefully. On
  `devicechange` a vanished selection reverts to the default with a
  one-shot status-bar notice (never a popup).
- **Per-track input** (`state/trackInputs.ts`): each track's capture
  device, hardware channel selection (mono channel N / stereo pair) and
  monitoring. Machine-specific by nature — a device id means nothing on a
  collaborator's machine, the same reason descriptors never carry
  filesystem paths — so it stays out of the document and syncs nothing.
  Streams are shared and reference-counted per device; `audio/input.ts`
  builds the splitter/merger tap that selects channels, and the SAME tap
  feeds monitoring (into the track chain, so you hear your own inserts)
  and recording, so what you hear is what gets captured. Monitoring never
  persists across launches and is dropped when a project closes.
- **Shell** (`state/appShell.ts`): home vs. editor view. The home screen
  is the primary launcher; "Return to Home" keeps the project loaded.

## Looping (the cycle region)

Looping is a TRANSPORT feature, not a clip property: a region on the ruler
that playback cycles through, repeating everything inside it. Like the
playhead it is per-user ephemeral state (`state/transport.ts`) — one
collaborator auditioning a chorus must not hijack anyone else's playback —
so it is neither an operation nor part of the document.

Two pieces make it exact:

- **Position** wraps with pure modulo math off the audio clock inside
  `positionTicks()`. Nothing polls, and the drawn playhead can never
  disagree with what is heard. Starting before the region plays the run-up
  once, then cycles.
- **The song loop cycles what is AUDIBLE.** Its wrap point is the end of
  the material on tracks `isTrackEffectivelyAudible` accepts, so soloing a
  section loops that section and a muted tail does not make the loop wait
  on silence. Because the engine pre-schedules a whole iteration, a
  mute/solo change while it runs re-anchors and re-emits a seek so the new
  region is re-queued. An explicit cycle region is the more deliberate
  gesture and still overrides it.
- **Audio** is pre-scheduled per iteration. `scheduleClips`/`scheduleNotes`
  take an `untilTicks` bound, so the engine queues one pass per iteration
  anchored at that iteration's exact wrap time (`AudioEngine.scheduleAll`
  + a lookahead top-up). Because every source already has its precise
  `when`, a late timer tick cannot dent the loop's timing — the seam is
  sample-accurate, not frame-accurate.

The metronome keeps its own anchor and re-syncs when the playhead jumps
back, since it counts beats linearly and only queues ~150 ms ahead.

An earlier per-clip `loop`/`loopLength` model was removed: enabling it set
the period to the clip's own length, so it produced exactly one iteration
and appeared to do nothing. Loading an older project simply drops those
fields.

## Clip playback (reverse / pitch / stretch)

`Clip.reverse`, `Clip.pitch` (semitones) and `Clip.stretch` (time factor)
are document state driven by one `clip/setPlayback` op, so clip editing is
undoable, saved and synced like any other edit. `clipRate(clip)` — pure, in
`core/model/types` — folds pitch and stretch into the single resampling
rate the buffer-source primitives expose, and `scheduleClips` works in
BUFFER seconds (`durationSec * rate` = the clip's timeline window), so
looping, trimming and mid-clip resume all stay correct under resampling.
Reversed clips read a mirrored copy of the ASSET, cached once per asset by
`AssetStore.reversedBuffer` and shared by every clip using it.

**Two playback modes.** Default is resampling, i.e. tape/sampler
behaviour: transposing also changes how fast the material is consumed,
and time-scaling transposes. `Clip.warp` (the clip menu's "Warp (keep
pitch)") switches to the phase-vocoder path: the clip plays a
pre-stretched copy of its source (factor `clipWarpFactor` =
stretch · 2^(pitch/12)) at the pitch-only rate, so stretch re-times
without transposing and pitch transposes without re-timing. The stretch
itself is pure DSP (`audio/phaseVocoder.ts`: STFT with identity phase
locking, unit-tested for pitch/length/level preservation, deterministic
on every machine); warped copies are derived data cached per
(asset, factor) beside reversed copies — computed async and sliced (a
clip is silent until its copy lands, exactly like a transferring asset,
and the store's completion event re-queues it), evicted by the same
policy, never persisted or transferred. The offline renders pre-warm the
cache before building their graphs, so bounces and freezes match
playback. Slicing is the existing `clip/split`.

## Track kinds (audio · midi · drum · folder)

`TrackKind` separates DRUM tracks from melodic MIDI ones. Both are NOTE
tracks — identical clips, notes, `Track.synth` and instrument slot — so
every piece of note logic tests `isNoteTrackKind(track.kind)`, never
`kind === 'midi'`; testing for `'midi'` silently drops drum notes from
scheduling, recording, MIDI routing and the reducer. The kind describes
the MATERIAL, not the controller: a drum track is played perfectly well
by a keyboard or an electronic kit. What the kind actually decides is
where a track starts and how it reads — a drum track is created on the
drum instrument (`DRUM_INSTRUMENT_INDEX`), opens on the step grid, and
carries its own badge and menu wording. Every parameter stays editable
afterwards, including its instrument.

## Built-in instruments (analog · sampler · drum kit)

A note track's instrument is selected by the `instrument` synth param —
all three instruments' params coexist in the one flat `Track.synth`
record (`SYNTH_DEFS`), so switching never loses a knob position and every
control is the existing `track/setSynthParam` op (clamped in the reducer,
undoable, synced — no new op machinery). `instrumentKindOf(synth)` is the
single dispatch key; `audio/instruments.ts` holds the voice builders and
the two dispatch points (`buildInstrumentVoice` for scheduled notes,
`buildLiveInstrumentVoice` for live input), shared verbatim by the engine
and the offline renderer so bounces and freezes sound like playback.

- **Sampler.** Plays `Track.samplerAssetId` (a normal document asset
  reference — counted by `referencedAssetIds`, so save-GC, memory
  eviction and collab transfer all follow; a sample still transferring is
  simply silent, like a clip's asset). KEYS mode resamples chromatically
  from `smpRoot` with start/end region, optional sustain loop and ADSR;
  SLICES mode maps transient slices across the keys from
  `SLICE_BASE_PITCH` (C1). The asset lands via `track/setSampler`, whose
  optional `params` ride along so "drop a sample onto a track" is one op.
  Slice boundaries derive per client from the asset's peak envelope
  (`audio/onsets.ts`, the same detector waveform-peak snapping uses;
  region math in `core/model/slices.ts`) — document data only ever
  references slices by INDEX, so sub-millisecond decode differences
  between machines cannot diverge anything.
- **Drum synth.** Eight synthesized pads on the GM drum pitches
  (`DRUM_PADS`: kick/snare/clap/hats/toms/ride, with GM aliases), four
  params each (`<pad>Tune/Decay/Tone/Level`) generated into `SYNTH_DEFS`.
  Pure Web Audio synthesis (pitch-enveloped sines, filtered noise, the
  clap's stuttered envelope) — no samples, nothing to transfer. Unmapped
  pitches are silent; drum hits are one-shots (live release is a no-op).
- **Step sequencer** (the Editor tab's step form): a drum grid over ONE
  MIDI clip's notes — rows are the kit's pads (or the pitches in play on
  melodic tracks), columns 16th/8th steps. Cells are ordinary `Note`
  entities, so the piano roll, clip previews and collaborators see the same
  edit; a paint stroke commits as ONE `note/addMany`/`note/delete` on
  release (the one-gesture-one-op rule — painting never floods the sync
  stream). Which form the Editor tab wears follows the track's instrument
  (`state/editorUi.ts`: a drum kit gets the grid, anything else the roll);
  the PIANO/STEPS switch in the panel head pins the other form for that
  track and the pin drops when the editor retargets to another one.
- **Slicer.** "Slice at transients" cuts an audio clip in place (one
  `clip/slice`); "Slice to sampler" builds a sliced-sampler track plus a
  clip whose notes replay the original groove via the pure
  `core/ops/sliceToSampler.buildSliceToSamplerOp` — materialized ids,
  shipped as one `track/create`, one undo (the duplicate-track rule).

## Performance pads (the collaborative-DJ surface)

The Pads tab is an 8×8 launchpad. Pad ASSIGNMENTS are document state
(`ProjectState.pads`, `pad/set`/`pad/clear` ops) — a pad's id IS its grid
cell, so two peers assigning one cell write the same entity and converge
by last-write-wins. Pads reference clips/tracks/assets by id and tolerate
targets vanishing (a stale pad is silent, like a bay entry whose asset is
gone); `sanitizePad` is shared by the reducer and the file loader
(routes-grade hygiene). Sample-pad assets count as document references.

TRIGGERING is ephemeral performance, never document state
(`state/padPerform.ts`): sample pads fire one-shots into the master bus,
note pads play a track's instrument through `liveNoteOn` (inserts, fader,
bus routing apply), clip pads toggle a clip loop quantized to the NEXT
BAR — engine-side (`launchClipLoop`), the clip's repeats are queued
through the ordinary schedule math over a derived one-clip state
(`padClipRepeatState`, the track-loop trick), so launches carry fades,
per-clip looping and inserts, survive mid-set document edits (restart
rewinds each loop's repeat counter), and die on transport stop/seek.
Pads are playable by mouse, computer keyboard (bottom four grid rows),
or a MIDI grid controller (notes 36+, claimed from the track-input
router by `midiInputs.setPadSink`). Managing them is right-click:
add/replace the pad's audio through the OS picker (importing into the bay
exactly as a drop would, `browseForAudioAsset`), remove that audio, copy a
pad and paste it onto another cell (the clipboard is per-user UI state —
pasting is an ordinary `pad/set` on the target cell's id), open the pad
editor, or clear the cell.

Hits ride the presence channel (`PresenceData.padHit` — additive, opaque
to relay and host; older builds ignore it): the performer hears their
local echo instantly, peers receive `{hitId, padId, action, velocity}`
and reproduce the sound through their own engine from the shared
assignments — collaborative DJing with zero document traffic. Receipt is
a one-shot callback with an id-keyed dedupe set, never pull-from-render
(audio must fire exactly once).

## Time

Musical time is integer ticks at `PPQ = 960` (`src/core/model/timebase.ts`).
Integer ticks make concurrent edits deterministic across peers and avoid
floating-point drift. Audio-time mapping (tempo maps, seconds) comes with the
audio engine milestone.

## UI conventions

- Dark, dense, professional. All colors come from CSS variables in
  `styles.css`.
- Themes (Settings ▸ Themes, `state/theme.ts`) are app-level and personal —
  never part of a document, never sent to peers. A theme sets two
  attributes on `<html>`: `data-theme` (palette) and `data-shell` (surface
  treatment). Palettes only redefine the existing variables, so nothing
  else in the app knows a theme exists; a shell adds shape on top. The one
  non-plain shell, `analog` (`styles/analog.css`), machines every division
  into hardware grooves on cream panels; it is also where the
  light-background corrections live: styles.css draws a number of
  hairlines, outlines and labels in white, which is invisible on cream,
  and "light" is a property of the shell rather than of any one palette.
  Canvas can't read CSS variables, so the two waveform painters look up
  `--wave-ink` and repaint on theme change. The selection is persisted
  through `appStorage` and mirrored into `localStorage` so the first paint
  is already themed; a stored id from a removed theme falls back to the
  default.
- Track headers show only what is used constantly — name, pan knob, volume
  slider (whose bar doubles as a live per-track meter, painted straight to
  the DOM from one rAF loop so metering never re-renders React), FX,
  mute/solo, plus arm and monitor on audio tracks. Everything else lives
  behind the ⋯ menu, which is the same menu right-click opens: one
  definition, two entry points.
- Compact mode (`state/trackViewUi`) shrinks every row to just the track
  name so many tracks fit on screen. Row height is therefore dynamic:
  `laneH` flows from TimelineView into the header, clips, presence
  overlay and recording regions rather than being a fixed constant.
- Right-clicking a clip opens its editing menu: slice, reverse, pitch,
  length, fit-to-material and colour.
- Timeline is a CSS grid with sticky ruler/headers and absolutely positioned
  clip + playhead overlay layers; geometry constants in
  `components/timeline/geometry.ts`.
- No modal dialogs, no notifications, no loading screens unless a major
  event genuinely requires one.

## Development

```
npm run dev        # Electron app with HMR
npm run dev:web    # renderer only, in a browser (UI development/testing)
npm run typecheck  # strict TS across both tsconfigs
npm run test       # core op-system tests
npm run build      # production build to out/
```

Node is a portable install at
`%LOCALAPPDATA%\nodejs-portable\node-v24.19.0-win-x64` (not on PATH by
default).

Dev builds expose `window.__superdaw` (stores, engine, transport, a
synthetic-MIDI `midi.inject`, and the stress suite). The stress surface
(`__superdaw.stressTest`) covers generation, frame/playback probes,
undo/redo, dispatch throughput, routing graphs, folder nesting, automation
density, dense piano-roll, structural storms, remote at-least-once
double-delivery convergence, op-log folding, and persistence round-trips;
`runAll()` returns a machine-readable aggregate, and results live in
STRESS_TEST_RESULTS.md. A reduced-scale, store-only smoke of the same
scenarios runs headless in CI (`src/core/__tests__/stressSmoke.test.ts`)
so the convergence/fold/undo invariants are pinned forever. Known scaling
guidance from the 400-track run: per-op engine-rewire cost grows
super-linearly, so bulk import/template paths should batch rewires before
anyone raises the comfortable ~100-200-track ceiling.

## Milestone history / roadmap

1. ✅ **Foundation** — op pipeline, undo/redo, activity feed, timeline
   editing (tracks, clips, drag/resize), transport & playhead.
2. ✅ **Audio engine** — Web Audio playback on the audio clock, per-track
   routing with seamless mute/solo, drag-drop audio import, waveforms,
   metronome, master meter.
3. ✅ **File Bay + persistence** — Content-Browser-style bay (folders,
   audio, MIDI) as document state; single-file `.sdaw` projects (zip of
   state + assets) with native save/open dialogs, dirty tracking,
   Ctrl+S/Ctrl+Shift+S/Ctrl+O.
4. ✅ **Collaboration** — host-authoritative op sync with optimistic
   rebase (docs/PROTOCOL.md), proven by simulated-network convergence and
   fuzz tests; LAN sessions over WebSocket with join codes; background
   asset transfer; offline editing with reconnect replay; presence (live
   cursors, middle-click pings, roster). Internet rendezvous is a future
   additive milestone.
5. ✅ **Chat + comments** — conversation lives in the document (syncs in
   sessions, persists in .sdaw files, author names snapshotted). Chat:
   tabbed right dock, unread badge, append-only, deliberately NOT
   undoable and absent from the activity feed. Comments: threads anchored
   to clips/tracks (model supports files) with replies and resolve;
   undoable (thread deletes restore atomically) and surfaced in activity.
6. ✅ **Mixer + automation** — per-track volume/pan and master volume as
   ops; audio graph per track: source → autoGain → fader(mute/solo) →
   panner → master. Volume automation points (normalized, MULTIPLY the
   fader) compile to sample-accurate Web Audio linear ramps. Fader/knob/
   point drags preview live through the engine and dispatch ONE op on
   release. Mixer is a bottom-dock tab beside Files; automation lanes
   expand under tracks (per-user ephemeral visibility).

7. ✅ **Piano roll + MIDI** — notes live in the document, clip-relative
   (moving a clip carries them; shortening clips silences the overhang).
   note/* ops with cascades through clip/track deletes. SMF parser
   (core/midi) turns dropped .mid files into real notes. Built-in
   polyphonic synth (detuned saws → lowpass → ADSR) scheduled like clip
   sources into the same track chains. Piano-roll bottom-dock editor
   (double-click a MIDI clip), mini note previews on clips.

8. ✅ **Recording** — per-track input/channels (see App-level state); arm
   audio tracks (ephemeral, per-user), transport
   record button captures the input device via an AudioWorklet (raw PCM,
   no monitoring path). Stopping encodes a PCM16 WAV, registers it as a
   normal asset + File Bay entry, and creates clips at the record start
   on every armed track — so takes sync to collaborators through the
   standard asset machinery. Live red region shows the take growing.

9. ✅ **Effects + instrument controls** — per-track insert chains (EQ,
   compressor, limiter, delay, reverb) as document state; param metadata
   lives in core (core/model/effects.ts) so the reducer clamps, the
   engine builds nodes, and the UI renders controls from one definition.
   Graph: sources → input → [enabled inserts by rank] → autoGain → fader
   → panner → master; effect node instances persist across unrelated
   changes. Synth params (wave/cutoff/ADSR/detune) live on MIDI tracks.
   FX panel from track headers or mixer strips; knobs preview live and
   dispatch one op on release.

10. ✅ **Workflow audit fixes** — piano-roll hook-order crash fixed +
    app-wide error boundary (a UI crash never loses work); piano roll
    reachable from the transport tab; project rename, drag track reorder,
    clip colors (right-click palette), note velocity editing, editable
    time signature — all as ops with invert tests; clip split/merge ops
    (Ctrl+E) + copy/cut/paste/duplicate (in-memory clipboard, ephemeral);
    snap-grid selector + follow-playhead paging; File menu with New/Open/
    Save/Save As/Export; offline WAV mixdown (`src/audio/render.ts`
    rebuilds the engine graph in an OfflineAudioContext, reusing the same
    scheduling math, synth voice and effect builders); unsaved-changes
    close guard (Electron dialog handshake, browser beforeunload).

11. ✅ **Plugin architecture** — inserts became `PluginInstance`s carrying
    `PluginDescriptor` metadata (see the plugin architecture section):
    `plugin/*` ops, per-client `PluginRegistry` resolution with the four
    runtime states (local/remote/proxy/missing), builtin effects as
    providers, placeholder UI for unavailable plugins, derived plugin
    manifest in the status bar, and `.sdaw` format v2 with transparent
    migration of v1 `effects`. No external hosting yet — the contracts it
    will slot into.

12. ✅ **Internet collaboration** — sessions over a standalone relay
    server (design: docs/NETWORKING.md). Every peer, host included, dials
    the relay; the host stays the authoritative sequencer and the relay
    routes opaque payloads it never interprets. In-memory sessions, short
    join codes (XXXX-XXXX), host/guest resume tokens, host-away grace,
    automatic expiry — no accounts, no database, no project data at rest.
    Inner protocol v2: chunked credit-windowed asset transfers with
    resume, and guest uploads (host = asset hub). Client side: the
    `CollabNetworking` interface (`src/net`) with relay and LAN
    implementations — the UI never sees a WebSocket. LAN sessions remain
    (code length picks the transport in one Join box).

13. ✅ **Professional workflow** — (clip looping shipped here was later
    replaced by the transport cycle region, see above). Pan
    became a rotary knob, and automation gained `param: 'pan'` (0..1 ↦
    −1..+1 linear ramps own the panner while points exist). Duplicate
    track (⧉ / Ctrl+Shift+D) is a fully-materialized `track/create` with
    fresh ids built in core — deliberately NOT a `track/duplicate` op,
    which would mint divergent ids per peer. Home-screen launcher with a
    searchable local recent-projects index; app-level storage seam
    (userData JSON over IPC, localStorage in the browser); audio device
    settings (live `setSinkId` output switch, `ideal` input constraint,
    devicechange fallback + one-shot notice); in-app settings window
    (General + Audio live, other sections stubbed); File menu grew Open
    Recent, Close Project and Return to Home.

14. ✅ **Professional workflow II** — track freeze (`Track.frozenAssetId`
    + `track/freeze`/`unfreeze` ops; the render is an ordinary asset made
    pre-fader by `renderTrackFreeze`, so fader/pan/mute/solo stay live,
    peers receive it via normal asset transfer, and machines missing
    plugins hear the identical audio — the plugin-compat foundation).
    Folder tracks (`kind: 'folder'` + `parentId` on every track; the tree
    derives from flat `trackOrder`, folders are real buses in the graph,
    `track/delete` cascades with a subtree-restoring invert via
    `track/create.descendants`, `track/reorder` re-parents atomically;
    collapse is ephemeral). Track presets (`core/persistence/trackPreset`
    — portable validated JSON of mixer/synth/insert chain by descriptor,
    loaded as a plain `track/create`). Clip fade handles
    (`Clip.fadeIn/fadeOut` + `clip/setFades`; raised-cosine envelopes,
    pure math shared by engine and mixdown; a clip's audio source AND its
    synth voices run through one fade gain per clip, so MIDI tapers like
    audio; split/merge carry fades so inverts reconstruct exactly). Ruler modes (bars · min:sec · samples,
    ephemeral). Project metadata (`createdAt` in the document; recents
    index derives duration/plugin count/missing assets/compat at
    save/open). Command palette (Ctrl+P; entries derived from the
    document, actions reuse the same functions as menus). Health panel
    (status-bar popover of read-only observers: loop lag, heap, engine
    latency, collab transfers, missing assets, plugin compat). Routing
    visualizer (read-only derivation of a track's actual signal path
    through inserts and folder buses to master).

16. ✅ **Offline copy merge** — every project carries a `ProjectLineage`
    (stable `projectId` + origin snapshot) and the trailing op log
    (`ProjectStore.opLog`, deduped by envelope id, folded into the origin
    past 20k ops), persisted in `.sdaw` format v3. `core/merge` combines
    two copies of one project by replaying the union of their logs
    chronologically from the earliest origin through the ordinary
    reducer — per-field last-write-wins falls out of one-gesture-one-op,
    structural conflicts resolve by the convergence rule. Collab welcome
    carries the host's `projectId` so copies saved by any participant
    share lineage and can merge later (File → Merge from copy…, disabled
    during a live session).

17. ✅ **Per-clip looping, second take** — `Clip.loopLength` (period in
    ticks, 0 = off; `clipSegments()` in audio/scheduling is the single
    definition of tiling shared by engine, offline render and previews).
    The gesture is a stack of right-edge handles: ↻ (top) drags out
    repeats — one `clip/resize` carrying `loopLength`, pulling back to one
    repeat unloops; ↔ (middle, audio only) time-stretches — the same op
    carrying `stretch` (longer = slower/lower, tape-style; stretching a
    looped clip scales the period so the repeat count is preserved); trim
    (bottom) keeps plain resize, loop and stretch untouched. Waveforms/
    note previews tile per repeat with dashed dividers and ↻×N / ×S
    badges; audio and MIDI both repeat. Legacy boolean-loop files migrate
    (enabled keeps its period). Splitting a looped clip keeps the period;
    the right half re-anchors within the pattern.

18. ✅ **Workflow batch III** — peak-hold meter remnants (track slider +
    master meter, 1 s hold, painted in the existing rAF loops); per-track
    loop audition (`AudioEngine.setTrackLoop`: ghost repeats of one
    track's material via `trackLoopRepeatState` derived states through the
    ordinary schedule math, topped up on a lookahead timer — ephemeral,
    per-user, inactive while the cycle region runs); bare-letter shortcuts
    (S slice · M mute · I monitor · L track loop · D/Shift+D duplicate
    clip/track · Shift+A contextual select-all · Q quantize · H humanize —
    quantize/humanize are one absolute `note/moveMany` per press, jitter
    resolved before dispatch); tempo conform (`project/setTempo` grew an
    optional `conform` stretch list — ask/always/never preference with a
    don't-ask-again panel, plus per-track "Stretch audio to tempo");
    double-click trim handles restore the trimmed material; middle-button
    policy (hold-drag pans any `[data-pan]` panel, plain click pings,
    toggleable in Settings); grouped asset-download prompt (auto-download
    off by default, Settings ▸ Collaboration); collapsible FX cards
    (ephemeral); basic filter effects (low/high/band-pass, notch) + LFO
    tremolo as builtins; movable graph terminals
    (`track/setGraphTerminal`, positions on the Track); insert-parameter
    automation (`AutomationPoint.instanceId` — lanes pick any insert
    param, curves own the knob during playback via a 50 ms sampling timer
    live and sampled `apply` calls in offline renders, cascading with
    `plugin/remove`); VST3 editors now RECEIVE remote param ops
    (`vst3:set-editor-param` closes the peer-edit → stale-editor-state
    clobber gap).

19. ✅ **Workflow batch IV** — routing graph gained Ctrl+wheel zoom, a
    middle-drag pan surface and an inline "+ Add effect" browser (the "+"
    card extracted to `fx/AddPluginCard.tsx` with a compact toolbar mode);
    track headers gained an automation-lane toggle; a Save & Exit button
    sits left of File; the BPM field is draggable (preview locally, ONE op
    through the same conform flow on release; click still types); the two
    return-to-start buttons merged into one whose mode right-click
    switches; chat + activity panels start hidden with corner bubbles on
    their buttons (chat: dot, activity: count of ops since last viewed —
    `panels.unreadActivity`); the piano roll gained a sticky clip-absolute
    ruler with the arrangement ruler's gestures (scrub, Shift+click
    marker, loop-region strip).

20. ✅ **Workflow batch V** — per-ITEM history: `clip/restore` /
    `track/restore` / `plugin/restore` ops (absolute field sets, invert =
    current fields) fed by an ephemeral `state/itemHistory` store that
    reference-diffs adjacent immutable states per op (snapshots are shared
    references — no copying) and surfaces in the clip menu, track menu and
    FX cards; waveform-peak snapping (transient onsets derived once per
    asset from the existing peak envelopes; a clip drag snaps its
    transients onto other clips' transients when closer than the grid,
    with a guide line); live wire oscilloscopes on the routing graph (each
    wire draws the audio leaving its source node — the effects' existing
    analyser taps plus a lazy track-input tap); the piano roll became a
    WHOLE-TRACK editor in absolute song time (every MIDI clip of the track
    visible and editable side by side, per-clip end handles, dead regions
    between clips, add-note targets the clip under the pointer, scrolls
    freely across the song); the Exit button asks Save / Save As / Don't
    Save / Cancel in-app.

21. ✅ **Autosave + crash recovery** — periodic dirty-state snapshots into
    a single userData recovery slot (document JSON per change, asset bytes
    once each, atomic via the shared `writeFileAtomic`); home-screen
    "Recover unsaved project" offer; slot cleared by real saves and
    explicit discards only. See File Bay & persistence.

22. ✅ **Settings systems** (audit: docs/SETTINGS_AUDIT.md) — Project pane
    in Settings, the one document-editing pane (`project/updateSettings`
    per gesture): loudness target with platform presets, quantize
    swing/strength/humanize, default micro-fade/grid, export format +
    16/24-bit WAV depth (new `exportBitDepth` field + PCM24 encoder, both
    consumed by mixdown and track exports). BS.1770 integrated-loudness
    measurement of every bounce, reported against the target in the status
    bar (`audio/loudness.ts`). Rebindable keyboard shortcuts
    (`state/keymap.ts` + Shortcuts pane; global handler and piano roll
    resolve through one keymap). Session templates (`.sdtpl` — setup
    without content, fresh ids at instantiation; File ▸ Save as
    template… / New from template…). Autosave generations (3 rotated
    recovery docs, newest-parseable wins) and `.sdaw.bak` on overwrite.
    UI scale preference (75–150 %).

23. ✅ **MIDI input** — live play + record. Web MIDI seam
    (`state/midiInputs.ts`: lazy, feature-detected, omni default,
    per-track device/channel filters, `inject()` test seam), Electron
    `midi` permission handlers, open-ended live synth voices through the
    engine's `liveNoteOn/liveNoteOff` API (32-voice cap, oldest-steal),
    MIDI track arming + punch-in, takes committed as ONE `clip/create`
    per track via the pure `core/ops/midiTake.buildMidiTakeOp` (no new op
    type, no asset), rebindable record shortcut (R), MIDI input selector
    in Settings ▸ Audio. Verified end-to-end hardware-free via synthetic
    injection.

24. ✅ **Plugin hardening** — load-time plugin sanitization in `format.ts`
    (descriptor shape via shared `isPluginDescriptor`, reducer-identical
    param clamping, blob/rank/track hygiene — routes-grade validation for
    plugins), `stateBlob` envelope contract extracted to
    `main/vst3State.ts` with writer↔reader tests, crash-safe presume-
    guilty scan quarantine (persisted before each bundle loads), honest
    export notices naming tracks whose VST3 inserts were bypassed, docked-
    editor retry.

25. ✅ **Stress coverage** — scenarios for routing DAGs, folder nesting,
    automation density, dense piano-roll, structural storms, remote
    at-least-once double-delivery convergence, op-log folding, and
    persistence at scale; real measurements in STRESS_TEST_RESULTS.md
    (2026-08) including a 401-track run; headless CI smoke
    (`stressSmoke.test.ts`) pinning the correctness invariants; fabricated
    metrics removed.

26. 📐 **Native low-latency backend — designed, not built**:
    docs/NATIVE_AUDIO_BACKEND.md (IAudioBackend seam, miniaudio/WASAPI
    route with ASIO rejected on GPL grounds, utilityProcess placement,
    five shippable phases starting with zero-native seam extraction and a
    loopback latency-calibration feature that ships on Web Audio first).

27. ✅ **Instruments & performance** (see the built-in instruments and
    performance pads sections) — the sampler (KEYS/SLICES modes,
    `Track.samplerAssetId` + `track/setSampler`), the 8-pad drum synth
    (all params riding the existing synth-param ops via extended
    `SYNTH_DEFS`), the Steps drum-grid editor over ordinary notes
    (one-op paint strokes), the transient slicer ("Slice at transients"
    in place, "Slice to sampler" via `core/ops/sliceToSampler`), and the
    8×8 performance-pad grid (`ProjectState.pads` + `pad/*` ops,
    cell-keyed LWW convergence; triggering via `state/padPerform` with
    engine-side one-shots and bar-quantized clip launches; hits broadcast
    as `PresenceData.padHit` so collaborators hear the set). Instrument
    voices dispatch through `audio/instruments.ts`, shared by engine and
    offline render; onset detection extracted to `audio/onsets.ts`.
    Dock layouts now ADOPT panels added after the layout was saved
    instead of resetting.

28. ✅ **Workflow batch VI** — the song loop now wraps at the end of the
    AUDIBLE material: `songEndTicks()` skips clips on tracks
    `isTrackEffectivelyAudible` rejects, so soloing a chorus cycles the
    chorus and muting a long tail stops the loop waiting on silence
    (cached on the clips AND tracks identities; a mute/solo mid-cycle
    re-anchors and re-emits a seek so the engine re-queues the new
    region — an explicit cycle region still wins). The piano roll follows
    the track selection like the Effects dock does (`pianoRollUi`
    subscribes to `selection`; only while the roll is open, and only to a
    track that HAS MIDI — selecting an audio track leaves the editor up
    rather than blanking it). Chord guide in the roll (`lib/chords.ts`:
    32 shapes × 12 roots): picking one lights every key of the chord in
    every octave — bands across the lane, bars down the keyboard — a
    guide, not a note generator, so it touches no document state. The
    frozen ❄ badge became the unfreeze button. BPM and time signature
    grew ▾ quick-picks of the common values, both running the same code
    path typing or dragging does (tempo picks still go through the
    stretch-audio conform flow).

29. ✅ **Editor unification & pad management** — the Piano and Steps tabs
    became ONE Editor panel that takes the form the track's instrument
    calls for (`state/editorUi.ts` replaces `pianoRollUi`/`stepSeqUi`;
    persisted dock layouts migrate the two legacy ids onto the surviving
    tab's position, `LEGACY_PANEL_IDS`). Pressing anywhere in the timeline
    ruler grabs the playhead and keeps scrubbing — no need to hit the cap —
    and the cursor snaps to the grid like every other timeline drag (Grid:
    Off scrubs freely). Pads gained a right-click menu: add/replace audio
    through the OS picker (the file lands in the bay, as a drop would),
    remove the audio, copy/paste a pad onto another cell, edit, clear. The
    app version sits under the brand on the home screen and in the
    transport bar (`__APP_VERSION__`, a build-time define).

30. ✅ **Audio backend seam** (NATIVE_AUDIO_BACKEND.md phase 0) — the
    engine no longer touches AudioContext/AudioNode directly: every node,
    connection, param ramp, buffer voice and meter tap goes through
    `IAudioBackend` (`audio/backend.ts`), whose serializable currency
    (integer ids, named buffers, ParamEvent lists) is what the native
    addon will implement over a MessagePort. `WebAudioBackend` adapts
    today's graph; `backend.webAudio` is the documented escape hatch for
    the pieces later phases port (effect builders + instrument voices →
    phase 2, monitor/capture → phase 3, decode + UI analysers). The
    metronome click became two pre-rendered buffers. Verified three ways:
    the parity harness (`audio/parity.ts` — fixture render through the
    live engine against a patched OfflineAudioContext, diffed within
    tolerance against the committed pre-refactor baseline
    `parityBaseline.ts`; the DSP noise sources were seeded to make this
    possible), headless command-stream tests against a MockBackend
    (`backend.test.ts`), and a live playback smoke. Asset buffers are
    ADOPTED zero-copy and released alongside assetMemory eviction
    (`pruneAdoptedBuffers`), so decoded memory stays bounded.

31. ✅ **Tempo & warp** — the trim-point fix (see the audio-engine
    section's tempo note: `project/setTempo` preserves un-conformed audio
    clips' physical trim points, with exact undo via the op's `offsets`
    list) and formant-preserving stretch (`Clip.warp` + the
    phase-vocoder path — see Clip playback). New op coverage: derived
    rescale/exemptions/idempotency/rounding-exact undo for setTempo;
    warp round-trips on `clip/setPlayback`; warped schedule math; DSP
    pitch/length/level preservation; an end-to-end engine check
    (`parity.ts runWarpCheck`: warp+stretch 2 renders 2× longer at the
    same 440 Hz).

32. ✅ **Loopback latency calibration** (NATIVE_AUDIO_BACKEND.md phase 1)
    — Settings ▸ Audio measures the true round-trip: three exponential
    chirps played at known clock times, captured through the recording
    worklet, located by FFT matched filter with peak-to-sidelobe
    confidence gating and median-of-3 + spread refusal. Result keyed to
    the device setup that produced it, invalidates itself on any change,
    feeds recorded-take placement automatically (manual trim demoted to
    an offset on top). Pure DSP in `audio/calibration.ts` (unit-tested);
    the runner takes an injectable stimulus sink so the loop verifies
    hardware-free (an in-context DelayNode reads back exactly).

33. ✅ **Native duplex input** (NATIVE_AUDIO_BACKEND.md phase 3) — the
    audio addon opens a duplex `ma_device` on demand (only once a track
    actually arms, so the OS's microphone indicator stays honest), and
    capture frames arrive in the SAME callback that renders output:
    monitoring is pure in-callback DSP, no second stream, no IPC. A new
    `input` node kind reproduces `audio/input.ts`'s channel-selection rule
    (mono duplicates one channel to both sides, stereo takes the pair);
    capture itself rides a lock-free ring per input node, drained in
    100 ms batches, with a reader that falls a whole ring behind losing
    the OLDEST frames and saying so through a jump in the batch's start
    time — the recorder pads that gap with silence rather than splicing.
    The seam gained `openInput(config) → {node, channelCount, sampleRate,
    capture(), dispose()}` on BOTH backends (Web Audio moved its
    getUserMedia + capture worklet behind the same call), and
    `setMonitorSource(trackId, node)` became `setMonitorInput(trackId,
    handle)` — the one engine signature the native design flagged as
    unable to survive the process split. The native engine now
    pre-creates node 0 = output and node 1 = master (the loopback
    calibration's stimulus plays post-fader), which is the split
    milestone 34's PDC compensators and external inserts hang off of.
34. ✅ **Live VST3 inserts + plugin-delay compensation**
    (NATIVE_AUDIO_BACKEND.md phase 5) — the audio utilityProcess loads
    BOTH native addons, so an external insert is processed inside the
    realtime callback instead of behind the 2-second windowed preview.
    `native/shared/vst3bridge.h` is the plain C table audiohost's callback
    calls (napi cannot be called from an audio thread); slots are a fixed
    array with a per-slot busy flag, so a teardown waits out an in-flight
    block rather than freeing under it. Two new node kinds: `external`
    (the plugin call, bypassing when no slot is bound) and `pdc` (an exact
    integer delay — separate from `delay`, whose read side is clamped to a
    block to resolve feedback cycles). PDC itself is `audio/pdc.ts`: each
    chain carries a source compensator and an output compensator, because
    a folder's own material and its children's need different amounts.
    Only the native backend can do any of this, so the two live
    behaviours are kept honest by aligning all three paths — live native
    (PDC), freeze (trims each plugin's reported latency) and the Web Audio
    preview (reads its dry window that far ahead).

35. ✅ **Comping / take management** — recording several passes over one
    region and choosing between them. Model: additive `Clip.takeGroupId` /
    `Clip.takeActive` (canonical form: membership only as a non-empty
    string, the active flag only as `true`; absent = an ordinary clip, so
    older files need no migration). Clips on ONE track sharing a group are
    alternative takes; the INTENT is exactly one active per group, but the
    reducer tolerates divergence and playback resolves it per clip:
    `isClipTakeAudible` — a member sounds iff `takeActive` is true, so
    concurrent edits that leave several actives play them ALL until the
    next `take/activate` converges the group (never silent by accident).
    Implemented in the PURE schedulers (`scheduleClips`/`scheduleNotes`
    skip inactive takes), and inactive takes never extend `songEndTicks`
    or `trackLoopSpan`. Ops: `take/activate { groupId, clips }` (absolute
    flags for every member — one click, one op, whole-group LWW) and
    `take/setGroups { entries }` (absolute per-clip membership+flag; the
    group/ungroup gestures and every take invert; the reducer keeps groups
    on one track). Recording comps through the shared pure
    `core/ops/takes.takeCompForClip` — audio and MIDI identically: a take
    recorded over existing material joins/forms the group under it as THE
    active take while every other member deactivates, carried INSIDE the
    existing one-op-per-take commit via an optional `takes` stamp list on
    `clip/create`/`createMany` (inverts ride `clip/delete`/`deleteMany`
    the way plugin/add's severedRoutes pair with restoreRoutes), so one
    undo removes the take and restores the previous active. Flatten is
    `clip/deleteMany { takes }` (keep one, delete the rest, clear
    membership — one op, one undo); splitting a take keeps both halves in
    the group (`clip/split.rightTake` lets merge inverts restore exact
    fields); duplicate-track remaps group ids like clip ids. UI: a T2/3
    badge on members (click = fold/unfold), per-user ephemeral take-lane
    expansion (`state/takeLanesUi`, riding the laneH row plumbing like
    automation lanes) with one sub-lane per take — click a take = ONE
    `take/activate`, inactive takes drawn dimmed — and clip-menu entries
    (Use this take · Flatten takes (keep this take) · Ungroup takes ·
    Group as takes on overlapping loose clips). Persistence follows
    warp/freeLength: junk collapses to absent, round-trip is identity.

Roadmap beyond: the native backend phases
(docs/NATIVE_AUDIO_BACKEND.md), collaborator audio streaming +
proxy renders for remote/missing plugins, autotune/pitch correction (dedicated
AudioWorklet DSP milestone: pitch detection + PSOLA resynthesis),
per-strip metering + live LUFS on the master, sustain-pedal (CC64) and
MIDI activity indicators, engine rewire batching for bulk import/template
paths (the 400-track ceiling, STRESS_TEST_RESULTS.md), mid-take tempo-
change/loop-wrap capture mapping, packaging polish (icon, signing,
auto-update), master-bus effects, track height adjustment, relay
deployment (TLS, public host) + relay accounts/persistence per
docs/NETWORKING.md §15.
