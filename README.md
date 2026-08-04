# SuperDAW

A modern professional DAW whose core innovation is seamless real-time
collaboration — multiplayer from the ground up, no accounts, no cloud
dependency. Projects are local files; collaboration is an optional
host-based session joined with a short code.

**Status: Milestone 1 (foundation) complete.**

- Operation-based project core (every edit is a serializable op — the same
  pipeline powers undo/redo, the activity feed, and future real-time sync)
- Timeline editing: audio/MIDI tracks, create/move/resize/delete clips with
  snapping, mute/solo, rename, zoom
- Transport with playhead (audio engine is the next milestone)
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
