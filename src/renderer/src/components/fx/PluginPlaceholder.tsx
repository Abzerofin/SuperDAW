import type { PluginInstance } from '@core/model/types'
import type { PluginRuntimeStatus } from '@core/plugins/descriptor'
import { pluginSearchUrl } from '@core/plugins/descriptor'
import { projectStore } from '@/state/projectStore'

/**
 * Rendered in place of a plugin's controls when the plugin can't run on
 * this client. The instance stays fully intact in the document (params,
 * chunk state, rank) — the moment a matching provider registers, the
 * placeholder is swapped for live controls with zero reconstruction.
 */

const STATUS_LABELS: Record<PluginRuntimeStatus, string> = {
  local: 'Installed',
  remote: 'Streaming from collaborator',
  proxy: 'Playing rendered proxy',
  missing: 'Not installed — audio bypassed'
}

export function PluginPlaceholder({
  instance,
  status
}: {
  instance: PluginInstance
  status: PluginRuntimeStatus
}): React.JSX.Element {
  const d = instance.descriptor
  return (
    <div className="fx-section fx-placeholder">
      <div className="fx-section-head">
        <span className={`fx-status-dot fx-status-${status}`} title={STATUS_LABELS[status]} />
        <span className="fx-section-title">{d.name}</span>
        <button
          className="comment-delete fx-remove"
          title="Remove plugin"
          onClick={() => projectStore.dispatch({ type: 'plugin/remove', instanceId: instance.id })}
        >
          ×
        </button>
      </div>
      <div className="fx-placeholder-meta statusbar-dim">
        {d.vendor} · {d.format.toUpperCase()} {d.version}
      </div>
      <div className="fx-placeholder-status">{STATUS_LABELS[status]}</div>
      {status === 'missing' && (
        <a
          className="fx-placeholder-link"
          href={pluginSearchUrl(d)}
          target="_blank"
          rel="noopener noreferrer"
          title={`Find ${d.name} by ${d.vendor}`}
        >
          Find this plugin ↗
        </a>
      )}
    </div>
  )
}
