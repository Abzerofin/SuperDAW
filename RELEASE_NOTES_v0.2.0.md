SuperDAW 0.2.0 — the workflow release. Everything below rides the same op pipeline as always: undoable, synced to collaborators, saved in your `.sdaw` files.

## Editing & timeline

- **Waveform peak snapping** — dragging an audio clip snaps its transients into alignment with other clips' transients (closer than the grid wins), with a guide line at the aligned hit. Shift still drags free.
- **Peak-hold meters** — track sliders and the master meter leave a marker at the recent peak for a second.
- **Per-track loop audition** — a ↻ button on each track repeats that track's material while the rest of the song plays on, for working out melodies. Per-user, never saved or synced.
- **Tempo that moves your audio** — changing the BPM can stretch audio clips so they keep filling the same bars (tape-style). Ask / always / never, remembered until changed in Settings; per-track "Stretch audio to tempo" in the ⋯ menu. The BPM field is draggable, or click to type.
- **Double-click a trim handle** to restore the trimmed material (left edge brings the head back, right edge extends to the full source).
- **Workflow keys** — S slice · M mute · I monitor · L track loop · D / Shift+D duplicate clip / track · Shift+A contextual select-all · **Q quantize** · **H humanize** (one undo step per press).

## Per-item history

Every clip, track and effect keeps its own session history. Open it from the clip menu, track menu, or the 🕘 on an FX card: a floating panel lists every change with a ↩ that winds back *just that item* — without disturbing anything else anyone did since.

## Effects

- **New builtins**: Low-pass / High-pass / Band-pass / Notch filters and an LFO (tremolo), with live visuals.
- **Routing graph, grown up**: zoom (Ctrl+wheel), middle-drag panning, an inline "+ Add effect" browser, movable In / Mix Out terminals — and **live waveforms riding every wire**, showing the signal as it leaves each node, so you watch the sound transform effect by effect.
- **Automation for any effect parameter** — automation lanes now target any insert's parameter (volume and pan too, as before). Curves own the knob during playback and render into WAV mixdowns and freezes.
- **Collapsible FX cards**, and VST3 editors now receive collaborators' parameter changes live (closing your editor can no longer overwrite a peer's tweak with stale state).

## Piano roll

- Now a **whole-track editor** in absolute song time: every MIDI clip on the track side by side, each editable, with per-clip end handles and dimmed dead space between clips. Scrolls freely across the song.
- Its own **timeline ruler**: scrub the playhead, Shift+click pins the edit marker, drag the top strip for the loop region.
- Marquee drag-select, contextual Shift+A, quantize and humanize.

## Precision input

- **Click any number to type it exactly** — pan ("25L"), volume in dB ("-6", "-inf"), every effect/synth parameter, note velocity, BPM.
- **Shift while dragging any knob, slider or fader = fine adjustment**, engageable mid-drag.

## Collaboration & app

- **File downloads ask first** (default; auto-download available in Settings): one grouped card per batch of incoming collaborator files, expandable to pick individually. Clips just play silent until their file arrives, so waiting is always safe.
- **Middle mouse**: hold and drag pans any panel; a plain click pings (toggleable in Settings).
- **Chat & Activity start hidden**, with corner bubbles — a dot for unread chat, a count of actions on Activity.
- **Exit** asks Save / Save As / Don't Save / Cancel. Settings sits next to File. One return-to-start button (right-click switches its mode). Condensed track headers fit all controls.
