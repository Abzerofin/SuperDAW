import { useEffect, useReducer, useRef, useState } from 'react'
import type { Clip, Note, NoteId } from '@core/model/types'
import { notesOfClip } from '@core/model/types'
import { PPQ, snapTicks, ticksPerBar } from '@core/model/timebase'
import { newId } from '@core/model/ids'
import { projectStore } from '@/state/projectStore'
import { useProjectState } from '@/state/hooks'
import { transport } from '@/state/transport'
import { pianoRollUi } from '@/state/pianoRollUi'
import { capturePointer } from '@/lib/pointer'
import { humanizeNotes, quantizeNotes } from '@/lib/noteActions'
import { parseNumberIn } from '@/lib/valueParse'
import { EditableValue } from '../controls/EditableValue'

const ROW_H = 12
const KEYS_W = 56
const RULER_H = 20
const LOOP_STRIP_H = 8
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
  /** The grabbed note's clip start (abs ticks) — snapping is absolute. */
  clipStart: number
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

/**
 * Bottom-dock note editor. Shows the WHOLE TRACK the opened clip lives on
 * — every MIDI clip of that track is visible and editable side by side in
 * absolute song time (an empty clip is only useful next to the one it was
 * split from). Scrolls freely left/right across the song; each note
 * belongs to its own clip, and double-clicking empty space adds a note to
 * whichever clip covers that spot.
 */
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
  /** Live preview while dragging a clip's end handle, else null. */
  const [endPreview, setEndPreviewState] = useState<{ clipId: string; duration: number } | null>(
    null
  )
  const endPreviewRef = useRef<{ clipId: string; duration: number } | null>(null)
  const setEndPreview = (value: { clipId: string; duration: number } | null): void => {
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
  // selection), center the view around the notes, and scroll to the clip.
  useEffect(() => {
    rootRef.current?.focus()
    const el = scrollRef.current
    if (!el) return
    const opened = projectStore.state.clips[clipId]
    const notes = notesOfClip(projectStore.state, clipId)
    const focusPitch =
      notes.length > 0
        ? Math.round(notes.reduce((sum, n) => sum + n.pitch, 0) / notes.length)
        : 60
    el.scrollTop = pitchToY(focusPitch) - el.clientHeight / 2
    if (opened) el.scrollLeft = Math.max(0, opened.start * (48 / PPQ) - 40)
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

  // Every MIDI clip on this track, in song order, each with a possible
  // end-drag preview applied.
  const trackClips = Object.values(state.clips)
    .filter((c) => c.trackId === track.id && c.assetId === null)
    .sort((a, b) => a.start - b.start)
  const shownDuration = (c: Clip): number =>
    endPreview?.clipId === c.id ? endPreview.duration : c.duration

  /** All notes on the track, each with its owning clip. */
  const laid = trackClips.flatMap((c) =>
    notesOfClip(state, c.id).map((note) => ({ note, clip: c }))
  )
  const clipOf = new Map(laid.map(({ note, clip: c }) => [note.id, c]))

  const clipsEnd = trackClips.reduce((max, c) => Math.max(max, c.start + shownDuration(c)), 0)
  const notesEnd = laid.reduce(
    (max, { note, clip: c }) => Math.max(max, c.start + note.start + note.duration),
    0
  )
  const contentTicks = Math.max(clipsEnd, notesEnd) + barTicks * 2
  const contentW = Math.ceil(contentTicks * pxPerTick)
  const selectedNote = selected.size === 1 ? state.notes[[...selected][0]] : undefined

  const withPreview = (note: Note): Note => {
    if (!drag) return note
    if (drag.noteId === note.id) {
      return { ...note, start: drag.start, pitch: drag.pitch, duration: drag.duration }
    }
    const member = drag.others.find((m) => m.noteId === note.id)
    return member ? { ...note, start: member.start, pitch: member.pitch } : note
  }

  /** Uncovered stretches of the timeline (notes there would be silent). */
  const deadRegions = ((): Array<{ start: number; end: number }> => {
    const out: Array<{ start: number; end: number }> = []
    let at = 0
    for (const c of trackClips) {
      if (c.start > at) out.push({ start: at, end: c.start })
      at = Math.max(at, c.start + shownDuration(c))
    }
    if (at < contentTicks) out.push({ start: at, end: contentTicks })
    return out
  })()

  const addNote = (e: React.MouseEvent): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const absTicks = Math.max(0, e.clientX - rect.left) / pxPerTick
    // The note goes into whichever clip covers this spot; empty space
    // between clips takes nothing (there is no clip to hold the note).
    const home = trackClips.find(
      (c) => absTicks >= c.start && absTicks < c.start + shownDuration(c)
    )
    if (!home) return
    const snappedAbs = Math.floor(absTicks / gridTicks) * gridTicks
    const note: Note = {
      id: newId('not'),
      clipId: home.id,
      pitch: yToPitch(e.clientY - rect.top),
      start: Math.max(0, snappedAbs - home.start),
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
      clipStart: clipOf.get(note.id)?.start ?? 0,
      others
    })
  }

  /** Pointer position in lane-content pixels. */
  const lanePoint = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = laneRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return { x: Math.max(0, e.clientX - rect.left), y: Math.max(0, e.clientY - rect.top) }
  }

  /** Notes whose rectangles intersect the dragged box (absolute coords). */
  const notesInMarquee = (box: MarqueeState): NoteId[] => {
    const left = Math.min(box.originX, box.x)
    const right = Math.max(box.originX, box.x)
    const top = Math.min(box.originY, box.y)
    const bottom = Math.max(box.originY, box.y)
    const hits: NoteId[] = []
    for (const { note, clip: c } of laid) {
      const noteLeft = (c.start + note.start) * pxPerTick
      const noteRight = (c.start + note.start + note.duration) * pxPerTick
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

  const beginEndHandleDrag = (e: React.PointerEvent, c: Clip): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    capturePointer(e)
    setEndPreview({ clipId: c.id, duration: c.duration })
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
    const preview = endPreviewRef.current
    if (preview !== null) {
      const previewClip = state.clips[preview.clipId]
      if (previewClip) {
        const absTicks = lanePoint(e).x / pxPerTick
        const rel = absTicks - previewClip.start
        const snapped = Math.max(gridTicks, Math.round(rel / gridTicks) * gridTicks)
        setEndPreview({ clipId: preview.clipId, duration: snapped })
      }
      return
    }
    if (!drag) return
    const dxTicks = (e.clientX - drag.originX) / pxPerTick
    setDrag((prev) => {
      if (!prev) return prev
      if (prev.mode === 'move') {
        // Snap in ABSOLUTE song time (the clip may start off-grid), then
        // come back to the note's clip-relative start.
        const snappedAbs =
          Math.round((prev.clipStart + prev.origStart + dxTicks) / gridTicks) * gridTicks
        const dPitch = Math.round((prev.originY - e.clientY) / ROW_H)
        const start = Math.max(0, snappedAbs - prev.clipStart)
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
    const preview = endPreviewRef.current
    if (preview !== null) {
      const previewClip = state.clips[preview.clipId]
      setEndPreview(null)
      if (previewClip && preview.duration !== previewClip.duration) {
        projectStore.dispatch({
          type: 'clip/resize',
          clipId: preview.clipId,
          start: previewClip.start,
          duration: preview.duration,
          offset: previewClip.offset
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
    const mod = e.ctrlKey || e.metaKey
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size > 0) {
      e.stopPropagation()
      projectStore.dispatch({ type: 'note/delete', noteIds: [...selected] })
      setSelected(new Set())
      return
    }
    // Shift+A widens a note selection to every note ON THE TRACK. With
    // nothing selected it deliberately does nothing — same contract as the
    // timeline's select-all.
    if (e.key.toLowerCase() === 'a' && e.shiftKey && !mod && !e.altKey) {
      if (selected.size > 0) {
        e.stopPropagation()
        e.preventDefault()
        setSelected(new Set(laid.map(({ note }) => note.id)))
      }
      return
    }
    // Q quantizes, H humanizes — the selection if there is one, else every
    // note shown. One note/moveMany per press: one undo step.
    if (e.key.toLowerCase() === 'q' && !mod && !e.altKey && !e.shiftKey) {
      e.stopPropagation()
      quantizeNotes(selected.size > 0 ? selected : laid.map(({ note }) => note.id), gridTicks)
      return
    }
    if (e.key.toLowerCase() === 'h' && !mod && !e.altKey && !e.shiftKey) {
      e.stopPropagation()
      humanizeNotes(selected.size > 0 ? selected : laid.map(({ note }) => note.id))
      return
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
      data-ping={`piano roll · "${track.name}"`}
    >
      <div className="proll-head">
        <span className="proll-title">
          <span className="proll-dot" style={{ background: track.color }} />
          {track.name}
          {trackClips.length > 1 && (
            <span className="statusbar-dim"> · {trackClips.length} clips</span>
          )}
        </span>
        {selectedNote && <VelocityControl key={selectedNote.id} note={selectedNote} />}
        {selected.size > 1 && <span className="proll-hint">{selected.size} notes selected</span>}
        <span className="proll-hint">
          Double-click to add · drag empty space to select · edges resize · drag a clip&apos;s edge
          to extend · Del to delete
        </span>
        <button className="proll-close" title="Close (Esc)" onClick={() => pianoRollUi.close()}>
          ×
        </button>
      </div>
      <div className="proll-scroll" ref={scrollRef} data-pan>
        <RollRuler
          contentTicks={contentTicks}
          contentW={contentW}
          pxPerTick={pxPerTick}
          gridTicks={gridTicks}
          barTicks={barTicks}
        />
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
            {/* Timeline not covered by any clip: notes cannot live there. */}
            {deadRegions.map((region) => (
              <div
                key={`${region.start}`}
                className="proll-dead"
                style={{
                  left: region.start * pxPerTick,
                  width: Math.max(0, (region.end - region.start) * pxPerTick)
                }}
              />
            ))}
            {/* Each clip's span, its name, and its draggable end. */}
            {trackClips.map((c) => (
              <div key={c.id} className="proll-clip-span" style={{ left: c.start * pxPerTick }}>
                <span
                  className={`proll-clip-name mono ${c.id === clipId ? 'proll-clip-name-focus' : ''}`}
                >
                  {c.name}
                </span>
              </div>
            ))}
            {trackClips.map((c) => (
              <div
                key={`end:${c.id}`}
                className="proll-end-handle"
                title={`End of "${c.name}" — drag to extend or shrink what plays`}
                style={{ left: (c.start + shownDuration(c)) * pxPerTick }}
                onPointerDown={(e) => beginEndHandleDrag(e, c)}
              />
            ))}
            {laid.map(({ note: raw, clip: c }) => {
              const note = withPreview(raw)
              return (
                <div
                  key={note.id}
                  className={`proll-note ${selected.has(note.id) ? 'proll-note-selected' : ''} ${
                    note.start >= shownDuration(c) ? 'proll-note-dead' : ''
                  }`}
                  style={{
                    left: (c.start + note.start) * pxPerTick,
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
            <RollPlayhead pxPerTick={pxPerTick} />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * The roll's own timeline ruler — the same gestures as the arrangement
 * ruler, in absolute song time: click/drag the lower part scrubs the
 * playhead, Shift+click pins the edit marker (so S / Ctrl+E slice there),
 * and dragging the top strip (or Alt+drag) sets the transport cycle
 * region. Sticky, so it stays visible while scrolling pitches.
 */
function RollRuler({
  contentTicks,
  contentW,
  pxPerTick,
  gridTicks,
  barTicks
}: {
  contentTicks: number
  contentW: number
  pxPerTick: number
  gridTicks: number
  barTicks: number
}): React.JSX.Element {
  const [, force] = useReducer((c: number) => c + 1, 0)
  useEffect(() => transport.subscribe(force), [])
  const laneRef = useRef<HTMLDivElement>(null)
  const [drag, setDragState] = useState<{ anchor: number; start: number; end: number } | null>(
    null
  )
  const dragRef = useRef<typeof drag>(null)
  const setDrag = (value: typeof drag): void => {
    dragRef.current = value
    setDragState(value)
  }
  const scrubRef = useRef(false)

  /** Absolute timeline ticks under the pointer. */
  const absTicksAt = (clientX: number): number => {
    const rect = laneRef.current?.getBoundingClientRect()
    if (!rect) return 0
    return Math.max(0, (clientX - rect.left) / pxPerTick)
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    const ticks = snapTicks(absTicksAt(e.clientX), gridTicks)
    if (e.shiftKey) {
      transport.setMarker(ticks)
      return
    }
    const rect = laneRef.current!.getBoundingClientRect()
    if (e.clientY - rect.top < LOOP_STRIP_H || e.altKey) {
      capturePointer(e)
      setDrag({ anchor: ticks, start: ticks, end: ticks })
      return
    }
    capturePointer(e)
    scrubRef.current = true
    transport.clearMarker()
    transport.setPosition(absTicksAt(e.clientX))
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    if (dragRef.current) {
      const ticks = snapTicks(absTicksAt(e.clientX), gridTicks)
      const { anchor } = dragRef.current
      setDrag({ anchor, start: Math.min(anchor, ticks), end: Math.max(anchor, ticks) })
      return
    }
    if (scrubRef.current) transport.setPosition(absTicksAt(e.clientX))
  }

  const onPointerUp = (): void => {
    const d = dragRef.current
    if (d) {
      setDrag(null)
      if (d.end - d.start >= 1) transport.setLoopRegion(d.start, d.end)
      else transport.clearLoop() // a plain click on the strip clears it
    }
    scrubRef.current = false
  }

  const bars: Array<{ rel: number; number: number }> = []
  for (let k = 0; k * barTicks < contentTicks; k++) {
    bars.push({ rel: k * barTicks, number: k + 1 })
  }

  const region = drag ?? transport.loopRegion
  const relRegion = region
    ? { start: Math.max(0, region.start), end: Math.min(contentTicks, region.end) }
    : null
  const marker = transport.markerTicks

  return (
    <div className="proll-ruler" style={{ width: KEYS_W + contentW, height: RULER_H }}>
      <div
        className="proll-ruler-lane"
        ref={laneRef}
        style={{ left: KEYS_W, width: contentW }}
        title="Click to move the playhead · Shift+click pins the edit marker · drag the top strip for the loop region"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div className="ruler-loop-strip" style={{ height: LOOP_STRIP_H }} />
        {bars.map((bar) => (
          <span key={bar.number} className="proll-ruler-bar mono" style={{ left: bar.rel * pxPerTick }}>
            {bar.number}
          </span>
        ))}
        {relRegion && relRegion.end > relRegion.start && (
          <div
            className={`ruler-loop ${transport.loopEnabled || drag ? '' : 'ruler-loop-off'}`}
            style={{
              left: relRegion.start * pxPerTick,
              width: Math.max(2, (relRegion.end - relRegion.start) * pxPerTick)
            }}
          />
        )}
        {marker !== null && marker >= 0 && marker <= contentTicks && (
          <div className="proll-ruler-marker" style={{ left: marker * pxPerTick }} />
        )}
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
      <EditableValue
        className="proll-vel-value"
        text={String(preview ?? note.velocity)}
        parse={parseNumberIn(1, 127)}
        onCommit={(velocity) =>
          projectStore.dispatch({
            type: 'note/setVelocity',
            noteId: note.id,
            velocity: Math.round(velocity)
          })
        }
      />
    </span>
  )
}

function RollPlayhead({ pxPerTick }: { pxPerTick: number }): React.JSX.Element | null {
  const [, force] = useReducer((c: number) => c + 1, 0)
  useEffect(() => transport.subscribe(force), [])
  const ticks = transport.positionTicks()
  if (ticks < 0) return null
  return <div className="playhead" style={{ transform: `translateX(${ticks * pxPerTick}px)` }} />
}
