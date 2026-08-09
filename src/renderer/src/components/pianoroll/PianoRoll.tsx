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

/** One note taking part in a drag: pre-drag values plus its live preview. */
interface DragMember {
  noteId: NoteId
  origStart: number
  origPitch: number
  start: number
  pitch: number
}

interface NoteDrag extends DragMember {
  mode: 'move' | 'resize-r' | 'resize-l'
  originX: number
  originY: number
  origDuration: number
  duration: number
  /**
   * The rest of a multi-selection, moved by the same deltas as the grabbed
   * note (which does the snapping). Empty for a single-note drag; edge
   * resizes always act on the grabbed note alone.
   */
  others: DragMember[]
}

/**
 * Rubber-band selection over the note lane. Coordinates are lane-content
 * pixels (scroll-independent), matching how notes are positioned.
 */
interface MarqueeState {
  originX: number
  originY: number
  x: number
  y: number
  /** Selection when the drag began (Shift/Ctrl adds to it). */
  base: NoteId[]
}

/** Bottom-dock editor for one MIDI clip's notes. */
export function PianoRoll({ clipId }: { clipId: string }): React.JSX.Element | null {
  const state = useProjectState()
  const [pxPerBeat, setPxPerBeat] = useState(48)
  const [selected, setSelected] = useState<ReadonlySet<NoteId>>(new Set())
  const [drag, setDrag] = useState<NoteDrag | null>(null)
  // Mirrored in refs: pointermove updates batch at low priority, so a fast
  // gesture could otherwise commit against stale state on pointerup.
  const [marquee, setMarqueeState] = useState<MarqueeState | null>(null)
  const marqueeRef = useRef<MarqueeState | null>(null)
  const setMarquee = (value: MarqueeState | null): void => {
    marqueeRef.current = value
    setMarqueeState(value)
  }
  /** Live preview while dragging the clip-end handle (ticks), else null. */
  const [endPreview, setEndPreviewState] = useState<number | null>(null)
  const endPreviewRef = useRef<number | null>(null)
  const setEndPreview = (value: number | null): void => {
    endPreviewRef.current = value
    setEndPreviewState(value)
  }
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const laneRef = useRef<HTMLDivElement>(null)

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
    setSelected(new Set())
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
  const shownClipEnd = endPreview ?? clip.duration
  const contentTicks = Math.max(shownClipEnd, lastEnd) + barTicks * 2
  const contentW = Math.ceil(contentTicks * pxPerTick)
  const selectedNote =
    selected.size === 1 ? state.notes[[...selected][0]] : undefined

  const withPreview = (note: Note): Note => {
    if (!drag) return note
    if (drag.noteId === note.id) {
      return { ...note, start: drag.start, pitch: drag.pitch, duration: drag.duration }
    }
    const member = drag.others.find((m) => m.noteId === note.id)
    return member ? { ...note, start: member.start, pitch: member.pitch } : note
  }

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
    setSelected(new Set([note.id]))
  }

  const beginDrag = (e: React.PointerEvent, note: Note, mode: NoteDrag['mode']): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    // Shift/Ctrl-click gathers notes instead of dragging, like the timeline.
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(note.id)) next.delete(note.id)
        else next.add(note.id)
        return next
      })
      return
    }
    capturePointer(e)
    // Grabbing a note inside a multi-selection drags the whole set;
    // grabbing anything else collapses the selection to it.
    const inSelection = selected.has(note.id) && selected.size > 1
    const nextSelection = inSelection ? selected : new Set([note.id])
    setSelected(nextSelection)
    const others: DragMember[] =
      mode === 'move' && inSelection
        ? [...nextSelection]
            .filter((id) => id !== note.id)
            .flatMap((id) => {
              const other = projectStore.state.notes[id]
              if (!other) return []
              return [
                {
                  noteId: other.id,
                  origStart: other.start,
                  origPitch: other.pitch,
                  start: other.start,
                  pitch: other.pitch
                }
              ]
            })
        : []
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
      duration: note.duration,
      others
    })
  }

  /** Pointer position in lane-content pixels. */
  const lanePoint = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = laneRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return { x: Math.max(0, e.clientX - rect.left), y: Math.max(0, e.clientY - rect.top) }
  }

  /** Notes whose rectangles intersect the dragged box. */
  const notesInMarquee = (box: MarqueeState): NoteId[] => {
    const left = Math.min(box.originX, box.x)
    const right = Math.max(box.originX, box.x)
    const top = Math.min(box.originY, box.y)
    const bottom = Math.max(box.originY, box.y)
    const hits: NoteId[] = []
    for (const note of notes) {
      const noteLeft = note.start * pxPerTick
      const noteRight = (note.start + note.duration) * pxPerTick
      const noteTop = pitchToY(note.pitch)
      if (noteRight < left || noteLeft > right) continue
      if (noteTop + ROW_H < top || noteTop > bottom) continue
      hits.push(note.id)
    }
    return hits
  }

  const beginMarquee = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    const { x, y } = lanePoint(e)
    capturePointer(e)
    setMarquee({ originX: x, originY: y, x, y, base: additive ? [...selected] : [] })
    // A plain click on empty space still clears; the marquee only adds to
    // that once the pointer actually moves.
    if (!additive) setSelected(new Set())
  }

  const beginEndHandleDrag = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    capturePointer(e)
    setEndPreview(clip.duration)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    if (marqueeRef.current) {
      const { x, y } = lanePoint(e)
      const box = { ...marqueeRef.current, x, y }
      setMarquee(box)
      // Selection follows the box live — ephemeral, nothing to undo.
      setSelected(new Set([...box.base, ...notesInMarquee(box)]))
      return
    }
    if (endPreviewRef.current !== null) {
      const ticks = lanePoint(e).x / pxPerTick
      const snapped = Math.max(gridTicks, Math.round(ticks / gridTicks) * gridTicks)
      setEndPreview(snapped)
      return
    }
    if (!drag) return
    const dxTicks = (e.clientX - drag.originX) / pxPerTick
    setDrag((prev) => {
      if (!prev) return prev
      if (prev.mode === 'move') {
        const snapped = Math.round((prev.origStart + dxTicks) / gridTicks) * gridTicks
        const dPitch = Math.round((prev.originY - e.clientY) / ROW_H)
        const start = Math.max(0, snapped)
        const pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, prev.origPitch + dPitch))
        // The rest of the selection follows by the same resolved deltas, so
        // relative spacing and intervals hold.
        const dStart = start - prev.origStart
        const dPitchResolved = pitch - prev.origPitch
        const others = prev.others.map((m) => ({
          ...m,
          start: Math.max(0, m.origStart + dStart),
          pitch: Math.min(PITCH_MAX, Math.max(PITCH_MIN, m.origPitch + dPitchResolved))
        }))
        return { ...prev, start, pitch, others }
      }
      if (prev.mode === 'resize-l') {
        const end = prev.origStart + prev.origDuration
        const snapped = Math.round((prev.origStart + dxTicks) / gridTicks) * gridTicks
        const start = Math.min(end - gridTicks, Math.max(0, snapped))
        return { ...prev, start, duration: end - start }
      }
      const snapped = Math.round((prev.origDuration + dxTicks) / gridTicks) * gridTicks
      return { ...prev, duration: Math.max(gridTicks, snapped) }
    })
  }

  const endGesture = (): void => {
    if (marqueeRef.current) {
      // The selection was already applied as the box moved.
      setMarquee(null)
      return
    }
    if (endPreviewRef.current !== null) {
      const duration = endPreviewRef.current
      setEndPreview(null)
      if (duration !== clip.duration) {
        projectStore.dispatch({
          type: 'clip/resize',
          clipId,
          start: clip.start,
          duration,
          offset: clip.offset
        })
      }
      return
    }
    if (!drag) return
    if (drag.mode === 'move') {
      const moved = drag.start !== drag.origStart || drag.pitch !== drag.origPitch
      if (moved && drag.others.length === 0) {
        projectStore.dispatch({
          type: 'note/move',
          noteId: drag.noteId,
          pitch: drag.pitch,
          start: drag.start
        })
      } else if (moved) {
        projectStore.dispatch({
          type: 'note/moveMany',
          moves: [drag, ...drag.others].map((m) => ({
            noteId: m.noteId,
            pitch: m.pitch,
            start: m.start
          }))
        })
      }
    } else if (drag.duration !== drag.origDuration || drag.start !== drag.origStart) {
      projectStore.dispatch({
        type: 'note/resize',
        noteId: drag.noteId,
        duration: drag.duration,
        ...(drag.mode === 'resize-l' ? { start: drag.start } : {})
      })
    }
    setDrag(null)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // Don't steal keys from the velocity slider (or any future input).
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT') return
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size > 0) {
      e.stopPropagation()
      projectStore.dispatch({ type: 'note/delete', noteIds: [...selected] })
      setSelected(new Set())
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
    <div
      className="proll"
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-ping-id="pianoroll"
      data-ping={`piano roll · "${clip.name}"`}
    >
      <div className="proll-head">
        <span className="proll-title">
          <span className="proll-dot" style={{ background: track.color }} />
          {clip.name} · {track.name}
        </span>
        {selectedNote && <VelocityControl key={selectedNote.id} note={selectedNote} />}
        {selected.size > 1 && <span className="proll-hint">{selected.size} notes selected</span>}
        <span className="proll-hint">
          Double-click to add · drag empty space to select · edges resize · drag the clip edge to
          extend · Del to delete
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
          onPointerUp={endGesture}
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
            ref={laneRef}
            style={{ left: KEYS_W, width: contentW, ...rowStripes }}
            onDoubleClick={addNote}
            onPointerDown={beginMarquee}
          >
            {/* Region past the clip end: notes there are silent. */}
            <div
              className="proll-dead"
              style={{
                left: shownClipEnd * pxPerTick,
                width: contentW - shownClipEnd * pxPerTick
              }}
            />
            {/* The clip's end — drag it to extend or shrink what plays. */}
            <div
              className="proll-end-handle"
              title="Clip end — drag to extend the clip"
              style={{ left: shownClipEnd * pxPerTick }}
              onPointerDown={beginEndHandleDrag}
            />
            {notes.map((raw) => {
              const note = withPreview(raw)
              return (
                <div
                  key={note.id}
                  className={`proll-note ${selected.has(note.id) ? 'proll-note-selected' : ''} ${
                    note.start >= shownClipEnd ? 'proll-note-dead' : ''
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
                    className="proll-note-handle proll-note-handle-l"
                    onPointerDown={(e) => beginDrag(e, raw, 'resize-l')}
                  />
                  <div
                    className="proll-note-handle"
                    onPointerDown={(e) => beginDrag(e, raw, 'resize-r')}
                  />
                </div>
              )
            })}
            {marquee && (
              <div
                className="marquee"
                style={{
                  left: Math.min(marquee.originX, marquee.x),
                  top: Math.min(marquee.originY, marquee.y),
                  width: Math.abs(marquee.x - marquee.originX),
                  height: Math.abs(marquee.y - marquee.originY)
                }}
              />
            )}
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
