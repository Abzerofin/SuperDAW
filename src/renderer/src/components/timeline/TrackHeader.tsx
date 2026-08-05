import { useState } from 'react'
import type { Track } from '@core/model/types'
import { projectStore } from '@/state/projectStore'
import { useProjectState } from '@/state/hooks'
import { commentUi, useCommentUi } from '@/state/commentUi'
import { automationUi, useAutomationUi } from '@/state/automationUi'
import { recording, useRecording } from '@/state/recording'
import { fxUi, useFxUi } from '@/state/fxUi'
import { CommentThread } from '../comments/CommentThread'
import { FxPanel } from '../fx/FxPanel'

export function TrackHeader({ track }: { track: Track }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const openAnchor = useCommentUi().anchor
  const comments = useProjectState().comments
  const commentCount = Object.values(comments).filter(
    (c) => c.parentId === null && !c.resolved && c.anchor.kind === 'track' && c.anchor.id === track.id
  ).length
  const popoverOpen = openAnchor?.kind === 'track' && openAnchor.id === track.id
  const fxOpen = useFxUi().trackId === track.id
  const hasFx = Object.values(useProjectState().plugins).some((p) => p.trackId === track.id)

  const commit = (): void => {
    setEditing(false)
    const trimmed = name.trim()
    if (trimmed && trimmed !== track.name) {
      projectStore.dispatch({ type: 'track/rename', trackId: track.id, name: trimmed })
    }
  }

  return (
    <div className="track-header" style={{ borderLeftColor: track.color }}>
      <div className="track-header-top">
        {editing ? (
          <input
            className="track-name-input"
            autoFocus
            value={name}
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
            title="Double-click to rename"
            onDoubleClick={() => {
              setName(track.name)
              setEditing(true)
            }}
          >
            {track.name}
          </span>
        )}
        <button
          className={`track-comment ${commentCount > 0 ? 'track-comment-active' : ''}`}
          title="Comments"
          onClick={() => commentUi.open({ kind: 'track', id: track.id })}
        >
          {commentCount > 0 ? commentCount : '🗨'}
        </button>
        <button
          className="track-delete"
          title="Delete track"
          onClick={() => projectStore.dispatch({ type: 'track/delete', trackId: track.id })}
        >
          ×
        </button>
      </div>
      {popoverOpen && (
        <div className="comment-layer-anchor track-comment-popover">
          <CommentThread anchor={{ kind: 'track', id: track.id }} />
        </div>
      )}
      {fxOpen && (
        <div className="comment-layer-anchor track-comment-popover">
          <FxPanel track={track} />
        </div>
      )}
      <div className="track-header-bottom">
        <span className="track-kind">{track.kind === 'audio' ? 'AUDIO' : 'MIDI'}</span>
        <button
          className={`track-toggle track-fx ${hasFx || track.kind === 'midi' ? 'track-fx-has' : ''} ${
            fxOpen ? 'track-toggle-auto' : ''
          }`}
          title="Instruments & effects"
          onClick={() => fxUi.toggle(track.id)}
        >
          FX
        </button>
        <div className="track-toggles">
          {track.kind === 'audio' && <ArmToggle trackId={track.id} />}
          <AutomationToggle trackId={track.id} />
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

function AutomationToggle({ trackId }: { trackId: string }): React.JSX.Element {
  const autoUi = useAutomationUi()
  return (
    <button
      className={`track-toggle ${autoUi.isOpen(trackId) ? 'track-toggle-auto' : ''}`}
      title="Volume automation"
      onClick={() => automationUi.toggle(trackId)}
    >
      A
    </button>
  )
}
