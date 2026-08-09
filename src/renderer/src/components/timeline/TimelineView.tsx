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
import { selection, useSelectionVersion } from '@/state/selection'
import { transport } from '@/state/transport'
import { gridTicksFor, useGridChoice } from '@/state/gridUi'
import {
  BAY_DRAG_MIME,
  browseForMediaFiles,
  createClipFromBayAsset,
  importFilesAsNewTracks,
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
  DROP_BAR_H,
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

/**
 * Rubber-band selection dragged across empty timeline space. Coordinates
 * are CONTENT pixels (relative to the lane area's top-left, so unaffected
 * by scrolling), matching how clips are positioned.
 */
interface MarqueeState {
  originX: number
  originY: number
  x: number
  y: number
  /** Ctrl/Cmd started the drag: add to the existing selection. */
  additive: boolean
  /** Selection as it was when the drag began (the base for `additive`). */
  base: ClipId[]
}

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

/** One clip taking part in a drag: its pre-drag values plus its preview. */
interface DragMember {
  clipId: ClipId
  hasAsset: boolean
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
}

interface DragState extends DragMember {
  mode: 'move' | 'resize-l' | 'resize-r' | 'loop-r' | 'stretch-r'
  originX: number
  originY: number
  /**
   * The rest of the multi-clip selection, dragged by the SAME deltas as
   * the grabbed clip (which snaps; the others follow it exactly, so their
   * relative spacing is preserved). Empty for an ordinary single drag.
   */
  others: DragMember[]
  moved: boolean
}

/**
 * Apply the grabbed clip's resolved deltas to another selected clip.
 * Deltas rather than absolute values, so a multi-clip drag preserves the
 * spacing and relative lengths the user arranged — and only the grabbed
 * clip snaps to the grid, which is what makes the group feel rigid.
 */
function followDrag(
  member: DragMember,
  lead: DragState,
  resolved: Pick<
    DragMember,
    'start' | 'duration' | 'offset' | 'loopLength' | 'stretch' | 'trackIndex'
  >,
  gridTicks: number
): DragMember {
  const next = { ...member }
  switch (lead.mode) {
    case 'move': {
      next.start = Math.max(0, member.origStart + (resolved.start - lead.origStart))
      next.trackIndex = Math.max(
        0,
        member.origTrackIndex + (resolved.trackIndex - lead.origTrackIndex)
      )
      return next
    }
    case 'resize-l': {
      const dStart = resolved.start - lead.origStart
      const maxStart = member.origStart + member.origDuration - gridTicks
      const minStart = member.hasAsset ? member.origStart - member.origOffset : 0
      next.start = Math.min(maxStart, Math.max(minStart, Math.max(0, member.origStart + dStart)))
      next.duration = member.origStart + member.origDuration - next.start
      next.offset = member.hasAsset
        ? member.origOffset + (next.start - member.origStart)
        : member.origOffset
      return next
    }
    case 'stretch-r': {
      // Share the FACTOR, not the length: each clip stretches by the same
      // proportion, so a slow-down applies evenly across the selection.
      const factor = resolved.stretch / lead.origStretch
      next.stretch = Math.min(
        MAX_STRETCH,
        Math.max(MIN_STRETCH, member.origStretch * factor)
      )
      next.duration = Math.max(
        1,
        Math.round((member.origDuration * next.stretch) / member.origStretch)
      )
      next.loopLength =
        member.origLoop > 0
          ? Math.round((member.origLoop * next.stretch) / member.origStretch)
          : 0
      return next
    }
    case 'loop-r': {
      const dDuration = resolved.duration - lead.origDuration
      const base = member.origLoop > 0 ? member.origLoop : member.origDuration
      next.duration = Math.max(gridTicks, member.origDuration + dDuration)
      next.loopLength = next.duration > base ? base : 0
      return next
    }
    default: {
      const dDuration = resolved.duration - lead.origDuration
      next.duration = Math.max(gridTicks, member.origDuration + dDuration)
      return next
    }
  }
}

export function TimelineView(): React.JSX.Element {
  const state = useProjectState()
  // Re-render on any selection change; the sets are read off `selection`.
  useSelectionVersion()
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
  /** Files are hovering the trailing drop bar (highlight only). */
  const [dropBarActive, setDropBarActive] = useState(false)
  // Rubber-band select. Mirrored in a ref because pointermove batching can
  // otherwise let pointerup read a stale rectangle.
  const [marquee, setMarqueeState] = useState<MarqueeState | null>(null)
  const marqueeRef = useRef<MarqueeState | null>(null)
  const setMarquee = (value: MarqueeState | null): void => {
    marqueeRef.current = value
    setMarqueeState(value)
  }
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
  const markerTicks = transport.markerTicks
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
  // A trailing drop bar always closes the list: it is where files land to
  // become new tracks, and it doubles as the empty-project call to action.
  const rowTemplate =
    trackCount === 0
      ? `${RULER_H}px ${DROP_BAR_H}px`
      : `${RULER_H}px ${rowMeta
          .map((m) => (m.auto ? `${laneH}px ${AUTO_H}px` : `${laneH}px`))
          .join(' ')} ${DROP_BAR_H}px`

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

  /** Snapshot a clip's pre-drag values; null if it can't take part. */
  const dragMemberOf = (clipId: ClipId): DragMember | null => {
    const clip = projectStore.state.clips[clipId]
    if (!clip) return null
    if (projectStore.state.tracks[clip.trackId]?.frozenAssetId) return null
    const trackIndex = rowIndexOfTrack.get(clip.trackId) ?? -1
    if (trackIndex === -1) return null
    return {
      clipId,
      hasAsset: clip.assetId !== null,
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
      trackIndex
    }
  }

  const beginDrag = (
    e: React.PointerEvent,
    clipId: ClipId,
    mode: DragState['mode']
  ): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    const clip = projectStore.state.clips[clipId]
    if (!clip) return
    // Ctrl/Cmd-click extends the selection instead of starting a drag, so
    // several clips can be gathered before moving them together.
    if (e.ctrlKey || e.metaKey) {
      selection.toggleClip(clipId, clip.trackId)
      return
    }
    // Frozen tracks are locked: their render would go stale if clips moved.
    // Unfreeze to edit (selection and comments still work).
    if (projectStore.state.tracks[clip.trackId]?.frozenAssetId) {
      selection.select(clipId, clip.trackId)
      return
    }
    const member = dragMemberOf(clipId)
    if (!member) return
    // Grabbing a clip that is already part of a multi-selection drags the
    // whole set; grabbing anything else collapses the selection to it.
    const inSelection = selection.isClipSelected(clipId) && selection.selectedClipIds.size > 1
    if (inSelection) selection.selectClips(selection.selectedClipIds, clipId)
    else selection.select(clipId, clip.trackId)
    const others = inSelection
      ? [...selection.selectedClipIds]
          .filter((id) => id !== clipId)
          .map(dragMemberOf)
          .filter((m): m is DragMember => m !== null)
      : []
    capturePointer(e)
    setDrag({ ...member, mode, originX: e.clientX, originY: e.clientY, others, moved: false })
  }

  /** Pointer position in lane-content pixels (scroll-independent). */
  const contentPoint = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = gridRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: Math.max(0, e.clientX - rect.left - HEADER_W),
      y: Math.max(0, e.clientY - rect.top - RULER_H)
    }
  }

  /**
   * Rubber-band select: drag from empty lane space to gather every clip the
   * box touches. Pure selection — no ops, nothing to undo.
   */
  const beginMarquee = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const additive = e.ctrlKey || e.metaKey
    const { x, y } = contentPoint(e)
    capturePointer(e)
    setMarquee({
      originX: x,
      originY: y,
      x,
      y,
      additive,
      base: additive ? [...selection.selectedClipIds] : []
    })
    // A plain click on empty space still clears, as it always did; the
    // marquee only adds to that once the pointer actually moves.
    if (!additive) selection.select(null)
  }

  /** Clip ids whose rectangles intersect the dragged box. */
  const clipsInMarquee = (box: MarqueeState): ClipId[] => {
    const left = Math.min(box.originX, box.x)
    const right = Math.max(box.originX, box.x)
    const top = Math.min(box.originY, box.y)
    const bottom = Math.max(box.originY, box.y)
    const hits: ClipId[] = []
    for (const clip of Object.values(state.clips)) {
      const index = rowIndexOfTrack.get(clip.trackId)
      if (index === undefined) continue // hidden inside a collapsed folder
      const clipTop = trackTops[index]
      if (clipTop + laneH < top || clipTop > bottom) continue
      const clipLeft = clip.start * pxPerTick
      const clipRight = (clip.start + clip.duration) * pxPerTick
      if (clipRight < left || clipLeft > right) continue
      hits.push(clip.id)
    }
    return hits
  }

  /** Drag a track header vertically to reorder tracks (ONE op on release). */
  const beginReorder = (e: React.PointerEvent, index: number): void => {
    if (e.button !== 0) return
    // Buttons, inputs and popovers inside the header keep their own gestures.
    if ((e.target as HTMLElement).closest('button, input, .comment-layer-anchor')) return
    // Ctrl/Cmd and Shift are selection modifiers on a header, not drags.
    if (e.ctrlKey || e.metaKey || e.shiftKey) return
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
    if (marqueeRef.current) {
      const { x, y } = contentPoint(e)
      const box = { ...marqueeRef.current, x, y }
      setMarquee(box)
      // Selection follows the box live, so the result is visible before
      // release. Ephemeral state only — no ops, nothing to undo.
      selection.selectClips([...box.base, ...clipsInMarquee(box)])
      return
    }
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
      // The rest of the selection follows by the SAME deltas the grabbed
      // clip resolved to (it did the snapping), so relative spacing holds.
      const others = prev.others.map((m) =>
        followDrag(m, prev, { start, duration, offset, loopLength, stretch, trackIndex }, gridTicks)
      )
      return {
        ...prev,
        start,
        duration,
        offset,
        loopLength,
        stretch,
        trackIndex,
        others,
        moved
      }
    })
  }

  const onPointerUp = (): void => {
    if (marqueeRef.current) {
      // The selection was already applied as the box moved.
      setMarquee(null)
      return
    }
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
      const members: DragMember[] = [drag, ...drag.others]
      if (drag.mode === 'move') {
        // Folder and frozen lanes never accept clips (the reducer would
        // reject the folder case anyway; skip the no-op dispatch).
        const moves = members.flatMap((m) => {
          const targetTrack = tracks[m.trackIndex]
          if (!targetTrack || targetTrack.kind === 'folder' || targetTrack.frozenAssetId) return []
          return [{ clipId: m.clipId, trackId: targetTrack.id, start: m.start }]
        })
        // A whole multi-clip move must land or not land together: if any
        // clip's destination is unusable, the group would tear apart.
        if (moves.length === members.length && moves.length > 0) {
          projectStore.dispatch(
            moves.length === 1
              ? { type: 'clip/move', ...moves[0] }
              : { type: 'clip/moveMany', moves }
          )
        }
      } else {
        // The loop handle sets the period and the stretch handle sets the
        // time factor with the same gesture; a plain trim leaves both
        // untouched (fields absent). Stretching a looped clip scales its
        // period so the repeat count is preserved.
        const edits = members.map((m) => ({
          clipId: m.clipId,
          start: m.start,
          duration: m.duration,
          offset: m.offset,
          ...(drag.mode === 'loop-r' ? { loopLength: m.loopLength } : {}),
          ...(drag.mode === 'stretch-r'
            ? { stretch: m.stretch, ...(m.origLoop > 0 ? { loopLength: m.loopLength } : {}) }
            : {})
        }))
        projectStore.dispatch(
          edits.length === 1
            ? { type: 'clip/resize', ...edits[0] }
            : { type: 'clip/resizeMany', edits }
        )
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
    // Shift pins the edit marker instead of moving the playhead, so edits
    // have a fixed target while the song keeps playing.
    if (e.shiftKey) {
      transport.setMarker(ticks)
      return
    }
    const inLoopStrip = e.clientY - rect.top < LOOP_STRIP_H
    if (inLoopStrip || e.altKey) {
      capturePointer(e)
      setLoopDrag({ mode: 'new', anchorTicks: ticks, start: ticks, end: ticks })
      return
    }
    // Scrubbing means "edit here" again: drop any pinned marker.
    transport.clearMarker()
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

  const addTrack = (kind: TrackKind): void => {
    createTrack(kind)
  }

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

  // Live drag previews by clip id — the grabbed clip and everything else
  // in a multi-clip selection all move at once.
  const dragPreviews = new Map<
    ClipId,
    Pick<DragMember, 'start' | 'duration' | 'offset' | 'loopLength' | 'stretch' | 'trackIndex'>
  >()
  if (drag) {
    for (const m of [drag, ...drag.others]) {
      dragPreviews.set(m.clipId, {
        start: m.start,
        duration: m.duration,
        offset: m.offset,
        loopLength: m.loopLength,
        stretch: m.stretch,
        trackIndex: m.trackIndex
      })
    }
  }

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
            onPointerDown={(e) => {
              // Shift anywhere on the timeline pins the edit marker, so you
              // don't have to reach for the ruler mid-take.
              if (e.shiftKey) {
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                transport.setMarker(snapTicks((e.clientX - rect.left) / pxPerTick, gridTicks))
                return
              }
              beginMarquee(e)
            }}
            onDoubleClick={(e) => onLaneDoubleClick(e, i)}
            onDragOver={(e) => onLaneDragOver(e, i)}
            onDrop={(e) => onLaneDrop(e, i)}
          />
        ))}

        <div
          className={`track-drop-bar ${dropBarActive ? 'track-drop-bar-over' : ''}`}
          style={{ gridRow: lastGridRow, gridColumn: '1 / 3' }}
          title="Drop audio or MIDI files here, or click to browse"
          onClick={() => void browseForMediaFiles()}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            setDropBarActive(true)
          }}
          onDragLeave={() => setDropBarActive(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDropBarActive(false)
            const files = Array.from(e.dataTransfer.files)
            if (files.length > 0) void importFilesAsNewTracks(files)
          }}
        >
          <span className="track-drop-bar-text">
            {trackCount === 0
              ? 'Drop audio or MIDI files here to start — or click to browse'
              : 'Drop files here to add tracks — or click to browse'}
          </span>
        </div>

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
                  preview={dragPreviews.get(clip.id) ?? null}
                  selected={selection.isClipSelected(clip.id)}
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
                    // Right-clicking inside a multi-selection keeps it, so
                    // the menu can act on the whole set.
                    if (!selection.isClipSelected(clip.id)) {
                      selection.select(clip.id, clip.trackId)
                    }
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

        {trackCount > 0 && markerTicks !== null && (
          <div className="marker-layer" style={{ gridRow: `1 / ${lastGridRow}`, gridColumn: 2 }}>
            <div
              className="edit-marker"
              style={{ left: markerTicks * pxPerTick }}
              title="Edit marker — slices and pastes land here. Click the flag to clear it."
            >
              <button
                className="edit-marker-flag"
                title="Clear the edit marker"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => transport.clearMarker()}
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {marquee && (
          <div className="marquee-layer" style={{ gridRow: `2 / ${lastGridRow}`, gridColumn: 2 }}>
            <div
              className="marquee"
              style={{
                left: Math.min(marquee.originX, marquee.x),
                top: Math.min(marquee.originY, marquee.y),
                width: Math.abs(marquee.x - marquee.originX),
                height: Math.abs(marquee.y - marquee.originY)
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
