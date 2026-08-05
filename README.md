# SuperDAW

A modern professional DAW whose core innovation is seamless real-time
collaboration — multiplayer from the ground up, no accounts, no cloud
dependency. Projects are local files; collaboration is an optional
host-based session joined with a short code.

**Status: Milestone 5 (chat + comments) complete.**

- Project chat (dockable tab, unread badge) and comment threads on clips
  and tracks (reply, resolve) — both sync live in sessions and persist
  inside the project file

- Real-time collaboration, LAN-first: click Collab → Start, share the
  join code, others join — no accounts, no cloud. Host-authoritative op
  sync with optimistic local editing (see docs/PROTOCOL.md), background
  asset transfer, offline editing with automatic resync, live cursors,
  middle-click pings, per-user undo

- Operation-based project core (every edit is a serializable op — the same
  pipeline powers undo/redo, the activity feed, and future real-time sync)
- Timeline editing: audio/MIDI tracks, create/move/resize/delete clips with
  snapping, mute/solo, rename, zoom
- Audio playback on the Web Audio clock: drop audio files onto tracks,
  waveforms, per-track routing with click-free mute/solo, metronome,
  master meter
- File Bay: Content-Browser-style panel with folders, waveform thumbnails,
  drag assets onto tracks, drag OS files in to import
- Single-file `.sdaw` projects — save/open with native dialogs (Ctrl+S /
  Ctrl+Shift+S / Ctrl+O), unsaved-changes indicator
- Activity feed
- Full undo/redo

## Running

Requires Node.js ≥ 20.

```
npm install
npm run dev       # desktop app (Electron)
npm run dev:web   # UI only, in a browser
npm run test      # core test suite
```

Architecture and contribution rules: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
