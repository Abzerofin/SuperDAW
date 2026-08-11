import type { PluginInstance } from '@core/model/types'
import type { PluginRuntimeStatus } from '@core/plugins/descriptor'
import { pluginSearchUrl } from '@core/plugins/descriptor'
import { isNormalizedParam, paramDefsOf } from '@core/plugins/builtin'
import { projectStore } from '@/state/projectStore'
import { useFxUi } from '@/state/fxUi'
import { collab, useCollab } from '@/state/collab'
import { ParamSlider } from './ParamSlider'

/**
 * Rendered in place of a plugin's controls when the plugin can't run on
 * this client. The instance stays fully intact in the document (params,
 * chunk state, rank) — the moment a matching provider registers, the
 * placeholder is swapped for live controls with zero reconstruction.
 *
 * PARAMETER EDITING WITHOUT THE PLUGIN: the descriptor carries a snapshot
 * of the plugin's param defs (captured on the machine that added it), and
 * the reducer clamps `plugin/setParam` against those defs alone — never
 * against local availability. So a client WITHOUT the plugin computes
 * exactly the state a client with it computes, and the latter's engine
 * pushes the synced value into its live nodes. The controls below are
 * therefore ordinary document edits: you change shared project data, and
 * the sound follows on whichever machines can actually run the plugin.
 *
 * Whoever HAS the plugin never lands here — they get the full insert
 * controls — so this path is only ever the not-installed case, which is
 * exactly the case Settings ▸ Collaboration can withdraw.
 *
 * Deliberately no live preview — there are no local nodes to push a value
 * into, so a drag commits on release like any other one-gesture-one-op
 * edit. 'proxy' stays read-only: a pre-rendered proxy cannot answer to
 * param changes, so offering knobs there would be a lie about what you
 * hear.
 */

const STATUS_LABELS: Record<PluginRuntimeStatus, string> = {
  local: 'Installed',
  offline: 'Previews with ~2s latency — freeze for exact playback',
  remote: 'Streaming from collaborator',
  proxy: 'Playing rendered proxy',
  missing: 'Not installed — audio bypassed'
}

/** Shown instead of the bare status when the controls below are live. */
const EDITABLE_LABELS: Partial<Record<PluginRuntimeStatus, string>> = {
  remote: 'Streaming from a collaborator — these controls change it on their machine',
  missing: 'Not installed here — these controls change it wherever it runs'
}

export function PluginPlaceholder({
  instance,
  status
}: {
  instance: PluginInstance
  status: PluginRuntimeStatus
}): React.JSX.Element {
  const fxCollapse = useFxUi()
  useCollab() // a peer's policy can withdraw the controls mid-session
  const collapsed = fxCollapse.isCollapsed(instance.id)
  const d = instance.descriptor
  // No defs = nothing trustworthy to draw (an external plugin added before
  // snapshots, or an unknown builtin uid). Better a bare card than sliders
  // with invented ranges.
  const defs = status === 'proxy' ? null : paramDefsOf(d)
  const entries = defs ? Object.entries(defs) : []
  const permitted = collab.paramEditsPermitted()
  const editable = entries.length > 0 && permitted

  return (
    <div className="fx-section fx-placeholder">
      <div className="fx-section-head">
        <span className={`fx-status-dot fx-status-${status}`} title={STATUS_LABELS[status]} />
        <span className="fx-section-title">{d.name}</span>
        {editable && (
          <button
            className="fx-collapse"
            title={collapsed ? 'Expand' : 'Collapse to just the header'}
            onClick={() => fxCollapse.toggleCollapsed(instance.id)}
          >
            {collapsed ? '▸' : '▾'}
          </button>
        )}
        <button
          className="fx-remove"
          title="Remove plugin"
          onClick={() => projectStore.dispatch({ type: 'plugin/remove', instanceId: instance.id })}
        >
          ×
        </button>
      </div>
      <div className="fx-placeholder-meta statusbar-dim">
        {d.vendor} · {d.format.toUpperCase()} {d.version}
      </div>
      <div className="fx-placeholder-status">
        {entries.length > 0 && !permitted
          ? 'Its owner has limited adjustment to people who have this plugin'
          : (editable && EDITABLE_LABELS[status]) || STATUS_LABELS[status]}
      </div>
      {editable && !collapsed && (
        // Scrolls rather than growing: an external plugin's snapshot can
        // carry dozens of params, and the rack is a fixed-height row.
        <div className="fx-placeholder-params">
          {entries.map(([key, paramDef]) => (
            <ParamSlider
              key={key}
              def={paramDef}
              value={instance.params[key] ?? paramDef.default}
              percent={isNormalizedParam(d, paramDef)}
              onCommit={(v) =>
                projectStore.dispatch({
                  type: 'plugin/setParam',
                  instanceId: instance.id,
                  param: key,
                  value: v
                })
              }
            />
          ))}
        </div>
      )}
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
