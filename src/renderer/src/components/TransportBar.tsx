import { useEffect, useReducer, useState } from 'react'
import { formatPosition } from '@core/model/timebase'
import { useProjectState, useCanUndo, useCanRedo } from '@/state/hooks'
import { projectStore } from '@/state/projectStore'
import { transport } from '@/state/transport'

interface Props {
  activityOpen: boolean
  onToggleActivity: () => void
}

export function TransportBar({ activityOpen, onToggleActivity }: Props): React.JSX.Element {
  const state = useProjectState()
  const canUndo = useCanUndo()
  const canRedo = useCanRedo()

  return (
    <div className="transport">
      <div className="transport-brand">SuperDAW</div>

      <div className="transport-center">
        <button
          className="tbtn"
          title="Return to start"
          onClick={() => transport.setPosition(0)}
        >
          ⏮
        </button>
        <PlayButton />
        <PositionDisplay />
        <TempoField tempo={state.tempo} />
        <div className="transport-sig mono">
          {state.timeSignature[0]}/{state.timeSignature[1]}
        </div>
      </div>

      <div className="transport-right">
        <button className="tbtn" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => projectStore.undo()}>
          ↶
        </button>
        <button className="tbtn" title="Redo (Ctrl+Y)" disabled={!canRedo} onClick={() => projectStore.redo()}>
          ↷
        </button>
        <button
          className={`tbtn ${activityOpen ? 'tbtn-active' : ''}`}
          title="Toggle activity feed"
          onClick={onToggleActivity}
        >
          Activity
        </button>
      </div>
    </div>
  )
}

function PlayButton(): React.JSX.Element {
  const [, force] = useReducer((c: number) => c + 1, 0)
  useEffect(() => transport.subscribe(force), [])
  return (
    <button
      className={`tbtn tbtn-play ${transport.isPlaying ? 'tbtn-active' : ''}`}
      title="Play/Stop (Space)"
      onClick={() => transport.toggle()}
    >
      {transport.isPlaying ? '■' : '▶'}
    </button>
  )
}

function PositionDisplay(): React.JSX.Element {
  const [, force] = useReducer((c: number) => c + 1, 0)
  useEffect(() => transport.subscribe(force), [])
  const sig = useProjectState().timeSignature
  return <div className="transport-pos mono">{formatPosition(transport.positionTicks(), sig)}</div>
}

function TempoField({ tempo }: { tempo: number }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')

  const commit = (): void => {
    setEditing(false)
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed !== tempo) {
      projectStore.dispatch({ type: 'project/setTempo', tempo: Math.round(parsed) })
    }
  }

  if (editing) {
    return (
      <input
        className="transport-tempo-input mono"
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
    <button
      className="transport-tempo mono"
      title="Click to edit tempo"
      onClick={() => {
        setValue(String(tempo))
        setEditing(true)
      }}
    >
      {tempo} BPM
    </button>
  )
}
