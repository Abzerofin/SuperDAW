import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import { formatPosition } from '@core/model/timebase'
import { useProjectState, useCanUndo, useCanRedo } from '@/state/hooks'
import { projectStore } from '@/state/projectStore'
import { transport } from '@/state/transport'
import { audioEngine } from '@/state/audioInstance'
import { useCollab, USER_COLORS } from '@/state/collab'
import { usePanels } from '@/state/panels'
import { usePianoRollUi } from '@/state/pianoRollUi'
import { CollabPanel } from './CollabPanel'

export function TransportBar(): React.JSX.Element {
  const panelState = usePanels()
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
        <MetronomeButton />
        <Meter />
      </div>

      <div className="transport-right">
        <CollabButton />
        <button className="tbtn" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => projectStore.undo()}>
          ↶
        </button>
        <button className="tbtn" title="Redo (Ctrl+Y)" disabled={!canRedo} onClick={() => projectStore.redo()}>
          ↷
        </button>
        <button
          className={`tbtn ${panelState.bottomPanel === 'files' ? 'tbtn-active' : ''}`}
          title="Toggle File Bay"
          onClick={() => panelState.toggleBottom('files')}
        >
          Files
        </button>
        <button
          className={`tbtn ${panelState.bottomPanel === 'mixer' ? 'tbtn-active' : ''}`}
          title="Toggle mixer"
          onClick={() => panelState.toggleBottom('mixer')}
        >
          Mixer
        </button>
        <PianoRollTab />
        <button
          className={`tbtn ${panelState.rightPanel === 'chat' ? 'tbtn-active' : ''}`}
          title="Toggle chat"
          onClick={() => panelState.toggleRight('chat')}
        >
          Chat
          {panelState.unreadChat > 0 && (
            <span className="chat-badge">{Math.min(panelState.unreadChat, 99)}</span>
          )}
        </button>
        <button
          className={`tbtn ${panelState.rightPanel === 'activity' ? 'tbtn-active' : ''}`}
          title="Toggle activity feed"
          onClick={() => panelState.toggleRight('activity')}
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

function PianoRollTab(): React.JSX.Element | null {
  const rollState = usePianoRollUi()
  const panelState = usePanels()
  if (rollState.clipId === null) return null
  return (
    <button
      className={`tbtn ${panelState.bottomPanel === 'pianoroll' ? 'tbtn-active' : ''}`}
      title="Toggle piano roll"
      onClick={() => panelState.toggleBottom('pianoroll')}
    >
      Piano
    </button>
  )
}

function CollabButton(): React.JSX.Element {
  const collab = useCollab()
  const [open, setOpen] = useState(false)
  const active = collab.mode !== 'off'

  return (
    <div className="collab-anchor">
      <button
        className={`tbtn ${active ? 'tbtn-active' : ''}`}
        title="Collaboration"
        onClick={() => setOpen((v) => !v)}
      >
        {active ? (
          <span className="collab-btn-users">
            {collab.users.slice(0, 4).map((u) => (
              <span
                key={u.userId}
                className="collab-user-dot"
                style={{ background: USER_COLORS[u.colorIndex % USER_COLORS.length] }}
              />
            ))}
            {collab.reconnecting ? '⟳' : ''}
          </span>
        ) : (
          'Collab'
        )}
      </button>
      {open && <CollabPanel onClose={() => setOpen(false)} />}
    </div>
  )
}

function MetronomeButton(): React.JSX.Element {
  const enabled = useSyncExternalStore(
    audioEngine.subscribeMetronome,
    () => audioEngine.metronomeEnabled
  )
  return (
    <button
      className={`tbtn ${enabled ? 'tbtn-active' : ''}`}
      title="Metronome"
      onClick={() => audioEngine.setMetronome(!enabled)}
    >
      ♩
    </button>
  )
}

/** Master peak meter. Idles at zero; driven by its own rAF loop with decay. */
function Meter(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let raf = 0
    let level = 0
    const draw = (): void => {
      const canvas = canvasRef.current
      if (canvas) {
        const g = canvas.getContext('2d')
        if (g) {
          const { width, height } = canvas
          level = Math.max(audioEngine.meterLevel(), level * 0.92)
          g.clearRect(0, 0, width, height)
          g.fillStyle = 'rgba(255, 255, 255, 0.08)'
          g.fillRect(0, 0, width, height)
          const w = Math.round(Math.min(1, level) * width)
          g.fillStyle = level > 0.98 ? '#e06c75' : level > 0.7 ? '#e0b25b' : '#6fbf73'
          g.fillRect(0, 0, w, height)
        }
      }
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [])

  return <canvas ref={canvasRef} className="meter" width={72} height={8} title="Master level" />
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
