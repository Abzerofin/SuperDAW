import { memo, useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { Track } from '@core/model/types'
import { childTracksOf } from '@core/model/types'
import { buildDuplicateTrackOp } from '@core/ops/duplicateTrack'
import { projectStore } from '@/state/projectStore'
import { useProjectSelector } from '@/state/hooks'
import { commentUi } from '@/state/commentUi'
import { automationUi } from '@/state/automationUi'
import { recording } from '@/state/recording'
import { panels } from '@/state/panels'
import { selection } from '@/state/selection'
import { collab } from '@/state/collab'
import { folderUi } from '@/state/folderUi'
import { routingUi } from '@/state/routingUi'
import { trackInputs } from '@/state/trackInputs'
import { trackInputUi } from '@/state/trackInputUi'
import {
  freezeTrack,
  groupTracksIntoFolder,
  loadTrackPreset,
  saveTrackPreset,
  selectTrackRange,
  ungroupFolder,
  unfreezeTrack
} from '@/lib/trackActions'
import { exportTrackAudio } from '@/lib/exportAudio'
import { conformTrackAudioToTempo } from '@/lib/tempoActions'
import { audioEngine } from '@/state/audioInstance'
import { CommentThread } from '../comments/CommentThread'
import { historyUi } from '@/state/historyUi'
import { TrackInputPanel } from '../track/TrackInputPanel'
import { TrackStripControls } from './TrackStripControls'

/**
 * The track header. Only the controls used constantly live on its face —
 * name, pan, volume (with a live meter), mute/solo, and record arm +
 * monitor on audio tracks. Everything else (effects, input routing,
 * automation, comments, duplicate, freeze, presets, routing, delete) sits
 * behind the ⋯ menu, which is the same menu right-click opens.
 */
export const TrackHeader = memo(function TrackHeader({
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
  // Every subscription below snapshots ONLY what this one row displays —
  // booleans and counts — so React bails out of re-rendering the other 99
  // headers when one track's state changes. At scale this is the
  // difference between 1 render and a full column repaint per toggle.
  const popoverOpen = useSyncExternalStore(
    commentUi.subscribe,
    () => commentUi.anchor?.kind === 'track' && commentUi.anchor.id === track.id
  )
  const commentCount = useProjectSelector(
    (s) =>
      Object.values(s.comments).filter(
        (c) =>
          c.parentId === null && !c.resolved && c.anchor.kind === 'track' && c.anchor.id === track.id
      ).length
  )
  const isSelected = useSyncExternalStore(selection.subscribe, () =>
    selection.isTrackSelected(track.id)
  )
  const multi = useSyncExternalStore(selection.subscribe, () => selection.selectedTrackIds.size > 1)
  // In a session, freezing does double duty: the render it bakes is also
  // what reaches collaborators who cannot run this track's plugins, so the
  // action is named for both jobs.
  const inSession = useSyncExternalStore(collab.subscribe, () => collab.mode !== 'off')
  const hasFx = useProjectSelector((s) =>
    Object.values(s.plugins).some((p) => p.trackId === track.id)
  )
  const isFolder = track.kind === 'folder'
  const frozen = track.frozenAssetId !== null
  /** Arm is for audio AND MIDI tracks; monitoring (a mic feed) audio only. */
  const canRecord = (track.kind === 'audio' || track.kind === 'midi') && !frozen
  const canMonitor = track.kind === 'audio' && !frozen
  const inputOpen = useSyncExternalStore(
    trackInputUi.subscribe,
    () => trackInputUi.trackId === track.id
  )
  const monitoring = useSyncExternalStore(trackInputs.subscribe, () =>
    trackInputs.isMonitoring(track.id)
  )
  const looping = useSyncExternalStore(audioEngine.subscribeTrackLoops, () =>
    audioEngine.isTrackLooping(track.id)
  )
  const autoOpen = useSyncExternalStore(automationUi.subscribe, () =>
    automationUi.isOpen(track.id)
  )
  const collapsed = useSyncExternalStore(folderUi.subscribe, () => folderUi.isCollapsed(track.id))
  const childCount = useProjectSelector((s) =>
    isFolder ? childTracksOf(s, track.id).length : 0
  )

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
      data-ping-id={`track:${track.id}`}
      data-ping={`track "${track.name}"`}
      // Any interaction with a header selects its track (the Effects dock
      // follows the selection), including right-click and control clicks
      // that bubble up. Ctrl/Cmd extends the selection instead, so several
      // tracks can be gathered and acted on together.
      onPointerDown={(e) => {
        if (e.ctrlKey || e.metaKey) selection.toggleTrack(track.id)
        else if (e.shiftKey) selectTrackRange(projectStore.state, track.id)
        else selection.selectTrack(track.id)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        // Right-clicking inside a multi-selection keeps it, so the menu
        // can offer actions over the whole set.
        if (!selection.isTrackSelected(track.id)) selection.selectTrack(track.id)
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
          <button
            className="track-frozen-badge"
            title="Frozen (playing a pre-rendered bounce) — click to unfreeze and edit again"
            onClick={(e) => {
              e.stopPropagation()
              unfreezeTrack(track.id)
            }}
          >
            ❄
          </button>
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
        <span
          className="track-kind"
          title={
            track.kind === 'audio' ? 'Audio track' : track.kind === 'midi' ? 'MIDI track' : 'Folder (bus)'
          }
        >
          {track.kind === 'audio' ? 'A' : track.kind === 'midi' ? 'M' : 'F'}
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
            panels.openPanel('effects')
          }}
        >
          FX
        </button>
        <div className="track-toggles">
          <button
            className={`track-toggle ${autoOpen ? 'track-toggle-auto' : ''}`}
            title={
              autoOpen
                ? 'Hide the automation lane'
                : 'Show the automation lane (volume, pan, effects)'
            }
            onClick={() => automationUi.toggle(track.id)}
          >
            <svg width="12" height="10" viewBox="0 0 12 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
              <path d="M1 8 L4 3 L8 6 L11 2" />
            </svg>
          </button>
          {canMonitor && (
            <button
              className={`track-toggle ${monitoring ? 'track-toggle-monitor' : ''}`}
              title={
                monitoring
                  ? 'Monitoring the live input — click to stop'
                  : 'Monitor the live input through this track (use headphones)'
              }
              onClick={() => void trackInputs.toggleMonitor(track.id)}
            >
              <svg
                width="13"
                height="11"
                viewBox="0 0 13 11"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              >
                <path d="M2.6 9a5.5 5.5 0 0 1 0-7" />
                <path d="M10.4 2a5.5 5.5 0 0 1 0 7" />
                <circle cx="6.5" cy="5.5" r="1.4" fill="currentColor" stroke="none" />
              </svg>
            </button>
          )}
          {canRecord && <ArmToggle trackId={track.id} />}
          {!isFolder && (
            <button
              className={`track-toggle ${looping ? 'track-toggle-loop' : ''}`}
              title={
                looping
                  ? 'Track loop ON — this track repeats its material while the rest plays on (L)'
                  : 'Loop this track: repeat its material while the rest of the song plays on — for working out melodies (L)'
              }
              disabled={frozen}
              onClick={() => audioEngine.setTrackLoop(track.id, !looping)}
            >
              ↻
            </button>
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
                panels.openPanel('effects')
              },
              false
            )}
            {canMonitor &&
              menuItem('Input, channels & monitoring…', () => trackInputUi.open(track.id))}
            {track.kind === 'midi' &&
              !frozen &&
              menuItem('MIDI input & channel…', () => trackInputUi.open(track.id))}
            {track.kind === 'audio' &&
              !frozen &&
              menuItem('Stretch audio to tempo', () => conformTrackAudioToTempo(track.id))}
            {menuItem('Automation (volume, pan, effects)', () => automationUi.toggle(track.id))}
            {menuItem('Comments…', () => commentUi.open({ kind: 'track', id: track.id }))}
            {menuItem('Show routing…', () => routingUi.open(track.id))}
            <div className="menu-sep" />
            {multi &&
              menuItem(`Group ${selection.selectedTrackIds.size} tracks into a folder`, () =>
                groupTracksIntoFolder([...selection.selectedTrackIds])
              )}
            {!multi && menuItem('Group into a folder', () => groupTracksIntoFolder([track.id]))}
            {isFolder &&
              menuItem('Ungroup (keep the tracks)', () => ungroupFolder(track.id))}
            {menuItem('Duplicate', duplicate)}
            {!isFolder &&
              (frozen
                ? menuItem('Unfreeze', () => unfreezeTrack(track.id))
                : menuItem(inSession ? 'Freeze/Sync' : 'Freeze', () =>
                    void freezeTrack(track.id)
                  ))}
            {menuItem('Export track as WAV…', () => void exportTrackAudio(track.id, 'wav'))}
            {menuItem('Export track as MP3…', () => void exportTrackAudio(track.id, 'mp3'))}
            {menuItem('Save track preset…', () => void saveTrackPreset(track.id))}
            {menuItem('Load track preset…', () => void loadTrackPreset())}
            <div className="menu-sep" />
            {menuItem(isFolder ? 'Delete folder' : 'Delete track', () =>
              projectStore.dispatch({ type: 'track/delete', trackId: track.id })
            )}
            <div className="menu-sep" />
            {menuItem('History…', () =>
              historyUi.open({
                kind: 'track',
                id: track.id,
                title: track.name,
                x: menu.x,
                y: menu.y
              })
            )}
            {hasFx && <div className="menu-note">This track has effects</div>}
          </div>,
          document.body
        )}
    </div>
  )
})

function ArmToggle({ trackId }: { trackId: string }): React.JSX.Element {
  const armed = useSyncExternalStore(recording.subscribe, () => recording.isArmed(trackId))
  return (
    <button
      className={`track-toggle ${armed ? 'track-toggle-armed' : ''}`}
      title="Arm for recording"
      onClick={() => recording.toggleArm(trackId)}
    >
      ●
    </button>
  )
}
