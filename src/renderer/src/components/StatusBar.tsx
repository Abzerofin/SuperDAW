import { useEffect, useRef, useState } from 'react'
import type { ProjectState } from '@core/model/types'
import { pluginManifest } from '@core/plugins/manifest'
import { pluginRegistry } from '@audio/pluginRegistry'
import { projectStore } from '@/state/projectStore'
import { useProjectState } from '@/state/hooks'
import { usePluginRegistry } from '@/state/pluginRegistryHook'
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
        <PluginManifestStatus state={state} />
      </div>
    </div>
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
  const missing = entries.filter((e) => pluginRegistry.status(e.descriptor) !== 'local').length

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
