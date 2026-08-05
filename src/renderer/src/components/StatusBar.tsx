import { useState } from 'react'
import { projectStore } from '@/state/projectStore'
import { useProjectState } from '@/state/hooks'
import { useSessionFile } from '@/state/sessionFile'

export function StatusBar(): React.JSX.Element {
  const state = useProjectState()
  const { path, dirty } = useSessionFile()
  const trackCount = state.trackOrder.length
  const clipCount = Object.keys(state.clips).length
  const fileLabel = path ? path.split(/[\\/]/).pop() : 'not saved'

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        <span className="statusbar-project">
          <ProjectName name={state.name} />
          {dirty && <span className="statusbar-dirty" title="Unsaved changes" />}
        </span>
        <span className="statusbar-dim">Local project · {fileLabel}</span>
      </div>
      <div className="statusbar-hint statusbar-dim">
        Drop audio or .mid files on a track · Double-click a lane to add a clip · Double-click a
        MIDI clip to edit notes · Right-click a clip for colors
      </div>
      <div className="statusbar-right statusbar-dim mono">
        {trackCount} tracks · {clipCount} clips
      </div>
    </div>
  )
}

function ProjectName({ name }: { name: string }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')

  const commit = (): void => {
    setEditing(false)
    const trimmed = value.trim()
    if (trimmed && trimmed !== name) {
      projectStore.dispatch({ type: 'project/rename', name: trimmed })
    }
  }

  if (editing) {
    return (
      <input
        className="statusbar-name-input"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setEditing(false)
        }}
      />
    )
  }
  return (
    <span
      className="statusbar-name"
      title="Double-click to rename the project"
      onDoubleClick={() => {
        setValue(name)
        setEditing(true)
      }}
    >
      {name}
    </span>
  )
}
