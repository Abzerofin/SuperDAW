import { useEffect, useRef } from 'react'
import type { PluginInstance } from '@core/model/types'
import { builtinTypeOf } from '@core/plugins/builtin'
import { pluginRegistry } from '@audio/pluginRegistry'
import { useProjectState } from '@/state/hooks'
import { useFxFloatUi, fxFloatUi } from '@/state/fxFloatUi'
import { useFxUi } from '@/state/fxUi'
import { useVst3Dock } from '@/state/vst3Dock'
import { capturePointer } from '@/lib/pointer'
import { PluginSection } from './EffectsDock'

/**
 * Effect devices dragged off the Effects dock float here, above the whole
 * app. Each window is the same PluginSection the rack renders — header
 * drag moves the window instead of reordering, ⇱ racks it again. Windows
 * follow the document: an instance that disappears (remove, undo, a
 * collaborator's delete) takes its window with it.
 */
export function FloatingEffects(): React.JSX.Element | null {
  const state = useProjectState()
  const float = useFxFloatUi()
  const ids = float.ids()

  useEffect(() => {
    for (const id of ids) if (!state.plugins[id]) fxFloatUi.dock(id)
  }, [state.plugins, ids])

  const instances = ids
    .map((id) => state.plugins[id])
    .filter((p): p is PluginInstance => p !== undefined)
  if (instances.length === 0) return null
  return (
    <>
      {instances.map((instance) => (
        <FloatingEffectWindow key={instance.id} instance={instance} />
      ))}
    </>
  )
}

function FloatingEffectWindow({ instance }: { instance: PluginInstance }): React.JSX.Element {
  const float = useFxFloatUi()
  const dock = useVst3Dock()
  const collapsed = useFxUi().isCollapsed(instance.id)
  const pos = float.positionOf(instance.id) ?? { x: 80, y: 80 }
  const grabRef = useRef<{ dx: number; dy: number } | null>(null)

  const moveHandle: React.HTMLAttributes<HTMLElement> = {
    onPointerDown: (e) => {
      if (e.button !== 0) return
      // Presses on the header's own controls (power, collapse, …) stay clicks.
      if ((e.target as HTMLElement).closest('button')) return
      e.preventDefault()
      capturePointer(e)
      grabRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
    },
    onPointerMove: (e) => {
      const grab = grabRef.current
      if (!grab) return
      fxFloatUi.move(instance.id, e.clientX - grab.dx, e.clientY - grab.dy)
    },
    onPointerUp: () => {
      grabRef.current = null
    },
    onPointerCancel: () => {
      grabRef.current = null
    }
  }

  const guiMode =
    pluginRegistry.status(instance.descriptor) === 'offline' && !dock.isFailed(instance.id)
  const wide = builtinTypeOf(instance.descriptor) === 'paraeq'
  const size = collapsed ? '' : guiMode ? 'fx-float-expanded' : wide ? 'fx-float-wide' : ''
  // Keep at least the header reachable however the viewport shrinks.
  const x = Math.min(Math.max(0, pos.x), Math.max(0, window.innerWidth - 160))
  const y = Math.min(Math.max(0, pos.y), Math.max(0, window.innerHeight - 40))

  return (
    <div className={`fx-float ${size}`} style={{ left: x, top: y }}>
      <PluginSection instance={instance} dragHandle={moveHandle} floating />
    </div>
  )
}
