import { useEffect, useState } from 'react'
import {
  addPluginFolder,
  clearPluginQuarantine,
  externalHostAvailable,
  externalPlugins,
  externalScanError,
  pluginFailures,
  pluginFolders,
  pluginLastScanMs,
  pluginScanning,
  refreshExternalPlugins,
  resetPluginFolders,
  scanExternalPlugins,
  setPluginFolders,
  subscribeExternalPlugins
} from '@/state/externalPlugins'

/**
 * Plugin scanning settings: which folders are searched, what was found,
 * and what refused to load. Scanning itself happens in the main process
 * (out of process, in fact — see src/main/pluginScan.ts); this pane only
 * drives it and reports.
 */
export function PluginsPane(): React.JSX.Element {
  // The store is plain module state, so re-render on its change signal.
  const [, force] = useState(0)
  useEffect(() => subscribeExternalPlugins(() => force((n) => n + 1)), [])
  useEffect(() => {
    void scanExternalPlugins()
  }, [])

  const available = externalHostAvailable()
  const folders = pluginFolders()
  const failures = pluginFailures()
  const plugins = externalPlugins()
  const scanning = pluginScanning()
  const error = externalScanError()
  const lastScan = pluginLastScanMs()

  const crashed = failures.filter((f) => f.crashed)

  if (!available) {
    return (
      <div className="settings-pane">
        <h2>Plugins</h2>
        <p className="settings-dim">
          VST3 hosting is desktop-only — this is the browser build. Run the app with{' '}
          <code>npm run dev</code> to scan for plugins.
        </p>
      </div>
    )
  }

  return (
    <div className="settings-pane">
      <h2>Plugins</h2>

      <div className="settings-field">
        <label>Scan folders</label>
        <div className="plugin-folders">
          {folders.length === 0 && (
            <p className="settings-dim">
              No folders configured — nothing will be scanned. Add one, or restore the defaults.
            </p>
          )}
          {folders.map((folder) => (
            <div className="plugin-folder" key={folder}>
              <span className="plugin-folder-path mono" title={folder}>
                {folder}
              </span>
              <button
                className="plugin-folder-remove"
                title="Stop scanning this folder"
                disabled={scanning}
                onClick={() => void setPluginFolders(folders.filter((f) => f !== folder))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="plugin-actions">
          <button disabled={scanning} onClick={() => void addPluginFolder()}>
            Add folder…
          </button>
          <button disabled={scanning} onClick={() => void resetPluginFolders()}>
            Restore defaults
          </button>
        </div>
        <p className="settings-dim">
          Only <code>.vst3</code> plugins are supported. Changing folders rescans immediately.
        </p>
      </div>

      <div className="settings-field">
        <label>Installed plugins</label>
        <div className="plugin-actions">
          <button
            className="plugin-refresh"
            disabled={scanning}
            onClick={() => void refreshExternalPlugins()}
          >
            {scanning ? 'Scanning…' : 'Refresh Plugins'}
          </button>
          <span className="settings-dim">
            {scanning
              ? 'Loading each plugin — this can take a moment.'
              : `${plugins.length} found${
                  lastScan === null ? '' : ` · ${new Date(lastScan).toLocaleTimeString()}`
                }`}
          </span>
        </div>
        <p className="settings-dim">
          Results are cached, so startup does not reload every plugin. Refresh re-inspects
          everything — use it after installing or updating one.
        </p>
      </div>

      {error && (
        <div className="settings-field">
          <label>Scan error</label>
          <p className="plugin-error">{error}</p>
        </div>
      )}

      {failures.length > 0 && (
        <div className="settings-field">
          <label>Could not be loaded ({failures.length})</label>
          <div className="plugin-failures">
            {failures.map((failure) => (
              <div className="plugin-failure" key={failure.path}>
                <span className="plugin-failure-name mono" title={failure.path}>
                  {failure.path.split(/[\\/]/).pop()}
                </span>
                <span className={failure.crashed ? 'plugin-failure-bad' : 'settings-dim'}>
                  {failure.crashed ? 'crashed · skipped' : failure.reason}
                </span>
              </div>
            ))}
          </div>
          <p className="settings-dim">
            These are scanned in a separate process, so a plugin that crashes cannot take the app
            down with it.
            {crashed.length > 0 && ' Crashed plugins are skipped until you refresh.'}
          </p>
          {crashed.length > 0 && (
            <div className="plugin-actions">
              <button disabled={scanning} onClick={() => void clearPluginQuarantine()}>
                Forget crashes and retry
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
