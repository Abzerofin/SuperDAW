import { useSyncExternalStore } from 'react'
import { pluginRegistry } from '@audio/pluginRegistry'

let version = 0
pluginRegistry.subscribe(() => {
  version++
})

/**
 * Re-renders when the local plugin registry changes (e.g. a plugin gets
 * installed mid-session), so placeholders transition to live controls
 * without any document change or manual refresh.
 */
export function usePluginRegistry(): number {
  return useSyncExternalStore(
    (cb) => pluginRegistry.subscribe(cb),
    () => version
  )
}
