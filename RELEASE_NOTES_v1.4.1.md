SuperDAW 1.4.1 — the mixing & takes release. Everything below rides the same op pipeline as always: undoable, synced to collaborators, saved in your `.sdaw` files.

## Mixing

- **Per-strip metering** in the mixer: a dB-scaled bar per channel with an RMS core, peak hold, and a clip latch you clear with a click.
- **Master-bus insert effects** — the master strip now takes the same effect chain as any track.
- **Sidechain routing** with a new **Sidechain Duck** builtin: key it from any track's post-fader signal, so mute/solo/volume on the key are what you duck against.
- **Live LUFS metering** on the master bus.
- **Spectrum analyzer** for the master bus, in a transport-bar popover.
- **Per-track macro controls**: four knobs per track, each mappable to any insert parameter.
- Mixer strips now stretch with the dock height — a taller mixer means a longer fader throw, and below the minimum the desk scrolls instead of crushing the strips.

## Recording & takes

- **Comping / take lanes**: record several passes over one region and choose between them. Each pass lands as a take; unfold the lane to audition, click a take to make it the active one, then flatten when the comp is done. One click is one op, so take choices undo cleanly and sync to collaborators.

## Effects

- Two new builtin inserts: **Reverb Pro** and **Saturator**.

## Arranging & editing

- **Named arrangement markers** — part of the document, so they save, sync, and undo.
- **Musical scales in the piano roll**: a scale guide on the key lanes plus optional snap to scale.

## Import & export

- **Export Stems**: bounce every audible track to its own file, with a directory picker (or a zip in the browser build).
- **ACID loop import**: loops with ACID metadata auto-conform to the project tempo, file slice markers come along, and REX files get a clear notice instead of a silent failure.

## Plugins

- Groundwork for **CLAP hosting** (phase C1): a native scanner plus browse/add plumbing. Full CLAP audio lands over the coming phases.

## Fixes

- Toggling Warp on a clip now reschedules its audio immediately instead of leaving the old rendering audible until the next transport restart.
- A project template with malformed plugin parameter definitions now drops that plugin at load instead of failing later.

## Also in this build

- SuperDAW has a website now — overview and donation pages, app screenshots, and a LAN-first collaboration guide (including Tailscale setup) — plus a proper app logo.
