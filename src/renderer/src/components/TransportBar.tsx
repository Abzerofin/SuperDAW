import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import { formatClock, formatPosition, type TimeSignature } from '@core/model/timebase'
import { ticksPerSecond } from '@audio/scheduling'
import { useProjectState, useCanUndo, useCanRedo } from '@/state/hooks'
import { projectStore } from '@/state/projectStore'
import { transport } from '@/state/transport'
import { timelineViewport } from '@/state/timelineViewport'
import { audioEngine } from '@/state/audioInstance'
import { useCollab, USER_COLORS } from '@/state/collab'
import { usePanels } from '@/state/panels'
import { useRecording } from '@/state/recording'
import { GRID_CHOICES, gridUi, useGridChoice, type GridChoice } from '@/state/gridUi'
import { RULER_MODES, rulerUi, useRulerMode, type RulerMode } from '@/state/rulerUi'
import {
  closeProject,
  mergeProjectFromFile,
  newProject,
  openProject,
  openRecentProject,
  saveProject
} from '@/lib/projectFile'
import { exportMixdown, exportStems } from '@/lib/exportAudio'
import { newProjectFromTemplate, saveProjectTemplate } from '@/lib/templateActions'
import { appShell } from '@/state/appShell'
import { settingsUi } from '@/state/settingsUi'
import { preferences } from '@/state/preferences'
import { sessionFile } from '@/state/sessionFile'
import { capturePointer } from '@/lib/pointer'
import { useDismiss } from '@/lib/dismiss'
import { changeTempo, tempoConformEntries } from '@/lib/tempoActions'
import { useRecentProjects } from '@/state/recentProjects'
import { APP_VERSION } from '@/lib/appVersion'
import { CollabPanel } from './CollabPanel'

export function TransportBar(): React.JSX.Element {
  const panelState = usePanels()
  const state = useProjectState()
  const canUndo = useCanUndo()
  const canRedo = useCanRedo()

  return (
    <div className="transport">
      <div className="transport-brand">
        SuperDAW
        <span className="brand-version mono">v{APP_VERSION}</span>
      </div>
      <ExitButton />
      <FileMenu />
      <button className="tbtn" title="Settings" onClick={() => settingsUi.open()}>
        Settings
      </button>

      <div className="transport-center">
        <ReturnButton />
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
        <button
          className="tbtn"
          title={canUndo ? 'Undo (Ctrl+Z)' : 'Nothing to undo'}
          disabled={!canUndo}
          onClick={() => projectStore.undo()}
        >
          ↶
        </button>
        <button
          className="tbtn"
          title={canRedo ? 'Redo (Ctrl+Y)' : 'Nothing to redo'}
          disabled={!canRedo}
          onClick={() => projectStore.redo()}
        >
          ↷
        </button>
        <button
          className={`tbtn ${panelState.isOpen('chat') ? 'tbtn-active' : ''}`}
          title="Toggle chat"
          onClick={() => panelState.togglePanel('chat')}
        >
          Chat
          {panelState.unreadChat > 0 && <span className="chat-badge chat-badge-dot" />}
        </button>
        <button
          className={`tbtn ${panelState.isOpen('activity') ? 'tbtn-active' : ''}`}
          title="Toggle activity feed"
          onClick={() => panelState.togglePanel('activity')}
        >
          Activity
          {panelState.unreadActivity > 0 && (
            <span className="chat-badge">{Math.min(panelState.unreadActivity, 99)}</span>
          )}
        </button>
        <button className="tbtn" title="Settings" onClick={() => settingsUi.open()}>
          ⚙
        </button>
      </div>
    </div>
  )
}

/**
 * Exit: back to Home. With unsaved changes it asks — Save / Save As /
 * Don't Save / Cancel — in a small anchored panel (no OS dialog). A clean
 * project just exits.
 */
function ExitButton(): React.JSX.Element {
  const [asking, setAsking] = useState(false)

  const exitAfter = async (save: 'save' | 'saveAs' | null): Promise<void> => {
    setAsking(false)
    if (save) await saveProject(save === 'saveAs')
    // If a save dialog was cancelled the project is still dirty and the
    // regular confirm safety net still applies; "Don't save" skips it —
    // the user just answered that question here.
    closeProject(save === null)
  }

  return (
    <div className="collab-anchor">
      <button
        className="tbtn"
        title="Close the project and return to Home"
        onClick={() => {
          if (sessionFile.dirty) setAsking((v) => !v)
          else closeProject()
        }}
      >
        Exit
      </button>
      {asking && (
        <div className="menu-panel tempo-ask">
          <div className="tempo-ask-title">Save changes before exiting?</div>
          <div className="tempo-ask-actions">
            <button className="corner-btn" onClick={() => void exitAfter('save')}>
              Save
            </button>
            <button className="corner-btn" onClick={() => void exitAfter('saveAs')}>
              Save As…
            </button>
            <button className="corner-btn" onClick={() => void exitAfter(null)}>
              Don&apos;t save
            </button>
            <button className="corner-btn" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Return-to-start. One button, two flavors: plain return, or return AND
 * scroll the view back with it. Right-click switches which one this is.
 */
function ReturnButton(): React.JSX.Element {
  const [followView, setFollowView] = useState(false)
  return (
    <button
      className="tbtn"
      title={
        followView
          ? 'Return to start and bring the view along · right-click for plain return'
          : 'Return to start · right-click to also bring the view along'
      }
      onClick={() => {
        transport.setPosition(0)
        if (followView) timelineViewport.scrollTo(0)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        setFollowView((v) => !v)
      }}
    >
      {followView ? '⇤' : '⏮'}
    </button>
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
          ? 'Song loop ON — playback wraps to the start at the end of the song (muted and un-soloed material does not count)'
          : 'Loop the whole song: wrap to the start when the end is reached — solo a section to cycle just that'
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
      className={`tbtn tbtn-rec ${rec.recording ? 'tbtn-rec-active' : ''} ${rec.countingIn ? 'tbtn-rec-countin' : ''}`}
      title={
        rec.armedCount === 0
          ? 'Record (R) — arm an audio or MIDI track first: ● on a track header'
          : rec.recording
            ? 'Stop recording (R)'
            : rec.countingIn
              ? 'Counting in… click to cancel'
              : 'Record (R)'
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
          <button
            className="menu-item"
            disabled={inSession}
            title={
              inSession
                ? 'Leave the session first — a new project cannot replace the document a running session is syncing'
                : undefined
            }
            onClick={() => {
              setOpen(false)
              newProject()
            }}
          >
            <span>New project</span>
            <span className="menu-shortcut mono">Ctrl+Shift+N</span>
          </button>
          <button
            className="menu-item"
            disabled={inSession}
            title={
              inSession
                ? 'Leave the session first — a new project cannot replace the document a running session is syncing'
                : 'Start a new project from a saved template: tracks, effects, routing and project settings, no content'
            }
            onClick={() => {
              setOpen(false)
              void newProjectFromTemplate()
            }}
          >
            <span>New from template…</span>
          </button>
          <button
            className="menu-item"
            disabled={inSession}
            title={
              inSession
                ? 'Leave the session first — a loaded project cannot replace the document a running session is syncing'
                : undefined
            }
            onClick={() => {
              setOpen(false)
              void openProject()
            }}
          >
            <span>Open…</span>
            <span className="menu-shortcut mono">Ctrl+O</span>
          </button>
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
          {item('Save as template…', null, () => void saveProjectTemplate())}
          <div className="menu-sep" />
          {item(
            `Export ${projectStore.state.settings.exportFormat.toUpperCase()}…`,
            null,
            () => void exportMixdown()
          )}
          {item('Export stems…', null, () => void exportStems())}
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

/** Tempos worth one click. Typing and dragging still reach everything else. */
const COMMON_TEMPOS = [60, 70, 80, 85, 90, 100, 110, 120, 124, 128, 130, 140, 150, 160, 170, 174]

/** The signatures a session actually asks for, in the order they come up. */
const COMMON_SIGNATURES: TimeSignature[] = [
  [4, 4],
  [3, 4],
  [2, 4],
  [5, 4],
  [6, 4],
  [6, 8],
  [7, 8],
  [9, 8],
  [12, 8],
  [2, 2]
]

/**
 * The ▾ beside a value field: the handful of values that account for most
 * uses, one click away. Purely a shortcut — every one of them can still be
 * typed (or, for tempo, dragged) in the field itself, and picking one runs
 * the exact same code path the field does.
 */
function QuickPick({
  title,
  options,
  columns
}: {
  title: string
  options: ReadonlyArray<{ label: string; active: boolean; pick: () => void }>
  columns: number
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  return (
    <div className="collab-anchor" ref={ref}>
      <button
        className={`quick-pick-btn ${open ? 'tbtn-active' : ''}`}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        ▾
      </button>
      {open && (
        <div
          className="menu-panel quick-pick"
          style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
        >
          {options.map((option) => (
            <button
              key={option.label}
              className={`quick-pick-item mono ${option.active ? 'quick-pick-item-on' : ''}`}
              onClick={() => {
                setOpen(false)
                option.pick()
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function TimeSignatureField({ signature }: { signature: TimeSignature }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')

  /** The one entry point for a signature change — typed or picked. */
  const setSignature = (beats: number, unit: number): void => {
    if (beats === signature[0] && unit === signature[1]) return
    // The reducer validates (drops unknown denominators, clamps beats).
    projectStore.dispatch({
      type: 'project/setTimeSignature',
      timeSignature: [beats, unit] as const
    })
  }

  const commit = (): void => {
    setEditing(false)
    const match = value.trim().match(/^(\d{1,2})\s*\/\s*(\d{1,2})$/)
    if (!match) return
    setSignature(Number(match[1]), Number(match[2]))
  }

  return (
    <div className="transport-field">
      {editing ? (
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
      ) : (
        <button
          className="transport-sig mono"
          title="Click to type the time signature · ▾ for the common ones"
          onClick={() => {
            setValue(`${signature[0]}/${signature[1]}`)
            setEditing(true)
          }}
        >
          {signature[0]}/{signature[1]}
        </button>
      )}
      <QuickPick
        title="Common time signatures"
        columns={2}
        options={COMMON_SIGNATURES.map(([beats, unit]) => ({
          label: `${beats}/${unit}`,
          active: beats === signature[0] && unit === signature[1],
          pick: () => setSignature(beats, unit)
        }))}
      />
    </div>
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

  // Click-away or Escape closes the panel like every other popover (its
  // own clicks stop propagation; the button swallows the pointerdown so a
  // toggle click doesn't close-then-reopen).
  useDismiss(open, () => setOpen(false))

  return (
    <div className="collab-anchor">
      <button
        className={`tbtn ${active ? 'tbtn-active' : ''}`}
        title="Collaboration"
        onPointerDown={(e) => e.stopPropagation()}
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
    let peak = 0
    let peakUntil = 0
    const draw = (): void => {
      const canvas = canvasRef.current
      if (canvas) {
        const g = canvas.getContext('2d')
        if (g) {
          const { width, height } = canvas
          const raw = audioEngine.meterLevel()
          level = Math.max(raw, level * 0.92)
          g.clearRect(0, 0, width, height)
          g.fillStyle = 'rgba(255, 255, 255, 0.08)'
          g.fillRect(0, 0, width, height)
          const w = Math.round(Math.min(1, level) * width)
          g.fillStyle = level > 0.98 ? '#e06c75' : level > 0.7 ? '#e0b25b' : '#6fbf73'
          g.fillRect(0, 0, w, height)
          // Peak-hold remnant: a marker holds the recent peak for a second.
          const now = performance.now()
          if (raw >= peak && raw > 0.001) {
            peak = raw
            peakUntil = now + 1000
          } else if (now >= peakUntil) {
            peak = 0
          }
          if (peak > 0) {
            g.fillStyle = peak > 0.98 ? '#e06c75' : 'rgba(255, 255, 255, 0.75)'
            g.fillRect(Math.min(width - 2, Math.round(peak * width)), 0, 2, height)
          }
        }
      }
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [])

  return <canvas ref={canvasRef} className="meter" width={72} height={8} title="Master level" />
}

/**
 * The transport counter. It reads in whatever unit the ruler is set to —
 * bars/beats, minutes:seconds or samples — so the number under the playhead
 * and the number in the transport always speak the same language.
 */
function PositionDisplay(): React.JSX.Element {
  const [, force] = useReducer((c: number) => c + 1, 0)
  useEffect(() => transport.subscribe(force), [])
  const state = useProjectState()
  const mode = useRulerMode()
  const ticks = transport.displayTicks()

  let text: string
  if (mode === 'bars') {
    text = formatPosition(ticks, state.timeSignature)
  } else {
    const seconds = Math.max(0, ticks) / ticksPerSecond(state.tempo)
    text =
      mode === 'time'
        ? formatClock(seconds)
        : Math.round(seconds * (audioEngine.contextInfo()?.sampleRate ?? 48000)).toLocaleString()
  }

  return (
    <div
      className="transport-pos mono"
      title={`Position in ${RULER_MODES.find((m) => m.value === mode)?.label ?? 'bars'} — follows the ruler`}
    >
      {text}
    </div>
  )
}

function TempoField({ tempo }: { tempo: number }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  /** A tempo waiting on the stretch-audio question (preference = ask). */
  const [pending, setPending] = useState<number | null>(null)
  const [dontAsk, setDontAsk] = useState(false)
  /** Live value while the field is being dragged (no op until release). */
  const [dragValue, setDragValue] = useState<number | null>(null)
  const dragRef = useRef<{
    originX: number
    originY: number
    origTempo: number
    value: number
    moved: boolean
  } | null>(null)

  /** The single entry point for a tempo change — text edit or drag. */
  const requestTempo = (next: number): void => {
    if (next === tempo) return
    const choice = preferences.tempoConform
    const wouldConform = tempoConformEntries(projectStore.state, tempo, next).length > 0
    if (choice === 'ask' && wouldConform) {
      setPending(next)
      setDontAsk(false)
      return
    }
    changeTempo(next, choice === 'always')
  }

  const commit = (): void => {
    setEditing(false)
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return
    requestTempo(Math.round(parsed))
  }

  const resolve = (conform: boolean): void => {
    if (pending === null) return
    // "Don't ask again" locks this answer in until changed in Settings.
    if (dontAsk) preferences.set('tempoConform', conform ? 'always' : 'never')
    changeTempo(pending, conform)
    setPending(null)
  }

  // Drag = coarse tempo control (right/up raises); a plain click still
  // opens the text editor. ONE op on release, through the same conform flow.
  const beginDrag = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    capturePointer(e)
    dragRef.current = {
      originX: e.clientX,
      originY: e.clientY,
      origTempo: tempo,
      value: tempo,
      moved: false
    }
  }
  const moveDrag = (e: React.PointerEvent): void => {
    const drag = dragRef.current
    if (!drag) return
    const dx = e.clientX - drag.originX
    const dy = drag.originY - e.clientY
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return
    drag.moved = true
    drag.value = Math.min(400, Math.max(20, drag.origTempo + Math.round((dx + dy) / 3)))
    setDragValue(drag.value)
  }
  const endDrag = (): void => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    if (drag.moved) {
      requestTempo(drag.value)
      setDragValue(null)
    } else {
      setValue(String(tempo))
      setEditing(true)
    }
  }

  return (
    <div className="collab-anchor transport-field">
      {editing ? (
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
      ) : (
        <button
          className="transport-tempo mono"
          title="Drag to change the tempo · click to type it · ▾ for common tempos"
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={() => {
            dragRef.current = null
            setDragValue(null)
          }}
        >
          {dragValue ?? tempo} BPM
        </button>
      )}
      <QuickPick
        title="Common tempos"
        columns={4}
        options={COMMON_TEMPOS.map((bpm) => ({
          label: String(bpm),
          active: bpm === tempo,
          pick: () => requestTempo(bpm)
        }))}
      />
      {pending !== null && (
        <div className="menu-panel tempo-ask">
          <div className="tempo-ask-title">
            {tempo} → {pending} BPM — stretch audio to match?
          </div>
          <p className="settings-dim">
            Stretching keeps audio filling the same bars (tape-style, pitch shifts with speed).
            Without it, audio keeps its speed and drifts off the grid.
          </p>
          <div className="tempo-ask-actions">
            <button className="corner-btn" onClick={() => resolve(true)}>
              Stretch audio
            </button>
            <button className="corner-btn" onClick={() => resolve(false)}>
              Keep audio speed
            </button>
            <button className="corner-btn" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
          <label className="tempo-ask-remember">
            <input
              type="checkbox"
              checked={dontAsk}
              onChange={(e) => setDontAsk(e.target.checked)}
            />
            Don&apos;t ask again (change any time in Settings ▸ General)
          </label>
        </div>
      )}
    </div>
  )
}
