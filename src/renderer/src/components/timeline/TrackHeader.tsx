import { memo, useState, useSyncExternalStore } from 'react'
import type { Track } from '@core/model/types'
import {
  childTracksOf,
  isNoteTrackKind,
  TRACK_KIND_BADGES,
  TRACK_KIND_LABELS
} from '@core/model/types'
import { projectStore } from '@/state/projectStore'
import { useProjectSelector } from '@/state/hooks'
import { commentUi } from '@/state/commentUi'
import { automationUi } from '@/state/automationUi'
import { recording } from '@/state/recording'
import { panels } from '@/state/panels'
import { selection } from '@/state/selection'
import { folderUi } from '@/state/folderUi'
import { trackInputs } from '@/state/trackInputs'
import { trackInputUi } from '@/state/trackInputUi'
import { selectTrackRange, unfreezeTrack } from '@/lib/trackActions'
import { audioEngine } from '@/state/audioInstance'
import { CommentThread } from '../comments/CommentThread'
import { TrackInputPanel } from '../track/TrackInputPanel'
import { TrackMenu } from './TrackMenu'
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
  const hasFx = useProjectSelector((s) =>
    Object.values(s.plugins).some((p) => p.trackId === track.id)
  )
  const isFolder = track.kind === 'folder'
  const frozen = track.frozenAssetId !== null
  /** Arm is for audio AND MIDI tracks; monitoring (a mic feed) audio only. */
  const canRecord = (track.kind === 'audio' || isNoteTrackKind(track.kind)) && !frozen
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

  const commit = (): void => {
    setEditing(false)
    const trimmed = name.trim()
    if (trimmed && trimmed !== track.name) {
      projectStore.dispatch({ type: 'track/rename', trackId: track.id, name: trimmed })
    }
  }

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
          className={`track-kind track-kind-${track.kind}`}
          title={isFolder ? 'Folder (bus)' : `${TRACK_KIND_LABELS[track.kind]} track`}
        >
          {TRACK_KIND_BADGES[track.kind]}
        </span>
        <button
          className={`track-toggle track-fx ${hasFx || isNoteTrackKind(track.kind) ? 'track-fx-has' : ''}`}
          title={
            isFolder
              ? 'Bus effects (opens the Effects tab)'
              : track.kind === 'drum'
                ? 'Kit & effects — drum voices, EQ, compressor… (opens the Effects tab)'
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

      {menu && <TrackMenu track={track} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
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
