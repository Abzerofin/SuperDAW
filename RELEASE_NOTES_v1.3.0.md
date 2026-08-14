SuperDAW 1.3.0 — the native audio release. Everything below rides the same op pipeline as always: undoable, synced to collaborators, saved in your `.sdaw` files.

## Native audio engine (experimental)

Settings ▸ Audio ▸ Audio system now offers **Native** alongside Web Audio — a dedicated low-latency engine running on WASAPI, behind a toggle, with automatic fallback to Web Audio if anything goes wrong. This release brings it from playback-only to feature-complete:

- **VST3 inserts play live**, with automatic plugin-delay compensation, instead of the old 2-second windowed preview — turn a knob on a compressor or EQ and hear it change immediately, correctly aligned with every other track.
- **Recording and input monitoring now run natively too**: the microphone signal is captured in the same audio callback that renders output, so what you hear while tracking is sub-buffer-latency, not the browser's capture stack.
- All 11 built-in effects and all 3 instruments (analog synth, sampler, drum kit) run identically on both backends — verified against Web Audio's own output, not just against a spec.
- Per-backend device selection: your output/input choices are remembered separately for Web Audio and Native.
- A health indicator in the status bar surfaces audio dropouts (xruns) when running native, so a struggling buffer size shows up as a number before it shows up as crackle.

Bounces, exports, and the browser build still render through Web Audio, by design — this is a live-playback and tracking upgrade, not a mixdown engine change.

## Timing & tempo

- **Warp**: stretch a clip's timing without changing its pitch, or repitch it without changing its timing — a dedicated mode alongside the existing tape-style tempo stretch.
- Changing the project tempo no longer drifts an audio clip's trim points.
- **Loopback latency calibration** (Settings ▸ Audio): measure your actual round-trip latency with a short chirp instead of guessing a manual offset.

## Fixes

- The drum kit's snare had a pitch drop that only rendered correctly under Web Audio and came out flat under the native backend — a param-timeline anchoring gap, now fixed and pinned by a cross-backend test.

## Also in this build

- A Space Invaders minigame, for collaborators waiting on a session — DAW keyboard shortcuts no longer leak into it while it's focused.
