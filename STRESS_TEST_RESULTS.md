# SuperDAW Stress Test Results — August 2026

Run date: **2026-08-10**, Chromium (web renderer, `npm run dev:web`, dev build).
Suite: `window.__superdaw.stressTest.runAll()` at default scale — **all 14
scenarios passed, 0 assertion failures, 0 console errors or warnings**, total
139.4 s. A second, larger-scale pass (cumulative 401-track project) follows in
its own section.

Every scenario now returns structured JSON (timings + counts + named
correctness assertions); `runAll` returns the machine-readable aggregate.
The store-only scenarios also run headless at reduced scale in CI:
`src/core/__tests__/stressSmoke.test.ts` (11 tests, ~8 s).

## Default-scale results (single fresh project)

### 1. Generation — 100 tracks × 10 effects + 3 clips (5,100 notes)

| Phase | Time | Per op |
|---|---|---|
| Track creation (100) | 14 ms | 0.14 ms |
| Plugin adds (1,000) | 786 ms | 0.79 ms |
| Clips + notes (300 / 5,100) | 475 ms | 1.6 ms/clip |
| **Total** | **1,275 ms** | |

Verified against the store afterwards: 100/1,000/300/5,100 exactly.
Memory after generation: 75.3 MB used (1.8 % of the 4 GB heap limit).

### 2. Frame performance (idle, project loaded)

141.7 FPS average, 7.1 ms average frame time. (Max-FPS values are rAF
measurement artifacts; the display refresh ceiling is what matters.)

### 3. Playback (3 s, REAL audio this time)

- 95.8 FPS average during playback (min 26.7), audio context `running`.
- Memory 69.1 → 93.3 MB (audio buffer allocation, reclaimed later).
- 198 audio clips actually played material: browser runs now register four
  synthetic 1 s tone assets (decoded `AudioBuffer` + real PCM16 WAV bytes)
  and generated audio clips reference them round-robin. The previous
  generator minted **dangling assetIds** — every "audio" clip was silent and
  playback stress was hollow. Fixed in `devHandle.ensureStressAssets()`.

### 4. Undo/redo — first real recorded numbers

The old scenario **fabricated** its op count (`floor(count * 0.8)`) and
drained the entire undo stack, not just its own ops. Now it counts real
dispatch successes and undoes exactly what it created:

- 200/200 ops were real changes: created in 144 ms.
- Undo × 200: 117 ms — state **deep-equals the pre-scenario baseline**.
- Redo × 200: 113 ms — state **deep-equals the post-ops snapshot**.
- Cleanup undo restores baseline again; the project is left as found.

### 5. Dispatch throughput (formerly "concurrency" — renamed honestly)

500 mixed mixer ops (volume/pan/mute/solo) in 315 ms = **1,587 ops/s** on a
~200-track live project, 0 unintended no-ops. This measures LOCAL dispatch
only; the collaboration path has its own scenario (§11).

### 6. Routing graphs (new)

20 fresh tracks × 8 plugins; one `route/addMany` per track building a
layered DAG (parallel entries, skip edges, dual exits, parallel dry path):

- 340 valid edges accepted in 178 ms; **99 invalid entries** (cycle-closing,
  duplicate, self-loop, ghost-endpoint, cross-track edges) individually
  rejected by the reducer — every rejection asserted.
- Every track keeps a live in→out path (`hasLivePath`).
- Delete storm (120 skip edges) 173 ms; paths stay live; invariants hold.
- Engine rewire cost is included (browser run; the same scenario headless
  measures pure store cost).

### 7. Folder nesting (new)

6 trees × depth-8 folder chains + leaf tracks, built in 777 ms.

- All 6 deliberate cycle-creating reparents **rejected**.
- Reparent storm: 195/200 landed (5 were legitimate would-be-cycles), 1.83 s.
- Reorder storm: 200 ops, 1.80 s.
- Zero parent cycles / invariant violations afterwards.

### 8. Automation density (new)

4,000 points (volume/pan/plugin-param mix) + 1,500 moves on one track of the
live ~200-track project:

- Adds: 59.8 s ≈ **14.9 ms per `automation/add` dispatch** ← see findings.
- Moves: 23.2 s ≈ 15.5 ms/op. All last-write values exact in state.

### 9. Dense piano roll (new)

One clip, 2,500 notes via a single `note/addMany` (20 ms), then 6
`note/moveMany` storms moving the whole 2,500-note selection:

- 33.4 s total ≈ **5.6 s per whole-selection moveMany** ← see findings.
- Every note verified at its exact final absolute position.
- Re-delivering the last storm op is a **no-op** (idempotency asserted).

### 10. Structural storm (new)

398 seeded, pre-validated ops interleaving plugin add/remove, clip
create/move/split, track create/delete (cascades), plugin toggles:
7.25 s ≈ 55 ops/s **with live engine rewires**. Zero unintended no-ops; the
document is referentially intact afterwards (tracks/clips/notes/plugins/
automation/routes audit — `stateInvariantViolations`).

### 11. Remote delivery — the collaboration path, finally stressed (new)

Self-contained stores (does not touch the live project). A host generates
2,000 real ops as envelopes; then:

- **Every envelope delivered TWICE** (at-least-once transport) to a client:
  final state deep-equals a single-delivery control run AND the host
  document. Convergence asserted, not assumed.
- Op log **dedupes** re-delivered envelopes (exactly 2,000 entries).
- Pending-rebase interleaving: a client with 60 unconfirmed local ops
  receives its own echoes interleaved into the remote stream, all doubled —
  pending drains to 0 and the state deep-equals the reference order.
- Store-side throughput: ~193,000 envelopes/s (no UI subscribers).

### 12. Op-log fold (new)

Self-contained store driven past the 20,000-envelope limit:

- Fold observed at 20,000 → 15,000 entries; the folding dispatch cost
  **0.9 ms**; 20,197 total dispatches in 68 ms.
- **`lineage.origin` + op log replays to exactly the confirmed document**
  (deep-equal, 15,000-op replay in 1.9 ms). Invariants hold after the fold.

### 13. Persistence at scale (new)

On the live post-suite document (201 tracks, 1,185 plugins, 7,655 notes,
4,000 automation points, 220 routes):

| Payload | Size | Serialize | Parse |
|---|---|---|---|
| State only | 2.95 MB | 5.7 ms | 14.9 ms |
| Full (lineage + 9,312-entry op log) | 8.23 MB | 16.1 ms | 13.9 ms |

Round-trip equality asserted: parsed state deep-equals the source state,
op log survives intact.

## Larger configuration (cumulative 401-track project)

A further 100 × 10 × 3 generation was run on top of the ~300-track project,
then probes. Final document: **401 tracks, 3,086 plugins, 638 clips, 12,755
notes, 4,000 automation points, 220 routes**.

- Generation of that batch: **206.8 s** — 171 ms/track create,
  132.5 ms/plugin add, 190 ms/clip create (vs 0.14 / 0.79 / 1.6 ms on an
  empty project). See findings.
- Idle frame rate at 401 tracks: **133.6 FPS** (virtualization holds up).
- Playback at 401 tracks: 29.6 FPS average, min 1.4 — heavy but alive;
  audio context stayed `running`, no errors.
- Persistence: state 5.03 MB (38.6 ms serialize / 25.3 ms parse); full file
  12.6 MB with 11,716 log entries (46.4 / 38.4 ms). Round-trip exact.
- Memory: 359.7 MB used (8.8 % of heap).
- Note: the cumulative project also contains one partially generated batch
  (100 tracks + 901 plugins, no clips) from a tooling-aborted attempt — the
  401-track totals include it; the 206.8 s timing is from the clean run.

## Findings

1. **Per-op dispatch cost grows super-linearly with project size for
   engine-rewiring ops (browser only).** `plugin/add`: 0.79 ms → ~33 ms →
   ~132 ms per op at 100 → 300 → 400-track scale; `clip/create` 1.6 ms →
   190 ms; `track/create` 0.14 ms → 171 ms; `automation/add` ~15 ms/op at
   200-track scale. Mixer ops stay ~0.6 ms at the same scale, and the same
   scenarios headless are orders of magnitude faster — the cost is in
   per-op engine rewires + UI subscribers, not the reducer. Bulk import
   paths should batch or suspend rewires. Deep issue — documented, not
   patched here.
2. **`note/moveMany` is quadratic**: it applies per-note `note/move` steps,
   each copying the whole notes record — a 2,500-note selection over a
   ~12k-note document costs ~5.6 s per gesture in the browser. A single-copy
   batched reducer path would fix it; left documented (reducer change, out
   of scope for this pass).
3. **Value-identical `clip/move`/`clip/resize` report "changed"**: the
   `updateClip`/`updateTrack` helpers always build a new object for these
   ops (unlike `setVolume` etc. which compare first), so dispatch's no-op
   detection misses them. Convergence is unaffected (state content equal);
   it only weakens idempotency *reporting* and adds redundant log entries.
4. **Playback ceiling**: smooth at 100 tracks (96 FPS), ~30 FPS at 400
   tracks. The practical guidance below reflects that.
5. **Remote path**: `receiveAuthoritative` applies before its log-dedupe, so
   duplicate suppression is by op idempotency (verified for consecutive
   duplicates — the store's design contract). A duplicate arriving *after*
   later edits to the same field would re-apply stale values; per-envelope
   ordering is a protocol-layer guarantee, untested here.

### Fixed in this pass

- Undo/redo scenario no longer fabricates counts or drains foreign undo
  history; it asserts deep-equality against baseline both ways.
- "Concurrency" renamed `dispatchThroughput` (it never exercised the remote
  path); the real remote path now has a convergence scenario.
- Generated audio clips referenced **dangling assetIds** — playback stress
  was silent. Browser runs now register real synthetic tone assets.
- Generated MIDI velocities were 0.6–1.0 floats, clamped by the reducer to
  velocity **1** (near-silent). Now integer 60–126.
- `runAllStressTests` returned `void`; it now returns the full aggregate.

## Caveats

- FPS numbers are rAF-based; max values are artifacts, refresh-rate caps
  apply. `performance.memory` is Chromium-only.
- Headless smoke runs measure pure store cost (no engine, no React); the
  browser numbers above are the end-to-end cost.
- The remote scenario's stores have no UI subscribers; its throughput is a
  store ceiling, not an end-to-end network figure.

## Running the tests

```javascript
const st = window.__superdaw.stressTest   // dev builds only
await st.runAll()                          // full aggregate (~2–3 min)
await st.generate({ trackCount: 100, effectsPerTrack: 10, clipsPerTrack: 3 })
await st.framePerf(3000); await st.playback(3)
st.undoRedo(); st.dispatchThroughput(); st.routing(); st.folders()
st.automation(); st.pianoRoll(); st.structuralStorm()
st.remoteDelivery(); st.logFold(); st.persistence(); st.memory()
```

Every call returns structured JSON with `assertions` and `passed`. CI runs
the store-only scenarios in `src/core/__tests__/stressSmoke.test.ts`.

## Guidance for users

- 100-track projects with 1,000 inserts: generation ~1.3 s, editing and
  playback smooth. Safe.
- 200–400 tracks: editing stays responsive (idle 130+ FPS), but bulk
  operations (imports, template stamping) slow dramatically and playback
  drops toward 30 FPS. Split projects, or wait for batched rewires.
- Very long sessions: the op log folds transparently at 20k ops (~1 ms);
  project identity and merge lineage survive it.
