# SuperDAW Collaboration Protocol (v1)

## Model: host-authoritative op sequencing with optimistic clients

One peer — the **host** — is the authoritative sequencer for a session.
Every project mutation is an `Operation` (see ARCHITECTURE.md); the host
assigns each op a global sequence number and broadcasts it. All peers apply
the same ops in the same order through the same pure reducer, so all peers
converge. There is no CRDT machinery and none is needed while a single
sequencer exists; the op-based design does not foreclose adding offline
merge later.

## Peer state: confirmed + pending = displayed

Every client keeps:

- `confirmed` — the result of applying the host's authoritative op stream.
- `pending` — this peer's own ops, dispatched locally but not yet echoed
  back by the host (in flight, or accumulated while offline).
- `displayed` — what the UI shows: `pending` re-applied on top of
  `confirmed` (the **rebase**).

A local edit applies to `displayed` instantly (zero perceived latency),
joins `pending`, and is sent to the host. When the host's authoritative
stream delivers an op:

1. Apply it to `confirmed`.
2. If it is this peer's own op (matched by envelope id), drop it from
   `pending`.
3. Rebuild `displayed` by re-applying the remaining `pending` ops.

The rebase is what makes optimistic UI correct: if a remote op is
sequenced *before* my in-flight op, my display already shows the outcome
in host order, so there is no flicker when confirmation arrives. The host
itself has no pending set — its local edits are sequenced immediately —
and a solo (non-session) project degenerates to `confirmed == displayed`.

## Why this converges

- The reducer is a pure function; identical op sequences yield identical
  states on every peer.
- Ops whose targets no longer exist apply as no-ops, so causally stale
  ops (moving a clip another peer just deleted) are dropped identically
  everywhere.
- **Every op is idempotent** (creates are guarded by id, sets overwrite,
  deletes tolerate absence). This is a protocol invariant — it makes
  at-least-once delivery safe, which reconnect replay relies on. New op
  types MUST preserve it (enforced by the duplicate-delivery fuzz test).

## Undo in a session

Undo is per-user: undoing dispatches the *inverse op* (captured at edit
time) as a brand-new operation through the normal pipeline. If someone
else edited the same object since, last-write-wins in host order —
standard collaborative-editor semantics. Remote ops are never undoable
locally.

## Join, reconnect, offline

- **Join**: client sends `hello` (protocol version, identity). Host
  replies `welcome` carrying a full state snapshot + current seq + roster.
  The client replaces its document with the snapshot (fresh history).
- **Disconnect**: the client keeps editing; ops accumulate in `pending`.
- **Reconnect**: same `hello` flow, but the client *keeps* its history and
  pending set: the new snapshot becomes `confirmed`, pending (the offline
  edits) rebases on top, and everything pending is re-sent — safe because
  ops are idempotent, so edits the host already sequenced before the drop
  apply as no-ops. This is "continue working locally, sync when possible".
- **Session end**: when a client detaches (or hosting stops), `displayed`
  is adopted as the local document — the project simply becomes local
  again.
- A seq gap detected by a client (should not occur over TCP) forces a
  rejoin for a fresh snapshot.

## Messages (JSON)

Client → host:
- `hello { protocolVersion, userId, name, lastSeq | null }`
- `op { envelope }` — envelope = `{ id, userId, time, op }`
- `presence { data }` — ephemeral (cursors, pings); relayed, never stored
- `asset-request { assetId }`

Host → client:
- `welcome { seq, snapshot, users, yourColor }`
- `reject { reason }` — e.g. protocol version mismatch
- `op { seq, envelope }`
- `presence { userId, data }`
- `user-joined { user }` / `user-left { userId }`
- `asset-data { assetId, name, kind, ext, bytesBase64 }`

## Two-layer split: document vs assets, ops vs presence

- Document state syncs as ops (this protocol). Asset binaries transfer
  lazily in the background: the snapshot references assets by id; a client
  requests the ones it lacks; clips render (and are editable) immediately
  and are merely silent until bytes arrive.
- Presence (cursor motion, pings, who-is-here) is a separate relayed
  channel that never touches the document, history, or activity feed.

## Transport

Phase A proves this protocol over an in-memory simulated network (see
`src/core/session/__tests__`). The real transport is LAN-first: the host
listens on a WebSocket (Electron main process relays frames to the
renderer); the join code encodes address + port + session token.
Internet-wide rendezvous is a future, additive milestone — nothing in the
protocol assumes LAN.
