import type { PluginInstance, ProjectState, Route, TrackId } from './types'
import { pluginsOfTrack, routesOfTrack } from './types'

/**
 * Validation and graph math for per-track effect routing (see Route in
 * types.ts). Used by the reducer (which is the authority — every peer
 * clamps identically from document data alone), the audio layers, and the
 * graph editor UI.
 */

export type RouteEndpoint = 'in' | 'out' | string

/**
 * Whether adding `route` to `state` would be accepted by the reducer:
 * endpoints must exist on the route's own track, terminals must point the
 * right way, the edge must be new, and it must not close a cycle (Web
 * Audio forbids delay-free loops; a routing graph is a DAG here).
 */
export function routeIsValid(state: ProjectState, route: Route): boolean {
  if (!state.tracks[route.trackId]) return false
  if (route.from === 'out' || route.to === 'in') return false
  if (route.from === route.to) return false
  for (const endpoint of [route.from, route.to]) {
    if (endpoint === 'in' || endpoint === 'out') continue
    const plugin = state.plugins[endpoint]
    if (!plugin || plugin.trackId !== route.trackId) return false
  }
  for (const existing of routesOfTrack(state, route.trackId)) {
    if (existing.from === route.from && existing.to === route.to) return false
    if (existing.id === route.id) return false
  }
  return !closesCycle(routesOfTrack(state, route.trackId), route)
}

/** Would `candidate` create a cycle among the track's plugin nodes? */
function closesCycle(existing: Route[], candidate: Route): boolean {
  // Terminals can't be part of a cycle ('in' has no inputs, 'out' no outputs).
  if (candidate.from === 'in' || candidate.to === 'out') return false
  const edges = [...existing, candidate]
  // DFS from the candidate's target: reaching its source closes a loop.
  const stack: RouteEndpoint[] = [candidate.to]
  const seen = new Set<RouteEndpoint>()
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node === candidate.from) return true
    if (seen.has(node)) continue
    seen.add(node)
    for (const edge of edges) {
      if (edge.from === node && edge.to !== 'out') stack.push(edge.to)
    }
  }
  return false
}

/**
 * The linear chain expressed as graph edges (for materializing a track
 * into graph mode): in → each enabled-or-not insert in rank order → out.
 * Ids are minted by the caller — the reducer must never invent ids, or
 * peers replaying the op would diverge.
 */
export function linearChainEdges(
  instances: PluginInstance[]
): Array<{ from: 'in' | string; to: 'out' | string }> {
  const hops: Array<'in' | 'out' | string> = ['in', ...instances.map((p) => p.id), 'out']
  const edges: Array<{ from: 'in' | string; to: 'out' | string }> = []
  for (let i = 0; i < hops.length - 1; i++) {
    edges.push({ from: hops[i] as 'in' | string, to: hops[i + 1] as 'out' | string })
  }
  return edges
}

/**
 * Node depth by longest path from 'in' (for auto-layout columns).
 * Unreachable nodes get depth 0. Safe on any stored graph — the reducer
 * guarantees acyclicity.
 */
export function graphDepths(state: ProjectState, trackId: TrackId): Map<string, number> {
  const routes = routesOfTrack(state, trackId)
  const depths = new Map<string, number>()
  for (const plugin of pluginsOfTrack(state, trackId)) depths.set(plugin.id, 0)
  let changed = true
  let guard = depths.size + 2
  while (changed && guard-- > 0) {
    changed = false
    for (const route of routes) {
      if (route.to === 'out') continue
      const fromDepth = route.from === 'in' ? 0 : (depths.get(route.from) ?? 0)
      const next = fromDepth + (route.from === 'in' ? 0 : 1)
      if ((depths.get(route.to) ?? 0) < next) {
        depths.set(route.to, next)
        changed = true
      }
    }
  }
  return depths
}

/** Is there any path from 'in' to 'out'? (Without one the track is silent.) */
export function hasLivePath(state: ProjectState, trackId: TrackId): boolean {
  const routes = routesOfTrack(state, trackId)
  if (routes.length === 0) return true // chain mode always flows
  const stack: RouteEndpoint[] = ['in']
  const seen = new Set<RouteEndpoint>()
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node === 'out') return true
    if (seen.has(node)) continue
    seen.add(node)
    for (const edge of routes) {
      if (edge.from === node) stack.push(edge.to)
    }
  }
  return false
}
