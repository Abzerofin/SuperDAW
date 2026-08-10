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
  capture worklet — minus that latency, plus a manual input trim
  (Settings ▸ Audio) for the unreported mic→buffer path. Scheduling always
  stays on the raw clock.
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

Known limitation (accepted until tempo maps/warping): clip `offset` is in
ticks, so a tempo change rescales where trimmed audio starts in its source.

## Plugin architecture (`src/core/plugins` + `src/audio/pluginRegistry.ts`)

**Identity lives in the document; availability is ephemeral.** An insert is
a `PluginInstance` whose `PluginDescriptor` (format/uid/vendor/name/version
— never a filesystem path) identifies the plugin. Each client resolves
descriptors against its own local `PluginRegistry`, so the same project can
be fully editable on one collaborator's machine while showing placeholders
on another's — with zero document divergence.

- **Runtime status** (`local | remote | proxy | missing`) is computed per
  client, never stored. A missing plugin bypasses cleanly (engine and
  offline render both skip unresolved inserts) and its instance stays fully
  intact — params, rank, opaque `stateBlob` — so it comes alive the moment
  a matching provider registers (the registry is observable; the engine
  rewires and placeholders swap to live controls automatically). `remote`
  (collaborator streams the processed audio) and `proxy` (rendered stand-in
  plays) are reserved states for the collaboration-streaming milestone; the
  state machine, UI and document model already accommodate them.
- **Builtins are plugins.** The five insert effects register as providers
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

The built-in synth still lives on MIDI tracks (`Track.synth`); folding it
into an instrument-plugin instance is a future, separate migration.

### External plugins (VST3) — hosted, but only offline

VST3 hosting lives in a native addon (`native/vst3host`, Node-API so one
build loads in both Node and Electron) running in the MAIN process. That
placement is forced: the renderer runs `sandbox: true`, and a sandboxed
preload cannot `require()` a native addon. It also rules out live
streaming — `SharedArrayBuffer` does not cross an Electron process
boundary, so the usual "native thread writes a SAB, an AudioWorklet reads
it" design is unavailable, and per-block IPC is far too slow (a 128-frame
block at 48 kHz is 2.7 ms).

So external inserts are **rendered at freeze time**, which is exactly what
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

**These are resampling, i.e. tape/sampler behaviour**: transposing also
changes how fast the material is consumed, and time-scaling transposes.
Formant-preserving independent stretch needs the PSOLA/phase-vocoder
worklet the roadmap defers to its own DSP milestone; the UI says so rather
than implying otherwise. Slicing is the existing `clip/split`.

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

Roadmap beyond: VST3 hosting (native module; first consumer of the
provider/`stateBlob` contracts), collaborator audio streaming + proxy
renders for remote/missing plugins, autotune/pitch correction (dedicated AudioWorklet DSP
milestone: pitch detection + PSOLA resynthesis),
per-strip metering, packaging polish
(icon, signing, auto-update), multi-clip/multi-note selection, loop/cycle
region, master-bus effects, track height adjustment, count-in/punch
recording, input monitoring, relay deployment (TLS, public host) + relay
accounts/persistence per docs/NETWORKING.md §15.
