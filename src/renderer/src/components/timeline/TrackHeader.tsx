import { useState } from 'react'
import type { Track } from '@core/model/types'
import { projectStore } from '@/state/projectStore'

export function TrackHeader({ track }: { track: Track }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')

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
          className="track-delete"
          title="Delete track"
          onClick={() => projectStore.dispatch({ type: 'track/delete', trackId: track.id })}
        >
          ×
        </button>
      </div>
      <div className="track-header-bottom">
        <span className="track-kind">{track.kind === 'audio' ? 'AUDIO' : 'MIDI'}</span>
        <div className="track-toggles">
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
