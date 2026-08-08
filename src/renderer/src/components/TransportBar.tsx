import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import { formatPosition, type TimeSignature } from '@core/model/timebase'
import { useProjectState, useCanUndo, useCanRedo } from '@/state/hooks'
import { projectStore } from '@/state/projectStore'
import { transport } from '@/state/transport'
import { audioEngine } from '@/state/audioInstance'
import { useCollab, USER_COLORS } from '@/state/collab'
import { usePanels } from '@/state/panels'
import { useRecording } from '@/state/recording'
import { GRID_CHOICES, gridUi, useGridChoice, type GridChoice } from '@/state/gridUi'
import { RULER_MODES, rulerUi, useRulerMode, type RulerMode } from '@/state/rulerUi'
import {
  closeProject,
  exportWav,
  mergeProjectFromFile,
  newProject,
  openProject,
  openRecentProject,
  saveProject
} from '@/lib/projectFile'
import { appShell } from '@/state/appShell'
import { settingsUi } from '@/state/settingsUi'
import { useRecentProjects } from '@/state/recentProjects'
import { CollabPanel } from './CollabPanel'

export function TransportBar(): React.JSX.Element {
  const panelState = usePanels()
  const state = useProjectState()
  const canUndo = useCanUndo()
  const canRedo = useCanRedo()

  return (
    <div className="transport">
      <div className="transport-brand">SuperDAW</div>
      <FileMenu />

      <div className="transport-center">
        <button
          className="tbtn"
          title="Return to start"
          onClick={() => transport.setPosition(0)}
        >
          ⏮
        </button>
        <PlayButton />
        <StopButton />
        <RecordButton />
        <SongLoopButton />
        <PositionDisplay />
        <TempoField tempo={state.tempo} />
        <TimeSignatureField signature={state.timeSignature} />
        <MetronomeButton />
        <LoopButton />
        <GridSelect />
        <RulerSelect />
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
        <button className="tbtn" title="Settings" onClick={() => settingsUi.open()}>
          ⚙
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
      title="Play / stop and return (Space) · Shift+Space stops at the beginning"
      onClick={() => transport.toggleReturn()}
    >
      ▶
    </button>
  )
}

function StopButton(): React.JSX.Element {
  const [, force] = useReducer((c: number) => c + 1, 0)
  useEffect(() => transport.subscribe(force), [])
  return (
    <button
      className="tbtn"
      title="Stop and return to where play began · press again for the song start"
      onClick={() => transport.stopReturn()}
    >
      ■
    </button>
  )
}

function SongLoopButton(): React.JSX.Element {
  const [, force] = useReducer((c: number) => c + 1, 0)
  useEffect(() => transport.subscribe(force), [])
  const on = transport.songLoopEnabled
  return (
    <button
      className={`tbtn ${on ? 'tbtn-active' : ''}`}
      title={
        on
          ? 'Song loop ON — playback wraps to the start at the end of the song'
          : 'Loop the whole song: wrap to the start when the end is reached'
      }
      onClick={() => transport.setSongLoop(!on)}
    >
      ⟲
    </button>
  )
}

function RecordButton(): React.JSX.Element {
  const rec = useRecording()
  return (
    <button
      className={`tbtn tbtn-rec ${rec.recording ? 'tbtn-rec-active' : ''}`}
      title={
        rec.armedCount === 0
          ? 'Record (arm a track first: ● on a track header)'
          : rec.recording
            ? 'Stop recording'
            : 'Record'
      }
      onClick={() => void rec.toggle()}
    >
      ●
    </button>
  )
}

function FileMenu(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [recentsOpen, setRecentsOpen] = useState(false)
  const recents = useRecentProjects()
  const inSession = useCollab().mode !== 'off'
  const ref = useRef<HTMLDivElement>(null)

  // Any click outside the menu closes it.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  useEffect(() => {
    if (!open) setRecentsOpen(false)
  }, [open])

  const item = (label: string, shortcut: string | null, action: () => void): React.JSX.Element => (
    <button
      className="menu-item"
      onClick={() => {
        setOpen(false)
        action()
      }}
    >
      <span>{label}</span>
      {shortcut && <span className="menu-shortcut mono">{shortcut}</span>}
    </button>
  )

  return (
    <div className="collab-anchor" ref={ref}>
      <button className={`tbtn ${open ? 'tbtn-active' : ''}`} onClick={() => setOpen((v) => !v)}>
        File
      </button>
      {open && (
        <div className="menu-panel">
          {item('New project', 'Ctrl+Shift+N', () => newProject())}
          {item('Open…', 'Ctrl+O', () => void openProject())}
          <button
            className="menu-item"
            disabled={recents.length === 0}
            onClick={() => setRecentsOpen((v) => !v)}
          >
            <span>Open recent</span>
            <span className="menu-shortcut mono">{recentsOpen ? '▾' : '▸'}</span>
          </button>
          {recentsOpen &&
            recents.slice(0, 8).map((entry) => (
              <button
                key={(entry.path ?? '') + entry.name}
                className="menu-item menu-item-sub"
                title={entry.path ?? undefined}
                onClick={() => {
                  setOpen(false)
                  void openRecentProject(entry)
                }}
              >
                <span>{entry.name}</span>
              </button>
            ))}
          <button
            className="menu-item"
            disabled={inSession}
            title={
              inSession
                ? 'Leave the session first — live collaboration already syncs everyone'
                : 'Combine a saved copy of this project: every change lands at whichever copy touched it last'
            }
            onClick={() => {
              setOpen(false)
              void mergeProjectFromFile()
            }}
          >
            <span>Merge from copy…</span>
          </button>
          <div className="menu-sep" />
          {item('Save', 'Ctrl+S', () => void saveProject())}
          {item('Save as…', 'Ctrl+Shift+S', () => void saveProject(true))}
          <div className="menu-sep" />
          {item('Export WAV…', null, () => void exportWav())}
          <div className="menu-sep" />
          {item('Close project', null, () => closeProject())}
          {item('Return to Home', null, () => appShell.goHome())}
        </div>
      )}
    </div>
  )
}

function RulerSelect(): React.JSX.Element {
  const mode = useRulerMode()
  return (
    <select
      className="transport-grid"
      title="Timeline ruler: bars/beats, minutes:seconds, or samples"
      value={mode}
      onChange={(e) => rulerUi.set(e.target.value as RulerMode)}
    >
      {RULER_MODES.map((m) => (
        <option key={m.value} value={m.value}>
          Ruler: {m.label}
        </option>
      ))}
    </select>
  )
}

function GridSelect(): React.JSX.Element {
  const choice = useGridChoice()
  return (
    <select
      className="transport-grid"
      title="Timeline snap grid"
      value={choice}
      onChange={(e) => gridUi.set(e.target.value as GridChoice)}
    >
      {GRID_CHOICES.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </select>
  )
}

function TimeSignatureField({ signature }: { signature: TimeSignature }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')

  const commit = (): void => {
    setEditing(false)
    const match = value.trim().match(/^(\d{1,2})\s*\/\s*(\d{1,2})$/)
    if (!match) return
    const beats = Number(match[1])
    const unit = Number(match[2])
    if (beats === signature[0] && unit === signature[1]) return
    // The reducer validates (drops unknown denominators, clamps beats).
    projectStore.dispatch({
      type: 'project/setTimeSignature',
      timeSignature: [beats, unit] as const
    })
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
      className="transport-sig mono"
      title="Click to edit the time signature"
      onClick={() => {
        setValue(`${signature[0]}/${signature[1]}`)
        setEditing(true)
      }}
    >
      {signature[0]}/{signature[1]}
    </button>
  )
}

function CollabButton(): React.JSX.Element {
  const collab = useCollab()
  const [open, setOpen] = useState(false)
  const active = collab.mode !== 'off'

  // The home screen's "Join Collaboration" lands here with the panel open.
  useEffect(() => {
    if (appShell.consumeCollabIntent()) setOpen(true)
  }, [])

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

/**
 * Cycle playback on/off. The region itself is dragged out on the timeline
 * ruler; with none set the button explains how to make one.
 */
function LoopButton(): React.JSX.Element {
  const [, force] = useReducer((c: number) => c + 1, 0)
  useEffect(() => transport.subscribe(force), [])
  const region = transport.loopRegion
  return (
    <button
      className={`tbtn ${transport.loopEnabled && region ? 'tbtn-active' : ''}`}
      disabled={!region}
      title={
        region
          ? 'Loop the selected region (drag the top of the ruler to change it)'
          : 'Drag across the top of the timeline ruler to set a loop region'
      }
      onClick={() => transport.setLoopEnabled(!transport.loopEnabled)}
    >
      ⟳
    </button>
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
