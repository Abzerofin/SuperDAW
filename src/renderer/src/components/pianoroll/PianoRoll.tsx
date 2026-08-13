import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { Clip, Note, NoteId } from '@core/model/types'
import { noteSourceOf, notesOfClip } from '@core/model/types'
import { PPQ, snapTicks, ticksPerBar } from '@core/model/timebase'
import { newId } from '@core/model/ids'
import { projectStore } from '@/state/projectStore'
import { useProjectState } from '@/state/hooks'
import { auditionDown, auditionUp } from '@/lib/audition'
import { transport } from '@/state/transport'
import { editorUi } from '@/state/editorUi'
import { keymap } from '@/state/keymap'
import { capturePointer } from '@/lib/pointer'
import { humanizeNotes, quantizeNotes } from '@/lib/noteActions'
import { createPattern } from '@/lib/patternActions'
import { parseNumberIn } from '@/lib/valueParse'
import {
  CHORD_TYPES,
  NOTE_NAMES,
  chordLabel,
  chordPitchClasses,
  type ChordType
} from '@/lib/chords'
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
export function PianoRoll({
  clipId,
  trackId: pendingTrackId = null
}: {
  clipId: string | null
  /**
   * Set instead of `clipId` when the roll opens on a note track that has
   * nothing on it yet: the grid is live and empty, and the first note
   * placed creates the clip under it (see lib/patternActions).
   */
  trackId?: string | null
}): React.JSX.Element | null {
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
  /** The chord guide, if one is up: root pitch class + shape. Ephemeral. */
  const [chord, setChord] = useState<{ root: number; type: ChordType } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const laneRef = useRef<HTMLDivElement>(null)

  const clip = clipId !== null ? state.clips[clipId] : undefined
  const track = clip ? state.tracks[clip.trackId] : (pendingTrackId ? state.tracks[pendingTrackId] : undefined)

  // Note and clip indexes, rebuilt only when the underlying records change
  // — notesOfClip per clip per render is O(clips × notes) and dominates
  // render cost on busy tracks. (Hooks stay above the early return below.)
  const notesByClip = useMemo(() => {
    const map = new Map<string, Note[]>()
    for (const note of Object.values(state.notes)) {
      const list = map.get(note.clipId)
      if (list) list.push(note)
      else map.set(note.clipId, [note])
    }
    for (const list of map.values()) list.sort((a, b) => a.start - b.start)
    return map
  }, [state.notes])
  const trackClips = useMemo(() => {
    if (!track) return []
    return Object.values(state.clips)
      .filter((c) => c.trackId === track.id && c.assetId === null)
      .sort((a, b) => a.start - b.start)
  }, [state.clips, track])

  // Close if the clip vanishes (deleted locally or by a peer) — unless the
  // roll is deliberately open on a track with no clip yet.
  useEffect(() => {
    if (!clip && pendingTrackId === null) editorUi.close()
  }, [clip, pendingTrackId])

  // On open: take keyboard focus (Delete must edit notes, not the timeline
  // selection), center the view around the notes, and scroll to the clip.
  useEffect(() => {
    rootRef.current?.focus()
    const el = scrollRef.current
    if (!el) return
    const opened = clipId !== null ? projectStore.state.clips[clipId] : undefined
    const notes = clipId !== null ? notesOfClip(projectStore.state, clipId) : []
    const focusPitch =
      notes.length > 0
        ? Math.round(notes.reduce((sum, n) => sum + n.pitch, 0) / notes.length)
        : 60
    el.scrollTop = pitchToY(focusPitch) - el.clientHeight / 2
    if (opened) el.scrollLeft = Math.max(0, opened.start * (48 / PPQ) - 40)
    setSelected(new Set())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId, pendingTrackId])

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

  /**
   * The roll has no end. It used to stop just past the last note, so
   * scrolling right — or playing on past the clip — ran the cursor off the
   * grid into grey nothing. Instead the content stays a screenful ahead of
   * wherever you have reached; it only grows, and only in screenful jumps,
   * so scrolling never thrashes the layout. Zoom still stops at its limits.
   */
  const [reachTicks, setReachTicks] = useState(0)
  /**
   * The reach mirrored in a ref. These two feeds run per scroll frame and
   * per playback frame; calling setState from them 60 times a second —
   * even when the value is unchanged — re-renders the roll continuously
   * and makes the scrollbars flicker. The ref answers "did it actually
   * grow?" without React being involved at all.
   */
  const reachRef = useRef(0)
  const growReach = (to: number): void => {
    if (to <= reachRef.current) return
    reachRef.current = to
    setReachTicks(to)
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const pxPerTickNow = pxPerBeat / PPQ
    let raf = 0
    const grow = (): void => {
      raf = 0
      const usableW = Math.max(1, el.clientWidth - KEYS_W)
      const rightTicks = (el.scrollLeft + usableW) / pxPerTickNow
      if (rightTicks > reachRef.current) growReach(rightTicks + usableW / pxPerTickNow)
    }
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(grow)
    }
    grow()
    el.addEventListener('scroll', schedule, { passive: true })
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', schedule)
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pxPerBeat, clip !== undefined])

  // The playhead runs on past every note; the grid follows it.
  const barTicksForReach = ticksPerBar(state.timeSignature)
  useEffect(
    () =>
      transport.subscribe(() => {
        const ticks = transport.positionTicks()
        if (ticks > reachRef.current) growReach(ticks + barTicksForReach * 2)
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [barTicksForReach]
  )

  // The roll is a TRACK view — it needs a track, not necessarily a clip.
  if (!track) return null

  const pxPerTick = pxPerBeat / PPQ
  const gridTicks = pxPerBeat >= 36 ? PPQ / 4 : PPQ / 2
  const barTicks = ticksPerBar(state.timeSignature)

  // The chord guide marks every key belonging to the chord, in every
  // octave — horizontal bands across the roll and lit keys on the keyboard.
  const chordClasses = chord ? chordPitchClasses(chord.root, chord.type.intervals) : null
  const chordRows: number[] = []
  if (chordClasses) {
    for (let pitch = PITCH_MIN; pitch <= PITCH_MAX; pitch++) {
      if (chordClasses.has(pitch % 12)) chordRows.push(pitch)
    }
  }

  // Each clip with a possible end-drag preview applied.
  const shownDuration = (c: Clip): number =>
    endPreview?.clipId === c.id ? endPreview.duration : c.duration

  /** All notes on the track, each with its owning clip. */
  // A STAMP has no notes of its own: it draws the loop it was stamped
  // from, so the roll shows the same phrase at every stamp's position and
  // an edit made at one is seen at all of them.
  const laid = trackClips.flatMap((c) =>
    (notesByClip.get(noteSourceOf(state, c.id)) ?? []).map((note) => ({ note, clip: c }))
  )
  const clipOf = new Map(laid.map(({ note, clip: c }) => [note.id, c]))

  const clipsEnd = trackClips.reduce((max, c) => Math.max(max, c.start + shownDuration(c)), 0)
  const notesEnd = laid.reduce(
    (max, { note, clip: c }) => Math.max(max, c.start + note.start + note.duration),
    0
  )
  const contentTicks = Math.max(clipsEnd, notesEnd, reachTicks) + barTicks * 2
  const contentW = Math.ceil(contentTicks * pxPerTick)
  const selectedNote = selected.size === 1 ? state.notes[[...selected][0]] : undefined

  // Map lookup, not a linear scan per note — a large multi-selection drag
  // is otherwise O(notes × selected) per frame.
  const dragOthers = drag ? new Map(drag.others.map((m) => [m.noteId, m])) : null
  const withPreview = (note: Note): Note => {
    if (!drag) return note
    if (drag.noteId === note.id) {
      return { ...note, start: drag.start, pitch: drag.pitch, duration: drag.duration }
    }
    const member = dragOthers?.get(note.id)
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
    const snappedAbs = Math.floor(absTicks / gridTicks) * gridTicks
    const pitch = yToPitch(e.clientY - rect.top)
    // The note goes into whichever clip covers this spot. Empty space used
    // to take nothing at all; instead the clip to hold the note is created
    // under it — one op, so undo takes back the clip and the note together.
    const home = trackClips.find(
      (c) => absTicks >= c.start && absTicks < c.start + shownDuration(c)
    )
    if (!home) {
      const barTicksHere = ticksPerBar(state.timeSignature)
      const clipStart = Math.floor(absTicks / barTicksHere) * barTicksHere
      createPattern(track.id, {
        start: clipStart,
        notes: [
          {
            id: newId('not'),
            clipId: '', // filled in by createPattern
            pitch,
            start: Math.max(0, snappedAbs - clipStart),
            duration: DEFAULT_NOTE_TICKS,
            velocity: 100
          }
        ]
      })
      return
    }
    const note: Note = {
      id: newId('not'),
      // Drawing on a stamp writes into the loop it stamps — that is what
      // makes the new note appear at every stamp of it.
      clipId: noteSourceOf(state, home.id),
      pitch,
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
      // Selection follows the box live — ephemeral, nothing to undo. Keep
      // the previous set's identity when membership is unchanged so React
      // can skip the (large) note field re-render.
      const next = new Set([...box.base, ...notesInMarquee(box)])
      setSelected((prev) => {
        if (prev.size === next.size) {
          let same = true
          for (const id of next) {
            if (!prev.has(id)) {
              same = false
              break
            }
          }
          if (same) return prev
        }
        return next
      })
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
    // Same rebindable actions as the timeline (state/keymap.ts), applied
    // to NOTES here — stopPropagation keeps the global handler out.
    const id = keymap.resolve(e.nativeEvent)
    if (id === 'selection.delete' && selected.size > 0) {
      e.stopPropagation()
      projectStore.dispatch({ type: 'note/delete', noteIds: [...selected] })
      setSelected(new Set())
      return
    }
    // Select-all widens a note selection to every note ON THE TRACK. With
    // nothing selected it deliberately does nothing — same contract as the
    // timeline's select-all.
    if (id === 'selection.all') {
      if (selected.size > 0) {
        e.stopPropagation()
        e.preventDefault()
        setSelected(new Set(laid.map(({ note }) => note.id)))
      }
      return
    }
    // Quantize/humanize — the selection if there is one, else every note
    // shown. One note/moveMany per press: one undo step.
    if (id === 'notes.quantize') {
      e.stopPropagation()
      quantizeNotes(selected.size > 0 ? selected : laid.map(({ note }) => note.id), gridTicks)
      return
    }
    if (id === 'notes.humanize') {
      e.stopPropagation()
      humanizeNotes(selected.size > 0 ? selected : laid.map(({ note }) => note.id))
      return
    }
    if (e.key === 'Escape') editorUi.close()
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
        <ChordPicker chord={chord} onPick={setChord} />
        {selectedNote && <VelocityControl key={selectedNote.id} note={selectedNote} />}
        {selected.size > 1 && <span className="proll-hint">{selected.size} notes selected</span>}
        <span className="proll-hint">
          Double-click to add · drag empty space to select · edges resize · drag a clip&apos;s edge
          to extend · Del to delete
        </span>
        <button className="proll-close" title="Close (Esc)" onClick={() => editorUi.close()}>
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
                  className={`proll-key ${isBlackKey(pitch) ? 'proll-key-black' : ''} ${
                    chordClasses?.has(pitch % 12) ? 'proll-key-chord' : ''
                  } ${chord && pitch % 12 === chord.root ? 'proll-key-chord-root' : ''}`}
                  // Click a key to hear the pitch through this track's
                  // instrument — same audition the step labels give.
                  onPointerDown={(e) => {
                    if (e.button !== 0) return
                    auditionDown(track.id, pitch)
                  }}
                  onPointerUp={() => auditionUp(track.id, pitch)}
                  onPointerLeave={(e) => {
                    if (e.buttons !== 0) auditionUp(track.id, pitch)
                  }}
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
            {/* Chord guide: the rows that belong to the chosen chord. */}
            {chordRows.map((pitch) => (
              <div
                key={`chord:${pitch}`}
                className={`proll-chord-row ${
                  chord && pitch % 12 === chord.root ? 'proll-chord-row-root' : ''
                }`}
                style={{ top: pitchToY(pitch), height: ROW_H }}
              />
            ))}
            {/* Timeline not covered by any clip: notes cannot live there. */}
            {deadRegions.map((region) => (
              <div
                key={`${region.start}`}
                className="proll-dead"
                title="No clip covers this range — notes need a clip to live in. Drag a clip end handle to extend one."
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
                  // Right-click erases — the note, or the whole selection
                  // when it is part of one (standard piano-roll gesture).
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    const ids =
                      selected.has(raw.id) && selected.size > 1 ? [...selected] : [raw.id]
                    projectStore.dispatch({ type: 'note/delete', noteIds: ids })
                    setSelected(new Set())
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
  // Transport STATE only (loop region, marker, play state) — never the
  // frame feed, which would rebuild the whole ruler at 60 fps during
  // playback. The moving playhead is RollPlayhead's job.
  const [, force] = useReducer((c: number) => c + 1, 0)
  useEffect(() => transport.subscribeUi(force), [])
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

/**
 * The chord menu: pick a root and a shape and the roll lights up every key
 * that belongs to the chord, in every octave. A GUIDE, not a generator —
 * it changes nothing in the document (so it is neither an op nor synced),
 * it just makes the right rows obvious while you draw.
 */
function ChordPicker({
  chord,
  onPick
}: {
  chord: { root: number; type: ChordType } | null
  onPick: (chord: { root: number; type: ChordType } | null) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [root, setRoot] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  return (
    <div className="collab-anchor" ref={ref}>
      <button
        className={`proll-chord-btn ${chord ? 'proll-chord-btn-on' : ''}`}
        title={
          chord
            ? `Chord guide: ${chordLabel(chord.root, chord.type)} — click to change or clear`
            : 'Highlight the keys of a chord across the roll'
        }
        onClick={() => setOpen((v) => !v)}
      >
        {chord ? chordLabel(chord.root, chord.type) : 'Chords'}
      </button>
      {open && (
        <div className="menu-panel proll-chord-menu">
          <div className="proll-chord-roots">
            {NOTE_NAMES.map((name, pitchClass) => (
              <button
                key={name}
                className={`proll-chord-root mono ${
                  pitchClass === (chord?.root ?? root) ? 'proll-chord-root-on' : ''
                }`}
                onClick={() => {
                  setRoot(pitchClass)
                  // Re-root the chord already up, so hunting for the right
                  // root is one click per try instead of two.
                  if (chord) onPick({ root: pitchClass, type: chord.type })
                }}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="proll-chord-list">
            {CHORD_TYPES.map((type) => (
              <button
                key={type.name}
                className={`proll-chord-item ${chord?.type === type ? 'proll-chord-item-on' : ''}`}
                onClick={() => onPick({ root: chord?.root ?? root, type })}
              >
                {type.name}
              </button>
            ))}
          </div>
          <button
            className="proll-chord-clear"
            disabled={!chord}
            onClick={() => {
              onPick(null)
              setOpen(false)
            }}
          >
            Clear guide
          </button>
        </div>
      )}
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
  const ticks = transport.displayTicks()
  if (ticks < 0) return null
  return <div className="playhead" style={{ transform: `translateX(${ticks * pxPerTick}px)` }} />
}
