import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Track } from '@core/model/types'
import { childTracksOf } from '@core/model/types'
import { buildDuplicateTrackOp } from '@core/ops/duplicateTrack'
import { projectStore } from '@/state/projectStore'
import { useProjectState } from '@/state/hooks'
import { commentUi, useCommentUi } from '@/state/commentUi'
import { automationUi } from '@/state/automationUi'
import { recording, useRecording } from '@/state/recording'
import { panels } from '@/state/panels'
import { selection, useSelectedTrackId } from '@/state/selection'
import { folderUi, useFolderUi } from '@/state/folderUi'
import { routingUi } from '@/state/routingUi'
import { trackInputs, useTrackInputs } from '@/state/trackInputs'
import { trackInputUi, useTrackInputUi } from '@/state/trackInputUi'
import { freezeTrack, loadTrackPreset, saveTrackPreset, unfreezeTrack } from '@/lib/trackActions'
import { CommentThread } from '../comments/CommentThread'
import { TrackInputPanel } from '../track/TrackInputPanel'
import { TrackStripControls } from './TrackStripControls'

/**
 * The track header. Only the controls used constantly live on its face —
 * name, pan, volume (with a live meter), mute/solo, and record arm +
 * monitor on audio tracks. Everything else (effects, input routing,
 * automation, comments, duplicate, freeze, presets, routing, delete) sits
 * behind the ⋯ menu, which is the same menu right-click opens.
 */
export function TrackHeader({
  track,
  depth = 0,
  compact = false
}: {
  track: Track
  depth?: number
  /** Hide every control, leaving the name — see state/trackViewUi. */
  compact?: boolean
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const openAnchor = useCommentUi().anchor
  const state = useProjectState()
  const commentCount = Object.values(state.comments).filter(
    (c) => c.parentId === null && !c.resolved && c.anchor.kind === 'track' && c.anchor.id === track.id
  ).length
  const popoverOpen = openAnchor?.kind === 'track' && openAnchor.id === track.id
  const isSelected = useSelectedTrackId() === track.id
  const hasFx = Object.values(state.plugins).some((p) => p.trackId === track.id)
  const isFolder = track.kind === 'folder'
  const frozen = track.frozenAssetId !== null
  const canRecord = track.kind === 'audio' && !frozen
  const inputOpen = useTrackInputUi().trackId === track.id
  const monitoring = useTrackInputs().isMonitoring(track.id)
  const collapsed = useFolderUi().isCollapsed(track.id)
  const childCount = isFolder ? childTracksOf(state, track.id).length : 0

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menu])

  const commit = (): void => {
    setEditing(false)
    const trimmed = name.trim()
    if (trimmed && trimmed !== track.name) {
      projectStore.dispatch({ type: 'track/rename', trackId: track.id, name: trimmed })
    }
  }

  const duplicate = (): void => {
    const op = buildDuplicateTrackOp(projectStore.state, track.id)
    if (op) projectStore.dispatch(op)
  }

  const menuItem = (label: string, action: () => void, disabled = false): React.JSX.Element => (
    <button
      key={label}
      className="menu-item"
      disabled={disabled}
      onClick={() => {
        setMenu(null)
        action()
      }}
    >
      <span>{label}</span>
    </button>
  )

  const openMenuAt = (x: number, y: number): void => setMenu({ x, y })

  return (
    <div
      className={`track-header ${frozen ? 'track-header-frozen' : ''} ${
        compact ? 'track-header-compact' : ''
      } ${isSelected ? 'track-header-selected' : ''}`}
      style={{ borderLeftColor: track.color, paddingLeft: 9 + depth * 14 }}
      // Any interaction with a header selects its track (the Effects dock
      // follows the selection), including right-click and control clicks
      // that bubble up.
      onPointerDown={() => selection.selectTrack(track.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        openMenuAt(e.clientX, e.clientY)
      }}
    >
      <div className="track-header-top">
        {isFolder && (
          <button
            className="track-collapse"
            title={collapsed ? `Expand (${childCount} tracks)` : 'Collapse'}
            onClick={() => folderUi.toggle(track.id)}
          >
            {collapsed ? '▸' : '▾'}
          </button>
        )}
        {editing ? (
          <input
            className="track-name-input"
            autoFocus
            value={name}
            // Preselect so typing replaces the old name (rename convention).
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <span
            className="track-name"
            title="Double-click to rename · right-click for all track actions"
            onDoubleClick={() => {
              setName(track.name)
              setEditing(true)
            }}
          >
            {track.name}
            {collapsed && childCount > 0 && <span className="track-childcount"> ({childCount})</span>}
          </span>
        )}
        {frozen && (
          <span className="track-frozen-badge" title="Frozen — see the ⋯ menu to unfreeze">
            ❄
          </span>
        )}
        {commentCount > 0 && (
          <button
            className="track-comment track-comment-active"
            title="Comments"
            onClick={() => commentUi.open({ kind: 'track', id: track.id })}
          >
            {commentCount}
          </button>
        )}
        <button
          className="track-menu-btn"
          title="Track settings"
          onClick={(e) => {
            e.stopPropagation()
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
            openMenuAt(rect.left, rect.bottom + 2)
          }}
        >
          ⋯
        </button>
      </div>

      {popoverOpen && (
        <div className="comment-layer-anchor track-comment-popover">
          <CommentThread anchor={{ kind: 'track', id: track.id }} />
        </div>
      )}
      {inputOpen && (
        <div className="comment-layer-anchor track-comment-popover">
          <TrackInputPanel track={track} />
        </div>
      )}

      {!compact && <TrackStripControls track={track} />}

      {!compact && (
      <div className="track-header-bottom">
        <span className="track-kind">
          {track.kind === 'audio' ? 'AUD' : track.kind === 'midi' ? 'MIDI' : 'FLDR'}
        </span>
        <button
          className={`track-toggle track-fx ${hasFx || track.kind === 'midi' ? 'track-fx-has' : ''}`}
          title={
            isFolder
              ? 'Bus effects (opens the Effects tab)'
              : track.kind === 'midi'
                ? 'Instrument & effects — synth, EQ, compressor… (opens the Effects tab)'
                : 'Effects — EQ, compressor, reverb… (opens the Effects tab)'
          }
          onClick={() => {
            selection.selectTrack(track.id)
            panels.setBottom('effects')
          }}
        >
          FX
        </button>
        <div className="track-toggles">
          {canRecord && (
            <>
              <button
                className={`track-toggle ${monitoring ? 'track-toggle-monitor' : ''}`}
                title={
                  monitoring
                    ? 'Monitoring the live input — click to stop'
                    : 'Monitor the live input through this track (use headphones)'
                }
                onClick={() => void trackInputs.toggleMonitor(track.id)}
              >
                ◉
              </button>
              <ArmToggle trackId={track.id} />
            </>
          )}
          <button
            className={`track-toggle ${track.muted ? 'track-toggle-mute' : ''}`}
            title="Mute"
            onClick={() =>
              projectStore.dispatch({ type: 'track/setMute', trackId: track.id, muted: !track.muted })
            }
          >
            M
          </button>
          <button
            className={`track-toggle ${track.soloed ? 'track-toggle-solo' : ''}`}
            title="Solo"
            onClick={() =>
              projectStore.dispatch({ type: 'track/setSolo', trackId: track.id, soloed: !track.soloed })
            }
          >
            S
          </button>
        </div>
      </div>
      )}

      {/*
        Portalled to <body>: every track header sits in its own
        `.header-cell`, which is `position: sticky` WITH a z-index and so
        opens a stacking context. Rendered in place, the menu's z-index
        would only rank it inside that one cell, leaving every track below
        it painting on top. Coordinates are already viewport-based, so
        `position: fixed` needs no adjustment out here.
      */}
      {menu &&
        createPortal(
          <div
            className="menu-panel track-context-menu"
            style={{ left: menu.x, top: menu.y }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {menuItem(
              isFolder ? 'Bus effects…' : 'Instruments & effects…',
              () => {
                selection.selectTrack(track.id)
                panels.setBottom('effects')
              },
              false
            )}
            {canRecord &&
              menuItem('Input, channels & monitoring…', () => trackInputUi.open(track.id))}
            {menuItem('Volume/pan automation', () => automationUi.toggle(track.id))}
            {menuItem('Comments…', () => commentUi.open({ kind: 'track', id: track.id }))}
            {menuItem('Show routing…', () => routingUi.open(track.id))}
            <div className="menu-sep" />
            {menuItem('Duplicate', duplicate)}
            {!isFolder &&
              (frozen
                ? menuItem('Unfreeze', () => unfreezeTrack(track.id))
                : menuItem('Freeze track', () => void freezeTrack(track.id)))}
            {menuItem('Save track preset…', () => void saveTrackPreset(track.id))}
            {menuItem('Load track preset…', () => void loadTrackPreset())}
            <div className="menu-sep" />
            {menuItem(isFolder ? 'Delete folder' : 'Delete track', () =>
              projectStore.dispatch({ type: 'track/delete', trackId: track.id })
            )}
            {hasFx && <div className="menu-note">This track has effects</div>}
          </div>,
          document.body
        )}
    </div>
  )
}

function ArmToggle({ trackId }: { trackId: string }): React.JSX.Element {
  const rec = useRecording()
  return (
    <button
      className={`track-toggle ${rec.isArmed(trackId) ? 'track-toggle-armed' : ''}`}
      title="Arm for recording"
      onClick={() => recording.toggleArm(trackId)}
    >
      ●
    </button>
  )
}
