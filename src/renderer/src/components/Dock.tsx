import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useProjectState } from '@/state/hooks'
import { useSelectedClipId, useSelectedTrackId } from '@/state/selection'
import { panels, usePanels, PANEL_LABELS, type DockSide, type PanelId } from '@/state/panels'
import { pianoRollUi, usePianoRollUi } from '@/state/pianoRollUi'
import { bayUi, type BayIntent } from '@/state/bayUi'
import { capturePointer } from '@/lib/pointer'
import { contextMenuStyle } from '@/lib/contextMenu'
import { FileBay } from './bay/FileBay'
import { EffectsDock } from './fx/EffectsDock'
import { MixerPanel } from './mixer/MixerPanel'
import { PianoRoll } from './pianoroll/PianoRoll'
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
  const rollState = usePianoRollUi()
  const ids = panelState.layout.docks[side]
  const active = panelState.layout.active[side]
  const showBody = active !== null && (active !== 'pianoroll' || rollState.clipId !== null)

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
            <PanelBody id={active} clipId={rollState.clipId} />
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
          <PanelBody id={active} clipId={rollState.clipId} />
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

function PanelBody({ id, clipId }: { id: PanelId; clipId: string | null }): React.JSX.Element | null {
  switch (id) {
    case 'files':
      return <FileBay />
    case 'mixer':
      return <MixerPanel />
    case 'effects':
      return <EffectsDock />
    case 'pianoroll':
      return clipId ? <PianoRoll clipId={clipId} /> : null
    case 'activity':
      return <ActivityFeed />
    case 'chat':
      return <ChatPanel />
    case 'lyrics':
      return <LyricsPanel />
  }
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
  const rollState = usePianoRollUi()
  const state = useProjectState()
  const selectedTrackId = useSelectedTrackId()
  const selectedClipId = useSelectedClipId()
  const [drag, setDragState] = useState<TabDrag | null>(null)
  const dragRef = useRef<TabDrag | null>(null)
  /** Right-click menu on the Files tab: bay actions without opening it first. */
  const [filesMenu, setFilesMenu] = useState<{ x: number; y: number } | null>(null)
  const setDrag = (value: TabDrag | null): void => {
    dragRef.current = value
    setDragState(value)
  }

  useEffect(() => {
    if (!filesMenu) return
    const close = (): void => setFilesMenu(null)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [filesMenu])

  /** Open the bay and hand it the action — same code the bay's own UI runs. */
  const sendBayAction = (intent: BayIntent): void => {
    setFilesMenu(null)
    panels.openPanel('files')
    bayUi.send(intent)
  }

  // A MIDI clip is "editable" when it's already open in the roll, or the
  // current selection can be opened.
  const selectedClip = selectedClipId ? state.clips[selectedClipId] : undefined
  const selectedMidiClipId =
    selectedClip && state.tracks[selectedClip.trackId]?.kind === 'midi' ? selectedClip.id : null
  const openable = rollState.clipId ?? selectedMidiClipId
  const disabled = id === 'pianoroll' && openable === null

  const effectsTrack =
    id === 'effects' && selectedTrackId ? state.tracks[selectedTrackId] : undefined
  const title =
    id === 'pianoroll'
      ? disabled
        ? 'Piano roll — select or double-click a MIDI clip to edit its notes'
        : 'Toggle piano roll'
      : id === 'effects'
        ? effectsTrack
          ? `Effects — ${effectsTrack.name}'s insert chain`
          : 'Effects — select a track to edit its insert chain'
        : {
            files: 'File Bay — imported audio and MIDI · right-click to import',
            mixer: 'Mixer — faders, pans and inserts for every track',
            activity: 'Activity — who changed what, when',
            chat: 'Chat — saved with the project',
            lyrics: 'Lyrics — saved with the project'
          }[id as Exclude<PanelId, 'pianoroll' | 'effects'>]

  const onClick = (): void => {
    if (dragRef.current) return // a drop, not a click
    if (id !== 'pianoroll') {
      panels.togglePanel(id)
      return
    }
    if (panelState.isOpen('pianoroll')) {
      panels.closePanel('pianoroll')
    } else if (selectedMidiClipId && selectedMidiClipId !== rollState.clipId) {
      pianoRollUi.open(selectedMidiClipId)
    } else if (rollState.clipId !== null) {
      panels.openPanel('pianoroll')
    }
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
        data-ping={`the ${PANEL_LABELS[id]} tab`}
        disabled={disabled}
        title={title}
        onClick={onClick}
        onContextMenu={(e) => {
          if (id !== 'files') return
          e.preventDefault()
          e.stopPropagation()
          setFilesMenu({ x: e.clientX, y: e.clientY })
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
        {PANEL_LABELS[id]}
        {id === 'chat' && panelState.unreadChat > 0 && (
          <span className="chat-badge">{Math.min(panelState.unreadChat, 99)}</span>
        )}
      </button>
      {drag?.dragging && (
        <div className="dock-tab-ghost" style={{ left: drag.x + 10, top: drag.y + 8 }}>
          {PANEL_LABELS[id]}
        </div>
      )}
      {filesMenu &&
        createPortal(
          <div
            className="menu-panel ctx-menu"
            style={contextMenuStyle(filesMenu.x, filesMenu.y)}
            onPointerDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button className="menu-item" onClick={() => sendBayAction('import')}>
              <span>Import files…</span>
            </button>
            <button className="menu-item" onClick={() => sendBayAction('new-folder')}>
              <span>New folder</span>
            </button>
          </div>,
          document.body
        )}
    </>
  )
}
