import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { Track } from '@core/model/types'
import { buildDuplicateTrackOp } from '@core/ops/duplicateTrack'
import { projectStore } from '@/state/projectStore'
import { useProjectSelector } from '@/state/hooks'
import { commentUi } from '@/state/commentUi'
import { automationUi } from '@/state/automationUi'
import { panels } from '@/state/panels'
import { selection } from '@/state/selection'
import { collab } from '@/state/collab'
import { routingUi } from '@/state/routingUi'
import { trackInputUi } from '@/state/trackInputUi'
import {
  freezeTrack,
  groupTracksIntoFolder,
  loadTrackPreset,
  saveTrackPreset,
  ungroupFolder,
  unfreezeTrack
} from '@/lib/trackActions'
import { exportTrackAudio } from '@/lib/exportAudio'
import { conformTrackAudioToTempo } from '@/lib/tempoActions'
import { contextMenuStyle } from '@/lib/contextMenu'
import { useDismiss } from '@/lib/dismiss'
import { historyUi } from '@/state/historyUi'

/**
 * THE track menu — every track action in one place, shared by the track
 * header (right-click / ⋯) and the mixer strip, so both surfaces act on a
 * track identically. Portalled to <body>: both hosts live inside stacking
 * or scroll contexts that would clip or misorder it.
 */
export function TrackMenu({
  track,
  x,
  y,
  onClose
}: {
  track: Track
  x: number
  y: number
  onClose: () => void
}): React.JSX.Element {
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
  const canMonitor = track.kind === 'audio' && !frozen

  useDismiss(true, onClose)

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
        onClose()
        action()
      }}
    >
      <span>{label}</span>
    </button>
  )

  return createPortal(
    <div
      className="menu-panel track-context-menu"
      style={contextMenuStyle(x, y, 208, 470)}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menuItem(isFolder ? 'Bus effects…' : 'Instruments & effects…', () => {
        selection.selectTrack(track.id)
        panels.openPanel('effects')
      })}
      {canMonitor && menuItem('Input, channels & monitoring…', () => trackInputUi.open(track.id))}
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
      {isFolder && menuItem('Ungroup (keep the tracks)', () => ungroupFolder(track.id))}
      {menuItem('Duplicate', duplicate)}
      {!isFolder &&
        (frozen
          ? menuItem('Unfreeze', () => unfreezeTrack(track.id))
          : menuItem(inSession ? 'Freeze/Sync' : 'Freeze', () => void freezeTrack(track.id)))}
      {menuItem('Export track as WAV…', () => void exportTrackAudio(track.id, 'wav'))}
      {menuItem('Export track as MP3…', () => void exportTrackAudio(track.id, 'mp3'))}
      {menuItem('Save track preset…', () => void saveTrackPreset(track.id))}
      {menuItem('Load track preset…', () => void loadTrackPreset())}
      <div className="menu-sep" />
      {menuItem(isFolder ? 'Delete folder' : 'Delete track', () => {
        // A deleted track must not stay "selected" — panels following the
        // selection would point at a ghost and shortcuts would no-op.
        if (selection.isTrackSelected(track.id)) selection.selectTrack(null)
        projectStore.dispatch({ type: 'track/delete', trackId: track.id })
      })}
      <div className="menu-sep" />
      {menuItem('History…', () =>
        historyUi.open({
          kind: 'track',
          id: track.id,
          title: track.name,
          x,
          y
        })
      )}
      {hasFx && <div className="menu-note">This track has effects</div>}
    </div>,
    document.body
  )
}
