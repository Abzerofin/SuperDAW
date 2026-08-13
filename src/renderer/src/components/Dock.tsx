import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isNoteTrack } from '@core/model/types'
import { useProjectState } from '@/state/hooks'
import { useSelectedClipId, useSelectedTrackId } from '@/state/selection'
import { panels, usePanels, PANEL_LABELS, type DockSide, type PanelId } from '@/state/panels'
import { editorUi, useEditorUi, editorFormFor, type EditorForm } from '@/state/editorUi'
import { bayUi, type BayIntent } from '@/state/bayUi'
import { capturePointer } from '@/lib/pointer'
import { contextMenuStyle } from '@/lib/contextMenu'
import { useDismiss } from '@/lib/dismiss'
import { FileBay } from './bay/FileBay'
import { EffectsDock } from './fx/EffectsDock'
import { MixerPanel } from './mixer/MixerPanel'
import { PadGrid } from './pads/PadGrid'
import { PianoRoll } from './pianoroll/PianoRoll'
import { StepSequencer } from './steps/StepSequencer'
import { ActivityFeed } from './ActivityFeed'
import { ChatPanel } from './ChatPanel'
import { LyricsPanel } from './LyricsPanel'

/**
 * One dock: a strip of draggable tabs plus the open panel. Every panel can
 * live in either dock — drag a tab onto the other strip (or dock) to
 * re-home it, drag the dock edge to resize. Clicking the open tab closes
 * the dock (the strip stays, as the drop target it needs to be).
 */
export function Dock({ side }: { side: DockSide }): React.JSX.Element {
  const panelState = usePanels()
  const editorState = useEditorUi()
  const ids = panelState.layout.docks[side]
  const active = panelState.layout.active[side]
  // The clip editor needs a target: a clip, or a note track it is waiting
  // to write the first one on. A persisted layout can name it active with
  // neither (e.g. it was open at quit) — show no body then.
  const editorTarget = editorState.clipId ?? editorState.pendingTrackId
  const showBody = active !== null && (active !== 'editor' || editorTarget !== null)

  if (side === 'bottom') {
    return (
      <div className="dock dock-bottom" data-dock="bottom">
        <div className="dock-tabs" data-dock="bottom">
          {ids.map((id) => (
            <DockTab key={id} id={id} />
          ))}
        </div>
        {showBody && (
          <div className="dock-body" style={{ height: panelState.layout.bottomHeight }}>
            <DockResizer side="bottom" />
            <PanelBody
            id={active}
            clipId={editorState.clipId}
            trackId={editorState.pendingTrackId}
          />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="dock dock-right" data-dock="right">
      {showBody && (
        <div
          className="dock-body dock-body-right"
          style={{ width: panelState.layout.rightWidth }}
        >
          <DockResizer side="right" />
          <PanelBody
            id={active}
            clipId={editorState.clipId}
            trackId={editorState.pendingTrackId}
          />
        </div>
      )}
      <div className="dock-tabs dock-tabs-vertical" data-dock="right">
        {ids.map((id) => (
          <DockTab key={id} id={id} vertical />
        ))}
      </div>
    </div>
  )
}

function PanelBody({
  id,
  clipId,
  trackId
}: {
  id: PanelId
  clipId: string | null
  /** Set instead of clipId when the editor is open on a track with no clip. */
  trackId: string | null
}): React.JSX.Element | null {
  switch (id) {
    case 'files':
      return <FileBay />
    case 'mixer':
      return <MixerPanel />
    case 'effects':
      return <EffectsDock />
    case 'editor':
      return clipId || trackId ? <ClipEditor clipId={clipId} trackId={trackId} /> : null
    case 'pads':
      return <PadGrid />
    case 'activity':
      return <ActivityFeed />
    case 'chat':
      return <ChatPanel />
    case 'lyrics':
      return <LyricsPanel />
  }
}

/**
 * The clip editor, in the form the TRACK asks for: the step grid on a drum
 * track, the piano roll on a MIDI one. Same tab either way, and not a
 * choice — the two surfaces suit two different kinds of material.
 */
function ClipEditor({
  clipId,
  trackId
}: {
  clipId: string | null
  trackId: string | null
}): React.JSX.Element | null {
  const state = useProjectState()
  useEditorUi()
  const openClipId = clipId !== null && state.clips[clipId] ? clipId : null
  const openTrackId = openClipId !== null ? null : trackId
  if (openClipId === null && (openTrackId === null || !state.tracks[openTrackId])) return null
  return editorFormFor(state, openClipId, openTrackId) === 'steps' ? (
    <StepSequencer clipId={openClipId} trackId={openTrackId} />
  ) : (
    <PianoRoll clipId={openClipId} trackId={openTrackId} />
  )
}

/** Drag the dock edge to resize it (per-user, persisted). */
function DockResizer({ side }: { side: DockSide }): React.JSX.Element {
  const startRef = useRef<{ pos: number; size: number } | null>(null)
  return (
    <div
      className={side === 'bottom' ? 'dock-resizer dock-resizer-h' : 'dock-resizer dock-resizer-v'}
      title="Drag to resize"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        capturePointer(e)
        startRef.current = {
          pos: side === 'bottom' ? e.clientY : e.clientX,
          size:
            side === 'bottom' ? panels.layout.bottomHeight : panels.layout.rightWidth
        }
      }}
      onPointerMove={(e) => {
        const start = startRef.current
        if (!start) return
        if (side === 'bottom') panels.setBottomHeight(start.size + (start.pos - e.clientY))
        else panels.setRightWidth(start.size + (start.pos - e.clientX))
      }}
      onPointerUp={() => {
        startRef.current = null
      }}
    />
  )
}

interface TabDrag {
  startX: number
  startY: number
  dragging: boolean
  x: number
  y: number
}

function DockTab({ id, vertical = false }: { id: PanelId; vertical?: boolean }): React.JSX.Element {
  const panelState = usePanels()
  const editorState = useEditorUi()
  const state = useProjectState()
  const selectedTrackId = useSelectedTrackId()
  const selectedClipId = useSelectedClipId()
  const [drag, setDragState] = useState<TabDrag | null>(null)
  const dragRef = useRef<TabDrag | null>(null)
  /** Right-click menu on a tab: move/close everywhere, bay actions on Files. */
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number } | null>(null)
  const setDrag = (value: TabDrag | null): void => {
    dragRef.current = value
    setDragState(value)
  }

  useDismiss(tabMenu !== null, () => setTabMenu(null))

  /** Open the bay and hand it the action — same code the bay's own UI runs. */
  const sendBayAction = (intent: BayIntent): void => {
    setTabMenu(null)
    panels.openPanel('files')
    bayUi.send(intent)
  }

  // A MIDI clip is "editable" when it's already open in the editor, or the
  // current selection can be opened. Selecting a MIDI TRACK is enough —
  // its first clip is the target — so clicking a header or mixer strip
  // arms the editor too. Dead ids (clip deleted while the panel was
  // closed) count as no target instead of a tab that opens nothing.
  const selectedClip = selectedClipId ? state.clips[selectedClipId] : undefined
  const selectedMidiClipId =
    selectedClip && isNoteTrack(state, selectedClip.trackId) ? selectedClip.id : null
  const selectedTrackMidiClipId =
    selectedMidiClipId === null &&
    selectedTrackId !== null &&
    isNoteTrack(state, selectedTrackId)
      ? (Object.values(state.clips)
          .filter((c) => c.trackId === selectedTrackId && c.assetId === null)
          .sort((a, b) => a.start - b.start)[0]?.id ?? null)
      : null
  const editTarget = selectedMidiClipId ?? selectedTrackMidiClipId
  const editorClipId =
    editorState.clipId !== null && state.clips[editorState.clipId] ? editorState.clipId : null
  // A note track with nothing on it yet is still editable: the editor
  // opens empty on it and the first note (or +) makes the clip.
  const emptyNoteTrackId =
    editTarget === null && selectedTrackId !== null && isNoteTrack(state, selectedTrackId)
      ? selectedTrackId
      : null
  const pendingTrackId =
    editorState.pendingTrackId !== null && state.tracks[editorState.pendingTrackId]
      ? editorState.pendingTrackId
      : null
  const openable = editorClipId ?? editTarget
  const disabled = id === 'editor' && openable === null && emptyNoteTrackId === null
  // The tab wears the form its track calls for: a drum track reads
  // "Steps", a MIDI one "Piano".
  const editorForm: EditorForm = editorFormFor(
    state,
    openable,
    pendingTrackId ?? emptyNoteTrackId
  )

  const effectsTrack =
    id === 'effects' && selectedTrackId ? state.tracks[selectedTrackId] : undefined
  const title =
    id === 'editor'
      ? disabled
        ? 'Clip editor — select or double-click a MIDI clip to edit it'
        : editorForm === 'steps'
          ? 'Toggle the step grid — this drum track’s loops'
          : 'Toggle the piano roll — this MIDI track’s notes'
      : id === 'effects'
        ? effectsTrack
          ? `Effects — ${effectsTrack.name}'s insert chain`
          : 'Effects — select a track to edit its insert chain'
        : {
            files: 'File Bay — imported audio and MIDI · right-click to import',
            mixer: 'Mixer — faders, pans and inserts for every track',
            pads: 'Performance pads — samples, notes and clip launches on an 8×8 grid',
            activity: 'Activity — who changed what, when',
            chat: 'Chat — saved with the project',
            lyrics: 'Lyrics — saved with the project'
          }[id as Exclude<PanelId, 'editor' | 'effects'>]

  const label = id === 'editor' ? (editorForm === 'steps' ? 'Steps' : 'Piano') : PANEL_LABELS[id]

  const onClick = (): void => {
    if (dragRef.current) return // a drop, not a click
    if (id === 'editor') {
      if (panelState.isOpen('editor')) {
        panels.closePanel('editor')
      } else if (editTarget && editTarget !== editorClipId) {
        editorUi.open(editTarget)
      } else if (editorClipId !== null) {
        panels.openPanel('editor')
      } else if (emptyNoteTrackId !== null) {
        editorUi.openTrack(emptyNoteTrackId)
      }
      return
    }
    panels.togglePanel(id)
  }

  const drop = (x: number, y: number): void => {
    const under = document.elementFromPoint(x, y)
    const strip = under?.closest('[data-dock]')
    if (!strip) return
    const side = strip.getAttribute('data-dock') as DockSide
    const overTab = under?.closest('[data-dock-tab]')
    const overId = overTab?.getAttribute('data-dock-tab') as PanelId | null
    const index =
      overId && overId !== id
        ? panels.layout.docks[side].indexOf(overId)
        : panels.layout.docks[side].length
    panels.movePanel(id, side, index)
  }

  return (
    <>
      <button
        className={`dock-tab ${panelState.isOpen(id) ? 'dock-tab-active' : ''} ${
          vertical ? 'dock-tab-vertical' : ''
        }`}
        data-dock-tab={id}
        data-ping-id={`tab:${id}`}
        data-ping={`the ${label} tab`}
        disabled={disabled}
        title={title}
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setTabMenu({ x: e.clientX, y: e.clientY })
        }}
        onPointerDown={(e) => {
          if (e.button !== 0 || disabled) return
          capturePointer(e)
          setDrag({ startX: e.clientX, startY: e.clientY, dragging: false, x: e.clientX, y: e.clientY })
        }}
        onPointerMove={(e) => {
          const d = dragRef.current
          if (!d) return
          const dragging =
            d.dragging || Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 6
          setDrag({ ...d, dragging, x: e.clientX, y: e.clientY })
        }}
        onPointerUp={(e) => {
          const d = dragRef.current
          if (d?.dragging) {
            drop(e.clientX, e.clientY)
            // Swallow the click that follows this pointerup.
            setTimeout(() => setDrag(null), 0)
          } else {
            setDrag(null)
          }
        }}
      >
        {label}
        {id === 'chat' && panelState.unreadChat > 0 && (
          <span className="chat-badge">{Math.min(panelState.unreadChat, 99)}</span>
        )}
      </button>
      {drag?.dragging && (
        <div className="dock-tab-ghost" style={{ left: drag.x + 10, top: drag.y + 8 }}>
          {label}
        </div>
      )}
      {tabMenu &&
        createPortal(
          <div
            className="menu-panel ctx-menu"
            style={contextMenuStyle(tabMenu.x, tabMenu.y)}
            onPointerDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            {id === 'files' && (
              <>
                <button className="menu-item" onClick={() => sendBayAction('import')}>
                  <span>Import files…</span>
                </button>
                <button className="menu-item" onClick={() => sendBayAction('new-folder')}>
                  <span>New folder</span>
                </button>
                <div className="menu-sep" />
              </>
            )}
            <button
              className="menu-item"
              onClick={() => {
                setTabMenu(null)
                const other: DockSide = panels.dockOf(id) === 'bottom' ? 'right' : 'bottom'
                panels.movePanel(id, other, panels.layout.docks[other].length)
              }}
            >
              <span>Move to {panels.dockOf(id) === 'bottom' ? 'right' : 'bottom'} dock</span>
            </button>
            {panelState.isOpen(id) && (
              <button
                className="menu-item"
                onClick={() => {
                  setTabMenu(null)
                  panels.closePanel(id)
                }}
              >
                <span>Close panel</span>
              </button>
            )}
          </div>,
          document.body
        )}
    </>
  )
}
