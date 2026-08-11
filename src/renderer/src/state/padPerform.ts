import { useSyncExternalStore } from 'react'
import type { PadId, PerformancePad } from '@core/model/types'
import { PAD_GRID_COLS, PAD_GRID_ROWS, padIdAt } from '@core/model/types'
import { SLICE_BASE_PITCH } from '@core/model/effects'
import { audioEngine } from './audioInstance'
import { projectStore } from './projectStore'
import { transport } from './transport'
import { collab } from './collab'
import { midiInputs } from './midiInputs'

/**
 * Performance-pad TRIGGERING — the ephemeral half of the pad system. Pad
 * assignments live in the document (types.PerformancePad); this store
 * routes hits into the engine: sample pads fire one-shots, note pads play
 * a track's instrument through liveNoteOn (inserts and fader apply), clip
 * pads toggle bar-quantized clip loops. Hits are broadcast over the
 * presence channel and remote hits replay through the exact same path, so
 * a collaborative DJ set is heard by everyone — while nothing about a
 * performance ever touches the document.
 */

/** Keyboard rows (top to bottom) mapped onto the grid's bottom four rows. */
const KEY_ROWS = ['12345678', 'QWERTYUI', 'ASDFGHJK', 'ZXCVBNM,']

class PadPerformStore {
  /** Computer-keyboard triggering (bottom four rows of the grid). */
  kbdEnabled = false
  /** MIDI-note triggering (notes 36+ map across the grid, bottom-left up). */
  midiEnabled = false

  /** Pads currently held down (local or remote) — the grid's lights. */
  private held = new Set<PadId>()
  /** Note pads' open voices, so an up releases exactly what a down opened. */
  private heldNotes = new Map<PadId, { trackId: string; pitch: number }>()

  private version = 0
  private listeners = new Set<() => void>()

  constructor() {
    collab.setPadHitListener((_userId, hit) => {
      this.trigger(hit.padId, hit.action, hit.velocity, false)
    })
    // Engine-side activity (voices ending, loops stopping) relights the grid.
    audioEngine.subscribePads(() => this.emit())
  }

  isHeld(padId: PadId): boolean {
    return this.held.has(padId)
  }

  padDown(padId: PadId, velocity = 0.9): void {
    this.trigger(padId, 'down', velocity, true)
  }

  padUp(padId: PadId): void {
    this.trigger(padId, 'up', 0, true)
  }

  /** One code path for local, keyboard, MIDI and remote hits. */
  private trigger(padId: PadId, action: 'down' | 'up', velocity: number, broadcast: boolean): void {
    const pad = projectStore.state.pads[padId]
    if (!pad) return
    if (action === 'down') {
      this.held.add(padId)
      this.fire(pad, velocity)
    } else {
      this.held.delete(padId)
      this.release(pad)
    }
    // Local echo first (zero latency), then tell the room — the ping rule.
    if (broadcast) collab.sendPadHit(padId, action, velocity)
    this.emit()
  }

  private fire(pad: PerformancePad, velocity: number): void {
    switch (pad.kind) {
      case 'sample':
        if (pad.assetId) audioEngine.playPadSample(pad.id, pad.assetId)
        return
      case 'note': {
        if (!pad.trackId) return
        const prior = this.heldNotes.get(pad.id)
        if (prior) audioEngine.liveNoteOff(prior.trackId, prior.pitch)
        audioEngine.liveNoteOn(pad.trackId, pad.pitch, velocity)
        this.heldNotes.set(pad.id, { trackId: pad.trackId, pitch: pad.pitch })
        return
      }
      case 'clip': {
        if (!pad.clipId) return
        if (audioEngine.clipLoopActive(pad.clipId)) {
          audioEngine.stopClipLoop(pad.clipId)
          return
        }
        // A launch needs a rolling transport — starting the set IS the
        // gesture when the song is parked.
        if (!transport.isPlaying) transport.play()
        audioEngine.launchClipLoop(pad.clipId)
        return
      }
    }
  }

  private release(pad: PerformancePad): void {
    switch (pad.kind) {
      case 'sample':
        if (pad.gate) audioEngine.stopPadSample(pad.id)
        return
      case 'note': {
        const open = this.heldNotes.get(pad.id)
        if (!open) return
        this.heldNotes.delete(pad.id)
        // One-shot note pads let the voice ring to its natural end.
        if (pad.gate) audioEngine.liveNoteOff(open.trackId, open.pitch)
        return
      }
      case 'clip':
        return // clip pads toggle on the down
    }
  }

  // ---------- computer keyboard ----------

  setKbdEnabled(enabled: boolean): void {
    if (this.kbdEnabled === enabled) return
    this.kbdEnabled = enabled
    if (enabled) {
      window.addEventListener('keydown', this.onKeyDown, true)
      window.addEventListener('keyup', this.onKeyUp, true)
    } else {
      window.removeEventListener('keydown', this.onKeyDown, true)
      window.removeEventListener('keyup', this.onKeyUp, true)
    }
    this.emit()
  }

  private padForKey(e: KeyboardEvent): PadId | null {
    if (e.ctrlKey || e.metaKey || e.altKey) return null
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return null
    }
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key
    for (let r = 0; r < KEY_ROWS.length; r++) {
      const col = KEY_ROWS[r].indexOf(key)
      if (col !== -1) return padIdAt(PAD_GRID_ROWS - KEY_ROWS.length + r, col)
    }
    return null
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return
    const padId = this.padForKey(e)
    if (!padId || !projectStore.state.pads[padId]) return
    e.preventDefault()
    e.stopPropagation()
    this.padDown(padId)
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    const padId = this.padForKey(e)
    if (!padId || !projectStore.state.pads[padId]) return
    e.preventDefault()
    e.stopPropagation()
    this.padUp(padId)
  }

  // ---------- MIDI (a Launchpad or the bottom octaves of a keyboard) ----------

  setMidiEnabled(enabled: boolean): void {
    if (this.midiEnabled === enabled) return
    this.midiEnabled = enabled
    if (enabled) {
      void midiInputs.ensure()
      midiInputs.setPadSink((kind, pitch, velocity) => {
        const index = pitch - SLICE_BASE_PITCH
        if (index < 0 || index >= PAD_GRID_ROWS * PAD_GRID_COLS) return false
        // Note 36 = bottom-left, ascending left-to-right then upward —
        // the Launchpad convention.
        const padId = padIdAt(
          PAD_GRID_ROWS - 1 - Math.floor(index / PAD_GRID_COLS),
          index % PAD_GRID_COLS
        )
        if (!projectStore.state.pads[padId]) return false
        if (kind === 'on' && velocity > 0) this.padDown(padId, velocity / 127)
        else this.padUp(padId)
        return true
      })
    } else {
      midiInputs.setPadSink(null)
    }
    this.emit()
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

export const padPerform = new PadPerformStore()

export function usePadPerform(): PadPerformStore {
  useSyncExternalStore(padPerform.subscribe, padPerform.getVersion)
  return padPerform
}
