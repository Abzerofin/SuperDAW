import type { PluginInstance } from '@core/model/types'
import type { IAudioBackend } from './backend'
import type { PluginNodes, PluginProvider } from './pluginRegistry'

/**
 * An external-format plugin (VST3) as an ordinary insert — the same
 * builder shape the builtins use (src/audio/effects.ts): one `create` that
 * mints backend nodes, an `apply` that pushes params into them, and a
 * `dispose` that owns everything it made. The engine wires it exactly like
 * any other insert and never learns which kind it got.
 *
 * The difference is where the DSP runs. `backend.externalPlugins` exists
 * only on the native backend, whose audio process also hosts vst3host, so
 * the plugin is processed INSIDE the callback. On every other backend
 * (Web Audio, and therefore the browser build and every offline render)
 * the capability is null, `create` returns null, and the engine bypasses
 * the insert exactly as it does a missing plugin — which is what leaves
 * the freeze / windowed-preview route intact there.
 *
 * Minted PER INSTANCE rather than registered in the PluginRegistry: an
 * external plugin needs the instance's opaque `stateBlob` at open time,
 * and the registry deliberately answers "can this descriptor join the
 * RENDERER's graph" — which for a VST3 is still no. Keeping that answer
 * unchanged is what keeps freeze, mixdown and the export bypass notice
 * honest.
 */
export function externalInsertProvider(instance: PluginInstance): PluginProvider {
  return {
    descriptor: instance.descriptor,
    create(backend: IAudioBackend): PluginNodes | null {
      const external = backend.externalPlugins
      if (!external) return null
      const node = external.create({
        uid: instance.descriptor.uid,
        stateBlob: instance.stateBlob
      })
      // Only send what changed: apply() runs on every chain rewire and on
      // the 50 ms insert-automation tick, and a plugin with 150
      // parameters does not need all of them re-sent 20 times a second.
      let sent: Record<string, number> = {}
      return {
        input: node,
        output: node,
        apply(params) {
          const changed: Record<string, number> = {}
          let any = false
          for (const [key, value] of Object.entries(params)) {
            if (sent[key] === value) continue
            changed[key] = value
            any = true
          }
          if (!any) return
          sent = { ...sent, ...changed }
          external.setParams(node, changed)
        },
        // Null while the plugin has not answered yet (it has to load
        // first): unknown latency compensates as none, and the recompute
        // that the answer triggers puts it right.
        latencySamples: () => external.latencySamples(node) ?? 0,
        dispose() {
          backend.disposeNode(node)
        }
      }
    }
  }
}
