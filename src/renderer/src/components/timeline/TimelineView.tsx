import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { ClipId, Track, TrackKind } from '@core/model/types'
import {
  childTracksOf,
  isTrackEffectivelyAudible,
  isTrackSelfOrDescendant,
  trackSubtreeOf,
  MAX_STRETCH,
  MIN_STRETCH
} from '@core/model/types'
import { PPQ, barsToTicks, snapTicks, ticksPerBar } from '@core/model/timebase'
import { newId } from '@core/model/ids'
import { projectStore } from '@/state/projectStore'
import { useProjectState } from '@/state/hooks'
import { selection, useSelectedClipId } from '@/state/selection'
import { transport } from '@/state/transport'
import { gridTicksFor, useGridChoice } from '@/state/gridUi'
import {
  BAY_DRAG_MIME,
  createClipFromBayAsset,
  importFilesToTrack,
  type BayDragPayload
} from '@/lib/importAudio'
import { collab } from '@/state/collab'
import { createTrack } from '@/lib/trackActions'
import { capturePointer } from '@/lib/pointer'
import { commentUi, useCommentUi } from '@/state/commentUi'
import { useAutomationUi } from '@/state/automationUi'
import { pianoRollUi } from '@/state/pianoRollUi'
import { useRecording } from '@/state/recording'
import { folderUi, useFolderUi } from '@/state/folderUi'
import { trackViewUi, useTrackViewUi } from '@/state/trackViewUi'
import { useRulerMode } from '@/state/rulerUi'
import { audioEngine } from '@/state/audioInstance'
import { ticksPerSecond } from '@audio/scheduling'
import {
  HEADER_W,
  RULER_H,
  LANE_H,
  COMPACT_LANE_H,
  AUTO_H,
  MIN_PX_PER_BEAT,
  MAX_PX_PER_BEAT
} from './geometry'
import { TrackHeader } from './TrackHeader'
import { ClipView } from './ClipView'
import { ClipMenu } from './ClipMenu'
import { AutomationLane } from './AutomationLane'
import { PingOverlay, RemoteCursors } from './PresenceOverlay'
import { CommentThread } from '../comments/CommentThread'

interface ReorderState {
  fromIndex: number
  /** Insertion slot 0..trackCount (between rows). */
  slot: number
  /**
   * Folder the pointer is hovering the MIDDLE of — the drop goes inside it
   * (the row lights up). Null means an ordinary between-rows insertion at
   * `slot`, shown as a line.
   */
  intoFolderId: string | null
  originY: number
  /** Engages after a small vertical threshold so clicks stay clicks. */
  active: boolean
}

/** Height of the ruler strip that drags out a loop region. */
const LOOP_STRIP_H = 12

type LoopDragMode = 'new' | 'start' | 'end' | 'move'

interface LoopDrag {
  mode: LoopDragMode
  /** Where the gesture began, in ticks. */
  anchorTicks: number
  start: number
  end: number
  origStart?: number
  origEnd?: number
}

interface DragState {
  mode: 'move' | 'resize-l' | 'resize-r' | 'loop-r' | 'stretch-r'
  clipId: ClipId
  hasAsset: boolean
  originX: number
  originY: number
  origStart: number
  origDuration: number
  origOffset: number
  origLoop: number
  origStretch: number
  origTrackIndex: number
  start: number
  duration: number
  offset: number
  /** Loop period preview during a loop-handle drag (0 = no loop). */
  loopLength: number
  /** Time-factor preview during a stretch-handle drag. */
  stretch: number
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

  // Notes grouped by clip, for MIDI clip previews.
  const notesByClip = new Map<string, typeof state.notes[string][]>()
  for (const note of Object.values(state.notes)) {
    const list = notesByClip.get(note.clipId)
    if (list) list.push(note)
    else notesByClip.set(note.clipId, [note])
  }
  const [pxPerBeat, setPxPerBeat] = useState(32)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [reorder, setReorderState] = useState<ReorderState | null>(null)
  // Authoritative copy: pointermove updates are batched at low priority by
  // React, so a fast drag could commit after pointerup reads the state.
  const reorderRef = useRef<ReorderState | null>(null)
  const setReorder = (value: ReorderState | null): void => {
    reorderRef.current = value
    setReorderState(value)
  }
  const [colorMenu, setColorMenu] = useState<{ clipId: ClipId; x: number; y: number } | null>(null)
  // Loop-region drag (ephemeral preview; the transport is updated on release).
  const [loopDrag, setLoopDragState] = useState<LoopDrag | null>(null)
  const loopDragRef = useRef<LoopDrag | null>(null)
  const setLoopDrag = (value: LoopDrag | null): void => {
    loopDragRef.current = value
    setLoopDragState(value)
  }
  // Redraw when the transport's loop region changes (it is not React state).
  const [, forceTransport] = useReducer((c: number) => c + 1, 0)
  useEffect(() => transport.subscribe(forceTransport), [])
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const pendingScrollX = useRef<number | null>(null)
  const lastCursorSent = useRef(0)
  const gridChoice = useGridChoice()
  const rulerMode = useRulerMode()

  const sig = state.timeSignature
  const pxPerTick = pxPerBeat / PPQ
  const barTicks = ticksPerBar(sig)
  const gridTicks = gridTicksFor(gridChoice, sig, pxPerBeat)
  const pxPerBar = barTicks * pxPerTick

  const autoUi = useAutomationUi()
  const foldUi = useFolderUi()
  // Compact mode shrinks every row and strips the header down to its name.
  const compact = useTrackViewUi().compact
  const laneH = compact ? COMPACT_LANE_H : LANE_H

  // Visible rows derive from the folder tree: roots in trackOrder order,
  // each folder followed by its children (collapsed folders hide theirs).
  // Sibling order is trackOrder-relative, so any interleaving a concurrent
  // edit produces still renders sanely.
  const tracks: Track[] = []
  const depthOf: number[] = []
  {
    const visit = (parentId: string | null, depth: number): void => {
      for (const child of childTracksOf(state, parentId)) {
        tracks.push(child)
        depthOf.push(depth)
        if (child.kind === 'folder' && !foldUi.isCollapsed(child.id)) visit(child.id, depth + 1)
      }
    }
    visit(null, 0)
  }
  const rowIndexOfTrack = new Map(tracks.map((t, i) => [t.id, i]))
  const trackCount = tracks.length

  // Row layout: each track lane, optionally followed by its automation lane.
  // All overlay layers position by trackTops (content px below the ruler).
  const rowMeta = tracks.map((track) => ({ track, auto: autoUi.isOpen(track.id) }))
  const trackTops: number[] = []
  const gridRowOfTrack: number[] = []
  {
    let top = 0
    let row = 2
    for (const meta of rowMeta) {
      trackTops.push(top)
      gridRowOfTrack.push(row)
      top += laneH
      row += 1
      if (meta.auto) {
        top += AUTO_H
        row += 1
      }
    }
  }
  const lastGridRow =
    2 + rowMeta.reduce((n, m) => n + (m.auto ? 2 : 1), 0)
  const rowTemplate =
    trackCount === 0
      ? `${RULER_H}px ${laneH}px`
      : `${RULER_H}px ${rowMeta
          .map((m) => (m.auto ? `${laneH}px ${AUTO_H}px` : `${laneH}px`))
          .join(' ')}`

  /** Track index for a y position in content coordinates (below the ruler). */
  const trackIndexAtY = (y: number): number => {
    for (let i = 0; i < rowMeta.length; i++) {
      const bottom = trackTops[i] + laneH + (rowMeta[i].auto ? AUTO_H : 0)
      if (y < bottom) return i
    }
    return Math.max(0, rowMeta.length - 1)
  }

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

  // Follow the playhead during playback: when it crosses the right edge of
  // the view, page forward so it lands near the left. Crossing-detection
  // (not containment) so manual scrolling is never fought.
  const followRef = useRef({ pxPerTick, prevRel: 0 })
  followRef.current.pxPerTick = pxPerTick
  useEffect(
    () =>
      transport.subscribe(() => {
        const el = scrollRef.current
        if (!el || !transport.isPlaying) return
        const x = transport.positionTicks() * followRef.current.pxPerTick
        const visW = el.clientWidth - HEADER_W
        const rel = x - el.scrollLeft
        const prevRel = followRef.current.prevRel
        followRef.current.prevRel = rel
        if (prevRel <= visW - 8 && rel > visW - 8) {
          el.scrollLeft = Math.max(0, x - 32)
        }
      }),
    []
  )

  // A click anywhere outside the clip color palette closes it.
  useEffect(() => {
    if (!colorMenu) return
    const onPointerDown = (): void => setColorMenu(null)
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [colorMenu])

  const beginDrag = (
    e: React.PointerEvent,
    clipId: ClipId,
    mode: DragState['mode']
  ): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    const clip = projectStore.state.clips[clipId]
    if (!clip) return
    // Frozen tracks are locked: their render would go stale if clips moved.
    // Unfreeze to edit (selection and comments still work).
    if (projectStore.state.tracks[clip.trackId]?.frozenAssetId) {
      selection.select(clipId, clip.trackId)
      return
    }
    const trackIndex = rowIndexOfTrack.get(clip.trackId) ?? -1
    if (trackIndex === -1) return
    selection.select(clipId, clip.trackId)
    capturePointer(e)
    setDrag({
      mode,
      clipId,
      hasAsset: clip.assetId !== null,
      originX: e.clientX,
      originY: e.clientY,
      origStart: clip.start,
      origDuration: clip.duration,
      origOffset: clip.offset,
      origLoop: clip.loopLength,
      origStretch: clip.stretch,
      origTrackIndex: trackIndex,
      start: clip.start,
      duration: clip.duration,
      offset: clip.offset,
      loopLength: clip.loopLength,
      stretch: clip.stretch,
      trackIndex,
      moved: false
    })
  }

  /** Drag a track header vertically to reorder tracks (ONE op on release). */
  const beginReorder = (e: React.PointerEvent, index: number): void => {
    if (e.button !== 0) return
    // Buttons, inputs and popovers inside the header keep their own gestures.
    if ((e.target as HTMLElement).closest('button, input, .comment-layer-anchor')) return
    // NOTE: pointer capture is deliberately deferred until the gesture is a
    // real drag (see onPointerMove). Capturing here would retarget the
    // follow-up clicks and swallow the double-click that renames a track.
    setReorder({
      fromIndex: index,
      slot: index,
      intoFolderId: null,
      originY: e.clientY,
      active: false
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
    // Over the headers or ruler, clamp instead of hiding: a cursor that
    // blinks out whenever a collaborator reaches for a fader reads as
    // "presence is broken". It clears only on leaving the timeline.
    const x = Math.max(0, e.clientX - rect.left - HEADER_W)
    const y = Math.max(0, e.clientY - rect.top - RULER_H)
    collab.sendCursor({ ticks: x / pxPerTick, trackIndex: trackIndexAtY(y) })
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
    const trackIndex = trackIndexAtY(y - RULER_H)
    const track = tracks[trackIndex]
    if (!track) return
    const clip = Object.values(state.clips).find(
      (c) => c.trackId === track.id && c.start <= ticks && ticks < c.start + c.duration
    )
    collab.ping(ticks, trackIndex, clip ? `clip "${clip.name}"` : `"${track.name}" Â· bar ${bar}`)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    shareCursor(e)
    if (loopDragRef.current) {
      onLoopDragMove(e)
      return
    }
    const activeReorder = reorderRef.current
    if (activeReorder) {
      const rect = gridRef.current?.getBoundingClientRect()
      if (!rect) return
      const y = e.clientY - rect.top - RULER_H
      const active = activeReorder.active || Math.abs(e.clientY - activeReorder.originY) > 4
      // Capture only once this is really a drag — capturing on pointerdown
      // would swallow the double-click that starts an inline rename.
      if (active && !activeReorder.active) capturePointer(e)

      let slot = rowMeta.length
      for (let i = 0; i < rowMeta.length; i++) {
        const mid = trackTops[i] + (laneH + (rowMeta[i].auto ? AUTO_H : 0)) / 2
        if (y < mid) {
          slot = i
          break
        }
      }

      // Hovering the middle band of a folder row means "drop INSIDE this
      // folder" (the row lights up); the edges keep the between-rows
      // insertion line, so both gestures stay reachable on every row.
      const dragged = tracks[activeReorder.fromIndex]
      let intoFolderId: string | null = null
      for (let i = 0; i < rowMeta.length; i++) {
        const top = trackTops[i]
        if (y < top + laneH * 0.25 || y > top + laneH * 0.75) continue
        const row = tracks[i]
        // A folder can never be dropped into itself or its own subtree.
        if (row.kind === 'folder' && dragged && !isTrackSelfOrDescendant(state, row.id, dragged.id)) {
          intoFolderId = row.id
        }
        break
      }
      setReorder({ ...activeReorder, active, slot, intoFolderId })
      return
    }
    if (!drag) return
    const dxTicks = (e.clientX - drag.originX) / pxPerTick
    // Holding Shift bypasses grid snapping for the duration of the drag
    // (grid 1 = free movement at tick resolution).
    const snapGrid = e.shiftKey ? 1 : gridTicks
    setDrag((prev) => {
      if (!prev) return prev
      let { start, duration, offset, loopLength, stretch, trackIndex } = prev
      if (prev.mode === 'loop-r') {
        // The loop handle: dragging out repeats the clip's material. The
        // period is the clip's length when the drag began (or its existing
        // period); pulling back to one repeat or less turns looping off.
        const base = prev.origLoop > 0 ? prev.origLoop : prev.origDuration
        duration = Math.max(gridTicks, snapTicks(prev.origDuration + dxTicks, snapGrid))
        loopLength = duration > base ? base : 0
      } else if (prev.mode === 'stretch-r') {
        // The stretch handle: the same material fills the new length, so
        // longer = slower and lower, shorter = faster and higher (tape).
        // Duration re-derives from the clamped factor so the visual edge
        // never overshoots what playback will actually do.
        const wanted = Math.max(gridTicks, snapTicks(prev.origDuration + dxTicks, snapGrid))
        const factor = (prev.origStretch * wanted) / prev.origDuration
        stretch = Math.min(MAX_STRETCH, Math.max(MIN_STRETCH, factor))
        duration = Math.max(1, Math.round((prev.origDuration * stretch) / prev.origStretch))
        // A looped clip's repeats stretch with the material, so the repeat
        // count is preserved rather than retiled.
        loopLength =
          prev.origLoop > 0 ? Math.round((prev.origLoop * stretch) / prev.origStretch) : 0
      } else if (prev.mode === 'move') {
        start = Math.max(0, snapTicks(prev.origStart + dxTicks, snapGrid))
        const yCenter =
          trackTops[prev.origTrackIndex] + laneH / 2 + (e.clientY - prev.originY)
        trackIndex = trackIndexAtY(yCenter)
      } else if (prev.mode === 'resize-l') {
        const maxStart = prev.origStart + prev.origDuration - gridTicks
        // Audio clips can't extend left past the start of their source material.
        const minStart = prev.hasAsset ? prev.origStart - prev.origOffset : 0
        start = Math.min(
          maxStart,
          Math.max(minStart, Math.max(0, snapTicks(prev.origStart + dxTicks, snapGrid)))
        )
        duration = prev.origStart + prev.origDuration - start
        offset =
          prev.hasAsset ? prev.origOffset + (start - prev.origStart) : prev.origOffset
      } else {
        duration = Math.max(gridTicks, snapTicks(prev.origDuration + dxTicks, snapGrid))
      }
      const moved =
        start !== prev.origStart ||
        duration !== prev.origDuration ||
        loopLength !== prev.origLoop ||
        stretch !== prev.origStretch ||
        trackIndex !== prev.origTrackIndex
      return { ...prev, start, duration, offset, loopLength, stretch, trackIndex, moved }
    })
  }

  const onPointerUp = (): void => {
    if (loopDragRef.current) {
      onLoopDragEnd()
      return
    }
    const endedReorder = reorderRef.current
    if (endedReorder) {
      if (endedReorder.active) {
        const track = tracks[endedReorder.fromIndex]
        if (track && endedReorder.intoFolderId) {
          // Dropped on a folder's middle: land at the end of its contents.
          const folderId = endedReorder.intoFolderId
          const lastIndex = trackSubtreeOf(state, folderId).reduce(
            (max, t) => Math.max(max, state.trackOrder.indexOf(t.id)),
            -1
          )
          const fromOrder = state.trackOrder.indexOf(track.id)
          let targetOrder = lastIndex + 1
          if (fromOrder < targetOrder) targetOrder -= 1
          if (targetOrder !== fromOrder || track.parentId !== folderId) {
            projectStore.dispatch({
              type: 'track/reorder',
              trackId: track.id,
              index: targetOrder,
              parentId: folderId
            })
          }
          // Reveal the result if the folder was collapsed.
          if (folderUi.isCollapsed(folderId)) folderUi.toggle(folderId)
          setReorder(null)
          return
        }
        if (track) {
          // An insertion line NEVER puts a track into a folder it is only
          // passing: joining a folder means dropping ON it (the highlighted
          // middle band). The line just adopts the depth of the row it
          // pushes down. One gesture = one op.
          const slot = endedReorder.slot
          const above = slot > 0 ? tracks[slot - 1] : null
          const below = slot < tracks.length ? tracks[slot] : null
          const underFolderHeader =
            above !== null && above.kind === 'folder' && !foldUi.isCollapsed(above.id)
          const parentId: string | null = underFolderHeader
            ? // Directly beneath an open folder's header: that line sits at
              // the FOLDER's own level, not inside it.
              above.parentId
            : (below?.parentId ?? null) // no row below = end of list = root
          // Never nest a folder inside itself/its subtree (reducer would
          // reject the parent change and leave a confusing half-move).
          let p: string | null = parentId
          while (p !== null && p !== track.id) p = state.tracks[p]?.parentId ?? null
          if (p !== track.id) {
            const fromOrder = state.trackOrder.indexOf(track.id)
            let targetOrder = below
              ? state.trackOrder.indexOf(below.id)
              : state.trackOrder.length
            if (underFolderHeader) {
              // Landing at the folder's level: go after its whole subtree,
              // so the stored order matches where the row is drawn.
              targetOrder =
                trackSubtreeOf(state, above.id).reduce(
                  (max, t) => Math.max(max, state.trackOrder.indexOf(t.id)),
                  -1
                ) + 1
            }
            if (fromOrder < targetOrder) targetOrder -= 1
            if (targetOrder !== fromOrder || parentId !== track.parentId) {
              projectStore.dispatch({
                type: 'track/reorder',
                trackId: track.id,
                index: targetOrder,
                parentId
              })
            }
          }
        }
      }
      setReorder(null)
      return
    }
    if (!drag) return
    // A drag is many ephemeral previews but exactly ONE operation, dispatched
    // on release. Keeps undo atomic and (later) the network op stream lean â€”
    // intermediate motion becomes presence data, not document ops.
    if (drag.moved) {
      if (drag.mode === 'move') {
        const targetTrack = tracks[drag.trackIndex]
        // Folder and frozen lanes never accept clips (the reducer would
        // reject the folder case anyway; skip the no-op dispatch).
        if (targetTrack && targetTrack.kind !== 'folder' && !targetTrack.frozenAssetId) {
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
          offset: drag.offset,
          // The loop handle sets the period and the stretch handle sets the
          // time factor with the same gesture; a plain trim leaves both
          // untouched (fields absent). Stretching a looped clip scales its
          // period so the repeat count is preserved.
          ...(drag.mode === 'loop-r' ? { loopLength: drag.loopLength } : {}),
          ...(drag.mode === 'stretch-r'
            ? {
                stretch: drag.stretch,
                ...(drag.origLoop > 0 ? { loopLength: drag.loopLength } : {})
              }
            : {})
        })
      }
    }
    setDrag(null)
  }

  const onLaneDoubleClick = (e: React.MouseEvent, trackIndex: number): void => {
    const track = tracks[trackIndex]
    if (!track || track.kind === 'folder' || track.frozenAssetId) return
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
      color: null,
      fadeIn: 0,
      fadeOut: 0,
      reverse: false,
      pitch: 0,
      stretch: 1,
      loopLength: 0
    }
    projectStore.dispatch({ type: 'clip/create', clip, notes: [] })
    selection.select(clip.id, clip.trackId)
  }

  const onLaneDragOver = (e: React.DragEvent, trackIndex: number): void => {
    const track = tracks[trackIndex]
    if (!track || track.kind === 'folder' || track.frozenAssetId) return
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
    if (!track || track.kind === 'folder' || track.frozenAssetId) return
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

  /**
   * The ruler has two gestures: the lower half scrubs the playhead, the
   * upper strip drags out the loop region (and a drag anywhere with Alt
   * does too, for muscle memory from other DAWs).
   */
  const onRulerPointerDown = (e: React.PointerEvent): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const ticks = Math.max(0, snapTicks((e.clientX - rect.left) / pxPerTick, gridTicks))
    const inLoopStrip = e.clientY - rect.top < LOOP_STRIP_H
    if (inLoopStrip || e.altKey) {
      capturePointer(e)
      setLoopDrag({ mode: 'new', anchorTicks: ticks, start: ticks, end: ticks })
      return
    }
    transport.setPosition((e.clientX - rect.left) / pxPerTick)
  }

  /** Grab an existing region: its edges resize, its body moves it. */
  const beginLoopAdjust = (e: React.PointerEvent, mode: LoopDragMode): void => {
    const region = transport.loopRegion
    if (!region || e.button !== 0) return
    e.stopPropagation()
    capturePointer(e)
    const rect = gridRef.current?.getBoundingClientRect()
    const ticks = rect ? (e.clientX - rect.left - HEADER_W) / pxPerTick : 0
    setLoopDrag({
      mode,
      anchorTicks: ticks,
      start: region.start,
      end: region.end,
      origStart: region.start,
      origEnd: region.end
    })
  }

  const onLoopDragMove = (e: React.PointerEvent): void => {
    const drag = loopDragRef.current
    if (!drag) return
    const rect = gridRef.current?.getBoundingClientRect()
    if (!rect) return
    const ticks = Math.max(0, snapTicks((e.clientX - rect.left - HEADER_W) / pxPerTick, gridTicks))
    if (drag.mode === 'new') {
      setLoopDrag({ ...drag, start: Math.min(drag.anchorTicks, ticks), end: Math.max(drag.anchorTicks, ticks) })
    } else if (drag.mode === 'start') {
      setLoopDrag({ ...drag, start: Math.min(ticks, drag.end - gridTicks) })
    } else if (drag.mode === 'end') {
      setLoopDrag({ ...drag, end: Math.max(ticks, drag.start + gridTicks) })
    } else {
      // Move: shift both edges, keeping the span and never going negative.
      const delta = ticks - drag.anchorTicks
      const span = (drag.origEnd ?? drag.end) - (drag.origStart ?? drag.start)
      const start = Math.max(0, (drag.origStart ?? drag.start) + delta)
      setLoopDrag({ ...drag, start, end: start + span })
    }
  }

  const onLoopDragEnd = (): void => {
    const drag = loopDragRef.current
    if (!drag) return
    setLoopDrag(null)
    if (drag.end - drag.start >= 1) transport.setLoopRegion(drag.start, drag.end)
    else if (drag.mode === 'new') transport.clearLoop() // a click clears it
  }

  const addTrack = (kind: TrackKind): void => createTrack(kind)

  // Ruler labels for the active mode, thinned to stay legible.
  const rulerLabels: Array<{ x: number; text: string }> = []
  if (rulerMode === 'bars') {
    const step = Math.max(1, Math.pow(2, Math.ceil(Math.log2(64 / Math.max(1, pxPerBar)))))
    for (let bar = 0; bar * barTicks < contentTicks; bar += step) {
      rulerLabels.push({ x: bar * pxPerBar, text: String(bar + 1) })
    }
  } else {
    const tps = ticksPerSecond(state.tempo)
    const pxPerSec = tps * pxPerTick
    const minPx = rulerMode === 'samples' ? 110 : 64
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
    const secStep = steps.find((s) => s * pxPerSec >= minPx) ?? 1200
    const totalSec = contentTicks / tps
    const sampleRate = audioEngine.contextInfo()?.sampleRate ?? 48000
    for (let sec = 0; sec <= totalSec; sec += secStep) {
      const text =
        rulerMode === 'time'
          ? `${Math.floor(sec / 60)}:${(sec % 60).toFixed(secStep < 1 ? 1 : 0).padStart(secStep < 1 ? 4 : 2, '0')}`
          : Math.round(sec * sampleRate).toLocaleString()
      rulerLabels.push({ x: sec * pxPerSec, text })
    }
  }

  // The region being dragged wins over the committed one, so the drag reads live.
  const shownLoop = loopDrag ?? transport.loopRegion

  const laneBackground = {
    backgroundImage:
      pxPerBeat >= 10
        ? `repeating-linear-gradient(to right, var(--grid-bar) 0 1px, transparent 1px ${pxPerBar}px),` +
          `repeating-linear-gradient(to right, var(--grid-beat) 0 1px, transparent 1px ${pxPerBeat}px)`
        : `repeating-linear-gradient(to right, var(--grid-bar) 0 1px, transparent 1px ${pxPerBar}px)`
  }

  // Silent = own mute/solo state OR any ancestor folder-bus closed.
  const isSilent = (trackId: string): boolean => !isTrackEffectivelyAudible(state, trackId)

  return (
    <div className="timeline" ref={scrollRef}>
      <div
        className="timeline-grid"
        ref={gridRef}
        style={{
          gridTemplateColumns: `${HEADER_W}px ${contentW}px`,
          gridTemplateRows: rowTemplate
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
          <button className="corner-btn" title="Folder track (a bus — drag tracks into it)" onClick={() => addTrack('folder')}>
            + Folder
          </button>
          <button
            className={`corner-btn corner-btn-icon ${compact ? 'corner-btn-active' : ''}`}
            title={compact ? 'Show track controls' : 'Compact tracks — hide controls to fit more on screen'}
            onClick={() => trackViewUi.toggleCompact()}
          >
            {compact ? '⇕' : '⇳'}
          </button>
        </div>

        <div
          className="timeline-ruler"
          style={{ gridRow: 1, gridColumn: 2 }}
          onPointerDown={onRulerPointerDown}
        >
          {rulerLabels.map((label) => (
            <span key={label.x} className="ruler-label mono" style={{ left: label.x + 4 }}>
              {label.text}
            </span>
          ))}
          <div className="ruler-loop-strip" style={{ height: LOOP_STRIP_H }} />
          {shownLoop && (
            <div
              className={`ruler-loop ${transport.loopEnabled ? '' : 'ruler-loop-off'}`}
              style={{
                left: shownLoop.start * pxPerTick,
                width: Math.max(2, (shownLoop.end - shownLoop.start) * pxPerTick)
              }}
              title="Loop region — drag to move, edges to resize, double-click to clear"
              onPointerDown={(e) => beginLoopAdjust(e, 'move')}
              onDoubleClick={(e) => {
                e.stopPropagation()
                transport.clearLoop()
              }}
            >
              <div
                className="ruler-loop-handle"
                onPointerDown={(e) => beginLoopAdjust(e, 'start')}
              />
              <div
                className="ruler-loop-handle ruler-loop-handle-end"
                onPointerDown={(e) => beginLoopAdjust(e, 'end')}
              />
            </div>
          )}
        </div>

        {tracks.map((track, i) => (
          <div
            key={track.id}
            style={{
              gridRow: `${gridRowOfTrack[i]} / span ${rowMeta[i].auto ? 2 : 1}`,
              gridColumn: 1
            }}
            className={`header-cell ${
              reorder?.active && reorder.fromIndex === i ? 'header-cell-dragging' : ''
            }`}
            onPointerDown={(e) => beginReorder(e, i)}
          >
            <TrackHeader track={track} depth={depthOf[i]} compact={compact} />
          </div>
        ))}

        {tracks.map((track, i) => (
          <div
            key={track.id}
            className={`lane ${isSilent(track.id) ? 'lane-muted' : ''} ${
              track.kind === 'folder' ? 'lane-folder' : ''
            }`}
            style={{ gridRow: gridRowOfTrack[i], gridColumn: 2, ...laneBackground }}
            onPointerDown={() => selection.select(null)}
            onDoubleClick={(e) => onLaneDoubleClick(e, i)}
            onDragOver={(e) => onLaneDragOver(e, i)}
            onDrop={(e) => onLaneDrop(e, i)}
          />
        ))}

        {tracks.map(
          (track, i) =>
            rowMeta[i].auto && (
              <div
                key={`auto-${track.id}`}
                className="auto-row"
                style={{ gridRow: gridRowOfTrack[i] + 1, gridColumn: 2, ...laneBackground }}
              >
                <AutomationLane track={track} pxPerTick={pxPerTick} contentW={contentW} />
              </div>
            )
        )}

        {trackCount > 0 && (
          <div
            className="clip-layer"
            style={{ gridRow: `2 / ${lastGridRow}`, gridColumn: 2 }}
          >
            {Object.values(state.clips).map((clip) => {
              // Hidden (collapsed-folder) tracks render no clips.
              const trackIndex = rowIndexOfTrack.get(clip.trackId) ?? -1
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
                          loopLength: drag.loopLength,
                          stretch: drag.stretch,
                          trackIndex: drag.trackIndex
                        }
                      : null
                  }
                  selected={clip.id === selectedClipId}
                  dimmed={isSilent(track.id) || track.frozenAssetId !== null}
                  pxPerTick={pxPerTick}
                  tempo={state.tempo}
                  laneTops={trackTops}
                  laneHeight={laneH}
                  commentCount={clipCommentCounts.get(clip.id) ?? 0}
                  notes={notesByClip.get(clip.id) ?? []}
                  fadesEditable={track.kind !== 'folder' && track.frozenAssetId === null}
                  onPointerDown={(e, mode) => beginDrag(e, clip.id, mode)}
                  onOpenComments={() => commentUi.open({ kind: 'clip', id: clip.id })}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    selection.select(clip.id, clip.trackId)
                    setColorMenu({ clipId: clip.id, x: e.clientX, y: e.clientY })
                  }}
                  onOpenEditor={
                    track.kind === 'midi' ? () => pianoRollUi.open(clip.id) : undefined
                  }
                />
              )
            })}
          </div>
        )}

        {trackCount > 0 && shownLoop && (
          <div className="loop-layer" style={{ gridRow: `2 / ${lastGridRow}`, gridColumn: 2 }}>
            <div
              className={`loop-region ${transport.loopEnabled ? '' : 'loop-region-off'}`}
              style={{
                left: shownLoop.start * pxPerTick,
                width: Math.max(2, (shownLoop.end - shownLoop.start) * pxPerTick)
              }}
            />
          </div>
        )}

        {trackCount > 0 && (
          <div className="playhead-layer" style={{ gridRow: `2 / ${lastGridRow}`, gridColumn: 2 }}>
            <Playhead pxPerTick={pxPerTick} />
          </div>
        )}

        {reorder?.active && trackCount > 0 && (
          <div
            className="reorder-layer"
            style={{ gridRow: `2 / ${lastGridRow}`, gridColumn: '1 / 3' }}
          >
            {reorder.intoFolderId !== null ? (
              <div
                className="reorder-into"
                style={{
                  top: trackTops[rowIndexOfTrack.get(reorder.intoFolderId) ?? 0],
                  height: laneH,
                  '--track-color': state.tracks[reorder.intoFolderId]?.color
                } as React.CSSProperties}
              />
            ) : (
              <div
                className="reorder-line"
                style={{
                  top:
                    reorder.slot < rowMeta.length
                      ? trackTops[reorder.slot]
                      : trackTops[rowMeta.length - 1] +
                        laneH +
                        (rowMeta[rowMeta.length - 1].auto ? AUTO_H : 0)
                }}
              />
            )}
          </div>
        )}

        {trackCount > 0 && (
          <div className="presence-layer" style={{ gridRow: `2 / ${lastGridRow}`, gridColumn: 2 }}>
            <RemoteCursors pxPerTick={pxPerTick} trackTops={trackTops} laneHeight={laneH} />
            <PingOverlay pxPerTick={pxPerTick} trackTops={trackTops} laneHeight={laneH} />
          </div>
        )}

        {trackCount > 0 && (
          <div className="recording-layer" style={{ gridRow: `2 / ${lastGridRow}`, gridColumn: 2 }}>
            <RecordingRegions
              pxPerTick={pxPerTick}
              trackTops={trackTops}
              trackIds={tracks.map((t) => t.id)}
              laneHeight={laneH}
            />
          </div>
        )}

        {trackCount > 0 &&
          openCommentAnchor?.kind === 'clip' &&
          (() => {
            const clip = state.clips[openCommentAnchor.id]
            const laneIndex = clip ? rowIndexOfTrack.get(clip.trackId) ?? -1 : -1
            if (!clip || laneIndex === -1) return null
            return (
              <div
                className="comment-layer"
                style={{ gridRow: `2 / ${lastGridRow}`, gridColumn: 2 }}
              >
                <div
                  className="comment-layer-anchor"
                  style={{
                    left: clip.start * pxPerTick + 8,
                    top: trackTops[laneIndex] + laneH - 8
                  }}
                >
                  <CommentThread anchor={openCommentAnchor} />
                </div>
              </div>
            )
          })()}
      </div>

      {colorMenu &&
        (() => {
          const clip = state.clips[colorMenu.clipId]
          if (!clip) return null
          return (
            <ClipMenu
              clip={clip}
              x={colorMenu.x}
              y={colorMenu.y}
              onClose={() => setColorMenu(null)}
            />
          )
        })()}
    </div>
  )
}

/** Growing red regions on armed tracks while recording. */
function RecordingRegions({
  pxPerTick,
  trackTops,
  trackIds,
  laneHeight
}: {
  pxPerTick: number
  trackTops: number[]
  trackIds: string[]
  laneHeight: number
}): React.JSX.Element | null {
  const rec = useRecording()
  const [, force] = useReducer((c: number) => c + 1, 0)
  useEffect(() => transport.subscribe(force), [])
  if (!rec.recording) return null
  const left = rec.recordStartTicks * pxPerTick
  const width = Math.max(2, (transport.positionTicks() - rec.recordStartTicks) * pxPerTick)
  return (
    <>
      {trackIds.map((trackId, i) =>
        rec.isArmed(trackId) ? (
          <div
            key={trackId}
            className="recording-region"
            style={{ left, top: trackTops[i] + 4, width, height: laneHeight - 8 }}
          />
        ) : null
      )}
    </>
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
