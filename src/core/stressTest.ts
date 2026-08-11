/**
 * Stress scenarios: large-project generation, dispatch/undo/remote-path
 * storms, and correctness assertions under load.
 *
 * Every scenario mutates state ONLY via ProjectStore.dispatch (or the
 * store's own remote-delivery API, which IS the sync layer's entry point)
 * and returns a structured, JSON-serializable result with timings AND
 * assertion outcomes — a stress scenario that cannot fail is theater.
 *
 * Browser: invoked via window.__superdaw.stressTest (dev builds).
 * Headless: the store-only scenarios run at reduced scale in
 * src/core/__tests__/stressSmoke.test.ts so CI catches regressions.
 */

import { newId } from './model/ids'
import type {
  Clip,
  Note,
  PluginInstance,
  ProjectState,
  Route,
  Track,
  TrackId
} from './model/types'
import { createEmptyProject, routesOfTrack } from './model/types'
import { hasLivePath } from './model/routing'
import { EFFECT_TYPES, effectDefaults, synthDefaults } from './model/effects'
import { builtinEffectDescriptor } from './plugins/builtin'
import { ProjectStore } from './state/store'
import type { Operation, OpEnvelope } from './ops/operations'
import { apply } from './ops/apply'
import { serializeProjectJson, parseProjectJson } from './persistence/format'

// ---------------------------------------------------------------------------
// Shared result shape + helpers
// ---------------------------------------------------------------------------

export interface StressAssertion {
  name: string
  passed: boolean
  detail?: string
}

export interface ScenarioResult {
  scenario: string
  config: Record<string, number>
  /** Milliseconds, rounded to 0.1. */
  timings: Record<string, number>
  counts: Record<string, number>
  assertions: StressAssertion[]
  passed: boolean
  notes: string[]
}

function result(
  scenario: string,
  config: Record<string, number>,
  timings: Record<string, number>,
  counts: Record<string, number>,
  assertions: StressAssertion[],
  notes: string[] = []
): ScenarioResult {
  const rounded: Record<string, number> = {}
  for (const [k, v] of Object.entries(timings)) rounded[k] = Math.round(v * 10) / 10
  return {
    scenario,
    config,
    timings: rounded,
    counts,
    assertions,
    passed: assertions.every((a) => a.passed),
    notes
  }
}

function check(name: string, passed: boolean, detail?: string): StressAssertion {
  return passed ? { name, passed } : { name, passed, detail: detail ?? 'failed' }
}

/** Deterministic LCG so storms replay identically across runs. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** Structural deep equality, insensitive to object key order. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object' || a === null || b === null) return false
  const arrA = Array.isArray(a)
  if (arrA !== Array.isArray(b)) return false
  if (arrA) {
    const x = a as unknown[]
    const y = b as unknown[]
    if (x.length !== y.length) return false
    for (let i = 0; i < x.length; i++) if (!deepEqual(x[i], y[i])) return false
    return true
  }
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  const bRec = b as Record<string, unknown>
  const aRec = a as Record<string, unknown>
  for (const k of ka) {
    if (!(k in bRec)) return false
    if (!deepEqual(aRec[k], bRec[k])) return false
  }
  return true
}

/**
 * Referential-integrity audit of a project document. Empty = healthy.
 * Used after structural storms and folds: any violation means the reducer
 * let the document decohere under load.
 */
export function stateInvariantViolations(state: ProjectState): string[] {
  const v: string[] = []
  const orderSet = new Set(state.trackOrder)
  if (orderSet.size !== state.trackOrder.length) v.push('trackOrder contains duplicate ids')
  for (const id of state.trackOrder) {
    if (!state.tracks[id]) v.push(`trackOrder id ${id} has no track`)
  }
  for (const track of Object.values(state.tracks)) {
    if (!orderSet.has(track.id)) v.push(`track ${track.id} missing from trackOrder`)
    if (track.parentId !== null) {
      const parent = state.tracks[track.parentId]
      if (!parent) v.push(`track ${track.id} parent ${track.parentId} missing`)
      else if (parent.kind !== 'folder') v.push(`track ${track.id} parent is not a folder`)
      let cur: TrackId | null = track.parentId
      const seen = new Set<TrackId>([track.id])
      while (cur !== null) {
        if (seen.has(cur)) {
          v.push(`parent cycle through track ${track.id}`)
          break
        }
        seen.add(cur)
        cur = state.tracks[cur]?.parentId ?? null
      }
    }
  }
  for (const clip of Object.values(state.clips)) {
    const track = state.tracks[clip.trackId]
    if (!track) v.push(`clip ${clip.id} references missing track ${clip.trackId}`)
    else if (track.kind === 'folder') v.push(`clip ${clip.id} sits on a folder track`)
  }
  for (const note of Object.values(state.notes)) {
    if (!state.clips[note.clipId]) v.push(`note ${note.id} references missing clip ${note.clipId}`)
  }
  for (const plugin of Object.values(state.plugins)) {
    if (!state.tracks[plugin.trackId]) {
      v.push(`plugin ${plugin.id} references missing track ${plugin.trackId}`)
    }
  }
  for (const point of Object.values(state.automation)) {
    if (!state.tracks[point.trackId]) {
      v.push(`automation ${point.id} references missing track ${point.trackId}`)
    }
    if (point.instanceId !== undefined) {
      const instance = state.plugins[point.instanceId]
      if (!instance) v.push(`automation ${point.id} references missing plugin ${point.instanceId}`)
      else if (instance.trackId !== point.trackId) {
        v.push(`automation ${point.id} plugin lives on another track`)
      }
    }
  }
  const edges = new Set<string>()
  const routesByTrack = new Map<TrackId, Route[]>()
  for (const route of Object.values(state.routes)) {
    if (!state.tracks[route.trackId]) {
      v.push(`route ${route.id} references missing track ${route.trackId}`)
      continue
    }
    for (const end of [route.from, route.to]) {
      if (end === 'in' || end === 'out') continue
      const plugin = state.plugins[end]
      if (!plugin) v.push(`route ${route.id} endpoint ${end} missing`)
      else if (plugin.trackId !== route.trackId) {
        v.push(`route ${route.id} endpoint ${end} lives on another track`)
      }
    }
    const key = `${route.trackId}|${route.from}|${route.to}`
    if (edges.has(key)) v.push(`duplicate routing edge ${key}`)
    edges.add(key)
    const list = routesByTrack.get(route.trackId) ?? []
    list.push(route)
    routesByTrack.set(route.trackId, list)
  }
  // Per-track acyclicity (terminals cannot be in a cycle by construction).
  for (const [trackId, routes] of routesByTrack) {
    const out = new Map<string, string[]>()
    for (const r of routes) {
      if (r.from === 'in' || r.to === 'out') continue
      const list = out.get(r.from) ?? []
      list.push(r.to)
      out.set(r.from, list)
    }
    const visiting = new Set<string>()
    const done = new Set<string>()
    const visit = (node: string): boolean => {
      if (done.has(node)) return true
      if (visiting.has(node)) return false
      visiting.add(node)
      for (const next of out.get(node) ?? []) if (!visit(next)) return false
      visiting.delete(node)
      done.add(node)
      return true
    }
    for (const node of out.keys()) {
      if (!visit(node)) {
        v.push(`routing cycle on track ${trackId}`)
        break
      }
    }
  }
  return v
}

// ---------------------------------------------------------------------------
// Entity generators
// ---------------------------------------------------------------------------

export interface StressTestConfig {
  trackCount: number
  effectsPerTrack: number
  clipsPerTrack: number
  notesPerClip: number
  /** Suppress console output (headless runs). */
  quiet: boolean
  /** Seed for ALL generator randomness — same seed, same project content. */
  seed: number
  /**
   * Registered asset ids to reference from generated audio clips (round-
   * robin). Without them audio clips are created empty (assetId null) —
   * previously the generator minted DANGLING ids, which made audio
   * playback stress hollow while looking real.
   */
  audioAssetIds: string[] | null
}

const DEFAULT_CONFIG: StressTestConfig = {
  trackCount: 100,
  effectsPerTrack: 10,
  clipsPerTrack: 3,
  notesPerClip: 50,
  quiet: false,
  seed: 0x5da5,
  audioAssetIds: null
}

// Generators draw ONLY from the caller's LCG — a stray Math.random here
// would break the seeded-replay guarantee the suite advertises.
function randomChoice<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)]
}

function generateTrack(
  id: string,
  index: number,
  rng: () => number,
  kind: 'audio' | 'midi' | 'folder' = index % 3 === 0 ? 'midi' : 'audio'
): Track {
  const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c']
  return {
    id,
    kind,
    name: `Track ${index + 1}`,
    color: randomChoice(colors, rng),
    muted: false,
    soloed: false,
    parentId: null,
    frozenAssetId: null,
    volume: 1,
    pan: 0,
    synth: kind === 'midi' ? synthDefaults() : {}
  }
}

function generateClip(
  id: string,
  trackId: string,
  startTick: number,
  isMidi: boolean,
  notesPerClip: number,
  assetId: string | null,
  rng: () => number
): [Clip, Note[]] {
  const duration = 1920 // 2 bars at 960 ticks/bar
  const clip: Clip = {
    id,
    trackId,
    name: `Clip ${id}`,
    start: startTick,
    duration,
    assetId: isMidi ? null : assetId,
    offset: 0,
    color: null,
    fadeIn: isMidi ? 0 : 480,
    fadeOut: isMidi ? 0 : 480,
    reverse: false,
    pitch: 0,
    stretch: 1,
    loopLength: 0
  }

  const notes: Note[] = []
  if (isMidi) {
    for (let i = 0; i < notesPerClip; i++) {
      notes.push({
        id: newId('note'),
        clipId: id,
        pitch: 36 + Math.floor(rng() * 48), // C2-C6
        start: Math.floor(rng() * (duration - 120)),
        duration: 60 + Math.floor(rng() * 240),
        // Integer 1..127 velocity. (The old generator emitted 0.6..1.0
        // floats, which the reducer clamps to 1 — every stress note was
        // near-silent and the "MIDI playback" stress was hollow.)
        velocity: 60 + Math.floor(rng() * 67)
      })
    }
  }

  return [clip, notes]
}

function generatePlugin(id: string, trackId: string, rank: number, rng: () => number): PluginInstance {
  const effectType = randomChoice(EFFECT_TYPES, rng)
  return {
    id,
    trackId,
    descriptor: builtinEffectDescriptor(effectType),
    enabled: rng() > 0.2, // 80% enabled
    rank,
    params: effectDefaults(effectType),
    stateBlob: null
  }
}

interface PerformanceMetrics {
  startTime: number
  trackCreateTime: number
  pluginAddTime: number
  clipCreateTime: number
  totalTime: number
  trackCount: number
  pluginCount: number
  clipCount: number
  noteCount: number
  /** Post-generation counts read back from the store (verification). */
  verified: {
    tracksInState: number
    pluginsInState: number
    clipsInState: number
    notesInState: number
  }
}

export async function generateStressProject(
  store: ProjectStore,
  config: Partial<StressTestConfig> = {}
): Promise<PerformanceMetrics> {
  const c = { ...DEFAULT_CONFIG, ...config }
  const rng = makeRng(c.seed)
  const log = c.quiet ? () => {} : console.log
  const metrics: PerformanceMetrics = {
    startTime: performance.now(),
    trackCreateTime: 0,
    pluginAddTime: 0,
    clipCreateTime: 0,
    totalTime: 0,
    trackCount: 0,
    pluginCount: 0,
    clipCount: 0,
    noteCount: 0,
    verified: { tracksInState: 0, pluginsInState: 0, clipsInState: 0, notesInState: 0 }
  }

  log(
    `Stress generate: ${c.trackCount} tracks x ${c.effectsPerTrack} effects + ${c.clipsPerTrack} clips each`
  )

  // Create tracks
  const trackStart = performance.now()
  const trackIds: string[] = []
  for (let i = 0; i < c.trackCount; i++) {
    const trackId = newId('track')
    trackIds.push(trackId)
    const trackObj = generateTrack(trackId, i, rng)

    const op: Operation = {
      type: 'track/create',
      track: trackObj,
      index: i,
      clips: [],
      automation: [],
      notes: [],
      plugins: []
    }
    store.dispatch(op, 'local')
  }
  metrics.trackCreateTime = performance.now() - trackStart
  metrics.trackCount = c.trackCount

  // Add effects to each track
  const pluginStart = performance.now()
  for (const trackId of trackIds) {
    for (let i = 0; i < c.effectsPerTrack; i++) {
      const pluginId = newId('plugin')
      const plugin = generatePlugin(pluginId, trackId, i + 1, rng)
      store.dispatch({ type: 'plugin/add', instance: plugin }, 'local')
      metrics.pluginCount++
    }
  }
  metrics.pluginAddTime = performance.now() - pluginStart

  // Add clips to each track
  const clipStart = performance.now()
  let clipIndex = 0
  for (let t = 0; t < trackIds.length; t++) {
    const trackId = trackIds[t]
    const isMidi = t % 3 === 0

    for (let clipIdx = 0; clipIdx < c.clipsPerTrack; clipIdx++) {
      const clipId = newId('clip')
      const startTick = clipIdx * 3840 // 4 bars apart
      const assetId =
        c.audioAssetIds && c.audioAssetIds.length > 0
          ? c.audioAssetIds[clipIndex % c.audioAssetIds.length]
          : null
      const [clipObj, notes] = generateClip(clipId, trackId, startTick, isMidi, c.notesPerClip, assetId, rng)
      clipIndex++

      store.dispatch({ type: 'clip/create', clip: clipObj, notes }, 'local')
      metrics.clipCount++
      metrics.noteCount += notes.length
    }
  }
  metrics.clipCreateTime = performance.now() - clipStart

  metrics.totalTime = performance.now() - metrics.startTime
  const state = store.state
  metrics.verified = {
    tracksInState: Object.keys(state.tracks).length,
    pluginsInState: Object.keys(state.plugins).length,
    clipsInState: Object.keys(state.clips).length,
    notesInState: Object.keys(state.notes).length
  }

  log(`Generation complete in ${metrics.totalTime.toFixed(0)}ms`)
  log(`   Tracks: ${metrics.trackCount} (${metrics.trackCreateTime.toFixed(0)}ms)`)
  log(`   Plugins: ${metrics.pluginCount} (${metrics.pluginAddTime.toFixed(0)}ms)`)
  log(
    `   Clips: ${metrics.clipCount}, Notes: ${metrics.noteCount} (${metrics.clipCreateTime.toFixed(0)}ms)`
  )

  return metrics
}

// ---------------------------------------------------------------------------
// Browser-only probes (Chromium memory, rAF frame timing, audio playback)
// ---------------------------------------------------------------------------

/**
 * Capture current browser performance stats. Chromium-only; null elsewhere.
 */
export function capturePerformanceMetrics() {
  const mem = (
    performance as Performance & {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
    }
  ).memory
  if (!mem) return null
  return {
    usedMemory: `${(mem.usedJSHeapSize / 1024 / 1024).toFixed(1)} MB`,
    totalMemory: `${(mem.totalJSHeapSize / 1024 / 1024).toFixed(1)} MB`,
    jsHeapLimit: `${(mem.jsHeapSizeLimit / 1024 / 1024).toFixed(1)} MB`,
    heapUsagePercent: `${((mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100).toFixed(1)}%`
  }
}

export interface FramePerfResult {
  avgFps: number
  minFps: number
  maxFps: number
  avgFrameTime: number
  /** Set when the tab went hidden — partial data, stats untrustworthy. */
  aborted?: 'hidden'
}

/**
 * Monitor FPS and frame time over a duration (ms). Browser-only (rAF).
 * A hidden tab stops rAF entirely, which would stall the await forever
 * and record one giant frame delta on return — so the measurement bails
 * out (aborted: 'hidden') the moment visibility is lost. `document` is
 * feature-detected: headless callers just get an unguarded measurement.
 */
export async function measureFramePerformance(durationMs: number = 5000): Promise<FramePerfResult> {
  return new Promise((resolve) => {
    const frameTimes: number[] = []
    let lastTime = performance.now()
    const startTime = performance.now()
    const doc = typeof document !== 'undefined' ? document : null
    let settled = false

    const finish = (aborted: boolean): void => {
      if (settled) return
      settled = true
      if (doc) doc.removeEventListener('visibilitychange', onVisibility)
      if (frameTimes.length === 0) {
        resolve({ avgFps: 0, minFps: 0, maxFps: 0, avgFrameTime: 0, aborted: 'hidden' })
        return
      }
      const avgFrameTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length
      const fps = 1000 / avgFrameTime
      const sortedTimes = [...frameTimes].sort((a, b) => a - b)
      resolve({
        avgFps: Math.round(fps * 10) / 10,
        minFps: Math.round((1000 / sortedTimes[sortedTimes.length - 1]) * 10) / 10,
        maxFps: Math.round((1000 / sortedTimes[0]) * 10) / 10,
        avgFrameTime: Math.round(avgFrameTime * 10) / 10,
        ...(aborted ? { aborted: 'hidden' as const } : {})
      })
    }

    const onVisibility = (): void => {
      if (doc?.hidden) finish(true)
    }
    if (doc) {
      if (doc.hidden) {
        finish(true)
        return
      }
      doc.addEventListener('visibilitychange', onVisibility)
    }

    function measure() {
      if (settled) return // aborted while this frame was queued
      const now = performance.now()
      frameTimes.push(now - lastTime)
      lastTime = now

      if (now - startTime < durationMs) {
        requestAnimationFrame(measure)
      } else {
        finish(false)
      }
    }

    requestAnimationFrame(measure)
  })
}

/**
 * Playback under load: frame rate, memory growth, audio context health.
 * Browser-only — needs the transport on the dev handle and a running
 * AudioContext (click play once first if the context is suspended).
 */
export async function stressTestPlayback(
  _store: ProjectStore,
  durationSeconds: number = 5
): Promise<{
  duration: number
  avgFps: number
  minFps: number
  maxFps: number
  avgFrameTime: number
  memoryAtStart: string
  memoryAtEnd: string
  audioContextState: string
  aborted?: 'hidden'
}> {
  const memStart = capturePerformanceMetrics()

  const transport = (globalThis as unknown as { __superdaw?: { transport?: { play(): void; stop(): void } } })
    .__superdaw?.transport
  if (!transport) throw new Error('Transport not available (browser dev build only)')

  transport.play()
  const framePerf = await measureFramePerformance(durationSeconds * 1000)
  transport.stop()

  const memEnd = capturePerformanceMetrics()
  const audioEngine = (globalThis as unknown as { __superdaw?: { audioEngine?: { ctx?: { state?: string } } } })
    .__superdaw?.audioEngine
  const audioContextState = audioEngine?.ctx?.state || 'unknown'

  return {
    duration: durationSeconds,
    avgFps: framePerf.avgFps,
    minFps: framePerf.minFps,
    maxFps: framePerf.maxFps,
    avgFrameTime: framePerf.avgFrameTime,
    memoryAtStart: memStart?.usedMemory || 'N/A',
    memoryAtEnd: memEnd?.usedMemory || 'N/A',
    audioContextState,
    ...(framePerf.aborted ? { aborted: framePerf.aborted } : {})
  }
}

// ---------------------------------------------------------------------------
// Undo/redo: real counts, undo exactly what this scenario created
// ---------------------------------------------------------------------------

export function stressTestUndoRedo(
  store: ProjectStore,
  config: { operations?: number; quiet?: boolean } = {}
): ScenarioResult {
  const operations = config.operations ?? 200
  const assertions: StressAssertion[] = []
  const notes: string[] = []
  const state0 = store.state
  const trackIds = Object.keys(state0.tracks).slice(0, 10)
  if (trackIds.length === 0) {
    return result(
      'undoRedo',
      { operations },
      {},
      {},
      [check('tracks available (generate a project first)', false)]
    )
  }

  const memStart = capturePerformanceMetrics()
  const baseline = store.state

  // Create ops, counting REAL successes: dispatch returns false for no-ops.
  const opStart = performance.now()
  let created = 0
  for (let i = 0; i < operations; i++) {
    const trackId = trackIds[i % trackIds.length]
    const current = store.state.tracks[trackId]?.volume ?? 1
    // Always a real change: alternate between two values distinct from current.
    const volume = current === 0.5 ? 0.6 : 0.5
    if (store.dispatch({ type: 'track/setVolume', trackId, volume }, 'local')) created++
  }
  const opsMs = performance.now() - opStart
  const afterOps = store.state
  const memAfterOps = capturePerformanceMetrics()

  // Undo EXACTLY the ops this scenario created — not the whole stack.
  const undoStart = performance.now()
  let undone = 0
  while (undone < created && store.undo()) undone++
  const undoMs = performance.now() - undoStart
  const memAfterUndo = capturePerformanceMetrics()

  assertions.push(check('every dispatched op was a real change', created === operations, `${created}/${operations}`))
  assertions.push(check('undo count matches created count', undone === created, `undid ${undone} of ${created}`))
  assertions.push(
    check('undo-all returns exactly to baseline state', deepEqual(store.state, baseline))
  )

  const redoStart = performance.now()
  let redone = 0
  while (redone < created && store.redo()) redone++
  const redoMs = performance.now() - redoStart

  assertions.push(check('redo count matches created count', redone === created, `redid ${redone} of ${created}`))
  assertions.push(
    check('redo-all returns exactly to post-ops state', deepEqual(store.state, afterOps))
  )

  // Leave the project as we found it.
  let cleanupUndone = 0
  while (cleanupUndone < created && store.undo()) cleanupUndone++
  assertions.push(
    check('cleanup undo restores baseline again', deepEqual(store.state, baseline))
  )

  if (memStart) {
    notes.push(
      `memory: ${memStart.usedMemory} -> ${memAfterOps?.usedMemory} (ops) -> ${memAfterUndo?.usedMemory} (after undo)`
    )
  }
  if (!config.quiet) {
    console.log(
      `undoRedo: ${created} ops in ${opsMs.toFixed(0)}ms, undo ${undoMs.toFixed(0)}ms, redo ${redoMs.toFixed(0)}ms`
    )
  }

  return result(
    'undoRedo',
    { operations },
    { opsMs, undoMs, redoMs },
    { operationsRequested: operations, operationsCreated: created, undone, redone },
    assertions,
    notes
  )
}

// ---------------------------------------------------------------------------
// Local dispatch throughput (honest framing: the REMOTE path is covered by
// stressTestRemoteDelivery, not by this)
// ---------------------------------------------------------------------------

export function stressTestDispatchThroughput(
  store: ProjectStore,
  config: { operations?: number; quiet?: boolean } = {}
): ScenarioResult {
  const operations = config.operations ?? 500
  const state0 = store.state
  const trackIds = Object.keys(state0.tracks).slice(0, 15)
  if (trackIds.length === 0) {
    return result(
      'dispatchThroughput',
      { operations },
      {},
      {},
      [check('tracks available (generate a project first)', false)]
    )
  }

  const memBefore = capturePerformanceMetrics()
  const startTime = performance.now()
  let changed = 0
  let noops = 0

  for (let i = 0; i < operations; i++) {
    const trackId = trackIds[i % trackIds.length]
    const track = store.state.tracks[trackId]
    if (!track) continue
    let op: Operation
    switch (i % 4) {
      case 0:
        op = { type: 'track/setVolume', trackId, volume: track.volume === 0.5 ? 0.75 : 0.5 }
        break
      case 1:
        op = { type: 'track/setPan', trackId, pan: track.pan === 0.25 ? -0.25 : 0.25 }
        break
      case 2:
        op = { type: 'track/setMute', trackId, muted: !track.muted }
        break
      default:
        op = { type: 'track/setSolo', trackId, soloed: !track.soloed }
    }
    if (store.dispatch(op, 'local')) changed++
    else noops++
  }

  const totalMs = performance.now() - startTime
  const memAfter = capturePerformanceMetrics()
  const opsPerSecond = Math.round(changed / (totalMs / 1000))

  // Leave mute/solo state clean (extra ops, not counted in the measurement).
  for (const trackId of trackIds) {
    const track = store.state.tracks[trackId]
    if (!track) continue
    if (track.muted) store.dispatch({ type: 'track/setMute', trackId, muted: false }, 'local')
    if (track.soloed) store.dispatch({ type: 'track/setSolo', trackId, soloed: false }, 'local')
  }

  const assertions = [
    check('every dispatched op was a real change', noops === 0, `${noops} no-ops`),
    check('all ops accounted for', changed + noops === operations)
  ]
  const notes = [
    'local dispatch only — the remote/collaboration path is stressTestRemoteDelivery',
    ...(memBefore ? [`memory: ${memBefore.usedMemory} -> ${memAfter?.usedMemory}`] : [])
  ]
  if (!config.quiet) {
    console.log(`dispatchThroughput: ${changed} ops in ${totalMs.toFixed(0)}ms (${opsPerSecond}/s)`)
  }

  return result(
    'dispatchThroughput',
    { operations },
    { totalMs },
    { changed, noops, opsPerSecond },
    assertions,
    notes
  )
}

// ---------------------------------------------------------------------------
// Routing graphs: DAGs on plugin-laden tracks, with invalid-edge rejection
// ---------------------------------------------------------------------------

export function stressTestRouting(
  store: ProjectStore,
  config: { tracks?: number; pluginsPerTrack?: number; quiet?: boolean } = {}
): ScenarioResult {
  const trackCount = config.tracks ?? 20
  const pluginsPerTrack = Math.max(3, config.pluginsPerTrack ?? 8)
  const assertions: StressAssertion[] = []
  const rng = makeRng(0x9047)

  // Fresh plugin-laden tracks so the scenario is self-sufficient.
  const setupStart = performance.now()
  const trackIds: string[] = []
  const pluginIdsByTrack: string[][] = []
  for (let t = 0; t < trackCount; t++) {
    const trackId = newId('track')
    trackIds.push(trackId)
    store.dispatch(
      {
        type: 'track/create',
        track: { ...generateTrack(trackId, t, rng, 'audio'), name: `Routing ${t + 1}` },
        index: store.state.trackOrder.length,
        clips: [],
        automation: [],
        notes: [],
        plugins: []
      },
      'local'
    )
    const plugins: string[] = []
    for (let p = 0; p < pluginsPerTrack; p++) {
      const pluginId = newId('plugin')
      plugins.push(pluginId)
      store.dispatch({ type: 'plugin/add', instance: generatePlugin(pluginId, trackId, p + 1, rng) }, 'local')
    }
    pluginIdsByTrack.push(plugins)
  }
  const setupMs = performance.now() - setupStart

  // One route/addMany per track: a layered DAG plus deliberately invalid
  // edges (cycle, duplicate, self-loop, ghost endpoint, cross-track).
  const P = pluginsPerTrack
  const expectedPerTrack = 2 * P + 1
  let routesRequested = 0
  const skipEdgeIdsByTrack: string[][] = []
  const cycleEdgeIds: string[] = []
  const addStart = performance.now()
  for (let t = 0; t < trackCount; t++) {
    const trackId = trackIds[t]
    const p = pluginIdsByTrack[t]
    const routes: Route[] = []
    const skipIds: string[] = []
    routes.push({ id: newId('route'), trackId, from: 'in', to: p[0] })
    routes.push({ id: newId('route'), trackId, from: 'in', to: p[1] })
    for (let i = 2; i < P; i++) {
      routes.push({ id: newId('route'), trackId, from: p[i - 1], to: p[i] })
      const skip: Route = { id: newId('route'), trackId, from: p[i - 2], to: p[i] }
      skipIds.push(skip.id)
      routes.push(skip)
    }
    routes.push({ id: newId('route'), trackId, from: p[P - 1], to: 'out' })
    routes.push({ id: newId('route'), trackId, from: p[P - 2], to: 'out' })
    routes.push({ id: newId('route'), trackId, from: 'in', to: 'out' }) // parallel dry path
    skipEdgeIdsByTrack.push(skipIds)

    // Invalid entries — the reducer must skip each one individually:
    const cycleEdge: Route = { id: newId('route'), trackId, from: p[2], to: p[0] }
    cycleEdgeIds.push(cycleEdge.id)
    routes.push(cycleEdge) // would close p0 -> p2 -> p0
    routes.push({ id: newId('route'), trackId, from: 'in', to: p[0] }) // duplicate edge
    routes.push({ id: newId('route'), trackId, from: p[3 % P], to: p[3 % P] }) // self-loop
    routes.push({ id: newId('route'), trackId, from: 'in', to: 'ghost-plugin' }) // unknown endpoint
    if (t > 0) {
      routes.push({ id: newId('route'), trackId, from: pluginIdsByTrack[t - 1][0], to: 'out' }) // cross-track
    }
    routesRequested += routes.length
    store.dispatch({ type: 'route/addMany', routes }, 'local')
  }
  const addMs = performance.now() - addStart

  let routesAdded = 0
  let livePaths = 0
  let cycleEdgesRejected = 0
  for (let t = 0; t < trackCount; t++) {
    const trackRoutes = routesOfTrack(store.state, trackIds[t])
    routesAdded += trackRoutes.length
    if (trackRoutes.length !== expectedPerTrack) {
      assertions.push(
        check(
          `track ${t} route count`,
          false,
          `expected ${expectedPerTrack}, got ${trackRoutes.length}`
        )
      )
    }
    if (hasLivePath(store.state, trackIds[t])) livePaths++
    if (!store.state.routes[cycleEdgeIds[t]]) cycleEdgesRejected++
  }
  assertions.push(
    check(
      'every track has exactly the valid edges',
      routesAdded === expectedPerTrack * trackCount,
      `${routesAdded} vs ${expectedPerTrack * trackCount}`
    )
  )
  assertions.push(check('every track keeps a live in->out path', livePaths === trackCount))
  assertions.push(
    check('every cycle-closing edge was rejected', cycleEdgesRejected === trackCount)
  )

  // Delete storm: drop the skip edges (chain + dry path keep tracks live).
  const deleteStart = performance.now()
  let routesDeleted = 0
  for (let t = 0; t < trackCount; t++) {
    const ids = skipEdgeIdsByTrack[t]
    if (store.dispatch({ type: 'route/deleteMany', routeIds: ids }, 'local')) routesDeleted += ids.length
  }
  const deleteMs = performance.now() - deleteStart

  let liveAfterDelete = 0
  let routesAfter = 0
  for (let t = 0; t < trackCount; t++) {
    routesAfter += routesOfTrack(store.state, trackIds[t]).length
    if (hasLivePath(store.state, trackIds[t])) liveAfterDelete++
  }
  assertions.push(
    check(
      'delete storm removed exactly the skip edges',
      routesAfter === (expectedPerTrack - (P - 2)) * trackCount,
      `${routesAfter} routes remain`
    )
  )
  assertions.push(check('tracks stay live after the delete storm', liveAfterDelete === trackCount))
  assertions.push(check('state invariants hold', stateInvariantViolations(store.state).length === 0))

  if (!config.quiet) {
    console.log(
      `routing: ${routesAdded} edges on ${trackCount} tracks in ${addMs.toFixed(0)}ms, deletes ${deleteMs.toFixed(0)}ms`
    )
  }

  return result(
    'routing',
    { tracks: trackCount, pluginsPerTrack },
    { setupMs, addMs, deleteMs },
    { routesRequested, routesAdded, invalidSkipped: routesRequested - routesAdded, routesDeleted },
    assertions,
    ['engine rewire cost is only included when an AudioEngine subscribes (browser runs)']
  )
}

// ---------------------------------------------------------------------------
// Folder nesting: deep trees, reparent/reorder storms, cycle rejection
// ---------------------------------------------------------------------------

function folderDepthOf(state: ProjectState, trackId: TrackId): number {
  let depth = 0
  let cur = state.tracks[trackId]?.parentId ?? null
  const seen = new Set<TrackId>()
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur)
    depth++
    cur = state.tracks[cur]?.parentId ?? null
  }
  return depth
}

export function stressTestFolderNesting(
  store: ProjectStore,
  config: { trees?: number; depth?: number; reparentOps?: number; reorderOps?: number; quiet?: boolean } = {}
): ScenarioResult {
  const trees = config.trees ?? 6
  const depth = config.depth ?? 8
  const reparentOps = config.reparentOps ?? 200
  const reorderOps = config.reorderOps ?? 200
  const assertions: StressAssertion[] = []
  const rng = makeRng(0xf01de5)

  // Build `trees` chains of `depth` folders, an audio leaf in the deepest.
  const buildStart = performance.now()
  const folderGrid: string[][] = [] // folderGrid[tree][level]
  const leafIds: string[] = []
  for (let t = 0; t < trees; t++) {
    const chain: string[] = []
    let parentId: string | null = null
    for (let d = 0; d < depth; d++) {
      const id = newId('track')
      chain.push(id)
      const folder: Track = {
        ...generateTrack(id, d, rng, 'folder'),
        name: `Tree${t + 1}/F${d + 1}`,
        parentId
      }
      store.dispatch(
        {
          type: 'track/create',
          track: folder,
          index: store.state.trackOrder.length,
          clips: [],
          automation: [],
          notes: [],
          plugins: []
        },
        'local'
      )
      parentId = id
    }
    folderGrid.push(chain)
    const leafId = newId('track')
    leafIds.push(leafId)
    store.dispatch(
      {
        type: 'track/create',
        track: { ...generateTrack(leafId, t, rng, 'audio'), name: `Tree${t + 1}/Leaf`, parentId },
        index: store.state.trackOrder.length,
        clips: [],
        automation: [],
        notes: [],
        plugins: []
      },
      'local'
    )
  }
  const buildMs = performance.now() - buildStart

  let depthsOk = 0
  for (const leafId of leafIds) {
    if (folderDepthOf(store.state, leafId) === depth) depthsOk++
  }
  assertions.push(check(`every leaf sits at depth ${depth}`, depthsOk === trees))

  // Cycle attempts: a root folder into its own deepest descendant.
  let cyclesRejected = 0
  for (let t = 0; t < trees; t++) {
    const rejected = !store.dispatch(
      { type: 'track/setParent', trackId: folderGrid[t][0], parentId: folderGrid[t][depth - 1] },
      'local'
    )
    if (rejected) cyclesRejected++
  }
  assertions.push(check('all cycle-creating reparents rejected', cyclesRejected === trees))

  // Reparent storm: leaves and mid-level folders hop between trees.
  const reparentStart = performance.now()
  let reparented = 0
  let reparentNoops = 0
  for (let i = 0; i < reparentOps; i++) {
    const fromTree = i % trees
    const toTree = (fromTree + 1 + Math.floor(rng() * (trees - 1))) % trees
    const movingLeaf = i % 2 === 0
    const trackId = movingLeaf
      ? leafIds[fromTree]
      : folderGrid[fromTree][2 + Math.floor(rng() * (depth - 2))]
    const parentId = folderGrid[toTree][Math.floor(rng() * depth)]
    if (store.dispatch({ type: 'track/setParent', trackId, parentId }, 'local')) reparented++
    else reparentNoops++ // legitimately rejected (would nest into own subtree)
  }
  const reparentMs = performance.now() - reparentStart

  // Reorder storm: shuffle the flat order (parents unchanged).
  const reorderStart = performance.now()
  let reordered = 0
  const allIds = [...folderGrid.flat(), ...leafIds]
  for (let i = 0; i < reorderOps; i++) {
    const trackId = allIds[Math.floor(rng() * allIds.length)]
    const index = Math.floor(rng() * store.state.trackOrder.length)
    if (store.dispatch({ type: 'track/reorder', trackId, index }, 'local')) reordered++
  }
  const reorderMs = performance.now() - reorderStart

  const violations = stateInvariantViolations(store.state)
  assertions.push(check('no parent cycles / invariant violations after storms', violations.length === 0, violations.slice(0, 5).join('; ')))
  assertions.push(check('reparent storm did real work', reparented > reparentOps / 2, `${reparented}/${reparentOps}`))

  if (!config.quiet) {
    console.log(
      `folderNesting: ${trees} trees depth ${depth} in ${buildMs.toFixed(0)}ms, reparent ${reparentMs.toFixed(0)}ms, reorder ${reorderMs.toFixed(0)}ms`
    )
  }

  return result(
    'folderNesting',
    { trees, depth, reparentOps, reorderOps },
    { buildMs, reparentMs, reorderMs },
    { foldersCreated: trees * depth, reparented, reparentRejected: reparentNoops, reordered },
    assertions
  )
}

// ---------------------------------------------------------------------------
// Automation density: thousands of points, then a move storm
// ---------------------------------------------------------------------------

export function stressTestAutomation(
  store: ProjectStore,
  config: { points?: number; moves?: number; quiet?: boolean } = {}
): ScenarioResult {
  const points = config.points ?? 4000
  const moves = config.moves ?? 1500
  const assertions: StressAssertion[] = []
  const rng = makeRng(0xa070)

  // A fresh track with one insert so both track params and plugin params
  // get automated.
  const trackId = newId('track')
  store.dispatch(
    {
      type: 'track/create',
      track: { ...generateTrack(trackId, 0, rng, 'audio'), name: 'Automation stress' },
      index: store.state.trackOrder.length,
      clips: [],
      automation: [],
      notes: [],
      plugins: []
    },
    'local'
  )
  const pluginId = newId('plugin')
  store.dispatch(
    {
      type: 'plugin/add',
      instance: {
        id: pluginId,
        trackId,
        descriptor: builtinEffectDescriptor('eq3'),
        enabled: true,
        rank: 1,
        params: effectDefaults('eq3'),
        stateBlob: null
      }
    },
    'local'
  )
  const pluginParams = Object.keys(store.state.plugins[pluginId]?.params ?? {})

  const pointIds: string[] = []
  const addStart = performance.now()
  let added = 0
  for (let i = 0; i < points; i++) {
    const id = newId('auto')
    const mode = i % 3
    const point =
      mode === 2 && pluginParams.length > 0
        ? {
            id,
            trackId,
            instanceId: pluginId,
            param: pluginParams[i % pluginParams.length],
            ticks: i * 24,
            value: (i % 101) / 100
          }
        : {
            id,
            trackId,
            param: mode === 0 ? 'volume' : 'pan',
            ticks: i * 24,
            value: (i % 101) / 100
          }
    if (store.dispatch({ type: 'automation/add', point }, 'local')) {
      added++
      pointIds.push(id)
    }
  }
  const addMs = performance.now() - addStart
  assertions.push(check('every automation/add landed', added === points, `${added}/${points}`))

  // Move storm: absolute targets so re-delivery stays idempotent.
  const lastMove = new Map<string, { ticks: number; value: number }>()
  const moveStart = performance.now()
  let moved = 0
  for (let i = 0; i < moves; i++) {
    const id = pointIds[Math.floor(rng() * pointIds.length)]
    const ticks = Math.floor(rng() * 200000)
    const value = Math.round(rng() * 100) / 100
    const current = store.state.automation[id]
    if (current && current.ticks === ticks && current.value === value) continue
    if (store.dispatch({ type: 'automation/move', pointId: id, ticks, value }, 'local')) {
      moved++
      lastMove.set(id, { ticks, value })
    }
  }
  const moveMs = performance.now() - moveStart

  const onTrack = Object.values(store.state.automation).filter((p) => p.trackId === trackId)
  assertions.push(
    check('point count on the stress track', onTrack.length === points, `${onTrack.length}`)
  )
  let movesLanded = 0
  for (const [id, m] of lastMove) {
    const p = store.state.automation[id]
    if (p && p.ticks === m.ticks && p.value === m.value) movesLanded++
  }
  assertions.push(
    check('every last-write move is what the state holds', movesLanded === lastMove.size, `${movesLanded}/${lastMove.size}`)
  )

  if (!config.quiet) {
    console.log(
      `automation: ${added} points in ${addMs.toFixed(0)}ms (${((addMs / Math.max(1, added)) * 1000).toFixed(0)}us/op), ${moved} moves in ${moveMs.toFixed(0)}ms`
    )
  }

  return result(
    'automation',
    { points, moves },
    { addMs, moveMs },
    { added, moved },
    assertions
  )
}

// ---------------------------------------------------------------------------
// Dense piano roll: one clip with thousands of notes, moveMany storms
// ---------------------------------------------------------------------------

export function stressTestDensePianoRoll(
  store: ProjectStore,
  config: { notes?: number; storms?: number; quiet?: boolean } = {}
): ScenarioResult {
  const noteCount = config.notes ?? 2500
  const storms = config.storms ?? 6
  const assertions: StressAssertion[] = []
  const rng = makeRng(0xd15c)

  const trackId = newId('track')
  store.dispatch(
    {
      type: 'track/create',
      track: { ...generateTrack(trackId, 0, rng, 'midi'), name: 'Dense piano roll' },
      index: store.state.trackOrder.length,
      clips: [],
      automation: [],
      notes: [],
      plugins: []
    },
    'local'
  )
  const clipId = newId('clip')
  const duration = 3840 * 16
  store.dispatch(
    {
      type: 'clip/create',
      clip: {
        id: clipId,
        trackId,
        name: 'Dense clip',
        start: 0,
        duration,
        assetId: null,
        offset: 0,
        color: null,
        fadeIn: 0,
        fadeOut: 0,
        reverse: false,
        pitch: 0,
        stretch: 1,
        loopLength: 0
      },
      notes: []
    },
    'local'
  )

  // One import-shaped gesture: note/addMany with every note.
  const noteIds: string[] = []
  const notes: Note[] = []
  for (let i = 0; i < noteCount; i++) {
    const id = newId('note')
    noteIds.push(id)
    notes.push({
      id,
      clipId,
      pitch: 24 + (i % 80),
      start: (i * 7) % (duration - 480),
      duration: 60 + (i % 8) * 30,
      velocity: 1 + (i % 127)
    })
  }
  const addStart = performance.now()
  const addChanged = store.dispatch({ type: 'note/addMany', notes }, 'local')
  const addMs = performance.now() - addStart
  assertions.push(check('note/addMany landed', addChanged))

  const inClip = Object.values(store.state.notes).filter((n) => n.clipId === clipId)
  assertions.push(check('all notes present', inClip.length === noteCount, `${inClip.length}`))

  // moveMany storms over the WHOLE selection, absolute targets.
  const stormOps: Operation[] = []
  for (let s = 0; s < storms; s++) {
    stormOps.push({
      type: 'note/moveMany',
      moves: noteIds.map((noteId, i) => ({
        noteId,
        pitch: 24 + ((i + s + 1) % 80),
        start: ((i * 7) % (duration - 480)) + 12 * (s + 1)
      }))
    })
  }
  const stormStart = performance.now()
  let stormsChanged = 0
  for (const op of stormOps) if (store.dispatch(op, 'local')) stormsChanged++
  const stormMs = performance.now() - stormStart
  assertions.push(check('every storm changed state', stormsChanged === storms))

  // Every note must sit exactly where the LAST storm put it.
  let exact = 0
  for (let i = 0; i < noteCount; i++) {
    const n = store.state.notes[noteIds[i]]
    if (
      n &&
      n.pitch === 24 + ((i + storms) % 80) &&
      n.start === ((i * 7) % (duration - 480)) + 12 * storms
    ) {
      exact++
    }
  }
  assertions.push(check('every note at its final absolute position', exact === noteCount, `${exact}/${noteCount}`))

  // Idempotency: re-delivering the last storm op must be a no-op.
  const redelivered = store.dispatch(stormOps[storms - 1], 'local')
  assertions.push(check('re-delivered moveMany is a no-op (idempotent)', redelivered === false))

  if (!config.quiet) {
    console.log(
      `densePianoRoll: ${noteCount} notes added in ${addMs.toFixed(0)}ms, ${storms} moveMany storms in ${stormMs.toFixed(0)}ms (${(stormMs / storms).toFixed(0)}ms each)`
    )
  }

  return result(
    'densePianoRoll',
    { notes: noteCount, storms },
    { addMs, stormMs, stormAvgMs: stormMs / Math.max(1, storms) },
    { notesInClip: inClip.length, stormsChanged },
    assertions
  )
}

// ---------------------------------------------------------------------------
// Structural storm: the rewire-triggering ops, interleaved
// ---------------------------------------------------------------------------

export function stressTestStructuralStorm(
  store: ProjectStore,
  config: { iterations?: number; seed?: number; quiet?: boolean } = {}
): ScenarioResult {
  const iterations = config.iterations ?? 400
  const seed = config.seed ?? 1337
  const assertions: StressAssertion[] = []
  const rng = makeRng(seed)

  // Working set: 12 tracks (8 audio / 4 midi), one clip each.
  const myTracks: string[] = []
  const myClips: string[] = []
  const myPlugins: string[] = []
  const setupStart = performance.now()
  for (let i = 0; i < 12; i++) {
    const trackId = newId('track')
    myTracks.push(trackId)
    const kind = i % 3 === 0 ? 'midi' : 'audio'
    store.dispatch(
      {
        type: 'track/create',
        track: { ...generateTrack(trackId, i, rng, kind), name: `Storm ${i + 1}` },
        index: store.state.trackOrder.length,
        clips: [],
        automation: [],
        notes: [],
        plugins: []
      },
      'local'
    )
    const clipId = newId('clip')
    myClips.push(clipId)
    const [clip, notes] = generateClip(clipId, trackId, 0, kind === 'midi', 5, null, rng)
    store.dispatch({ type: 'clip/create', clip, notes }, 'local')
  }
  const setupMs = performance.now() - setupStart

  const alive = <T extends string>(ids: T[], exists: (id: T) => boolean): T[] =>
    ids.filter(exists)

  let dispatched = 0
  let noops = 0
  const perAction: Record<string, number> = {}
  const stormStart = performance.now()
  for (let i = 0; i < iterations; i++) {
    const state = store.state
    const tracksAlive = alive(myTracks, (id) => !!state.tracks[id])
    const clipsAlive = alive(myClips, (id) => !!state.clips[id])
    const pluginsAlive = alive(myPlugins, (id) => !!state.plugins[id])
    const roll = rng()

    let op: Operation | null = null
    let action = ''
    if (roll < 0.2 && tracksAlive.length > 0) {
      action = 'plugin/add'
      const pluginId = newId('plugin')
      const trackId = tracksAlive[Math.floor(rng() * tracksAlive.length)]
      myPlugins.push(pluginId)
      op = {
        type: 'plugin/add',
        instance: generatePlugin(pluginId, trackId, 1 + Math.floor(rng() * 10), rng)
      }
    } else if (roll < 0.3 && pluginsAlive.length > 0) {
      action = 'plugin/remove'
      op = { type: 'plugin/remove', instanceId: pluginsAlive[Math.floor(rng() * pluginsAlive.length)] }
    } else if (roll < 0.5 && tracksAlive.length > 0) {
      action = 'clip/create'
      const trackId = tracksAlive[Math.floor(rng() * tracksAlive.length)]
      const isMidi = store.state.tracks[trackId]?.kind === 'midi'
      const clipId = newId('clip')
      myClips.push(clipId)
      const [clip, notes] = generateClip(clipId, trackId, Math.floor(rng() * 20) * 960, isMidi, 5, null, rng)
      op = { type: 'clip/create', clip, notes }
    } else if (roll < 0.65 && clipsAlive.length > 0 && tracksAlive.length > 0) {
      action = 'clip/move'
      const clipId = clipsAlive[Math.floor(rng() * clipsAlive.length)]
      const trackId = tracksAlive[Math.floor(rng() * tracksAlive.length)]
      const clip = state.clips[clipId]
      let start = Math.floor(rng() * 7680)
      if (clip.trackId === trackId && clip.start === start) start += 480
      op = { type: 'clip/move', clipId, trackId, start }
    } else if (roll < 0.75 && clipsAlive.length > 0) {
      const candidates = clipsAlive.filter((id) => state.clips[id].duration >= 480)
      if (candidates.length > 0) {
        action = 'clip/split'
        const clipId = candidates[Math.floor(rng() * candidates.length)]
        const clip = state.clips[clipId]
        const rightClipId = newId('clip')
        myClips.push(rightClipId)
        op = {
          type: 'clip/split',
          clipId,
          at: clip.start + Math.floor(clip.duration / 2),
          rightClipId
        }
      }
    } else if (roll < 0.8 && tracksAlive.length > 5) {
      action = 'track/delete'
      op = { type: 'track/delete', trackId: tracksAlive[Math.floor(rng() * tracksAlive.length)] }
    } else if (roll < 0.9) {
      action = 'track/create'
      const trackId = newId('track')
      myTracks.push(trackId)
      op = {
        type: 'track/create',
        track: { ...generateTrack(trackId, i, rng, rng() < 0.3 ? 'midi' : 'audio'), name: `Storm+${i}` },
        index: store.state.trackOrder.length,
        clips: [],
        automation: [],
        notes: [],
        plugins: []
      }
    } else if (pluginsAlive.length > 0) {
      action = 'plugin/setEnabled'
      const instanceId = pluginsAlive[Math.floor(rng() * pluginsAlive.length)]
      op = { type: 'plugin/setEnabled', instanceId, enabled: !state.plugins[instanceId].enabled }
    }

    if (!op) continue
    dispatched++
    perAction[action] = (perAction[action] ?? 0) + 1
    if (!store.dispatch(op, 'local')) noops++
  }
  const stormMs = performance.now() - stormStart

  const violations = stateInvariantViolations(store.state)
  assertions.push(
    check('no invariant violations after the storm', violations.length === 0, violations.slice(0, 5).join('; '))
  )
  assertions.push(check('no unexpected no-ops (pre-validated actions)', noops === 0, `${noops} no-ops`))
  assertions.push(check('storm did substantial work', dispatched > iterations * 0.8, `${dispatched}/${iterations}`))

  if (!config.quiet) {
    console.log(
      `structuralStorm: ${dispatched} structural ops in ${stormMs.toFixed(0)}ms (${Math.round(dispatched / (stormMs / 1000))}/s)`
    )
  }

  return result(
    'structuralStorm',
    { iterations, seed },
    { setupMs, stormMs },
    { dispatched, noops, ...perAction },
    assertions,
    ['plugin/track/clip churn triggers engine rewires only in browser runs']
  )
}

// ---------------------------------------------------------------------------
// REMOTE delivery: at-least-once double delivery + pending-local rebase
// ---------------------------------------------------------------------------

export function stressTestRemoteDelivery(
  config: { ops?: number; quiet?: boolean } = {}
): ScenarioResult {
  const opTarget = config.ops ?? 2000
  const assertions: StressAssertion[] = []
  const rng = makeRng(0x5eed)
  const nullLink = { sendLocalOp() {} }

  // Phase A: a host builds a shared baseline, then a script of real ops.
  const buildStart = performance.now()
  const host = new ProjectStore(createEmptyProject('Remote stress'), 'host')
  const baseTracks: string[] = []
  const midiClips: string[] = []
  for (let i = 0; i < 10; i++) {
    const trackId = newId('track')
    baseTracks.push(trackId)
    const kind = i < 4 ? 'midi' : 'audio'
    host.dispatch(
      {
        type: 'track/create',
        track: generateTrack(trackId, i, rng, kind),
        index: i,
        clips: [],
        automation: [],
        notes: [],
        plugins: []
      },
      'local'
    )
    const clipId = newId('clip')
    const [clip, notes] = generateClip(clipId, trackId, 0, kind === 'midi', 10, null, rng)
    if (kind === 'midi') midiClips.push(clipId)
    host.dispatch({ type: 'clip/create', clip, notes }, 'local')
  }
  const baseline = host.state

  const envelopes: OpEnvelope[] = []
  const unsub = host.onOperation((env) => envelopes.push(env))
  const hostPlugins: string[] = []
  let attempts = 0
  while (envelopes.length < opTarget && attempts < opTarget * 3) {
    attempts++
    const state = host.state
    const tracksAlive = baseTracks.filter((id) => state.tracks[id])
    if (tracksAlive.length === 0) break
    const roll = rng()
    if (roll < 0.3) {
      const trackId = tracksAlive[Math.floor(rng() * tracksAlive.length)]
      host.dispatch(
        { type: 'track/setVolume', trackId, volume: Math.round(rng() * 100) / 100 + 0.01 },
        'local'
      )
    } else if (roll < 0.45) {
      const trackId = tracksAlive[Math.floor(rng() * tracksAlive.length)]
      host.dispatch({ type: 'track/setPan', trackId, pan: Math.round((rng() * 2 - 1) * 100) / 100 }, 'local')
    } else if (roll < 0.6) {
      const clipsAlive = midiClips.filter((id) => state.clips[id])
      if (clipsAlive.length > 0) {
        const clipId = clipsAlive[Math.floor(rng() * clipsAlive.length)]
        host.dispatch(
          {
            type: 'note/add',
            note: {
              id: newId('note'),
              clipId,
              pitch: 30 + Math.floor(rng() * 60),
              start: Math.floor(rng() * 1700),
              duration: 120,
              velocity: 1 + Math.floor(rng() * 126)
            }
          },
          'local'
        )
      }
    } else if (roll < 0.75) {
      const clipIds = Object.keys(state.clips)
      if (clipIds.length > 0) {
        const clipId = clipIds[Math.floor(rng() * clipIds.length)]
        const trackId = tracksAlive[Math.floor(rng() * tracksAlive.length)]
        host.dispatch(
          { type: 'clip/move', clipId, trackId, start: Math.floor(rng() * 30) * 480 },
          'local'
        )
      }
    } else if (roll < 0.85) {
      const pluginId = newId('plugin')
      const trackId = tracksAlive[Math.floor(rng() * tracksAlive.length)]
      hostPlugins.push(pluginId)
      host.dispatch(
        { type: 'plugin/add', instance: generatePlugin(pluginId, trackId, 1 + Math.floor(rng() * 5), rng) },
        'local'
      )
    } else if (roll < 0.92) {
      const alivePlugins = hostPlugins.filter((id) => state.plugins[id])
      if (alivePlugins.length > 0) {
        host.dispatch(
          { type: 'plugin/remove', instanceId: alivePlugins[Math.floor(rng() * alivePlugins.length)] },
          'local'
        )
      }
    } else if (tracksAlive.length > 6) {
      host.dispatch(
        { type: 'track/delete', trackId: tracksAlive[Math.floor(rng() * tracksAlive.length)] },
        'local'
      )
    }
  }
  unsub()
  const buildMs = performance.now() - buildStart
  const scriptOps = envelopes.length

  // Phase B: single-delivery control client.
  const singleStart = performance.now()
  const control = new ProjectStore(baseline, 'control')
  control.attachSession(nullLink)
  for (const env of envelopes) control.receiveAuthoritative(env)
  const singleMs = performance.now() - singleStart

  // Phase C: EVERY envelope delivered TWICE (at-least-once transport).
  const doubleStart = performance.now()
  const doubled = new ProjectStore(baseline, 'doubled')
  doubled.attachSession(nullLink)
  for (const env of envelopes) {
    doubled.receiveAuthoritative(env)
    doubled.receiveAuthoritative(env)
  }
  const doubleMs = performance.now() - doubleStart

  assertions.push(
    check('double delivery converges with single delivery', deepEqual(doubled.state, control.state))
  )
  assertions.push(check('client converges with the host document', deepEqual(control.state, host.state)))
  assertions.push(
    check(
      'op log deduplicates re-delivered envelopes',
      doubled.opLog.length === scriptOps,
      `${doubled.opLog.length} vs ${scriptOps}`
    )
  )

  // Phase D: pending-local rebase — a client with unconfirmed local edits
  // receives interleaved remote + own (echoed) envelopes, each twice.
  const rebaseStart = performance.now()
  const sent: OpEnvelope[] = []
  const client = new ProjectStore(baseline, 'clientB')
  client.attachSession({ sendLocalOp: (e) => sent.push(e) })
  const clientOps = Math.max(10, Math.min(60, Math.floor(opTarget / 20)))
  for (let i = 0; i < clientOps; i++) {
    const trackId = baseTracks[i % baseTracks.length]
    const current = client.state.tracks[trackId]?.volume ?? 1
    client.dispatch(
      { type: 'track/setVolume', trackId, volume: current === 0.77 ? 0.66 : 0.77 },
      'local'
    )
  }
  const pendingBefore = client.pendingOps.length
  assertions.push(check('client ops are pending before confirmation', pendingBefore === clientOps, `${pendingBefore}`))

  // Authoritative order: a client envelope after every 10th host envelope.
  const authoritative: OpEnvelope[] = []
  let sentIdx = 0
  for (let i = 0; i < envelopes.length; i++) {
    authoritative.push(envelopes[i])
    if (i % 10 === 9 && sentIdx < sent.length) authoritative.push(sent[sentIdx++])
  }
  while (sentIdx < sent.length) authoritative.push(sent[sentIdx++])

  const reference = new ProjectStore(baseline, 'reference')
  reference.attachSession(nullLink)
  for (const env of authoritative) reference.receiveAuthoritative(env)
  for (const env of authoritative) {
    client.receiveAuthoritative(env)
    client.receiveAuthoritative(env)
  }
  const rebaseMs = performance.now() - rebaseStart

  assertions.push(check('pending drained after all confirmations', client.pendingOps.length === 0, `${client.pendingOps.length} left`))
  assertions.push(
    check('rebased client converges with the reference order', deepEqual(client.state, reference.state))
  )

  const delivered = scriptOps * 2 + authoritative.length * 2 + authoritative.length
  const throughput = Math.round(
    (scriptOps * 2 + authoritative.length * 2) / ((doubleMs + rebaseMs) / 1000)
  )

  if (!config.quiet) {
    console.log(
      `remoteDelivery: ${scriptOps} script ops, ${delivered} deliveries, ~${throughput} envelopes/s (double+rebase phases)`
    )
  }

  return result(
    'remoteDelivery',
    { ops: opTarget },
    { buildMs, singleMs, doubleMs, rebaseMs },
    { scriptOps, clientOps, envelopesDelivered: delivered, envelopesPerSecond: throughput },
    assertions,
    ['self-contained stores — does not touch the live project document']
  )
}

// ---------------------------------------------------------------------------
// Op-log fold: drive past LOG_LIMIT, verify origin + log reproduces the doc
// ---------------------------------------------------------------------------

export function stressTestOpLogFold(
  config: { quiet?: boolean } = {}
): ScenarioResult {
  const assertions: StressAssertion[] = []
  const rng = makeRng(0xf07d)
  const store = new ProjectStore(createEmptyProject('Fold stress'), 'folder')
  const trackA = newId('track')
  const trackB = newId('track')
  for (const [i, id] of [trackA, trackB].entries()) {
    store.dispatch(
      {
        type: 'track/create',
        track: generateTrack(id, i, rng, i === 0 ? 'midi' : 'audio'),
        index: i,
        clips: [],
        automation: [],
        notes: [],
        plugins: []
      },
      'local'
    )
  }
  const clipId = newId('clip')
  const [clip, notes] = generateClip(clipId, trackA, 0, true, 20, null, rng)
  store.dispatch({ type: 'clip/create', clip, notes }, 'local')

  // Alternating real changes until the log folds (LOG_LIMIT internal to the
  // store — detected empirically as the first length DROP), plus tail room.
  const totalStart = performance.now()
  let foldMs = -1
  let logBefore = -1
  let logAfter = -1
  let dispatches = 0
  const cap = 30000
  let tail = 200
  while (dispatches < cap && tail > 0) {
    const before = store.opLog.length
    const current = store.state.tracks[trackA]?.volume ?? 1
    const t0 = performance.now()
    store.dispatch(
      { type: 'track/setVolume', trackId: trackA, volume: current === 0.5 ? 0.6 : 0.5 },
      'local'
    )
    const dt = performance.now() - t0
    dispatches++
    const after = store.opLog.length
    if (after < before) {
      foldMs = dt
      logBefore = before
      logAfter = after
    }
    if (foldMs >= 0) tail--
  }
  const totalMs = performance.now() - totalStart

  assertions.push(check('fold occurred within the dispatch budget', foldMs >= 0, `no fold in ${dispatches} dispatches`))
  assertions.push(check('fold shrank the log', logAfter < logBefore, `${logBefore} -> ${logAfter}`))

  // The load-bearing invariant: origin + log reproduces the document.
  const replayStart = performance.now()
  let replayed = store.lineage.origin
  for (const env of store.opLog) replayed = apply(replayed, env.op)
  const replayMs = performance.now() - replayStart
  assertions.push(
    check('origin + op log reproduces the confirmed document', deepEqual(replayed, store.confirmedState))
  )
  assertions.push(
    check('state invariants hold after the fold', stateInvariantViolations(store.state).length === 0)
  )

  if (!config.quiet) {
    console.log(
      `opLogFold: ${dispatches} dispatches in ${totalMs.toFixed(0)}ms; fold ${logBefore} -> ${logAfter} took ${foldMs.toFixed(1)}ms; replay ${replayMs.toFixed(0)}ms`
    )
  }

  return result(
    'opLogFold',
    {},
    { totalMs, foldDispatchMs: foldMs, replayMs },
    { dispatches, logBefore, logAfter },
    assertions,
    ['self-contained store — does not touch the live project document']
  )
}

// ---------------------------------------------------------------------------
// Persistence at scale: serialize + parse the (giant) live document
// ---------------------------------------------------------------------------

export function stressTestPersistence(
  store: ProjectStore,
  config: { quiet?: boolean } = {}
): ScenarioResult {
  const assertions: StressAssertion[] = []
  const state = store.state

  const serializeStart = performance.now()
  const stateJson = serializeProjectJson(state, [])
  const serializeMs = performance.now() - serializeStart

  const serializeFullStart = performance.now()
  const fullJson = serializeProjectJson(state, [], store.lineage, store.opLog)
  const serializeFullMs = performance.now() - serializeFullStart

  const parseStart = performance.now()
  const parsed = parseProjectJson(stateJson)
  const parseMs = performance.now() - parseStart

  const parseFullStart = performance.now()
  const parsedFull = parseProjectJson(fullJson)
  const parseFullMs = performance.now() - parseFullStart

  assertions.push(check('state round-trips exactly', deepEqual(parsed.state, state)))
  assertions.push(
    check('full file (lineage + op log) state round-trips exactly', deepEqual(parsedFull.state, state))
  )
  assertions.push(
    check(
      'op log survives the round trip',
      (parsedFull.opLog?.length ?? 0) === store.opLog.length,
      `${parsedFull.opLog?.length} vs ${store.opLog.length}`
    )
  )

  const counts = {
    tracks: Object.keys(state.tracks).length,
    clips: Object.keys(state.clips).length,
    notes: Object.keys(state.notes).length,
    plugins: Object.keys(state.plugins).length,
    automation: Object.keys(state.automation).length,
    routes: Object.keys(state.routes).length,
    logEntries: store.opLog.length,
    stateBytes: stateJson.length,
    fullBytes: fullJson.length
  }

  if (!config.quiet) {
    console.log(
      `persistence: state ${(stateJson.length / 1024 / 1024).toFixed(2)}MB serialize ${serializeMs.toFixed(0)}ms / parse ${parseMs.toFixed(0)}ms; full ${(fullJson.length / 1024 / 1024).toFixed(2)}MB serialize ${serializeFullMs.toFixed(0)}ms / parse ${parseFullMs.toFixed(0)}ms`
    )
  }

  return result(
    'persistence',
    {},
    { serializeMs, parseMs, serializeFullMs, parseFullMs },
    counts,
    assertions
  )
}

// ---------------------------------------------------------------------------
// The whole suite, returning a machine-readable aggregate
// ---------------------------------------------------------------------------

export interface StressSuiteResult {
  startedAt: string
  totalMs: number
  passed: boolean
  failures: string[]
  /**
   * Scenarios the suite was asked to run but could not (playback without
   * a transport, frame probes in a hidden tab). Distinct from failures —
   * passed can be true with skips, but the caller sees exactly what ran.
   */
  skippedScenarios: string[]
  results: Record<string, unknown>
}

export async function runAllStressTests(
  store: ProjectStore,
  options: { generate?: Partial<StressTestConfig>; quiet?: boolean } = {}
): Promise<StressSuiteResult> {
  const quiet = options.quiet ?? false
  const startedAt = new Date().toISOString()
  const suiteStart = performance.now()
  const results: Record<string, unknown> = {}
  const failures: string[] = []
  const skippedScenarios: string[] = []

  const record = (name: string, r: ScenarioResult): void => {
    results[name] = r
    if (!r.passed) {
      for (const a of r.assertions.filter((x) => !x.passed)) {
        failures.push(`${name}: ${a.name}${a.detail ? ` (${a.detail})` : ''}`)
      }
    }
  }
  const guard = async (name: string, fn: () => ScenarioResult | Promise<ScenarioResult>): Promise<void> => {
    try {
      record(name, await fn())
    } catch (e) {
      failures.push(`${name}: threw ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Generation is asserted against the request, not just recorded — the
  // store may hold a pre-existing project, so compare GROWTH to expected.
  const genConfig = { ...DEFAULT_CONFIG, quiet, ...options.generate }
  const before = {
    tracks: Object.keys(store.state.tracks).length,
    plugins: Object.keys(store.state.plugins).length,
    clips: Object.keys(store.state.clips).length,
    notes: Object.keys(store.state.notes).length
  }
  try {
    const generation = await generateStressProject(store, genConfig)
    results.generation = generation
    const midiTracks = Math.ceil(genConfig.trackCount / 3) // every 3rd generated track
    const expected = {
      tracks: genConfig.trackCount,
      plugins: genConfig.trackCount * genConfig.effectsPerTrack,
      clips: genConfig.trackCount * genConfig.clipsPerTrack,
      notes: midiTracks * genConfig.clipsPerTrack * genConfig.notesPerClip
    }
    const grew = {
      tracks: generation.verified.tracksInState - before.tracks,
      plugins: generation.verified.pluginsInState - before.plugins,
      clips: generation.verified.clipsInState - before.clips,
      notes: generation.verified.notesInState - before.notes
    }
    for (const key of ['tracks', 'plugins', 'clips', 'notes'] as const) {
      if (grew[key] !== expected[key]) {
        failures.push(`generation: ${key} grew by ${grew[key]}, requested ${expected[key]}`)
      }
    }
  } catch (e) {
    failures.push(`generation: threw ${e instanceof Error ? e.message : String(e)}`)
  }
  results.memory = capturePerformanceMetrics()

  const browser = typeof requestAnimationFrame === 'function'
  if (browser) {
    try {
      const framePerf = await measureFramePerformance(3000)
      results.framePerf = framePerf
      if (framePerf.aborted) skippedScenarios.push(`framePerf: aborted (tab ${framePerf.aborted})`)
    } catch (e) {
      failures.push(`framePerf: threw ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      const playback = await stressTestPlayback(store, 3)
      results.playback = playback
      if (playback.aborted) skippedScenarios.push(`playback: aborted (tab ${playback.aborted})`)
    } catch (e) {
      const reason = String(e instanceof Error ? e.message : e)
      results.playback = { skipped: reason }
      skippedScenarios.push(`playback: ${reason}`)
    }
  } else {
    skippedScenarios.push('framePerf: headless (no requestAnimationFrame)')
    skippedScenarios.push('playback: headless (no requestAnimationFrame)')
  }

  await guard('undoRedo', () => stressTestUndoRedo(store, { quiet }))
  await guard('dispatchThroughput', () => stressTestDispatchThroughput(store, { quiet }))
  await guard('routing', () => stressTestRouting(store, { quiet }))
  await guard('folderNesting', () => stressTestFolderNesting(store, { quiet }))
  await guard('automation', () => stressTestAutomation(store, { quiet }))
  await guard('densePianoRoll', () => stressTestDensePianoRoll(store, { quiet }))
  await guard('structuralStorm', () => stressTestStructuralStorm(store, { quiet }))
  await guard('remoteDelivery', () => stressTestRemoteDelivery({ quiet }))
  await guard('opLogFold', () => stressTestOpLogFold({ quiet }))
  await guard('persistence', () => stressTestPersistence(store, { quiet }))

  const totalMs = Math.round(performance.now() - suiteStart)
  const suite: StressSuiteResult = {
    startedAt,
    totalMs,
    passed: failures.length === 0,
    failures,
    skippedScenarios,
    results
  }
  if (!quiet) {
    const skips = skippedScenarios.length > 0 ? ` (${skippedScenarios.length} skipped)` : ''
    console.log(
      failures.length === 0
        ? `STRESS SUITE PASSED in ${totalMs}ms${skips}`
        : `STRESS SUITE FAILURES (${failures.length})${skips}:\n${failures.join('\n')}`
    )
    for (const s of skippedScenarios) console.log(`  skipped ${s}`)
  }
  return suite
}
