# SuperDAW

Collaboration-first professional DAW. Desktop feel, multiplayer from the
ground up (Google Docs + Figma + professional DAW). **No AI features — by
design.** No accounts, no cloud dependency: local project files, optional
host-based collaboration sessions via join codes.

## Non-negotiable product rules

- Every project mutation is a serializable `Operation` through
  `ProjectStore.dispatch` — never mutate state another way. See
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before touching state logic.
- One user gesture = one operation (drags preview locally, dispatch on
  release).
- Ephemeral per-user state (selection, playhead, drag, zoom) stays out of
  the project document.
- Sync is event-based: never send whole project files; assets transfer
  separately in the background.
- UI: professional, minimal, fast. No unnecessary popups, animations,
  notifications, or loading screens. Drag-and-drop wherever possible.
- Networking independent from UI; audio independent from collaboration.

## Working on this repo

- On the maintainer's machine Node is portable and NOT on PATH; prefix
  shell commands with (harmless elsewhere — skip it if `node` already runs):
  `$env:Path = "$env:LOCALAPPDATA\nodejs-portable\node-v24.19.0-win-x64;$env:Path"`
- `npm run dev` (Electron) · `npm run dev:web` (browser, port 5180) ·
  `npm run typecheck` · `npm run test` · `npm run build`
- The renderer must keep working in a plain browser (guard all Electron API
  use behind `window.superdaw?`).
- Vite is pinned to 7.x (electron-vite compatibility) — don't bump to 8
  until electron-vite supports it.
- Every new op type needs an `invert` round-trip test in
  `src/core/ops/__tests__/ops.test.ts` (or, for deliberately non-undoable
  conversation ops like `chat/post`, an explicit null-invert test). All ops
  must stay idempotent — the sync layer relies on at-least-once delivery.
- Implement features incrementally; finish one milestone before starting the
  next (roadmap at the end of docs/ARCHITECTURE.md).
