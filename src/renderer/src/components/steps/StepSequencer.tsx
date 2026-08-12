import { useEffect, useMemo, useRef, useState } from 'react'
import { PPQ } from '@core/model/timebase'
import type { Note } from '@core/model/types'
import { DRUM_PADS, instrumentKindOf } from '@core/model/effects'
import { newId } from '@core/model/ids'
import { useProjectState } from '@/state/hooks'
import { projectStore } from '@/state/projectStore'
import { editorUi } from '@/state/editorUi'
import { EditorFormSwitch } from '../editor/EditorFormSwitch'
import { audioEngine } from '@/state/audioInstance'
import { transport } from '@/state/transport'

/**
 * The step-grid form of the clip editor: a drum-machine grid over ONE MIDI
 * clip's notes (the piano roll is the same tab's other form). Rows are
 * the drum kit's pads (or, on melodic tracks, the pitches in play); columns
 * are 16th/8th steps. Cells are the clip's actual Note entities — the piano
 * roll, the timeline previews and collaborators all see the same edit the
 * moment it lands. A paint drag is ONE op (note/addMany / note/delete), so
 * undo removes the whole stroke, and painting never floods the sync stream.
 */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const MAX_STEPS = 512
/** Cell/label geometry — mirrored by the .steps-* rules in styles.css. */
const STEP_W = 22
const LABEL_W = 64

function pitchName(pitch: number): string {
  return `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`
}

interface Row {
  readonly pitch: number
  readonly label: string
}

interface PaintState {
  readonly mode: 'add' | 'erase'
  readonly accent: boolean
  /** Cells painted so far this stroke, keyed `${pitch}:${col}`. */
  readonly cells: Map<string, { pitch: number; col: number }>
  /** Existing note ids the stroke erases. */
  readonly eraseIds: Set<string>
  /** Commit context captured at stroke start (a re-render can't stale it). */
  readonly clipId: string
  readonly stepTicks: number
}

export function StepSequencer({ clipId: openClipId }: { clipId: string }): React.JSX.Element {
  const state = useProjectState()
  const clip = state.clips[openClipId]
  const track = clip ? state.tracks[clip.trackId] : undefined
  const [stepsPerBeat, setStepsPerBeat] = useState(4)
  const [paint, setPaint] = useState<PaintState | null>(null)
  const paintRef = useRef<PaintState | null>(null)

  const stepTicks = PPQ / stepsPerBeat
  const clipId = clip?.id ?? null

  // The clip can vanish under the panel (deleted, undone, project closed).
  // Close instead of dangling — a dead id would keep the tab "openable".
  useEffect(() => {
    if (!projectStore.state.clips[openClipId]) editorUi.close()
  }, [openClipId, state.clips])

  const clipNotes = useMemo(() => {
    if (!clipId) return []
    return Object.values(state.notes).filter((n) => n.clipId === clipId)
  }, [state.notes, clipId])

  const rows: Row[] = useMemo(() => {
    if (!track) return []
    if (instrumentKindOf(track.synth) === 'drums') {
      return DRUM_PADS.map((pad) => ({ pitch: pad.pitch, label: pad.label }))
    }
    // Melodic tracks: the pitches in play plus a default octave to build in.
    const pitches = new Set<number>()
    for (let p = 60; p < 72; p++) pitches.add(p)
    for (const note of clipNotes) pitches.add(note.pitch)
    return [...pitches]
      .sort((a, b) => b - a)
      .map((pitch) => ({ pitch, label: pitchName(pitch) }))
  }, [track, clipNotes])

  const byCell = useMemo(() => {
    const map = new Map<string, Note[]>()
    for (const note of clipNotes) {
      const col = Math.floor(note.start / stepTicks)
      const key = `${note.pitch}:${col}`
      const list = map.get(key)
      if (list) list.push(note)
      else map.set(key, [note])
    }
    return map
  }, [clipNotes, stepTicks])

  // One stroke = one op, committed on pointerup anywhere. The stroke lives
  // in a REF and the listener is mounted once — a click released within a
  // single frame must not depend on React re-rendering in between.
  useEffect(() => {
    const up = (): void => {
      const p = paintRef.current
      if (!p) return
      paintRef.current = null
      setPaint(null)
      if (p.mode === 'erase') {
        if (p.eraseIds.size > 0) {
          projectStore.dispatch({ type: 'note/delete', noteIds: [...p.eraseIds] })
        }
        return
      }
      const notes: Note[] = [...p.cells.values()].map(({ pitch, col }) => ({
        id: newId('not'),
        clipId: p.clipId,
        pitch,
        start: col * p.stepTicks,
        duration: p.stepTicks,
        velocity: p.accent ? 127 : 100
      }))
      if (notes.length === 1) projectStore.dispatch({ type: 'note/add', note: notes[0] })
      else if (notes.length > 1) projectStore.dispatch({ type: 'note/addMany', notes })
    }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [])

  if (!clip || !track) {
    return (
      <div className="steps-panel">
        <div className="bay-empty">Select a MIDI clip to program a beat</div>
      </div>
    )
  }

  const cols = Math.min(MAX_STEPS, Math.max(1, Math.ceil(clip.duration / stepTicks)))
  const beatsPerBar = state.timeSignature[0]

  const audition = (pitch: number): void => {
    audioEngine.liveNoteOn(track.id, pitch, 0.85)
    window.setTimeout(() => audioEngine.liveNoteOff(track.id, pitch), 140)
  }

  const beginPaint = (pitch: number, col: number, accent: boolean, forceErase = false): void => {
    if (!clipId) return
    const existing = byCell.get(`${pitch}:${col}`)
    // Right-click always erases (the standard drum-machine gesture), even
    // when starting on an empty cell — the drag erases whatever it crosses.
    const stroke: PaintState =
      forceErase || (existing && existing.length > 0)
        ? {
            mode: 'erase',
            accent: false,
            cells: new Map([[`${pitch}:${col}`, { pitch, col }]]),
            eraseIds: new Set((existing ?? []).map((n) => n.id)),
            clipId,
            stepTicks
          }
        : {
            mode: 'add',
            accent,
            cells: new Map([[`${pitch}:${col}`, { pitch, col }]]),
            eraseIds: new Set(),
            clipId,
            stepTicks
          }
    if (stroke.mode === 'add') audition(pitch)
    // Synchronously, so a click released within the same frame still
    // commits; setPaint only mirrors the stroke for rendering.
    paintRef.current = stroke
    setPaint(stroke)
  }

  const extendPaint = (pitch: number, col: number): void => {
    const p = paintRef.current
    if (!p) return
    const key = `${pitch}:${col}`
    if (p.cells.has(key)) return
    const existing = byCell.get(key)
    if (p.mode === 'add') {
      if (existing && existing.length > 0) return // occupied: skip, keep painting
      audition(pitch)
      p.cells.set(key, { pitch, col })
    } else {
      if (!existing || existing.length === 0) return
      p.cells.set(key, { pitch, col })
      for (const note of existing) p.eraseIds.add(note.id)
    }
    setPaint({ ...p })
  }

  return (
    <div className="steps-panel">
      <div className="steps-head">
        <span className="proll-dot" style={{ background: clip.color ?? track.color }} />
        <span className="fx-dock-title">{clip.name}</span>
        <span className="statusbar-dim">
          {track.name} · {Math.ceil(cols / (beatsPerBar * stepsPerBeat))} bars
        </span>
        <EditorFormSwitch />
        <div className="fx-waves">
          <button
            className={`fx-wave fx-inst-kind ${stepsPerBeat === 4 ? 'fx-wave-active' : ''}`}
            title="16th-note steps"
            onClick={() => setStepsPerBeat(4)}
          >
            1/16
          </button>
          <button
            className={`fx-wave fx-inst-kind ${stepsPerBeat === 2 ? 'fx-wave-active' : ''}`}
            title="8th-note steps"
            onClick={() => setStepsPerBeat(2)}
          >
            1/8
          </button>
        </div>
        <button className="proll-close steps-close" title="Close" onClick={() => editorUi.close()}>
          ×
        </button>
      </div>
      <div className="steps-scroll" data-pan>
        <div className="steps-grid" style={{ ['--step-cols' as string]: cols }}>
          <div className="steps-corner" />
          <div className="steps-ruler">
            {Array.from({ length: cols }, (_, col) => (
              <div
                key={col}
                className={`steps-ruler-cell ${col % (beatsPerBar * stepsPerBeat) === 0 ? 'steps-bar-start' : col % stepsPerBeat === 0 ? 'steps-beat-start' : ''}`}
              >
                {col % stepsPerBeat === 0 ? col / stepsPerBeat + 1 : ''}
              </div>
            ))}
          </div>
          {rows.map((row) => (
            <StepRow
              key={row.pitch}
              row={row}
              cols={cols}
              stepsPerBeat={stepsPerBeat}
              beatsPerBar={beatsPerBar}
              byCell={byCell}
              paint={paint}
              onAudition={() => audition(row.pitch)}
              onBegin={beginPaint}
              onExtend={extendPaint}
            />
          ))}
          <StepPlayhead clip={clip} stepTicks={stepTicks} />
        </div>
      </div>
    </div>
  )
}

function StepRow({
  row,
  cols,
  stepsPerBeat,
  beatsPerBar,
  byCell,
  paint,
  onAudition,
  onBegin,
  onExtend
}: {
  row: Row
  cols: number
  stepsPerBeat: number
  beatsPerBar: number
  byCell: Map<string, Note[]>
  paint: PaintState | null
  onAudition: () => void
  onBegin: (pitch: number, col: number, accent: boolean, forceErase?: boolean) => void
  onExtend: (pitch: number, col: number) => void
}): React.JSX.Element {
  return (
    <>
      <button className="steps-label" title={`${row.label} — click to audition`} onClick={onAudition}>
        {row.label}
      </button>
      {Array.from({ length: cols }, (_, col) => {
        const key = `${row.pitch}:${col}`
        const notes = byCell.get(key)
        const painted = paint?.cells.has(key) ?? false
        const active =
          paint?.mode === 'erase'
            ? (notes?.length ?? 0) > 0 && !painted
            : (notes?.length ?? 0) > 0 || painted
        const velocity = painted && paint?.mode === 'add'
          ? (paint.accent ? 127 : 100)
          : (notes?.[0]?.velocity ?? 100)
        return (
          <button
            key={col}
            className={`steps-cell ${active ? 'steps-cell-on' : ''} ${
              col % (beatsPerBar * stepsPerBeat) === 0
                ? 'steps-bar-start'
                : col % stepsPerBeat === 0
                  ? 'steps-beat-start'
                  : ''
            }`}
            style={active ? { ['--step-vel' as string]: (0.35 + 0.65 * velocity / 127).toFixed(2) } : undefined}
            title={`${row.label} · step ${col + 1}${active ? ` · velocity ${velocity}` : ''} — Shift+click for an accent · right-click to erase`}
            onPointerDown={(e) => {
              if (e.button !== 0 && e.button !== 2) return
              e.preventDefault()
              onBegin(row.pitch, col, e.shiftKey, e.button === 2)
            }}
            onPointerEnter={(e) => {
              if ((e.buttons & 3) !== 0) onExtend(row.pitch, col)
            }}
            onContextMenu={(e) => e.preventDefault()}
          />
        )
      })}
    </>
  )
}

/** The moving playhead line, painted straight to the DOM (never re-renders React). */
function StepPlayhead({
  clip,
  stepTicks
}: {
  clip: { start: number; duration: number }
  stepTicks: number
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(
    () =>
      transport.subscribe(() => {
        const el = ref.current
        if (!el) return
        const ticks = transport.displayTicks() - clip.start
        const visible = transport.isPlaying && ticks >= 0 && ticks < clip.duration
        el.style.display = visible ? 'block' : 'none'
        if (visible) {
          el.style.transform = `translateX(${LABEL_W + (ticks / stepTicks) * STEP_W}px)`
        }
      }),
    [clip.start, clip.duration, stepTicks]
  )
  return <div className="steps-playhead" ref={ref} style={{ display: 'none' }} />
}
