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

Peer layers: `src/audio` (engine) and `src/core/session` (sync protocol,
transport-agnostic). Both depend on `core` and nothing else in the app.
Networking stays independent from UI: the WebSocket relay lives in the
Electron main process (`src/main/collabServer.ts`) and only moves strings;
all session logic runs against abstract MessageSinks. Audio stays
independent from collaboration.

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

Routing: clip sources → per-track `GainNode` → master `GainNode` → analyser
→ output. The engine (`engine.ts`) is independent of React and of the
future collaboration layer; it consumes the project store, transport, and
asset store through narrow structural interfaces.

- **Clock authority.** Once an `AudioContext` exists, the engine installs it
  as the transport's `TimeSource`, so the playhead and scheduled audio share
  one clock and cannot drift.
- **Scheduling** (`scheduling.ts`) is pure math — (state, anchor) → list of
  `(when, offset, duration)` — and fully unit-tested. All upcoming clip
  sources are (re)scheduled in one pass on play/seek/audible-edit; the
  reference-equality checks on `state.clips`/`state.tempo` guarantee that
  unrelated ops (e.g. renames) never interrupt playback. The metronome uses
  a small lookahead loop because it is unbounded.
- **Mute/solo are gain-level**, not schedule-level, so toggling mid-playback
  is seamless (smoothed with `setTargetAtTime` to avoid clicks).
- **Assets** (`assets.ts`) live outside project state; the document
  references them by id only. This split is what later allows instant state
  sync while binaries transfer in the background. Waveform peaks are
  computed once per asset at 120 buckets/second.
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
- **The manifest is derived** (`pluginManifest(state)`): distinct
  descriptors in use, their instances and tracks, joined with local status
  in the status bar — never persisted, so it can't drift.

The built-in synth still lives on MIDI tracks (`Track.synth`); folding it
into an instrument-plugin instance is a future, separate migration.

## File Bay & persistence

The bay's folder/asset structure lives IN the project document
(`ProjectState.files`) — organizing files is a collaborative, undoable
edit like any other, driven by `file/*` ops (subtree deletes restore in
one undo; cycle-creating moves are rejected in the reducer). Bay entries
reference assets by id; deleting an entry never touches clips or asset
data. Which folder a user is browsing is ephemeral UI state.

Projects save as a single `.sdaw` file: a ZIP of `project.json` (document
+ asset manifest, `src/core/persistence/format.ts` — pure, validated,
version-gated) plus each referenced asset's original encoded bytes.
Unreferenced assets are garbage-collected at save time. Electron shows
native dialogs via IPC (`project:save` / `project:open`); the browser dev
build falls back to download/file-picker. Loading is NOT an operation —
`ProjectStore.loadProject` swaps the document and resets history; the
future network layer will move snapshots through its own join path.

## Time

Musical time is integer ticks at `PPQ = 960` (`src/core/model/timebase.ts`).
Integer ticks make concurrent edits deterministic across peers and avoid
floating-point drift. Audio-time mapping (tempo maps, seconds) comes with the
audio engine milestone.

## UI conventions

- Dark, dense, professional. All colors come from CSS variables in
  `styles.css`.
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

8. ✅ **Recording** — arm audio tracks (ephemeral, per-user), transport
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

Roadmap beyond: VST3 hosting (native module; first consumer of the
provider/`stateBlob` contracts), collaborator audio streaming + proxy
renders for remote/missing plugins, autotune/pitch correction (dedicated AudioWorklet DSP
milestone: pitch detection + PSOLA resynthesis), effect reordering UI,
per-strip metering, internet rendezvous for join codes, packaging polish
(icon, signing, auto-update), multi-clip/multi-note selection, loop/cycle
region, master-bus effects, track height adjustment, count-in/punch
recording, input monitoring.
