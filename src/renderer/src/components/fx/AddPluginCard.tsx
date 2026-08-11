import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PluginInstance, Route, Track } from '@core/model/types'
import { routesOfTrack } from '@core/model/types'
import type { PluginDescriptor } from '@core/plugins/descriptor'
import { BUILTIN_EFFECT_DESCRIPTORS, pluginDefaults } from '@core/plugins/builtin'
import { newId } from '@core/model/ids'
import { projectStore } from '@/state/projectStore'
import {
  externalHostAvailable,
  externalParamDefs,
  externalPlugins,
  externalScanError,
  hasScanned,
  scanExternalPlugins,
  subscribeExternalPlugins,
  type ExternalPluginEntry
} from '@/state/externalPlugins'

/**
 * The "+" plugin browser: builtins and every installed VST3 effect,
 * searchable. Used as a card at the end of the rack, and (compact) as a
 * toolbar button on the routing-graph page — same browser either way.
 */
export function AddPluginCard({
  track,
  inserts,
  compact = false
}: {
  track: Track
  inserts: PluginInstance[]
  /** Render as a small toolbar button instead of a rack card. */
  compact?: boolean
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const browserRef = useRef<HTMLDivElement>(null)
  /** Where the popover anchors (viewport coords); null = closed. */
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)
  const open = anchor !== null
  const [external, setExternal] = useState(externalPlugins)

  useEffect(() => {
    const unsubscribe = subscribeExternalPlugins(() => setExternal(externalPlugins()))
    if (!hasScanned()) void scanExternalPlugins()
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!open) return
    // The popover is PORTALLED to <body> (an overflow ancestor would clip
    // it inside the dock), so "outside" means outside the card AND the
    // portalled panel.
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (!rootRef.current?.contains(target) && !browserRef.current?.contains(target)) {
        setAnchor(null)
      }
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAnchor(null)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const addPlugin = (descriptor: PluginDescriptor): void => {
    const maxRank = inserts.reduce((max, p) => Math.max(max, p.rank), 0)
    const instanceId = newId('plg')
    // Graph routing live: a node wired to nothing plays nothing, so splice
    // the new effect in series just before Mix Out — every edge into 'out'
    // is redirected through it. Rack and graph adds behave identically.
    const trackRoutes = routesOfTrack(projectStore.state, track.id)
    let wiring: { routes?: Route[]; severedRoutes?: Route[] } = {}
    if (trackRoutes.length > 0) {
      const tails = trackRoutes.filter((r) => r.to === 'out')
      const intoNew: Route[] =
        tails.length > 0
          ? tails.map((t) => ({ id: newId('rte'), trackId: track.id, from: t.from, to: instanceId }))
          : [{ id: newId('rte'), trackId: track.id, from: 'in', to: instanceId }]
      wiring = {
        routes: [...intoNew, { id: newId('rte'), trackId: track.id, from: instanceId, to: 'out' }],
        ...(tails.length > 0 ? { severedRoutes: tails } : {})
      }
    }
    projectStore.dispatch({
      type: 'plugin/add',
      instance: {
        id: instanceId,
        trackId: track.id,
        descriptor,
        enabled: true,
        rank: maxRank + 1,
        // VST3: start with NO stored params. Stored values are pushed to
        // the plugin on every processing block, so baking in the defaults
        // would permanently stomp preset/GUI state the plugin carries in
        // its own stateBlob. Only params the user actually moves belong
        // here. Builtins keep explicit defaults — their nodes read them.
        params: descriptor.format === 'vst3' ? {} : pluginDefaults(descriptor),
        stateBlob: null
      },
      ...wiring
    })
    // A new insert opens EXPANDED — you added it to work on it, so its
    // controls (and, for a VST3, its own editor) should be in front of you
    // without a second click. Collapsing remains available per card; it
    // just isn't the state you land in.
    setAnchor(null)
    setQuery('')
    // The new card lands at the END of the chain — bring it into view, or
    // on a long rack the add appears to do nothing.
    requestAnimationFrame(() => {
      const chain = rootRef.current?.closest('.fx-dock-chain')
      if (chain) chain.scrollLeft = chain.scrollWidth
    })
  }

  const addVst3 = async (plugin: ExternalPluginEntry): Promise<void> => {
    // Snapshot the plugin's parameters into the descriptor at add-time,
    // so every peer clamps identically — including peers that do not have
    // the plugin installed at all.
    const paramDefs = await externalParamDefs(plugin.uid)
    addPlugin({
      format: 'vst3',
      uid: plugin.uid,
      name: plugin.name,
      vendor: plugin.vendor,
      version: plugin.version,
      ...(paramDefs && Object.keys(paramDefs).length > 0 ? { paramDefs } : {})
    })
  }

  const q = query.trim().toLowerCase()
  const matches = (name: string, vendor = ''): boolean =>
    q === '' || name.toLowerCase().includes(q) || vendor.toLowerCase().includes(q)

  const builtins = BUILTIN_EFFECT_DESCRIPTORS.filter((d) => matches(d.name))
  // Effects only: instruments ignore audio input, and the insert chain is
  // not where they belong.
  const vst3Effects = external.filter(
    (p) => p.subCategories.startsWith('Fx') && matches(p.name, p.vendor)
  )
  const vst3Reason = !externalHostAvailable()
    ? 'VST3 · desktop app only (npm run dev)'
    : (externalScanError() ?? (external.length === 0 ? 'VST3 · no effects found' : null))

  const toggle = (e: React.MouseEvent): void => {
    if (open) {
      setAnchor(null)
      return
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setAnchor({
      // Keep the 280px panel on screen even when the + card sits at the
      // right edge of the chain.
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)),
      bottom: window.innerHeight - rect.top + 4
    })
  }

  return (
    <div className={compact ? 'fx-add-inline' : 'fx-card fx-add-card'} ref={rootRef}>
      {compact ? (
        <button className="bay-btn" title="Add an effect to this track" onClick={toggle}>
          + Add effect
        </button>
      ) : (
        <button className="fx-add-open" title="Add an effect" onClick={toggle}>
          +
        </button>
      )}
      {anchor &&
        createPortal(
          <div
            className="fx-browser"
            ref={browserRef}
            style={{ left: anchor.left, bottom: anchor.bottom }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <input
              className="fx-browser-search"
              placeholder="Search plugins… (Enter adds the top match)"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                if (builtins.length > 0) addPlugin(builtins[0])
                else if (vst3Effects.length > 0) void addVst3(vst3Effects[0])
              }}
            />
            <div className="fx-browser-list">
              {builtins.length > 0 && <div className="fx-browser-group statusbar-dim">Built-in</div>}
              {builtins.map((descriptor) => (
                <button
                  key={descriptor.uid}
                  className="fx-browser-item"
                  onClick={() => addPlugin(descriptor)}
                >
                  <span>{descriptor.name}</span>
                  <span className="statusbar-dim">SuperDAW</span>
                </button>
              ))}
              {(vst3Effects.length > 0 || vst3Reason) && (
                <div className="fx-browser-group statusbar-dim">
                  {vst3Reason ?? 'VST3 · rendered ahead during playback'}
                </div>
              )}
              {vst3Effects.map((plugin) => (
                <button
                  key={plugin.uid}
                  className="fx-browser-item"
                  title={`${plugin.vendor} · ${plugin.version}`}
                  onClick={() => void addVst3(plugin)}
                >
                  <span>{plugin.name}</span>
                  <span className="statusbar-dim">{plugin.vendor}</span>
                </button>
              ))}
              {builtins.length === 0 && vst3Effects.length === 0 && (
                <div className="bay-empty">No plugins match “{query}”</div>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
