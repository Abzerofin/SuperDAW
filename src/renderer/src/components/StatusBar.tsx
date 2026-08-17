import { useEffect, useReducer, useRef, useState } from 'react'
import type { ProjectState } from '@core/model/types'
import { pluginManifest } from '@core/plugins/manifest'
import { referencedAssetIds } from '@core/persistence/format'
import { pluginRegistry } from '@audio/pluginRegistry'
import { projectStore } from '@/state/projectStore'
import { useProjectState } from '@/state/hooks'
import { usePluginRegistry } from '@/state/pluginRegistryHook'
import { useSessionFile } from '@/state/sessionFile'
import { useAudioDevices } from '@/state/audioDevices'
import { useCollab } from '@/state/collab'
import { audioEngine, assetStore } from '@/state/audioInstance'
import { healthSampler } from '@/state/health'
import { statusNotice, useStatusNotice, useStatusNoticeAction } from '@/state/statusNotice'

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
      <DeviceNotice />
      <AppNotice />
      {/* Getting-started hints earn their place only while the project is
          empty; once real work exists the strip stays clean. */}
      {clipCount === 0 && (
        <div className="statusbar-hint statusbar-dim">
          Drop audio or .mid files on a track · Double-click a lane to add a clip · Double-click a
          MIDI clip to edit notes · Right-click a clip for colors
        </div>
      )}
      <div className="statusbar-right statusbar-dim mono">
        {trackCount} tracks · {clipCount} clips
        <PluginManifestStatus state={state} />
        <HealthStatus state={state} />
      </div>
    </div>
  )
}

/**
 * Project health, one glance deep: a status dot that opens a compact
 * diagnostics grid. All read-only observers (engine, event-loop lag,
 * memory, collab transfers, derived asset/plugin state); polls only while
 * the popover is open. Unobtrusive by design.
 */
function HealthStatus({ state }: { state: ProjectState }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [, force] = useReducer((c: number) => c + 1, 0)
  const rootRef = useRef<HTMLSpanElement>(null)
  const collab = useCollab()

  useEffect(() => {
    healthSampler.start()
  }, [])

  useEffect(() => {
    if (!open) return
    const timer = setInterval(force, 1000)
    const onPointerDown = (e: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      clearInterval(timer)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open])

  const referenced = [...referencedAssetIds(state)]
  const missingAssets = referenced.filter((id) => !assetStore.get(id)).length
  // Audio that IS loaded but never decoded plays silent and draws no
  // waveform while looking perfectly healthy — count it, or a project that
  // lost its audio to memory pressure reports itself fine.
  const silentAssets = referenced.filter((id) => {
    const asset = assetStore.get(id)
    return asset !== undefined && asset.kind === 'audio' && asset.buffer === null
  }).length
  const manifest = pluginManifest(state)
  // 'offline' is INSTALLED (out-of-process VST3) — only truly absent
  // plugins count as missing.
  const missingPlugins = manifest.filter(
    (e) => !['local', 'offline'].includes(pluginRegistry.status(e.descriptor))
  ).length
  const transfers = [...collab.assetProgress.values()]
  const lag = healthSampler.loopLagMs
  const warn =
    missingAssets > 0 || silentAssets > 0 || missingPlugins > 0 || lag > 50 || collab.reconnecting

  const info = audioEngine.contextInfo()
  const heap = healthSampler.heapMb
  const xruns = audioEngine.xruns()
  const row = (label: string, value: string, bad = false): React.JSX.Element => (
    <div key={label} className="health-row">
      <span>{label}</span>
      <span className={bad ? 'health-bad' : ''}>{value}</span>
    </div>
  )

  return (
    <span className="statusbar-plugins" ref={rootRef}>
      {' · '}
      <button
        className="statusbar-plugins-btn"
        title="Project health"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`health-dot ${warn ? 'health-dot-warn' : ''}`} /> health
      </button>
      {open && (
        <div className="plugin-manifest health-panel">
          {row('Main thread lag', `${lag.toFixed(1)} ms`, lag > 50)}
          {row('Memory (JS heap)', heap === null ? 'n/a' : `${heap.toFixed(0)} MB`)}
          {row('Sample rate', info ? `${info.sampleRate} Hz` : 'engine idle')}
          {row(
            'Audio latency',
            info?.baseLatencySec != null
              ? `≈ ${(info.baseLatencySec * 1000).toFixed(1)} ms (${Math.round(info.baseLatencySec * info.sampleRate)} frames)`
              : 'n/a'
          )}
          {/* Dropouts, where the backend can count them. Surfacing this
              is how a struggling buffer size shows up as a NUMBER before
              it shows up as crackles in someone's recording. */}
          {xruns !== null && row('Audio dropouts', `${xruns}`, xruns > 0)}
          {row(
            'Collaboration',
            collab.mode === 'off'
              ? 'solo'
              : `${collab.mode}${collab.reconnecting ? ' — reconnecting' : ' — connected'}`,
            collab.reconnecting
          )}
          {row(
            'Asset transfers',
            transfers.length === 0
              ? 'none pending'
              : `${transfers.length} active (${Math.round(
                  (transfers.reduce((a, t) => a + t.received, 0) /
                    Math.max(1, transfers.reduce((a, t) => a + t.total, 0))) *
                    100
                )}%)`
          )}
          {row('Missing assets', String(missingAssets), missingAssets > 0)}
          {row(
            'Undecodable audio',
            silentAssets === 0 ? 'none' : `${silentAssets} playing silent`,
            silentAssets > 0
          )}
          {row(
            'Plugin compatibility',
            manifest.length === 0
              ? 'no plugins in use'
              : missingPlugins === 0
                ? `all ${manifest.length} available`
                : `${missingPlugins} of ${manifest.length} unavailable here`,
            missingPlugins > 0
          )}
        </div>
      )}
    </span>
  )
}

/**
 * One-shot app notice (export loudness reports etc.) — same contract. A
 * notice may carry ONE action (e.g. "Stretch to fit" after a loop import);
 * running it dismisses the notice, and so does clicking the text.
 */
function AppNotice(): React.JSX.Element | null {
  const notice = useStatusNotice()
  const action = useStatusNoticeAction()
  if (!notice) return null
  return (
    <span className="statusbar-notice-group">
      <button className="statusbar-notice" title="Dismiss" onClick={() => statusNotice.dismiss()}>
        {notice}
      </button>
      {action && (
        <button
          className="statusbar-notice-action"
          onClick={() => {
            action.run()
            statusNotice.dismiss()
          }}
        >
          {action.label}
        </button>
      )}
    </span>
  )
}

/** One-shot device-loss notice (the "notify once" contract — never a popup). */
function DeviceNotice(): React.JSX.Element | null {
  const devices = useAudioDevices()
  if (!devices.notice) return null
  return (
    <button
      className="statusbar-notice"
      title="Dismiss"
      onClick={() => devices.dismissNotice()}
    >
      ⚠ {devices.notice}
    </button>
  )
}

/**
 * The plugin manifest, one glance deep: "N plugins" (with a warning tint
 * when any are unavailable here) opens a compact list of every plugin the
 * project uses, its metadata and local status. Derived live from project
 * state — never stored.
 */
function PluginManifestStatus({ state }: { state: ProjectState }): React.JSX.Element | null {
  usePluginRegistry()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  const entries = pluginManifest(state)
  if (entries.length === 0) return null
  const missing = entries.filter(
    (e) => !['local', 'offline'].includes(pluginRegistry.status(e.descriptor))
  ).length

  return (
    <span className="statusbar-plugins" ref={rootRef}>
      {' · '}
      <button
        className={`statusbar-plugins-btn ${missing > 0 ? 'statusbar-plugins-warn' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={missing > 0 ? `${missing} plugin(s) unavailable on this machine` : 'Plugins in use'}
      >
        {entries.length} plugin{entries.length === 1 ? '' : 's'}
        {missing > 0 && ` (${missing} missing)`}
      </button>
      {open && (
        <div className="plugin-manifest">
          {entries.map((entry) => {
            const status = pluginRegistry.status(entry.descriptor)
            const d = entry.descriptor
            return (
              <div key={`${d.format}:${d.uid}`} className="plugin-manifest-row">
                <span className={`fx-status-dot fx-status-${status}`} />
                <span className="plugin-manifest-name">{d.name}</span>
                <span className="statusbar-dim">
                  {d.vendor} · {d.format.toUpperCase()} {d.version} · {entry.trackIds.length}{' '}
                  track{entry.trackIds.length === 1 ? '' : 's'}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </span>
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
