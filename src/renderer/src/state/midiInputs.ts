import { useSyncExternalStore } from 'react'
import type { TrackId } from '@core/model/types'
import { parseMidiNoteMessage } from '@audio/midiCapture'
import { audioEngine } from './audioInstance'
import { projectStore } from './projectStore'
import { recording } from './recording'
import { selection } from './selection'
import { trackInputs } from './trackInputs'
import { statusNotice } from './statusNotice'
import { appStorageGet, appStorageSet } from './appStorage'

/**
 * MIDI input devices — app-level state exactly like audioDevices: personal,
 * persisted via appStorage, NEVER part of the project (a device id means
 * nothing on another machine). One global input selection (null = ALL
 * devices, the right default for a keyboard on a desk); per-track device
 * and channel overrides live in trackInputs.
 *
 * Access is lazy: nothing touches navigator.requestMIDIAccess until a MIDI
 * surface asks (Settings, a MIDI track's input panel, record start), so a
 * plain browser without the API — or a user who denies it — boots and runs
 * untouched. Note events route to every ARMED MIDI track; with none armed,
 * to the SELECTED track when it is a MIDI track — select and play, no
 * ceremony. Live audition goes through audioEngine.liveNoteOn/Off; capture
 * (while recording rolls) through recording.captureMidiEvent — both fed by
 * ONE code path that `inject()` shares, so tests and the dev handle
 * exercise exactly what hardware does.
 */

/** Structural Web MIDI types — feature-detected, never assumed in lib.dom. */
interface WebMidiInput {
  readonly id: string
  readonly name: string | null
  readonly manufacturer?: string | null
  onmidimessage: ((event: { data: Uint8Array | null; timeStamp: number }) => void) | null
}
interface WebMidiAccess {
  readonly inputs: ReadonlyMap<string, WebMidiInput>
  onstatechange: (() => void) | null
}

export interface MidiInputInfo {
  readonly id: string
  readonly name: string
}

export type MidiAccessStatus = 'idle' | 'pending' | 'ready' | 'denied' | 'unsupported'

const STORAGE_KEY = 'midiInputs'

/** Synthetic device id used by inject(); passes the omni/default filters. */
const INJECTED_INPUT_ID = '__injected__'

class MidiInputStore {
  /** Whether this environment offers Web MIDI at all (absent in Safari). */
  readonly supported =
    typeof navigator !== 'undefined' &&
    typeof (navigator as Navigator & { requestMIDIAccess?: unknown }).requestMIDIAccess ===
      'function'
  status: MidiAccessStatus = this.supported ? 'idle' : 'unsupported'
  inputs: MidiInputInfo[] = []
  /** null = listen to all devices (omni). */
  selectedInputId: string | null = null

  private access: WebMidiAccess | null = null
  private ensurePromise: Promise<void> | null = null
  /** Tracks that received each open note-on, keyed input:channel:pitch —
   *  the matching note-off must land on exactly these even if arming or
   *  selection moved while the key was held (a rerouted off would strand
   *  the old track's live voice, and its capture, open forever). */
  private openNoteRoutes = new Map<string, TrackId[]>()

  private version = 0
  private listeners = new Set<() => void>()

  constructor() {
    // The persisted selection loads immediately; hardware waits for ensure().
    void this.loadSelection()
  }

  private async loadSelection(): Promise<void> {
    const stored = await appStorageGet<{ selectedInputId?: string | null }>(STORAGE_KEY)
    if (stored && typeof stored.selectedInputId === 'string') {
      this.selectedInputId = stored.selectedInputId
      // Access may already be open (storage can resolve after the first
      // enumeration) — validate now instead of waiting for a hot-plug.
      if (this.access) this.dropSelectionIfMissing()
      this.emit()
    }
  }

  /**
   * Open MIDI access (idempotent, safe to await from anywhere). In plain
   * Chrome this may show the browser's own permission prompt — which is
   * why it only runs when a MIDI surface actually needs it.
   */
  ensure(): Promise<void> {
    if (!this.supported || this.access) return Promise.resolve()
    if (this.ensurePromise) return this.ensurePromise
    this.status = 'pending'
    this.emit()
    this.ensurePromise = (
      navigator as unknown as {
        requestMIDIAccess: (options?: { sysex?: boolean }) => Promise<WebMidiAccess>
      }
    )
      .requestMIDIAccess({ sysex: false })
      .then((access) => {
        this.access = access
        this.status = 'ready'
        access.onstatechange = () => this.refreshPorts()
        this.refreshPorts()
      })
      .catch(() => {
        this.status = 'denied'
        this.emit()
      })
      .finally(() => {
        this.ensurePromise = null
      })
    return this.ensurePromise
  }

  /** Re-wire message handlers and rebuild the device list. */
  private refreshPorts(): void {
    const access = this.access
    if (!access) return
    const inputs: MidiInputInfo[] = []
    let index = 0
    for (const input of access.inputs.values()) {
      inputs.push({ id: input.id, name: input.name || `MIDI input ${++index}` })
      // Assigning every refresh is idempotent and survives hot-plugs.
      input.onmidimessage = (event) => {
        if (event.data) this.handleMessage(input.id, event.data, event.timeStamp)
      }
    }
    this.inputs = inputs
    // Loss handling runs on EVERY enumeration, first included: a selection
    // persisted from another session may simply not be plugged in today,
    // and keeping it would silently filter ALL input while the Settings
    // select falls back to showing "All devices".
    this.dropSelectionIfMissing()
    this.emit()
  }

  /** Selected device absent → revert to omni (the audioDevices precedent). */
  private dropSelectionIfMissing(): void {
    if (this.selectedInputId === null) return
    if (this.inputs.some((d) => d.id === this.selectedInputId)) return
    this.selectedInputId = null
    this.persist()
    statusNotice.show('Selected MIDI input is not connected — listening to all devices.')
  }

  setSelected(id: string | null): void {
    if (this.selectedInputId === id) return
    this.selectedInputId = id
    this.persist()
    this.emit()
  }

  /**
   * Feed a raw MIDI message through the exact path hardware uses — the
   * dev/test seam (window.__superdaw.midi.inject). Timestamps are on the
   * performance timeline in ms, like real MIDIMessageEvent.timeStamp.
   */
  inject(data: readonly number[] | Uint8Array, timeStampMs?: number): void {
    this.handleMessage(INJECTED_INPUT_ID, Uint8Array.from(data), timeStampMs ?? performance.now())
  }

  /**
   * Route one parsed message (note-on/note-off only — the parser in
   * audio/midiCapture drops everything else). A note-on remembers which
   * tracks it reached; the matching note-off replays to exactly that set,
   * so a voice opened on one track always gets its off there — legato
   * survives switching the armed/selected target mid-hold.
   */
  private handleMessage(inputId: string, data: Uint8Array, timeStampMs: number): void {
    const message = parseMidiNoteMessage(data)
    if (!message) return
    const { kind, channel, pitch, velocity } = message
    const routeKey = `${inputId}:${channel}:${pitch}`
    const remembered = kind === 'off' ? this.openNoteRoutes.get(routeKey) : undefined
    // No memory for an off = the key was down before we listened; current
    // targets shrug off an unmatched off (engine and capture tolerate it).
    const targets =
      remembered ??
      this.targetTracks().filter((id) => this.trackAccepts(id, inputId, channel))
    if (kind === 'on') this.openNoteRoutes.set(routeKey, targets)
    else this.openNoteRoutes.delete(routeKey)

    for (const trackId of targets) {
      if (kind === 'on') {
        audioEngine.liveNoteOn(trackId, pitch, velocity / 127)
        recording.captureMidiEvent(trackId, 'on', pitch, velocity, timeStampMs)
      } else {
        audioEngine.liveNoteOff(trackId, pitch)
        recording.captureMidiEvent(trackId, 'off', pitch, velocity, timeStampMs)
      }
    }
  }

  /** Armed MIDI tracks; else the selected track when it is a MIDI track. */
  private targetTracks(): TrackId[] {
    const state = projectStore.state
    const playable = (id: TrackId): boolean => {
      const track = state.tracks[id]
      return track !== undefined && track.kind === 'midi' && track.frozenAssetId === null
    }
    const armed = recording.armedIds().filter(playable)
    if (armed.length > 0) return armed
    const selected = selection.selectedTrackId
    return selected !== null && playable(selected) ? [selected] : []
  }

  /** Per-track device + channel filter (null device = follow the global). */
  private trackAccepts(trackId: TrackId, inputId: string, channel: number): boolean {
    const config = trackInputs.configOf(trackId)
    const wantedDevice = config.midiInputId ?? this.selectedInputId
    if (wantedDevice !== null && wantedDevice !== inputId) return false
    return config.midiChannel === 'all' || config.midiChannel === channel
  }

  private persist(): void {
    void appStorageSet(STORAGE_KEY, { selectedInputId: this.selectedInputId })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version

  private emit(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }
}

export const midiInputs = new MidiInputStore()

export function useMidiInputs(): MidiInputStore {
  useSyncExternalStore(midiInputs.subscribe, midiInputs.getVersion)
  return midiInputs
}
