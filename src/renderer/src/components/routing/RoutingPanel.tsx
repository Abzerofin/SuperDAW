import { useEffect } from 'react'
import type { Track } from '@core/model/types'
import {
  automationOf,
  childTracksOf,
  clipsOfTrack,
  notesOfClip,
  pluginsOfTrack
} from '@core/model/types'
import { pluginRegistry } from '@audio/pluginRegistry'
import { useProjectState } from '@/state/hooks'
import { usePluginRegistry } from '@/state/pluginRegistryHook'
import { routingUi, useRoutingUi } from '@/state/routingUi'

/**
 * Read-only routing visualizer: one track's actual signal path, derived
 * live from the document + the local plugin registry (never stored). The
 * chain mirrors the real audio graph — sources → inserts → automation →
 * fader → pan → folder buses → master — so what you see is what the
 * engine wired. Future sends/returns surface here.
 */
export function RoutingPanel(): React.JSX.Element | null {
  const ui = useRoutingUi()
  const state = useProjectState()
  usePluginRegistry()

  useEffect(() => {
    if (ui.trackId === null) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') routingUi.close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [ui.trackId])

  const track = ui.trackId !== null ? state.tracks[ui.trackId] : undefined
  if (!track) return null

  const clips = clipsOfTrack(state, track.id)
  const noteCount = clips.reduce((n, c) => n + notesOfClip(state, c.id).length, 0)
  const inserts = pluginsOfTrack(state, track.id)
  const volPoints = automationOf(state, track.id, 'volume').length
  const panPoints = automationOf(state, track.id, 'pan').length
  const frozen = track.frozenAssetId !== null

  // Bus path up to master.
  const busPath: Track[] = []
  let parent = track.parentId
  while (parent !== null) {
    const bus = state.tracks[parent]
    if (!bus || busPath.includes(bus)) break
    busPath.push(bus)
    parent = bus.parentId
  }

  const gainToDb = (gain: number): string => {
    if (gain <= 0.0001) return '-∞ dB'
    const db = 20 * Math.log10(gain)
    return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`
  }
  const panLabel =
    Math.abs(track.pan) < 0.01
      ? 'C'
      : `${Math.round(Math.abs(track.pan) * 100)}${track.pan < 0 ? 'L' : 'R'}`

  const node = (title: string, detail?: string, tone?: 'muted' | 'frozen'): React.JSX.Element => (
    <div key={title + (detail ?? '')} className={`routing-node ${tone ? `routing-node-${tone}` : ''}`}>
      <span className="routing-node-title">{title}</span>
      {detail && <span className="routing-node-detail">{detail}</span>}
    </div>
  )

  const nodes: React.JSX.Element[] = []
  if (track.kind === 'folder') {
    const children = childTracksOf(state, track.id)
    nodes.push(
      node(
        'Bus input',
        children.length > 0
          ? `receives ${children.map((c) => c.name).join(', ')}`
          : 'no tracks routed here yet — drag tracks into this folder'
      )
    )
  } else if (frozen) {
    nodes.push(node('Frozen render', 'clips, notes, inserts & volume automation baked', 'frozen'))
  } else {
    nodes.push(
      track.kind === 'audio'
        ? node('Clips', `${clips.length} audio clip${clips.length === 1 ? '' : 's'}`)
        : node('Built-in synth', `${noteCount} note${noteCount === 1 ? '' : 's'} in ${clips.length} clip${clips.length === 1 ? '' : 's'}`)
    )
  }
  if (!frozen) {
    for (const instance of inserts) {
      const status = pluginRegistry.status(instance.descriptor)
      nodes.push(
        node(
          instance.descriptor.name,
          `${instance.enabled ? status : 'bypassed'}${status !== 'local' ? ' — bypassed here' : ''}`,
          instance.enabled && status === 'local' ? undefined : 'muted'
        )
      )
    }
    nodes.push(node('Volume automation', volPoints > 0 ? `${volPoints} points` : 'none (unity)', volPoints > 0 ? undefined : 'muted'))
  }
  nodes.push(node('Fader', `${gainToDb(track.volume)}${track.muted ? ' · MUTED' : ''}${track.soloed ? ' · SOLO' : ''}`))
  nodes.push(node('Pan', panPoints > 0 ? `automated (${panPoints} points)` : panLabel))
  for (const bus of busPath) nodes.push(node(`Bus: ${bus.name}`, `folder${bus.muted ? ' · MUTED' : ''}`))
  nodes.push(node('Master', 'main output'))

  return (
    <div className="routing-backdrop" onPointerDown={() => routingUi.close()}>
      <div className="routing-panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="routing-head">
          <span className="routing-title" style={{ color: track.color }}>
            {track.name}
          </span>
          <span className="routing-sub">signal path</span>
          <button className="settings-close" title="Close (Esc)" onClick={() => routingUi.close()}>
            ×
          </button>
        </div>
        <div className="routing-flow">
          {nodes.map((n, i) => (
            <div key={i} className="routing-step">
              {i > 0 && <div className="routing-arrow">↓</div>}
              {n}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
