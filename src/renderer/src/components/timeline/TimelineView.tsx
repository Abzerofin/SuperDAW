import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { ClipId, TrackKind } from '@core/model/types'
import { PPQ, barsToTicks, snapTicks, ticksPerBar, ticksPerBeat } from '@core/model/timebase'
import { newId } from '@core/model/ids'
import { projectStore } from '@/state/projectStore'
import { useProjectState } from '@/state/hooks'
import { selection, useSelectedClipId } from '@/state/selection'
import { transport } from '@/state/transport'
import { nextTrackColor } from '@/lib/colors'
import {
  BAY_DRAG_MIME,
  createClipFromBayAsset,
  importFilesToTrack,
  type BayDragPayload
} from '@/lib/importAudio'
import { collab } from '@/state/collab'
import { commentUi, useCommentUi } from '@/state/commentUi'
import { HEADER_W, RULER_H, LANE_H, MIN_PX_PER_BEAT, MAX_PX_PER_BEAT } from './geometry'
import { TrackHeader } from './TrackHeader'
import { ClipView } from './ClipView'
import { PingOverlay, RemoteCursors } from './PresenceOverlay'
import { CommentThread } from '../comments/CommentThread'

interface DragState {
  mode: 'move' | 'resize-l' | 'resize-r'
  clipId: ClipId
  hasAsset: boolean
  originX: number
  originY: number
  origStart: number
  origDuration: number
  origOffset: number
  origTrackIndex: number
  start: number
  duration: number
  offset: number
  trackIndex: number
  moved: boolean
}

export function TimelineView(): React.JSX.Element {
  const state = useProjectState()
  const selectedClipId = useSelectedClipId()
  const openCommentAnchor = useCommentUi().anchor

  // Open (unresolved) thread counts per clip, for the clip chips.
  const clipCommentCounts = new Map<string, number>()
  for (const comment of Object.values(state.comments)) {
    if (comment.parentId === null && !comment.resolved && comment.anchor.kind === 'clip') {
      clipCommentCounts.set(comment.anchor.id, (clipCommentCounts.get(comment.anchor.id) ?? 0) + 1)
    }
  }
  const [pxPerBeat, setPxPerBeat] = useState(32)
  const [drag, setDrag] = useState<DragState | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const pendingScrollX = useRef<number | null>(null)
  const lastCursorSent = useRef(0)

  const sig = state.timeSignature
  const pxPerTick = pxPerBeat / PPQ
  const barTicks = ticksPerBar(sig)
  const beatTicks = ticksPerBeat(sig)
  const gridTicks = pxPerBeat >= 16 ? beatTicks : barTicks
  const pxPerBar = barTicks * pxPerTick

  const tracks = state.trackOrder
    .map((id) => state.tracks[id])
    .filter((t) => t !== undefined)
  const trackCount = tracks.length

  // Content extends past the last clip so there is always room to work.
  const lastClipEnd = Object.values(state.clips).reduce(
    (max, c) => Math.max(max, c.start + c.duration),
    0
  )
  const contentTicks = Math.max(lastClipEnd + barsToTicks(16, sig), barsToTicks(64, sig))
  const contentW = Math.ceil(contentTicks * pxPerTick)

  // Ctrl+wheel zoom, anchored at the cursor. Native listener because React's
  // wheel events are passive and can't preventDefault the browser page zoom.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setPxPerBeat((prev) => {
        const next = Math.min(
          MAX_PX_PER_BEAT,
          Math.max(MIN_PX_PER_BEAT, prev * (e.deltaY < 0 ? 1.2 : 1 / 1.2))
        )
        if (next !== prev) {
          const cursorX = e.clientX - el.getBoundingClientRect().left - HEADER_W
          const beatsAtCursor = (el.scrollLeft + cursorX) / prev
          pendingScrollX.current = beatsAtCursor * next - cursorX
        }
        return next
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  useLayoutEffect(() => {
    if (pendingScrollX.current !== null && scrollRef.current) {
      scrollRef.current.scrollLeft = Math.max(0, pendingScrollX.current)
      pendingScrollX.current = null
    }
  }, [pxPerBeat])

  const beginDrag = (
    e: React.PointerEvent,
    clipId: ClipId,
    mode: DragState['mode']
  ): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    const clip = projectStore.state.clips[clipId]
    if (!clip) return
    const trackIndex = state.trackOrder.indexOf(clip.trackId)
    selection.select(clipId)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setDrag({
      mode,
      clipId,
      hasAsset: clip.assetId !== null,
      originX: e.clientX,
      originY: e.clientY,
      origStart: clip.start,
      origDuration: clip.duration,
      origOffset: clip.offset,
      origTrackIndex: trackIndex,
      start: clip.start,
      duration: clip.duration,
      offset: clip.offset,
      trackIndex,
      moved: false
    })
  }

  /** Share the pointer as a presence cursor, throttled to ~20 Hz. */
  const shareCursor = (e: React.PointerEvent): void => {
    if (collab.mode === 'off' || trackCount === 0) return
    const now = performance.now()
    if (now - lastCursorSent.current < 50) return
    lastCursorSent.current = now
    const rect = gridRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = e.clientX - rect.left - HEADER_W
    const y = e.clientY - rect.top - RULER_H
    if (x < 0 || y < 0) {
      collab.sendCursor(null)
      return
    }
    collab.sendCursor({
      ticks: Math.max(0, x / pxPerTick),
      trackIndex: Math.min(trackCount - 1, Math.floor(y / LANE_H))
    })
  }

  /** Middle mouse = temporary ping identifying exactly what was clicked. */
  const onGridMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 1) return
    e.preventDefault() // also suppresses browser autoscroll
    const rect = gridRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = e.clientX - rect.left - HEADER_W
    const y = e.clientY - rect.top
    if (x < 0) return
    const ticks = Math.max(0, x / pxPerTick)
    const bar = Math.floor(ticks / barTicks) + 1
    if (y <= RULER_H) {
      collab.ping(ticks, null, `bar ${bar}`)
      return
    }
    const trackIndex = Math.min(trackCount - 1, Math.floor((y - RULER_H) / LANE_H))
    const track = tracks[trackIndex]
    if (!track) return
    const clip = Object.values(state.clips).find(
      (c) => c.trackId === track.id && c.start <= ticks && ticks < c.start + c.duration
    )
    collab.ping(ticks, trackIndex, clip ? `clip "${clip.name}"` : `"${track.name}" · bar ${bar}`)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    shareCursor(e)
    if (!drag) return
    const dxTicks = (e.clientX - drag.originX) / pxPerTick
    setDrag((prev) => {
      if (!prev) return prev
      let { start, duration, offset, trackIndex } = prev
      if (prev.mode === 'move') {
        start = Math.max(0, snapTicks(prev.origStart + dxTicks, gridTicks))
        const laneDelta = Math.round((e.clientY - prev.originY) / LANE_H)
        trackIndex = Math.min(trackCount - 1, Math.max(0, prev.origTrackIndex + laneDelta))
      } else if (prev.mode === 'resize-l') {
        const maxStart = prev.origStart + prev.origDuration - gridTicks
        // Audio clips can't extend left past the start of their source material.
        const minStart = prev.hasAsset ? prev.origStart - prev.origOffset : 0
        start = Math.min(
          maxStart,
          Math.max(minStart, Math.max(0, snapTicks(prev.origStart + dxTicks, gridTicks)))
        )
        duration = prev.origStart + prev.origDuration - start
        offset = prev.hasAsset ? prev.origOffset + (start - prev.origStart) : 0
      } else {
        duration = Math.max(gridTicks, snapTicks(prev.origDuration + dxTicks, gridTicks))
      }
      const moved =
        start !== prev.origStart ||
        duration !== prev.origDuration ||
        trackIndex !== prev.origTrackIndex
      return { ...prev, start, duration, offset, trackIndex, moved }
    })
  }

  const onPointerUp = (): void => {
    if (!drag) return
    // A drag is many ephemeral previews but exactly ONE operation, dispatched
    // on release. Keeps undo atomic and (later) the network op stream lean —
    // intermediate motion becomes presence data, not document ops.
    if (drag.moved) {
      if (drag.mode === 'move') {
        const targetTrack = tracks[drag.trackIndex]
        if (targetTrack) {
          projectStore.dispatch({
            type: 'clip/move',
            clipId: drag.clipId,
            trackId: targetTrack.id,
            start: drag.start
          })
        }
      } else {
        projectStore.dispatch({
          type: 'clip/resize',
          clipId: drag.clipId,
          start: drag.start,
          duration: drag.duration,
          offset: drag.offset
        })
      }
    }
    setDrag(null)
  }

  const onLaneDoubleClick = (e: React.MouseEvent, trackIndex: number): void => {
    const track = tracks[trackIndex]
    if (!track) return
    const laneRect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const ticks = (e.clientX - laneRect.left) / pxPerTick
    const start = Math.floor(ticks / gridTicks) * gridTicks
    const clip = {
      id: newId('clp'),
      trackId: track.id,
      name: track.kind === 'audio' ? 'Audio Clip' : 'MIDI Clip',
      start,
      duration: barTicks,
      assetId: null,
      offset: 0,
      color: null
    }
    projectStore.dispatch({ type: 'clip/create', clip })
    selection.select(clip.id)
  }

  const onLaneDragOver = (e: React.DragEvent, trackIndex: number): void => {
    const track = tracks[trackIndex]
    if (!track) return
    // Bay assets announce their kind as a data type so we can filter here,
    // before the payload itself is readable (it only is on drop).
    const bayMatch = e.dataTransfer.types.includes(`${BAY_DRAG_MIME}-${track.kind}`)
    const osFiles = e.dataTransfer.types.includes('Files')
    if (bayMatch || osFiles) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  const onLaneDrop = (e: React.DragEvent, trackIndex: number): void => {
    const track = tracks[trackIndex]
    if (!track) return
    e.preventDefault()
    const laneRect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const ticks = (e.clientX - laneRect.left) / pxPerTick
    const start = Math.max(0, Math.floor(ticks / gridTicks) * gridTicks)

    const bayData = e.dataTransfer.getData(BAY_DRAG_MIME)
    if (bayData) {
      createClipFromBayAsset(JSON.parse(bayData) as BayDragPayload, track, start)
      return
    }
    void importFilesToTrack(Array.from(e.dataTransfer.files), track, start)
  }

  const onRulerPointerDown = (e: React.PointerEvent): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    transport.setPosition((e.clientX - rect.left) / pxPerTick)
  }

  const addTrack = (kind: TrackKind): void => {
    const count = projectStore.state.trackOrder.length
    projectStore.dispatch({
      type: 'track/create',
      track: {
        id: newId('trk'),
        kind,
        name: `${kind === 'audio' ? 'Audio' : 'MIDI'} ${count + 1}`,
        color: nextTrackColor(count),
        muted: false,
        soloed: false
      },
      index: count,
      clips: []
    })
  }

  // Bar-number labels, thinned so they stay >= ~64px apart.
  const labelStepBars = Math.max(1, Math.pow(2, Math.ceil(Math.log2(64 / Math.max(1, pxPerBar)))))
  const barLabels: number[] = []
  for (let bar = 0; bar * barTicks < contentTicks; bar += labelStepBars) barLabels.push(bar)

  const laneBackground = {
    backgroundImage:
      pxPerBeat >= 10
        ? `repeating-linear-gradient(to right, var(--grid-bar) 0 1px, transparent 1px ${pxPerBar}px),` +
          `repeating-linear-gradient(to right, var(--grid-beat) 0 1px, transparent 1px ${pxPerBeat}px)`
        : `repeating-linear-gradient(to right, var(--grid-bar) 0 1px, transparent 1px ${pxPerBar}px)`
  }

  const anySoloed = tracks.some((t) => t.soloed)

  return (
    <div className="timeline" ref={scrollRef}>
      <div
        className="timeline-grid"
        ref={gridRef}
        style={{
          gridTemplateColumns: `${HEADER_W}px ${contentW}px`,
          gridTemplateRows: `${RULER_H}px repeat(${Math.max(1, trackCount)}, ${LANE_H}px)`
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => collab.sendCursor(null)}
        onMouseDown={onGridMouseDown}
      >
        <div className="timeline-corner" style={{ gridRow: 1, gridColumn: 1 }}>
          <button className="corner-btn" onClick={() => addTrack('audio')}>
            + Audio
          </button>
          <button className="corner-btn" onClick={() => addTrack('midi')}>
            + MIDI
          </button>
        </div>

        <div
          className="timeline-ruler"
          style={{ gridRow: 1, gridColumn: 2 }}
          onPointerDown={onRulerPointerDown}
        >
          {barLabels.map((bar) => (
            <span key={bar} className="ruler-label mono" style={{ left: bar * pxPerBar + 4 }}>
              {bar + 1}
            </span>
          ))}
        </div>

        {tracks.map((track, i) => (
          <div key={track.id} style={{ gridRow: i + 2, gridColumn: 1 }} className="header-cell">
            <TrackHeader track={track} />
          </div>
        ))}

        {tracks.map((track, i) => (
          <div
            key={track.id}
            className={`lane ${track.muted || (anySoloed && !track.soloed) ? 'lane-muted' : ''}`}
            style={{ gridRow: i + 2, gridColumn: 2, ...laneBackground }}
            onPointerDown={() => selection.select(null)}
            onDoubleClick={(e) => onLaneDoubleClick(e, i)}
            onDragOver={(e) => onLaneDragOver(e, i)}
            onDrop={(e) => onLaneDrop(e, i)}
          />
        ))}

        {trackCount > 0 && (
          <div
            className="clip-layer"
            style={{ gridRow: `2 / ${trackCount + 2}`, gridColumn: 2 }}
          >
            {Object.values(state.clips).map((clip) => {
              const trackIndex = state.trackOrder.indexOf(clip.trackId)
              const track = state.tracks[clip.trackId]
              if (trackIndex === -1 || !track) return null
              return (
                <ClipView
                  key={clip.id}
                  clip={clip}
                  trackColor={track.color}
                  trackIndex={trackIndex}
                  preview={
                    drag && drag.clipId === clip.id
                      ? {
                          start: drag.start,
                          duration: drag.duration,
                          offset: drag.offset,
                          trackIndex: drag.trackIndex
                        }
                      : null
                  }
                  selected={clip.id === selectedClipId}
                  dimmed={track.muted || (anySoloed && !track.soloed)}
                  pxPerTick={pxPerTick}
                  tempo={state.tempo}
                  commentCount={clipCommentCounts.get(clip.id) ?? 0}
                  onPointerDown={(e, mode) => beginDrag(e, clip.id, mode)}
                  onOpenComments={() => commentUi.open({ kind: 'clip', id: clip.id })}
                />
              )
            })}
          </div>
        )}

        {trackCount > 0 && (
          <div className="playhead-layer" style={{ gridRow: `2 / ${trackCount + 2}`, gridColumn: 2 }}>
            <Playhead pxPerTick={pxPerTick} />
          </div>
        )}

        {trackCount > 0 && (
          <div className="presence-layer" style={{ gridRow: `2 / ${trackCount + 2}`, gridColumn: 2 }}>
            <RemoteCursors pxPerTick={pxPerTick} />
            <PingOverlay pxPerTick={pxPerTick} />
          </div>
        )}

        {trackCount > 0 &&
          openCommentAnchor?.kind === 'clip' &&
          (() => {
            const clip = state.clips[openCommentAnchor.id]
            const laneIndex = clip ? state.trackOrder.indexOf(clip.trackId) : -1
            if (!clip || laneIndex === -1) return null
            return (
              <div
                className="comment-layer"
                style={{ gridRow: `2 / ${trackCount + 2}`, gridColumn: 2 }}
              >
                <div
                  className="comment-layer-anchor"
                  style={{ left: clip.start * pxPerTick + 8, top: laneIndex * LANE_H + LANE_H - 8 }}
                >
                  <CommentThread anchor={openCommentAnchor} />
                </div>
              </div>
            )
          })()}
      </div>
    </div>
  )
}

function Playhead({ pxPerTick }: { pxPerTick: number }): React.JSX.Element {
  const [, force] = useReducer((c: number) => c + 1, 0)
  useEffect(() => transport.subscribe(force), [])
  return (
    <div
      className="playhead"
      style={{ transform: `translateX(${transport.positionTicks() * pxPerTick}px)` }}
    />
  )
}
