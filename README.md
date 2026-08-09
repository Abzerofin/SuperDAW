# SuperDAW

A modern professional DAW whose core innovation is seamless real-time
collaboration — multiplayer from the ground up, no accounts, no cloud
dependency. Projects are local files; collaboration is an optional
host-based session joined with a short code.

**Status: milestones 1–10 complete.**

- Complete editing workflow: clip split (Ctrl+E), copy/paste/duplicate,
  clip colors, drag track reorder, note velocity editing, editable time
  signature, snap-grid control, follow-playhead — every edit synced and
  undoable
- File menu (New/Open/Save/Save As), WAV mixdown export rendered offline
  through the full mixer/effects/synth graph, unsaved-changes guard on
  close, and a crash-safe UI (an interface error never loses the project)

- Per-track effects (EQ, compressor, limiter, delay, reverb) and synth
  controls (waveform, cutoff, ADSR) — synced, undoable, saved

- Piano roll with a built-in polyphonic synth — MIDI clips hold real
  notes (drop in .mid files), edited in a bottom-dock editor
- Audio recording: arm a track, hit ●, get a synced clip + waveform

- Mixer (per-track fader/pan, mute/solo, master) and volume automation
  lanes with sample-accurate playback — all synced and undoable

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

## Releases

Tagging a commit `v*` (e.g. `v0.2.0`) builds the Windows installer on CI and
publishes it to GitHub Releases; installed copies update themselves from
there. See [.github/workflows/release.yml](.github/workflows/release.yml).

## License

GNU General Public License v3.0 or later — see [LICENSE](LICENSE).

Music you make with SuperDAW is yours. Copyleft covers this program's own
source code, not the projects, presets or recordings you create with it.
