# SuperDAW Internet Collaboration — Architecture Proposal

Status: **PROPOSAL — awaiting review. No implementation yet.**

This document proposes evolving the existing LAN collaboration system into
an internet-capable one. It is an *evolution*: the operation pipeline, the
host-authoritative session protocol (docs/PROTOCOL.md), and the optimistic
rebase model are preserved verbatim. What changes is *where the wire goes*.

---

## 1. The load-bearing observation

The current LAN transport already has the exact shape the internet needs:

```
TODAY (LAN)
  guest renderer ──ws──▶ Electron main process ──IPC──▶ host renderer
                         (dumb frame relay:              (HostSession =
                          moves strings, understands     authoritative
                          nothing)                       sequencer)
```

The Electron main process is a *dumb relay* — it moves opaque strings and
understands nothing about DAW state. The internet architecture is that same
relay, lifted out of the host's machine onto a small public server:

```
PROPOSED (internet)
  guest A ──wss──▶ ┌──────────────┐ ◀──wss── guest B
                   │ relay server  │
                   │ (in-memory,   │
                   │  no DB, dumb) │
  host ────wss──▶ └──────────────┘
```

Every peer — **including the host** — is an outbound WebSocket client of
the relay. No port forwarding, no NAT traversal, no firewall rules. The
host remains the authoritative sequencer for project state exactly as
today; the relay's only job is to route frames between the host connection
and guest connections. It never parses an `Operation`.

Consequences that fall out for free:

- `HostSession` / `ClientSession` / `ProjectStore` / PROTOCOL.md: **zero
  changes to semantics.** Ops, undo, presence, chat, comments, offline
  buffering, reconnect replay — all already proven by the convergence and
  fuzz tests — work identically. The relay adds routing hops, nothing else.
- The server cannot leak project data it never stores and cannot corrupt
  state it never interprets. End-to-end encryption of payloads is a
  possible later addition *without any server change*, because payloads are
  already opaque to it.

## 2. Layering and folder structure

Networking remains a peer layer: independent of React, the timeline, the
audio engine, the mixer, the plugin system, and Electron. It depends on
`src/core` only, and only to move `core/session` messages and asset bytes.

```
server/                          NEW — standalone deployable relay
  package.json                   own minimal deps (ws); never bundled into the app
  tsconfig.json                  path-maps @core → ../src/core (shared types only)
  src/
    index.ts                     bootstrap: read env (port, limits), listen, TLS notes
    wsRelay.ts                   thin ws adapter: sockets ⇄ RelayCore sinks
    relayCore.ts                 ALL relay logic, transport-agnostic (unit-testable
                                 with fake sinks, mirroring core/session tests)
    sessionRegistry.ts           in-memory sessions: codes, roles, lifecycle, reaping
    codes.ts                     join-code minting (crypto random)

src/core/relay/                  NEW — shared wire contract (pure types + helpers)
  protocol.ts                    relay frame types (outer envelope), error codes
  codes.ts                       code alphabet/normalization (shared client+server)

src/core/session/                UNCHANGED semantics; protocol.ts gains the
  protocol.ts                    chunked-asset messages (inner protocol v2, §7)
  host.ts / client.ts            asset transfer generalized (§7); ops untouched

src/net/                         NEW — client networking layer (peer of src/audio;
  networking.ts                  no React, no DOM beyond WebSocket, no Electron)
  relayTransport.ts              one reconnecting WebSocket: backoff, heartbeat,
                                 generation guards, wire framing
  relayNetworking.ts             CollabNetworking implementation over the relay
  lanNetworking.ts               existing LAN paths refactored behind the same
                                 interface (kept? — open question §16)
  assetChannel.ts                chunked transfers: progress, flow control, cancel

src/renderer/src/state/collab.ts SLIMS DOWN — orchestrates via CollabNetworking
                                 only; owns presence UI state (cursors, pings,
                                 roster) exactly as today. Never sees a WebSocket.
```

Rule check: `src/net` imports from `src/core` only. `server/` imports
shared types from `src/core/relay` + `src/core/session` and nothing else
(no model, no ops — it must not even be *able* to interpret state).
`collab.ts` is the single place UI meets networking, through the interface.

## 3. The Networking abstraction

The UI never touches WebSockets. One interface, two implementations
(relay, LAN), both driving the same `HostSession`/`ClientSession` cores:

```ts
/** src/net/networking.ts — the ONLY surface the app layer sees. */
export interface CollabNetworking {
  /** off | connecting | online | reconnecting | host-away */
  readonly status: NetworkStatus

  /** Host a session for the current project. Resolves with the join code. */
  createSession(displayName: string): Promise<{ joinCode: string }>
  /** Join an existing session by code. */
  joinSession(code: string, displayName: string): Promise<void>
  /** Leave/stop. The project simply becomes a local project again. */
  leaveSession(): void

  /** Everything persistent — ops. (Chat, comments, all edits: see below.) */
  sendOperation(envelope: OpEnvelope): void
  /** Everything ephemeral — presence (cursors, pings). */
  sendPresence(data: PresenceData): void

  /** Ask the session for an asset this client is missing. */
  requestAsset(assetId: string): void
  /** Announce a locally imported asset so peers can fetch it. */
  offerAsset(meta: AssetMeta): void
  cancelTransfer(transferId: string): void

  subscribe(events: Partial<NetworkingEvents>): () => void
}
```

**On `sendChat` / `sendComment` / `sendPing`:** the brief lists these as
separate methods. In SuperDAW, chat and comments are *already operations*
(`chat/post`, `comment/*`) — they sync, persist, and (comments) undo
through the one pipeline; pings are presence. Giving them dedicated wire
methods would create a second path to the same destination and violate
"every persistent edit is an Operation". The interface therefore exposes
exactly two data channels — ops and presence — and chat/comments/pings
flow through them as they already do. (Convenience wrappers can exist at
the `collab.ts` level if the call sites read better; the wire stays two
channels.)

Events (`NetworkingEvents`) mirror today's `ClientSessionEvents` plus
transport health: `onStatusChange`, `onWelcome`, `onOperation` (internal —
wired straight to the store), `onPresence`, `onRosterChange`,
`onAssetProgress(transferId, done, total)`, `onAssetComplete`,
`onSessionEnded(reason)`, `onError(code, message)`.

## 4. Relay wire protocol (outer layer)

A thin, versioned envelope around the *existing* session protocol. The
relay reads ONLY this layer; `payload` is opaque bytes/JSON it never
inspects.

Text frames, JSON. `RELAY_PROTOCOL_VERSION = 1`.

```
Client → Relay
  { t:'create',  v:1, resumeToken?: string }
  { t:'join',    v:1, code: string, resumeToken?: string }
  { t:'msg',     to?: GuestId, payload: SessionMessage }
      • from host: to one guest (`to`) or all guests (no `to`)
      • from guest: always routed to the host (`to` forbidden)
  { t:'leave' }
  { t:'hb' }                        app-level heartbeat (browsers can't send ws pings)

Relay → Client
  { t:'created', code, sessionId, resumeToken }      you are the host
  { t:'attached', role:'guest', guestId, resumeToken }
  { t:'resumed',  role:'host' | 'guest' }            reconnect accepted
  host side:   { t:'guest-up', guestId }
               { t:'guest-msg', guestId, payload }
               { t:'guest-down', guestId }
  guest side:  { t:'host-msg', payload }
               { t:'host-away' } / { t:'host-back' } session paused/resumed
  { t:'closed', reason: 'expired' | 'host-left' | 'kicked' }
  { t:'hb' }
  { t:'error', code: RelayErrorCode, message: string }
```

Routing rules enforced by the relay (its entire "logic"):

- Guests can only send to the host. The host can send to one/all guests.
- A `msg` before successful `create`/`join` is dropped with an error.
- Per-connection rate limits (frames/sec, bytes/sec) with a generous
  ceiling — protection, not throttling.

The inner `payload` is today's `ClientToHost`/`HostToClient`. The host's
`RelayNetworking` adapts `guest-msg` → `HostSession.handleMessage(peer,…)`
with one `HostPeer` per `guestId` — exactly how `collab.ts` adapts IPC
events today. The symmetry is deliberate: the relay server *is* the
current `collabServer.ts` promoted to a standalone process.

**Binary frames** are reserved for asset chunks (§7): frame = `4-byte
header length | JSON header | raw bytes`. Control stays JSON text frames.
This avoids base64's +33% on the only traffic where size matters.

## 5. Session lifecycle (server side)

Sessions exist **only in memory**. No database, no disk, ever.

```
                create
                  │
                  ▼
   ┌─────────── ACTIVE ────────────┐
   │  host + 0..N guests attached  │
   └───┬──────────────────────┬────┘
       │ host socket drops    │ explicit leave by host
       ▼                      ▼
   HOST-AWAY (grace ~120s)   CLOSED('host-left')
       │            │
       │ host       │ grace expires
       │ resumes    ▼
       └──▶ ACTIVE  CLOSED('expired')

   Any state: all sockets gone → linger ~60s (covers blips) → deleted.
   Absolute idle cap (~24h no frames) → deleted. Reaper runs on a timer.
```

- `create` mints a session + join code + host `resumeToken` (crypto
  random, shown to no one, held in the client's memory only).
- During HOST-AWAY guests receive `host-away`, keep full local editing
  (ops pile up in `pending` — the store already does this), and see a
  quiet "reconnecting" hint. On `host-back`, each guest's `ClientSession`
  re-hellos through the restored route; snapshot resync + idempotent
  pending replay do the rest. **This is the existing reconnect path** —
  the server just tells guests when to run it.
- When a session closes, every peer adopts `displayed` as its local
  document (existing `leave()` behavior). Nothing remains on the server —
  by construction it never held anything but in-flight frames.

## 6. Operation flow (unchanged — shown end to end)

```
guest A edits          host (authoritative)              guest B
─────────────          ─────────────────────             ────────
dispatch(op) ─┐
displayed ✓   │ optimistic, instant
pending += op │
      └─▶ relay {t:'msg', payload:{t:'op',envelope}}
                └─▶ host: dispatch(op,'remote')
                    seq++, broadcast
                    {t:'msg', payload:{t:'op',seq,envelope}} ─▶ relay ─▶ A, B
A: confirmed += op, pending -= op,            B: confirmed += op
   displayed = rebase(pending)                   displayed updated
```

Latency budget: one extra hop (guest→relay→host→relay→guest) versus LAN.
The optimistic model makes this invisible for one's own edits; remote
edits arrive at internet RTT as they must. Undo, `op-noop` acks, seq-gap
resync: all identical to PROTOCOL.md today.

## 7. Asset flow (the one real protocol change — inner v2)

Today's `asset-data` ships an entire file as one base64 JSON message.
Acceptable on a LAN; wrong on the internet (memory spikes, no progress, no
cancel, head-of-line blocking op traffic behind a 100 MB WAV). Inner
session protocol v2 replaces it with chunked, flow-controlled transfers.
The host remains the **asset hub**, matching its authority role:

```
guest A imports drums.wav
  1. AssetStore registers locally; clip ops dispatch immediately (never blocked)
  2. A → host:  asset-offer   { assetId, name, kind, ext, size, sha256 }
  3. host (if missing) → A:   asset-pull  { assetId, transferId }
  4. A → host:  asset-chunk × N            (binary frames, ~256 KiB,
                                            credit window of 4 in flight,
                                            host acks with asset-credit)
  5. A → host:  asset-done    { transferId }
  6. host → all guests:       asset-available { assetId, meta }
  7. guest B (missing it) → host: asset-request { assetId }
  8. host → B: asset-push { transferId, meta } + chunks (same framing)
```

- **Placeholders:** clips referencing not-yet-arrived assets already
  render, edit, and simply play silent (existing behavior) — the timeline
  never waits. `onAssetProgress` lets the clip show a subtle fill.
- **Resume:** `asset-request` may carry `haveBytes`; transfers resume at
  an offset after reconnect. `sha256` verifies completion.
- **Cancel:** either side sends `asset-cancel { transferId }`; deleting
  the last reference cancels outstanding pulls.
- Interleaving: chunk frames are sent behind op frames in the transport's
  queue (small control messages always jump the asset queue), so a big
  upload never delays an edit.
- The relay routes chunk frames like any other `msg` — still opaque. It
  buffers only per-socket backpressure, bounded (slow guest → its own
  queue caps → chunks for *that guest* pause via credits; others unaffected).
- Later, `assetChannel.ts` can swap in a blob store or WebRTC data channel
  without touching `CollabNetworking` — the interface speaks transfers,
  not transports.

## 8. WebSocket architecture (client side)

One `RelayTransport` per session, owned by `RelayNetworking`:

- Single socket for control + ops + presence + assets (framing per §4/§7).
- **Heartbeat:** app-level `hb` every 20 s; missing 2 → declare dead,
  begin reconnect. (Server mirrors: 60 s silence → drop socket.)
- **Reconnect:** exponential backoff with full jitter (1 s → 2 → 4 → …
  cap 30 s), forever while the user stays in the session. Generation
  counter invalidates stale socket callbacks (pattern already in
  `collab.ts`).
- **Resume:** reconnect sends `join`/`create` with the held `resumeToken`;
  `resumed` restores the role (host keeps sessionId + code; guest keeps
  guestId/color). Then the *inner* protocol re-hellos (snapshot resync,
  pending replay) exactly as today.
- All buffering of unsent *ops* stays where it already lives — the store's
  `pending` set. The transport deliberately does NOT queue ops while
  offline; `ClientSession.connect()` re-sends all pending on welcome.
  One buffering mechanism, not two.

## 9. Join codes

Server-minted, opaque, meaningless — they locate nothing and encode
nothing (unlike LAN codes, which pack IP+port+token):

- Format: `XXXX-XXXX`, Crockford base32 minus confusables (existing
  alphabet in `core/session/joinCode.ts` — reused), case-insensitive,
  I/L→1, O→0 on input.
- 8 chars ≈ 40 bits of entropy, minted with `crypto.randomBytes`,
  collision-checked against live sessions (trivial: in-memory set).
- Brute-force resistance: relay rate-limits `join` attempts per IP
  (e.g. 10/min) and per session; codes die with the session anyway.
- Codes are capability tokens: knowing the code = permission to join.
  That is the whole (deliberate) v1 permission model; accounts refine it
  later (§15) without changing the code UX.

## 10. Error handling

Typed, boring, non-modal — matching the "networking is invisible" rule.

- `RelayErrorCode`: `bad-code | session-full | version-mismatch |
  rate-limited | already-attached | protocol-error | server-shutdown`.
- Client mapping: join-time errors surface once in the Collab panel
  (existing `lastError` slot — no dialogs). Mid-session transport loss is
  NOT an error: it is the `reconnecting`/`host-away` status, shown as the
  existing quiet indicator. `closed` → adopt local document + one status
  line ("Session ended — your copy is intact").
- Server: malformed frame → `error` + close that socket; never crashes a
  session for one bad peer. Every close path broadcasts `closed` with a
  reason so clients never guess.
- Version negotiation at BOTH layers: relay rejects unknown `v` cleanly;
  the inner hello/reject flow (already implemented) handles session
  protocol drift.

## 11. Server implementation notes

- Node + `ws`, ~4 small modules (§2). No framework, no database, no disk.
- `relayCore.ts` is transport-agnostic (sinks in, messages out) and unit
  tested exactly like `core/session` — fake sinks, full lifecycle tests
  (create/join/away/resume/expire), plus routing-rule and limit tests.
  `wsRelay.ts` is a ~100-line adapter, integration-tested once with real
  sockets in vitest (Node env).
- Config via env: `PORT`, `MAX_SESSIONS`, `MAX_GUESTS_PER_SESSION`,
  `MAX_FRAME_BYTES`, grace/linger/idle timers. TLS terminates at the
  reverse proxy (Caddy/nginx) in production — the process speaks plain ws
  behind it; `wss://` is mandatory client-side outside dev.
- Deployment target: any $5 VM or container. Stateless between restarts
  *by design* (a restart ends sessions; clients degrade to local editing
  and can re-create — acceptable for v1, addressed in §15 scaling).

## 12. What changes in existing code (small, surgical)

| File | Change |
|---|---|
| `core/session/protocol.ts` | inner v2: chunked asset messages (§7); `asset-data` removed; everything else untouched |
| `core/session/host.ts` | `HostAssetProvider` becomes chunk-oriented; gains `asset-offer` intake (guest uploads — new capability) |
| `core/session/client.ts` | asset events become transfer-shaped; op/presence paths untouched |
| `renderer/state/collab.ts` | drops direct WebSocket + IPC wiring; drives `CollabNetworking`; keeps presence/roster UI state |
| `main/collabServer.ts` | unchanged (LAN mode) or deleted (open question §16) |
| `docs/PROTOCOL.md` | gains the relay layer + asset v2 sections |

Everything in `src/core/ops`, the store, UI components (except the Collab
panel's status strings), audio, and plugins: **untouched.**

## 13. Session protocol on top of the relay — who is what

| Concern | Owner |
|---|---|
| Sequencing, snapshots, convergence | Host (`HostSession`) — unchanged |
| Presence fan-out | Host relays as today (server stays dumb) |
| Roster (who is connected) | Relay knows *connections*; host owns *users* (guest-up/down feed `addPeer`/`removePeer`) |
| Asset coordination | Host = hub; relay = pipe |
| Session existence, codes, expiry | Relay server |
| Project data at rest | **Nowhere but the peers.** |

## 14. Reconnect strategy — summary table

| Failure | Experience |
|---|---|
| Guest loses internet | Edits continue locally; quiet "reconnecting"; backoff; resume → resync + idempotent replay. Existing semantics. |
| Host loses internet | Guests get `host-away`; keep editing locally; host resumes within grace → everyone resyncs; grace expires → session ends, all copies intact. |
| Relay restarts | All sessions end (v1); everyone keeps their local copy; host re-creates with one click, shares a new code. |
| Guest closes app | `guest-down` → host `removePeer` → roster update. |
| Everyone leaves | Session lingers ~60 s, then evaporates. Nothing to clean up — nothing was stored. |

## 15. Future scalability (no API changes required)

The client-facing `CollabNetworking` interface and the relay wire protocol
are the two stable contracts. Each future capability slots behind them:

- **Accounts:** `create`/`join` gain an optional auth token field (already
  extensible JSON). Anonymous sessions keep working. No client interface
  change — `createSession` just starts reading an identity provider.
- **Cloud projects / dedicated storage:** a *separate* service the client
  talks to for open/save; the session protocol's snapshot-on-welcome
  already defines how a project enters a session. The relay stays a relay.
- **Permissions:** enforced at `join` (relay checks a claim) and, for
  fine-grained roles, at the host (it already sees every op with its
  author). No wire change — `reject` already exists.
- **Project history:** the op stream is the history. A future opt-in
  "archiver" peer (server-side `ClientSession`!) could subscribe and
  persist envelopes — *using the existing client protocol*, zero relay
  changes. This is the cleanest possible seam and a direct payoff of
  everything-is-an-op.
- **Horizontal scale:** sessions are share-nothing; shard by code (router
  in front, or DNS per region). In-memory model survives unchanged per
  shard.
- **E2E encryption:** payloads are opaque to the relay today; encrypting
  them is a client-side concern whenever wanted.

## 16. Open questions for review

1. **Keep LAN mode?** It works today, needs no server, and suits studios
   with no internet. Cost: two transports behind the interface (the
   refactor keeps this cheap) and the longer 15-char code format
   coexisting with 8-char relay codes (auto-detected by length).
   Recommendation: keep, as `lanNetworking.ts`.
2. **Grace periods:** host-away 120 s / linger 60 s / idle cap 24 h —
   sane defaults? All env-tunable.
3. **Relay deployment:** where will the v1 relay run (VM, Fly/Railway
   container)? Dev default `ws://localhost:8787`; the URL is a client
   setting either way.
4. **Guest uploads** (asset-offer) add the one genuinely new capability.
   In scope for v1, or host-imports-only first?

## 17. Implementation phases (after approval)

1. **Inner protocol v2** — chunked assets over the existing LAN transport
   (mechanical, fully testable with current fuzz/sim harness).
2. **Relay server** — `relayCore` + registry + tests, then the ws shell.
3. **Client `src/net/`** — transport, `RelayNetworking`, refactor
   `collab.ts` onto the interface (LAN path moves behind it too).
4. **UI touch-up** — Start/Join flows get the relay path (code-length
   detection), status strings for host-away.
5. **End-to-end soak** — two app instances + local relay; kill-switch
   tests (drop host, drop guest, restart relay) asserting convergence.

Each phase lands green (typecheck + tests) and independently revertible.
