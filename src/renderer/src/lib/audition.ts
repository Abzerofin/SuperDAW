import type { TrackId } from '@core/model/types'
import { audioEngine } from '@/state/audioInstance'
import { midiInputs } from '@/state/midiInputs'
import { padPerform } from '@/state/padPerform'

/**
 * Click-and-hold auditioning from the UI: piano-roll keys, the sampler's
 * play button — anywhere a pointer press starts a note and the matching
 * release ends it.
 *
 * The press is reliable; the release is not. A pointer can go away without
 * ever delivering `pointerup` to the element that started the note — the
 * window loses focus, the element unmounts under the cursor, a touch gets
 * cancelled — and a synth voice with no note-off sounds until the app
 * closes. So every open audition is remembered here and closed by
 * window-level events that fire no matter where the pointer ended up.
 *
 * Hardware MIDI does NOT come through here: its note-offs arrive over the
 * wire whether or not the window has focus, and cutting a held key on
 * every focus change would be its own bug (see state/midiInputs, which
 * closes its own routes when a device or route actually disappears).
 */

const open = new Map<string, { trackId: TrackId; pitch: number }>()

const keyOf = (trackId: TrackId, pitch: number): string => `${trackId}:${Math.round(pitch)}`

/** Start an audition note (pointer down). */
export function auditionDown(trackId: TrackId, pitch: number, velocity = 0.85): void {
  open.set(keyOf(trackId, pitch), { trackId, pitch })
  audioEngine.liveNoteOn(trackId, pitch, velocity)
}

/** End one audition note (pointer up / leave). Safe to call twice. */
export function auditionUp(trackId: TrackId, pitch: number): void {
  if (!open.delete(keyOf(trackId, pitch))) return
  audioEngine.liveNoteOff(trackId, pitch)
}

/** End every open audition — the pointer is gone, wherever it went. */
export function auditionAllUp(): void {
  const held = [...open.values()]
  open.clear()
  for (const { trackId, pitch } of held) audioEngine.liveNoteOff(trackId, pitch)
}

/**
 * The panic button (Ctrl+.): silence every note that is sounding without
 * the transport playing it — UI auditions, held pads, and any note-off a
 * MIDI route still owes. The last resort when something is stuck, and the
 * thing a musician reaches for before they work out why.
 */
export function panic(): void {
  auditionAllUp()
  padPerform.releaseAllHeld()
  midiInputs.allNotesOff()
  audioEngine.liveAllNotesOff()
}

if (typeof window !== 'undefined') {
  // A release anywhere ends every audition: pointerup on the element is a
  // nicety, this is the guarantee. Capture phase, so a handler that stops
  // propagation cannot strand a voice.
  window.addEventListener('pointerup', auditionAllUp, true)
  window.addEventListener('pointercancel', auditionAllUp, true)
  window.addEventListener('blur', auditionAllUp)
}
