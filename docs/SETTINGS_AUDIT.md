# Settings audit — 2026-08

A full audit of SuperDAW's settings systems against what a working producer
expects from Ableton / Logic / Studio One / Reaper, followed by the upgrades
implemented in this pass. The architectural frame (two scopes, one mutation
path each — see ARCHITECTURE.md "Settings") was already right; the findings
were almost all about REACH: a complete, tested project-settings op layer
that no UI ever dispatched.

## How settings are scoped (unchanged, now fully exercised)

| Scope | Lives in | Mutation path | Examples |
|---|---|---|---|
| **Project** (properties of the SONG) | `ProjectState.settings` (`core/model/projectSettings.ts`), saved in `.sdaw`, synced | `project/updateSettings` op — absolute per-field patch, idempotent, per-field LWW, undoable | loudness target, quantize feel, default grid, export format/bit depth |
| **User/app** (properties of a PERSON or MACHINE) | `appStorage` seam (userData JSON in Electron, localStorage in the browser) | store setters, no ops, syncs to no one | devices, theme, latency hint, autosave cadence, keymap, UI scale |

The scope test that decided every call below: *would this value be wrong on
a collaborator's machine?* If yes → user scope. If it changes what the song
IS or how it bounces → project scope.

## Findings and actions by area

### 1. Audio engine

**Current:** buffer size via `latencyHint` (the only knob the Web Audio
platform exposes; `'balanced'` is a valid `AudioContextLatencyCategory` — an
earlier concern that it wasn't turned out false), live output-device switch
via `setSinkId`, `ideal` input constraint with devicechange fallback, manual
input-latency trim (±250 ms), read-only engine panel (rate, channels, real
buffer size in frames), automatic output-latency compensation of the drawn
playhead. Health panel shows engine latency and loop lag.

**Gap:** sample rate is not selectable (the context runs at the device
rate — also the reason every asset decodes exactly once; a rate CHOICE
would force resampling). No ASIO: Chromium's WASAPI path is what exists
until a native audio backend milestone. CPU meter is approximated by
loop-lag in the health panel, not per-core DSP load.

**Priority:** the buffer control existed and is one click from anywhere
(Settings ▸ Audio, also reachable from the command palette). Remaining gaps
are *native-backend milestone* work, not settings work. → documented,
deferred.

### 2. Metering & reference ✅ upgraded

**Current before:** `loudnessTargetLufs` + `LOUDNESS_PRESETS` existed in
core with zero call sites — no UI wrote it, nothing read it. Meters were
peak/RMS only.

**Done in this pass:**
- **Settings ▸ Project** — loudness target with one-click platform presets
  (Streaming −14 / Apple Music −16 / EBU R128 −23), numeric entry, clear.
- **BS.1770-4 integrated loudness** (`src/audio/loudness.ts`): K-weighting
  (closed-form coefficients, correct at any sample rate), 400 ms blocks at
  75 % overlap, absolute −70 gate + relative −10 LU gate. Pure math over
  raw channels — unit-tested against the spec's −3.01 LKFS calibration
  tone at 48 kHz and 44.1 kHz, amplitude linearity, and gating behavior.
- **Every mixdown export measures itself** and posts a one-shot status-bar
  notice: `Exported Song.wav — loudness −12.3 LUFS — 1.7 LU above the
  −14.0 target`. No metering plugin, no popup.

**Still open (nice-to-have):** live LUFS metering during playback (needs a
worklet tap; the offline measurement lands the workflow value first), and
per-strip meters (already on the roadmap).

### 3. MIDI & timing

**Current:** quantize swing/strength and humanize amount were already
project settings applied by Q/H — but unreachable; **now editable in
Settings ▸ Project**. Count-in (0/1/2 bars) is a user preference; recording
latency trim covers the input path; playhead latency compensation is
automatic.

**Gap:** no Web MIDI input at all (hardware controllers, MIDI mapping) —
that is an input-milestone feature, not a settings gap; the mapping store
should be user-scope `appStorage` when it lands (device ids are per-machine,
like `trackInputs`). Pre-roll beyond count-in and punch in/out are on the
existing roadmap.

### 4. Performance & stability ✅ upgraded

**Current before:** plugin scan cache already existed (main-process
appData, quarantine list, background warm). Autosave interval was
configurable (5–300 s) into ONE recovery slot — a single bad snapshot
could cost the session.

**Done in this pass:**
- **Recovery generations:** every snapshot rotates `project.json` →
  `project.1.json` → `project.2.json` (renames — audio bytes are never
  rewritten). Recovery reads the newest generation that parses, so a
  corrupt latest write falls back one interval instead of losing the
  session. Assets are shared across generations by immutability.
- **`.sdaw.bak` on save:** overwriting a project first copies the previous
  bytes to `<name>.sdaw.bak` (best-effort — a failing copy never blocks
  the save). "I saved over the good version" is now a rename away from
  fixed.

**Still open:** disk-cache location choice (Electron userData is fixed
today; low demand until projects outgrow the system drive).

### 5. Workflow defaults ✅ upgraded

**Current before:** `defaultFadeTicks`, `defaultGrid`, `exportFormat`
existed in the document but were unreachable; `exportFormat` was read by
nothing (the export path hardcoded WAV); track presets existed; **no
session templates**.

**Done in this pass:**
- All defaults editable in **Settings ▸ Project**; `defaultGrid` seeding at
  load is now meaningful.
- **`exportFormat` is consumed:** File ▸ Export bounces the project's
  format (menu label follows: "Export WAV…" / "Export MP3…").
- **`exportBitDepth` (16/24)** added to `ProjectSettings` (normalized like
  every field; format v3 stays additive — old files gain the default), a
  24-bit PCM WAV encoder, honored by mixdown and track exports.
- **Session templates** (`core/persistence/projectTemplate.ts`, `.sdtpl`):
  track tree + mixer + synth params + full insert chains (descriptor +
  params + stateBlob, never paths) + routing graphs + tempo/signature +
  project settings — no content (clips/notes/files/chat/automation).
  Field-validated like the project format; instantiation mints fresh ids
  (two instantiations can never collide — the duplicate-track rule).
  File ▸ Save as template… / New from template…, both in the palette.

### 6. Customization ✅ upgraded

**Current before:** themes were solid (palette + shell attributes, boot
mirror). The Keyboard Shortcuts tab said "Coming in a future milestone" and
every binding was a hard-coded `switch`.

**Done in this pass:**
- **Rebindable shortcuts** (`state/keymap.ts`): a typed roster of 23
  actions with default combos and fixed aliases (Ctrl+Y for redo,
  Backspace for delete, Ctrl+D/Ctrl+E legacy combos). User overrides
  persist through `appStorage` (`keymap` key). The global handler AND the
  piano roll resolve every keydown through `keymap.resolve(event)`, so a
  rebinding applies in both surfaces from one definition. Collisions
  deactivate the loser and say so in the pane; nothing fails silently.
  Keys 2–9 (slice into N) stay fixed — a parameterized family, labeled as
  such in the pane.
- **Settings ▸ Keyboard Shortcuts** — grouped list, click-to-rebind
  (capture-phase so the pressed combo never fires its old action), per-row
  reset, reset-all.
- **UI scale** (75–150 %) as a user preference, applied as root zoom,
  effective immediately.

**Still open:** window layouts/workspaces (dock layout already persists;
named workspaces are a nice-to-have), theme editor.

## Serialization map (after this pass)

```
.sdaw › project.json › state.settings        loudnessTargetLufs · defaultFadeTicks
                                             swingPercent · quantizeStrength
                                             humanizeTicks · defaultGrid
                                             exportFormat · exportBitDepth
   (normalized on load; unknown keys dropped, values clamped — a doctored
    file cannot smuggle bad values; pre-v3 files gain defaults additively)

<name>.sdtpl                                 session template (setup, no content)

userData/superdaw-appdata.json               preferences (incl. uiScale) · keymap
  (browser: localStorage superdaw.appdata.*) theme · audioDevices · recentProjects
                                             trackInputs
userData/recovery/project[.1|.2].json        rotated autosave generations
<project>.sdaw.bak                           previous save's bytes
```

## Test coverage

- `ops.test.ts` — `project/updateSettings` invert round-trips (now incl.
  `exportBitDepth`), idempotency, clamp/drop of hostile patches, no-op
  inverts. Every settings field rides the existing op-test harness.
- `format.test.ts` — settings survive serialize→parse; old/doctored files
  normalize.
- `loudness.test.ts` (new) — BS.1770 calibration (−3.01 LKFS mono,
  ~0 stereo), rate independence (44.1/48 k), amplitude linearity, gating,
  null on silence/too-short.
- `projectTemplate.test.ts` (new) — round-trip of setup without content,
  fresh-id discipline across instantiations, rejection of non-templates /
  newer versions, hostile-field clamping, folder-cycle break.
- Keymap has no test file: it is renderer state (the test suite is core +
  audio); its behavior was verified end-to-end in the browser (rebind →
  persist → old combo released → new combo mutes through the op pipeline).

## Collaboration semantics

Project settings merge exactly like every other field: the patch carries
absolute values per touched key, so re-delivery is idempotent and two peers
editing different fields both win; the same field resolves last-write-wins.
Undo restores only the keys a patch touched. User-scope settings (keymap,
scale, devices, autosave cadence) sync to no one by construction.

## Priority queue for future passes

1. **Live LUFS meter** on the master (worklet tap; reuse `loudness.ts`
   filters) — the offline measurement covers the decision point today.
2. **MIDI input + controller mapping** (user-scope map keyed by device id).
3. **Native audio backend (ASIO/low-latency)** — the real buffer-size story.
4. **Per-strip metering**, already on the roadmap.
5. **Named window workspaces** on top of the persisted dock layout.
