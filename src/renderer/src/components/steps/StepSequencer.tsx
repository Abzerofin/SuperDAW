import { useEffect, useMemo, useRef, useState } from 'react'
import { PPQ, ticksPerBar } from '@core/model/timebase'
import type { Note, ProjectState } from '@core/model/types'
import { DRUM_PADS } from '@core/model/effects'
import { newId } from '@core/model/ids'
import { useProjectState } from '@/state/hooks'
import { projectStore } from '@/state/projectStore'
import { noteSourceOf, stampsOf } from '@core/model/types'
import { editorUi } from '@/state/editorUi'
import { selection } from '@/state/selection'
import {
  createPattern,
  deletePattern,
  nextPatternName,
  patternsOf,
  stampPattern,
  PATTERN_LENGTHS
} from '@/lib/patternActions'
import { useDismiss } from '@/lib/dismiss'
import { audioEngine } from '@/state/audioInstance'
import { transport } from '@/state/transport'

/**
 * The DRUM track's editor: a drum-machine grid over one loop's notes.
 * Rows are the kit's eight pads, columns are 16th/8th steps. A MIDI track
 * gets the piano roll instead — the track's kind decides, and there is no
 * switching between them. Cells are the clip's actual Note entities — the piano
 * roll, the timeline previews and collaborators all see the same edit the
 * moment it lands. A paint drag is ONE op (note/addMany / note/delete), so
 * undo removes the whole stroke, and painting never floods the sync stream.
 */

const MAX_STEPS = 512
/** Cell/label geometry — mirrored by the .steps-* rules in styles.css. */
const STEP_W = 22
const LABEL_W = 64

/** How many bars a column count covers, for the head's summary. */
function barsOf(cols: number, beatsPerBar: number, stepsPerBeat: number): number {
  return Math.max(1, Math.ceil(cols / (beatsPerBar * stepsPerBeat)))
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
  /** The clip's length at stroke start, so the commit knows if it grew. */
  readonly clipDuration: number
  /**
   * What a step past the end rounds the clip up to: a whole bar for the
   * measure-shaped lettered patterns, one step for a solo, which is not
   * bound to measures at all (see `freeLength` on Clip).
   */
  readonly growGrain: number
}

export function StepSequencer({
  clipId: openClipId,
  trackId: pendingTrackId = null
}: {
  clipId: string | null
  /**
   * Set instead of `clipId` when the grid opens on a note track with no
   * patterns yet — + makes the first one.
   */
  trackId?: string | null
}): React.JSX.Element {
  const state = useProjectState()
  const clip = openClipId !== null ? state.clips[openClipId] : undefined
  const track = clip
    ? state.tracks[clip.trackId]
    : pendingTrackId
      ? state.tracks[pendingTrackId]
      : undefined
  const [stepsPerBeat, setStepsPerBeat] = useState(4)
  const [paint, setPaint] = useState<PaintState | null>(null)
  const paintRef = useRef<PaintState | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const stepTicks = PPQ / stepsPerBeat
  /**
   * The clip whose notes we edit: the open one, or — if it is a STAMP —
   * the loop it was stamped from. Editing through a stamp edits the loop,
   * which is what makes every stamp of it change together.
   */
  const clipId = clip ? noteSourceOf(state, clip.id) : null
  const isStamp = clip !== undefined && clipId !== clip.id
  /** The PATTERN — the bank entry whose notes and length we are editing. */
  const source = clipId !== null ? state.clips[clipId] : undefined
  /**
   * How many places this material occupies on the timeline. Its stamps —
   * plus the source itself when the source is an ordinary clip rather than
   * a bank-only pattern, because such a clip IS one of its own placements.
   */
  const placementCount =
    clipId !== null ? stampsOf(state, clipId).length + (source && !source.isPattern ? 1 : 0) : 0
  const placements = clipId !== null ? stampsOf(state, clipId) : []
  /**
   * What the ruler and playhead are measured against: the placement we came
   * in through, or the first one on the timeline. A pattern with no
   * placements is nowhere, so the grid simply starts at bar 1.
   */
  const anchorStart = (clip && !clip.isPattern ? clip : placements[0])?.start ?? 0

  // The clip can vanish under the panel (deleted, undone, project closed).
  // Close instead of dangling — a dead id would keep the tab "openable" —
  // unless the grid is deliberately open on a track with no patterns yet.
  useEffect(() => {
    if (openClipId !== null && !projectStore.state.clips[openClipId]) editorUi.close()
    else if (openClipId === null && (pendingTrackId === null || !projectStore.state.tracks[pendingTrackId])) {
      editorUi.close()
    }
  }, [openClipId, pendingTrackId, state.clips, state.tracks])

  const clipNotes = useMemo(() => {
    if (!clipId) return []
    return Object.values(state.notes).filter((n) => n.clipId === clipId)
  }, [state.notes, clipId])

  // The grid only ever runs on a DRUM track, so the rows are always the
  // kit's pads — no melodic fallback to reason about.
  const rows: Row[] = useMemo(
    () => (track ? DRUM_PADS.map((pad) => ({ pitch: pad.pitch, label: pad.label })) : []),
    [track]
  )

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
      if (notes.length === 0) return
      // A step programmed past the end LENGTHENS the pattern to hold it,
      // rounded up to the pattern's own grain — a bar for the lettered
      // patterns, a step for a solo. Still one op, so undo takes back the
      // new length and the hits in a single step.
      const reach = Math.max(...notes.map((n) => n.start + n.duration))
      if (reach > p.clipDuration) {
        const duration = Math.ceil(reach / p.growGrain) * p.growGrain
        // Stamps that still match the loop's old length grow with it. One
        // that was deliberately trimmed or extended keeps its own length —
        // that trim is an arrangement decision, not a stale copy.
        const followers = stampsOf(projectStore.state, p.clipId)
          .filter((stamp) => stamp.duration === p.clipDuration)
          .map((stamp) => ({ clipId: stamp.id, duration }))
        projectStore.dispatch({
          type: 'clip/resizeWithNotes',
          clipId: p.clipId,
          duration,
          notes,
          ...(followers.length > 0 ? { followers } : {})
        })
        return
      }
      if (notes.length === 1) projectStore.dispatch({ type: 'note/add', note: notes[0] })
      else projectStore.dispatch({ type: 'note/addMany', notes })
    }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [])

  /**
   * How many columns the panel can show. The grid is filled out to this
   * width so a short pattern does not end mid-panel in a grey band; the
   * columns past the clip are drawn as OUTSIDE it, and programming one
   * lengthens the pattern to reach it.
   *
   * FLOOR, never ceil, and hysteresis on the way down: a count that just
   * overflows the panel summons a scrollbar, which shrinks the panel,
   * which changes the count — a ResizeObserver feedback loop that shows up
   * as scrollbars flickering on and off. Filling to just inside the width,
   * and only shrinking once a whole column of slack has opened up, leaves
   * nothing for the loop to oscillate on.
   */
  const [viewCols, setViewCols] = useState(0)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => {
      const fits = Math.max(0, Math.floor((el.clientWidth - LABEL_W) / STEP_W))
      setViewCols((prev) => (fits > prev || fits <= prev - 2 ? fits : prev))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  if (!track) {
    return (
      <div className="steps-panel">
        <div className="bay-empty">Select a MIDI clip to program a beat</div>
      </div>
    )
  }

  /** Columns the CLIP covers — the only ones a note can live in. */
  const clipCols = clip
    ? Math.min(MAX_STEPS, Math.max(1, Math.ceil((source ?? clip).duration / stepTicks)))
    : 0
  const cols = Math.min(MAX_STEPS, Math.max(clipCols, viewCols, 1))
  const beatsPerBar = state.timeSignature[0]

  const audition = (pitch: number): void => {
    audioEngine.liveNoteOn(track.id, pitch, 0.85)
    window.setTimeout(() => audioEngine.liveNoteOff(track.id, pitch), 140)
  }

  const beginPaint = (pitch: number, col: number, accent: boolean, forceErase = false): void => {
    // No pattern yet: the first step placed CREATES one, hit and all, in a
    // single op — the same gesture that fills a step fills a bank slot.
    if (!clipId) {
      if (forceErase) return
      audition(pitch)
      createPattern(track.id, {
        notes: [
          {
            id: newId('not'),
            clipId: '', // filled in by createPattern
            pitch,
            start: col * stepTicks,
            duration: stepTicks,
            velocity: accent ? 127 : 100
          }
        ]
      })
      return
    }
    // Past the clip's end there is nothing to erase — but adding IS
    // allowed: the commit lengthens the pattern to reach the step.
    const outside = col >= clipCols
    const existing = outside ? undefined : byCell.get(`${pitch}:${col}`)
    if (outside && forceErase) return
    const context = {
      clipId,
      stepTicks,
      clipDuration: source?.duration ?? 0,
      growGrain: source?.freeLength ? stepTicks : ticksPerBar(state.timeSignature)
    }
    // Right-click always erases (the standard drum-machine gesture), even
    // when starting on an empty cell — the drag erases whatever it crosses.
    const stroke: PaintState =
      forceErase || (existing && existing.length > 0)
        ? {
            mode: 'erase',
            accent: false,
            cells: new Map([[`${pitch}:${col}`, { pitch, col }]]),
            eraseIds: new Set((existing ?? []).map((n) => n.id)),
            ...context
          }
        : {
            mode: 'add',
            accent,
            cells: new Map([[`${pitch}:${col}`, { pitch, col }]]),
            eraseIds: new Set(),
            ...context
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
    // A drag that runs off the end keeps painting: every step it crosses
    // lands, and the commit grows the pattern to cover the furthest one.
    const existing = col >= clipCols ? undefined : byCell.get(key)
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
        <span className="proll-dot" style={{ background: clip?.color ?? track.color }} />
        <PatternBank state={state} trackId={track.id} openClipId={clipId} />
        <span className="statusbar-dim">
          {track.name}
          {clip
            ? ` · ${barsOf(clipCols, beatsPerBar, stepsPerBeat)} bar${barsOf(clipCols, beatsPerBar, stepsPerBeat) === 1 ? '' : 's'}`
            : ' · no loops yet'}
          {clip && (
            <span
              title={
                placementCount === 0
                  ? 'This loop is in the bank only — ⧉ puts it on the track'
                  : `On the track ${placementCount}×${
                      isStamp ? ' — you are editing it through one of them' : ''
                    }. Editing here changes every one.`
              }
            >
              {placementCount === 0 ? ' · bank only' : ` · ×${placementCount}`}
            </span>
          )}
        </span>
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
      <div className="steps-scroll" data-pan ref={scrollRef}>
        <div className="steps-grid" style={{ ['--step-cols' as string]: cols }}>
          <div className="steps-corner" />
          <StepRuler
            cols={cols}
            clipStart={anchorStart}
            stepTicks={stepTicks}
            stepsPerBeat={stepsPerBeat}
            beatsPerBar={beatsPerBar}
          />
          {rows.map((row) => (
            <StepRow
              key={row.pitch}
              row={row}
              cols={cols}
              clipCols={clipCols}
              stepsPerBeat={stepsPerBeat}
              beatsPerBar={beatsPerBar}
              byCell={byCell}
              paint={paint}
              onAudition={() => audition(row.pitch)}
              onBegin={beginPaint}
              onExtend={extendPaint}
            />
          ))}
          {source && (
            <StepPlayhead
              clip={{ start: anchorStart, duration: source.duration }}
              stepTicks={stepTicks}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The loop bank: A, B, C… across the top, ⧉ to stamp the open one further
 * along the track, and + for a new one — the drum-machine way of keeping
 * several loops on a track and arranging them. Each button IS a clip on
 * the timeline, so a loop drags, colours and trims like anything else.
 */
function PatternBank({
  state,
  trackId,
  openClipId
}: {
  state: ProjectState
  trackId: string
  openClipId: string | null
}): React.JSX.Element {
  const patterns = patternsOf(state, trackId)
  const [menuOpen, setMenuOpen] = useState(false)
  const barTicks = ticksPerBar(state.timeSignature)
  useDismiss(menuOpen, () => setMenuOpen(false))

  const add = (options: Parameters<typeof createPattern>[1]): void => {
    setMenuOpen(false)
    createPattern(trackId, options)
  }

  return (
    <span className="steps-bank">
      {patterns.map((pattern) => (
        <button
          key={pattern.id}
          className={`steps-bank-btn mono ${pattern.id === openClipId ? 'steps-bank-btn-on' : ''} ${
            pattern.freeLength ? 'steps-bank-btn-solo' : ''
          }`}
          title={`${pattern.freeLength ? 'Solo' : 'Loop'} ${pattern.name} — ${
            stampsOf(state, pattern.id).length === 0
              ? 'in the bank only, ⧉ puts it on the track'
              : `on the track ${stampsOf(state, pattern.id).length}×`
          } · right-click to delete it and everywhere it plays`}
          onClick={() => {
            selection.select(pattern.id, trackId)
            editorUi.open(pattern.id)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            deletePattern(pattern.id)
          }}
        >
          {pattern.name}
        </button>
      ))}
      {openClipId !== null && (
        <button
          className="steps-bank-btn steps-bank-stamp"
          title="Stamp this loop onto the track — a copy that follows every edit you make here"
          onClick={() => stampPattern(openClipId)}
        >
          ⧉
        </button>
      )}
      <span className="collab-anchor">
        <button
          className={`steps-bank-btn steps-bank-add ${menuOpen ? 'steps-bank-btn-on' : ''}`}
          title={`New loop (${nextPatternName(state, trackId)}) — one measure · right-click to choose the length, or a free-length solo`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => add({})}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenuOpen((v) => !v)
          }}
        >
          +
        </button>
        {menuOpen && (
          // The panel swallows pointerdown, or light-dismiss would close
          // the menu on the way down and the click would never land.
          <div
            className="menu-panel steps-bank-menu"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {PATTERN_LENGTHS.map((length) => (
              <button
                key={length.label}
                className="menu-item"
                onClick={() => add({ duration: Math.round(barTicks * length.measures) })}
              >
                <span>New loop · {length.label}</span>
              </button>
            ))}
            <div className="menu-sep" />
            <button
              className="menu-item"
              title="A solo or fill: it runs as long as the playing needs, growing exactly to each step you program instead of rounding up to the next bar"
              onClick={() => add({ freeLength: true })}
            >
              <span>New solo · free length</span>
            </button>
          </div>
        )}
      </span>
    </span>
  )
}

function StepRow({
  row,
  cols,
  clipCols,
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
  clipCols: number
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
        const outside = col >= clipCols
        return (
          <button
            key={col}
            className={`steps-cell ${active ? 'steps-cell-on' : ''} ${
              outside ? 'steps-cell-outside' : ''
            } ${
              col % (beatsPerBar * stepsPerBeat) === 0
                ? 'steps-bar-start'
                : col % stepsPerBeat === 0
                  ? 'steps-beat-start'
                  : ''
            }`}
            style={active ? { ['--step-vel' as string]: (0.35 + 0.65 * velocity / 127).toFixed(2) } : undefined}
            title={
              outside
                ? `${row.label} · step ${col + 1} — past the end: programming here lengthens the pattern to reach it`
                : `${row.label} · step ${col + 1}${active ? ` · velocity ${velocity}` : ''} — Shift+click for an accent · right-click to erase`
            }
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

/**
 * The moving playhead line, painted straight to the DOM (never re-renders
 * React). Drawn whenever the cursor is anywhere over the pattern, not only
 * while the song rolls — scrubbing the ruler with the transport stopped
 * has to show you where you landed.
 */
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
        const visible = ticks >= 0 && ticks < clip.duration
        el.style.display = visible ? 'block' : 'none'
        if (visible) {
          el.style.transform = `translateX(${LABEL_W + (ticks / stepTicks) * STEP_W}px)`
        }
      }),
    [clip.start, clip.duration, stepTicks]
  )
  return <div className="steps-playhead" ref={ref} style={{ display: 'none' }} />
}

/**
 * The step grid's ruler drives the TRANSPORT, like the timeline's ruler
 * and the piano roll's: press a step to put the cursor there, drag to
 * scrub across the pattern, Shift to pin the edit marker instead. Columns
 * are the natural resolution here, and the ruler is a row of the CSS grid
 * rather than one measurable lane, so each cell reports its own index —
 * exact by construction, no pixel arithmetic.
 *
 * Positions are CLIP-RELATIVE: the grid shows one pattern, so step 1 means
 * the clip's start, wherever the clip sits in the song.
 */
function StepRuler({
  cols,
  clipStart,
  stepTicks,
  stepsPerBeat,
  beatsPerBar
}: {
  cols: number
  clipStart: number
  stepTicks: number
  stepsPerBeat: number
  beatsPerBar: number
}): React.JSX.Element {
  const scrubbing = useRef(false)

  const seek = (col: number, shift: boolean): void => {
    const ticks = Math.max(0, clipStart + col * stepTicks)
    if (shift) transport.setMarker(ticks)
    else transport.setPosition(ticks)
  }

  // The press captures, so a drag that leaves the ruler keeps scrubbing
  // and the release always lands — the same guarantee the other rulers get
  // from pointer capture.
  useEffect(() => {
    const up = (): void => {
      scrubbing.current = false
    }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [])

  return (
    <div className="steps-ruler">
      {Array.from({ length: cols }, (_, col) => (
        <div
          key={col}
          className={`steps-ruler-cell ${
            col % (beatsPerBar * stepsPerBeat) === 0
              ? 'steps-bar-start'
              : col % stepsPerBeat === 0
                ? 'steps-beat-start'
                : ''
          }`}
          title="Click or drag to move the playhead · Shift+click pins the edit marker"
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.preventDefault()
            if (!e.shiftKey) {
              scrubbing.current = true
              transport.clearMarker()
            }
            seek(col, e.shiftKey)
          }}
          onPointerEnter={() => {
            if (scrubbing.current) seek(col, false)
          }}
        >
          {col % stepsPerBeat === 0 ? col / stepsPerBeat + 1 : ''}
        </div>
      ))}
    </div>
  )
}
