# Loop formats

What SuperDAW understands about loop-library files, and why .rx2 is
recognized but not decoded.

## ACID-ized WAV (supported)

Loop libraries going back to Sony ACID embed tempo metadata in ordinary
WAV files as extra RIFF chunks. `src/audio/loopMeta.ts` parses them —
pure byte parsing, no decoding, never throws on malformed input:

- **`acid`** — file-type flags (one-shot vs. loop), root note, number of
  beats, meter, native tempo.
- **`smpl`** — sampler loop points (start/end in sample frames).
- **`cue `** — marker positions; ReCycle-style editors and many DAWs
  write the loop's slice map here.

What the import path does with it:

- A **loop with a known tempo/beat count** gets the existing tempo-conform
  treatment on clip creation, driven by the same Settings preference that
  governs tempo changes (Settings ▸ General ▸ "Tempo changes"): `always`
  creates the clip already stretched onto the project tempo (tape-style,
  the same math and clamp as `project/setTempo`'s conform), with its
  duration snapped to the loop's beat count so it tiles exactly; `ask`
  imports plain and puts the question in the status bar as a one-click
  "Stretch to fit" action (one op, one undo — no popup mid-drop); `never`
  imports plain. A loop already at the project tempo just gets the
  beat-snapped duration.
- **Cue markers** (two or more) are treated as the file's authorial slice
  map: "Slice at transients", "Slice to sampler", the sampler's SLICES
  mode and waveform-peak snapping all use them instead of the detected
  transients, through one shared seam (`assetOnsetSeconds`). Document data
  stays slice-INDEX based; since markers derive from the encoded bytes,
  every collaborator computes the identical boundaries.

Nothing from these chunks is ever written into the project document —
everything is re-derived from the asset's encoded bytes when needed, so
project files carry no proprietary metadata.

## REX (.rx2 / .rex / .rcy) — recognized, not decoded

REX is Propellerheads' (Reason Studios') ReCycle container. The slice
table is readable, but the audio inside is compressed with a
**proprietary, undocumented codec** — there is no spec, and no
independent open-source decoder. Deliberately not reverse-engineered.

Decoding legitimately requires the licensed **REX Shared Library SDK**
(a closed-source Windows DLL / macOS dylib distributed by Reason Studios
under an agreement that precludes bundling it in an open project without
their sign-off). What .rx2 support would take:

1. An agreement with Reason Studios for SDK redistribution.
2. An **optional native addon** (like `native/audiohost`) wrapping the
   DLL/dylib, loaded only when present, with the import path treating
   "REX host available" like any other optional capability — absent =
   the current notice.
3. The decoded slices would then flow through the normal asset pipeline
   (each slice a plain buffer; the slice map becomes the same index-based
   data ACID cue markers produce).

Until then, the import path **recognizes** `.rx2`/`.rex`/`.rcy` by
extension and shows one status-bar notice pointing here instead of a
silent skip or a failed decode. The practical route: export the loop
from ReCycle/Reason (or any converter) as WAV or AIFF — an ACID-ized WAV
keeps both the tempo and the slice map, and imports fully.
