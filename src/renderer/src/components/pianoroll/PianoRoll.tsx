import { useEffect, useReducer, useRef, useState } from 'react'
import type { Note, NoteId } from '@core/model/types'
import { notesOfClip } from '@core/model/types'
import { PPQ, ticksPerBar } from '@core/model/timebase'
import { newId } from '@core/model/ids'
import { projectStore } from '@/state/projectStore'
import { useProjectState } from '@/state/hooks'
import { transport } from '@/state/transport'
import { pianoRollUi } from '@/state/pianoRollUi'
import { capturePointer } from '@/lib/pointer'

const ROW_H = 12
const KEYS_W = 56
const PITCH_MAX = 108 // C8
const PITCH_MIN = 21 // A0
const ROWS = PITCH_MAX - PITCH_MIN + 1
const DEFAULT_NOTE_TICKS = PPQ / 2 // an 8th

const isBlackKey = (pitch: number): boolean => [1, 3, 6, 8, 10].includes(pitch % 12)
const pitchToY = (pitch: number): number => (PITCH_MAX - pitch) * ROW_H
const yToPitch = (y: number): number =>
  Math.min(PITCH_MAX, Math.max(PITCH_MIN, PITCH_MAX - Math.floor(y / ROW_H)))

interface NoteDrag {
  mode: 'move' | 'resize'
  noteId: NoteId
  originX: number
  originY: number
  origStart: number
  origPitch: number
  origDuration: number
  start: number
  pitch: number
  duration: number
}

/** Bottom-dock editor for one MIDI clip's notes. */
export function PianoRoll({ clipId }: { clipId: string }): React.JSX.Element | null {
  const state = useProjectState()
  const [pxPerBeat, setPxPerBeat] = useState(48)
  const [selectedId, setSelectedId] = useState<NoteId | null>(null)
  const [drag, setDrag] = useState<NoteDrag | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const clip = state.clips[clipId]
  const track = clip ? state.tracks[clip.trackId] : undefined

  // Close if the clip vanishes (deleted locally or by a peer).
  useEffect(() => {
    if (!clip) pianoRollUi.close()
  }, [clip])

  // On open: take keyboard focus (Delete must edit notes, not the timeline
  // selection) and center the view around C4 / the clip's notes.
  useEffect(() => {
    rootRef.current?.focus()
    const el = scrollRef.current
    if (!el) return
    const notes = notesOfClip(projectStore.state, clipId)
    const focusPitch =
      notes.length > 0
        ? Math.round(notes.reduce((sum, n) => sum + n.pitch, 0) / notes.length)
        : 60
    el.scrollTop = pitchToY(focusPitch) - el.clientHeight / 2
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId])

  // Ctrl+wheel zoom (native listener — React wheel events are passive).
  // NOTE: all hooks stay above the early return below (rules of hooks).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setPxPerBeat((prev) => Math.min(160, Math.max(12, prev * (e.deltaY < 0 ? 1.2 : 1 / 1.2))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [clip !== undefined])

  if (!clip || !track) return null

  const pxPerTick = pxPerBeat / PPQ
  const gridTicks = pxPerBeat >= 36 ? PPQ / 4 : PPQ / 2
  const barTicks = ticksPerBar(state.timeSignature)
  const notes = notesOfClip(state, clipId)
  const lastEnd = notes.reduce((max, n) => Math.max(max, n.start + n.duration), 0)
  const contentTicks = Math.max(clip.duration, lastEnd) + barTicks * 2
  const contentW = Math.ceil(contentTicks * pxPerTick)
  const selectedNote = selectedId !== null ? state.notes[selectedId] : undefined

  const withPreview = (note: Note): Note =>
    drag && drag.noteId === note.id
      ? { ...note, start: drag.start, pitch: drag.pitch, duration: drag.duration }
      : note

  const addNote = (e: React.MouseEvent): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const ticks = Math.max(0, e.clientX - rect.left) / pxPerTick
    const note: Note = {
      id: newId('not'),
      clipId,
      pitch: yToPitch(e.clientY - rect.top),
      start: Math.floor(ticks / gridTicks) * gridTicks,
      duration: DEFAULT_NOTE_TICKS,
      velocity: 100
    }
    projectStore.dispatch({ type: 'note/add', note })
    setSelectedId(note.id)
  }

  const beginDrag = (e: React.PointerEvent, note: Note, mode: NoteDrag['mode']): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    capturePointer(e)
    setSelectedId(note.id)
    setDrag({
      mode,
      noteId: note.id,
      originX: e.clientX,
      originY: e.clientY,
      origStart: note.start,
      origPitch: note.pitch,
      origDuration: note.duration,
      start: note.start,
      pitch: note.pitch,
      duration: note.duration
    })
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!drag) return
    const dxTicks = (e.clientX - drag.originX) / pxPerTick
    setDrag((prev) => {
      if (!prev) return prev
      if (prev.mode === 'move') {
        const snapped = Math.round((prev.origStart + dxTicks) / gridTicks) * gridTicks
        const dPitch = Math.round((prev.originY - e.clientY) / ROW_H)
        return {
          ...prev,
          start: Math.max(0, snapped),
          pitch: Math.min(PITCH_MAX, Math.max(PITCH_MIN, prev.origPitch + dPitch))
        }
      }
      const snapped = Math.round((prev.origDuration + dxTicks) / gridTicks) * gridTicks
      return { ...prev, duration: Math.max(gridTicks, snapped) }
    })
  }

  const endDrag = (): void => {
    if (!drag) return
    if (drag.mode === 'move' && (drag.start !== drag.origStart || drag.pitch !== drag.origPitch)) {
      projectStore.dispatch({
        type: 'note/move',
        noteId: drag.noteId,
        pitch: drag.pitch,
        start: drag.start
      })
    } else if (drag.mode === 'resize' && drag.duration !== drag.origDuration) {
      projectStore.dispatch({ type: 'note/resize', noteId: drag.noteId, duration: drag.duration })
    }
    setDrag(null)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // Don't steal keys from the velocity slider (or any future input).
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT') return
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
      e.stopPropagation()
      projectStore.dispatch({ type: 'note/delete', noteIds: [selectedId] })
      setSelectedId(null)
    }
    if (e.key === 'Escape') pianoRollUi.close()
  }

  const rowStripes = {
    backgroundImage:
      `repeating-linear-gradient(to bottom, var(--proll-black-row) 0 ${ROW_H}px, transparent ${ROW_H}px ${ROW_H * 2}px),` +
      `repeating-linear-gradient(to right, var(--grid-bar) 0 1px, transparent 1px ${barTicks * pxPerTick}px),` +
      `repeating-linear-gradient(to right, var(--grid-beat) 0 1px, transparent 1px ${pxPerBeat}px)`
  }

  return (
    <div className="proll" ref={rootRef} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="proll-head">
        <span className="proll-title">
          <span className="proll-dot" style={{ background: track.color }} />
          {clip.name} · {track.name}
        </span>
        {selectedNote && <VelocityControl key={selectedNote.id} note={selectedNote} />}
        <span className="proll-hint">
          Double-click to add · drag to move · edge to resize · Del to delete
        </span>
        <button className="proll-close" title="Close (Esc)" onClick={() => pianoRollUi.close()}>
          ×
        </button>
      </div>
      <div className="proll-scroll" ref={scrollRef}>
        <div
          className="proll-grid"
          style={{ width: KEYS_W + contentW, height: ROWS * ROW_H }}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
        >
          <div className="proll-keys">
            {Array.from({ length: ROWS }, (_, i) => {
              const pitch = PITCH_MAX - i
              return (
                <div
                  key={pitch}
                  className={`proll-key ${isBlackKey(pitch) ? 'proll-key-black' : ''}`}
                >
                  {pitch % 12 === 0 && (
                    <span className="proll-key-label mono">
                      C{Math.floor(pitch / 12) - 1}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
          <div
            className="proll-lane"
            style={{ left: KEYS_W, width: contentW, ...rowStripes }}
            onDoubleClick={addNote}
            onPointerDown={() => setSelectedId(null)}
          >
            {/* Region past the clip end: notes there are silent. */}
            <div
              className="proll-dead"
              style={{ left: clip.duration * pxPerTick, width: contentW - clip.duration * pxPerTick }}
            />
            {notes.map((raw) => {
              const note = withPreview(raw)
              return (
                <div
                  key={note.id}
                  className={`proll-note ${note.id === selectedId ? 'proll-note-selected' : ''} ${
                    note.start >= clip.duration ? 'proll-note-dead' : ''
                  }`}
                  style={{
                    left: note.start * pxPerTick,
                    top: pitchToY(note.pitch),
                    width: Math.max(4, note.duration * pxPerTick - 1),
                    height: ROW_H - 1,
                    opacity: 0.45 + 0.55 * (note.velocity / 127),
                    '--track-color': track.color
                  } as React.CSSProperties}
                  onPointerDown={(e) => beginDrag(e, raw, 'move')}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    projectStore.dispatch({ type: 'note/delete', noteIds: [raw.id] })
                  }}
                >
                  <div
                    className="proll-note-handle"
                    onPointerDown={(e) => beginDrag(e, raw, 'resize')}
                  />
                </div>
              )
            })}
            <RollPlayhead clipStart={clip.start} pxPerTick={pxPerTick} />
          </div>
        </div>
      </div>
    </div>
  )
}

/** Velocity for the selected note: live slider, ONE op on release. */
function VelocityControl({ note }: { note: Note }): React.JSX.Element {
  const [preview, setPreviewState] = useState<number | null>(null)
  const previewRef = useRef<number | null>(null)

  const setPreview = (value: number): void => {
    previewRef.current = value
    setPreviewState(value)
  }

  const commit = (): void => {
    const value = previewRef.current
    previewRef.current = null
    setPreviewState(null)
    if (value !== null && value !== note.velocity) {
      projectStore.dispatch({ type: 'note/setVelocity', noteId: note.id, velocity: value })
    }
  }

  return (
    <span className="proll-vel" title="Velocity of the selected note">
      <span className="proll-vel-label">Vel</span>
      <input
        type="range"
        min={1}
        max={127}
        value={preview ?? note.velocity}
        onChange={(e) => setPreview(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="mono proll-vel-value">{preview ?? note.velocity}</span>
    </span>
  )
}

function RollPlayhead({
  clipStart,
  pxPerTick
}: {
  clipStart: number
  pxPerTick: number
}): React.JSX.Element | null {
  const [, force] = useReducer((c: number) => c + 1, 0)
  useEffect(() => transport.subscribe(force), [])
  const rel = transport.positionTicks() - clipStart
  if (rel < 0) return null
  return <div className="playhead" style={{ transform: `translateX(${rel * pxPerTick}px)` }} />
}
