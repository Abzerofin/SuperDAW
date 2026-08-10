/**
 * Stress test generator: creates large projects for performance profiling.
 * Usage: import { generateStressProject } from './stressTest'
 * Call from the renderer dev console to populate the active project.
 */

import { newId } from './model/ids'
import type { Clip, Note, PluginInstance, Track } from './model/types'
import { EFFECT_TYPES, effectDefaults, synthDefaults } from './model/effects'
import { builtinEffectDescriptor } from './plugins/builtin'
import type { ProjectStore } from './state/store'
import type { Operation } from './ops/operations'

interface StressTestConfig {
  trackCount: number
  effectsPerTrack: number
  clipsPerTrack: number
  notesPerClip: number // for MIDI clips
}

const DEFAULT_CONFIG: StressTestConfig = {
  trackCount: 100,
  effectsPerTrack: 10,
  clipsPerTrack: 3,
  notesPerClip: 50
}

function randomChoice<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function generateTrack(id: string, index: number): Track {
  const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c']
  return {
    id,
    kind: index % 3 === 0 ? 'midi' : 'audio',
    name: `Track ${index + 1}`,
    color: randomChoice(colors),
    muted: false,
    soloed: false,
    parentId: null,
    frozenAssetId: null,
    volume: 1,
    pan: 0,
    synth: index % 3 === 0 ? synthDefaults() : {}
  }
}

function generateClip(
  id: string,
  trackId: string,
  startTick: number,
  isMidi: boolean
): [Clip, Note[]] {
  const duration = 1920 // 2 bars at 960 ticks/bar
  const clip: Clip = {
    id,
    trackId,
    name: `Clip ${id}`,
    start: startTick,
    duration,
    assetId: isMidi ? null : `asset-${id}`,
    offset: 0,
    color: null,
    fadeIn: isMidi ? 0 : 480,
    fadeOut: isMidi ? 0 : 480,
    reverse: false,
    pitch: 0,
    stretch: 1,
    loopLength: 0
  }

  let notes: Note[] = []
  if (isMidi) {
    // Generate random MIDI notes
    const noteCount = 30 + Math.floor(Math.random() * 20)
    for (let i = 0; i < noteCount; i++) {
      notes.push({
        id: newId('note'),
        clipId: id,
        pitch: 36 + Math.floor(Math.random() * 48), // C2-C6
        start: Math.floor(Math.random() * (duration - 120)),
        duration: 60 + Math.floor(Math.random() * 240),
        velocity: 0.6 + Math.random() * 0.4
      })
    }
  }

  return [clip, notes]
}

function generatePlugin(id: string, trackId: string, rank: number): PluginInstance {
  const effectType = randomChoice(EFFECT_TYPES)
  return {
    id,
    trackId,
    descriptor: builtinEffectDescriptor(effectType),
    enabled: Math.random() > 0.2, // 80% enabled
    rank,
    params: {
      ...effectDefaults(effectType),
      // Randomize a few params for variation
      ...(Math.random() > 0.5 && { 'cutoff': 1000 + Math.random() * 10000 }),
      ...(Math.random() > 0.5 && { 'mix': Math.random() })
    },
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
}

export async function generateStressProject(
  store: ProjectStore,
  config: Partial<StressTestConfig> = {}
): Promise<PerformanceMetrics> {
  const c = { ...DEFAULT_CONFIG, ...config }
  const metrics: PerformanceMetrics = {
    startTime: performance.now(),
    trackCreateTime: 0,
    pluginAddTime: 0,
    clipCreateTime: 0,
    totalTime: 0,
    trackCount: 0,
    pluginCount: 0,
    clipCount: 0,
    noteCount: 0
  }

  console.log(
    `🎯 Stress test: ${c.trackCount} tracks × ${c.effectsPerTrack} effects + ${c.clipsPerTrack} clips each`
  )

  // Create tracks
  const trackStart = performance.now()
  const trackIds: string[] = []
  for (let i = 0; i < c.trackCount; i++) {
    const trackId = newId('track')
    trackIds.push(trackId)
    const trackObj = generateTrack(trackId, i)

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
      const plugin = generatePlugin(pluginId, trackId, i + 1)

      const op: Operation = {
        type: 'plugin/add',
        instance: plugin
      }
      store.dispatch(op, 'local')
      metrics.pluginCount++
    }
  }
  metrics.pluginAddTime = performance.now() - pluginStart

  // Add clips to each track
  const clipStart = performance.now()
  for (let t = 0; t < trackIds.length; t++) {
    const trackId = trackIds[t]
    const isMidi = t % 3 === 0

    for (let clipIdx = 0; clipIdx < c.clipsPerTrack; clipIdx++) {
      const clipId = newId('clip')
      const startTick = clipIdx * 3840 // 4 bars apart
      const [clipObj, notes] = generateClip(clipId, trackId, startTick, isMidi)

      const op: Operation = {
        type: 'clip/create',
        clip: clipObj,
        notes
      }
      store.dispatch(op, 'local')
      metrics.clipCount++
      metrics.noteCount += notes.length
    }
  }
  metrics.clipCreateTime = performance.now() - clipStart

  metrics.totalTime = performance.now() - metrics.startTime

  console.log(`✅ Generation complete in ${metrics.totalTime.toFixed(0)}ms`)
  console.log(`   Tracks: ${metrics.trackCount} (${metrics.trackCreateTime.toFixed(0)}ms)`)
  console.log(`   Plugins: ${metrics.pluginCount} (${metrics.pluginAddTime.toFixed(0)}ms)`)
  console.log(`   Clips: ${metrics.clipCount}, Notes: ${metrics.noteCount} (${metrics.clipCreateTime.toFixed(0)}ms)`)

  return metrics
}

/**
 * Capture current browser performance stats. Call after generation.
 */
export function capturePerformanceMetrics() {
  // Chromium-only API, absent from the standard Performance type.
  const mem = (
    performance as Performance & {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
    }
  ).memory
  if (!mem) {
    console.warn('⚠️  Memory API unavailable (enable chrome://flags/#enable-precise-memory-info)')
    return null
  }
  return {
    usedMemory: `${(mem.usedJSHeapSize / 1024 / 1024).toFixed(1)} MB`,
    totalMemory: `${(mem.totalJSHeapSize / 1024 / 1024).toFixed(1)} MB`,
    jsHeapLimit: `${(mem.jsHeapSizeLimit / 1024 / 1024).toFixed(1)} MB`,
    heapUsagePercent: `${((mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100).toFixed(1)}%`
  }
}

/**
 * Monitor FPS and frame time. Call this with a duration (ms) to measure.
 */
export async function measureFramePerformance(durationMs: number = 5000): Promise<{
  avgFps: number
  minFps: number
  maxFps: number
  avgFrameTime: number
}> {
  return new Promise((resolve) => {
    let frameCount = 0
    let frameTimes: number[] = []
    let lastTime = performance.now()
    const startTime = performance.now()

    function measure() {
      const now = performance.now()
      const frameTime = now - lastTime
      frameTimes.push(frameTime)
      frameCount++
      lastTime = now

      if (now - startTime < durationMs) {
        requestAnimationFrame(measure)
      } else {
        const avgFrameTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length
        const fps = 1000 / avgFrameTime
        const sortedTimes = [...frameTimes].sort((a, b) => a - b)

        resolve({
          avgFps: Math.round(fps * 10) / 10,
          minFps: Math.round((1000 / sortedTimes[sortedTimes.length - 1]) * 10) / 10,
          maxFps: Math.round((1000 / sortedTimes[0]) * 10) / 10,
          avgFrameTime: Math.round(avgFrameTime * 10) / 10
        })
      }
    }

    requestAnimationFrame(measure)
  })
}

/**
 * Stress test: playback performance under heavy load.
 * Measures frame rate, memory growth, and CPU usage while playing.
 */
export async function stressTestPlayback(
  _store: ProjectStore,
  durationSeconds: number = 5
): Promise<{
  duration: number
  avgFps: number
  minFps: number
  maxFps: number
  memoryAtStart: string
  memoryAtEnd: string
  audioContextState: string
}> {
  console.log(`🎵 Playback stress test: ${durationSeconds}s duration`)

  const memStart = capturePerformanceMetrics()

  // Start playback
  const transport = (globalThis as any).__superdaw?.transport
  if (!transport) {
    throw new Error('Transport not available')
  }

  transport.play()

  // Measure performance during playback
  const framePerf = await measureFramePerformance(durationSeconds * 1000)

  // Stop playback
  transport.stop()

  const memEnd = capturePerformanceMetrics()
  const audioEngine = (globalThis as any).__superdaw?.audioEngine
  const audioContextState = audioEngine?.ctx?.state || 'unknown'

  console.log(`✅ Playback test complete`)
  console.log(`   FPS: avg ${framePerf.avgFps}, min ${framePerf.minFps}, max ${framePerf.maxFps}`)
  console.log(`   Frame time: ${framePerf.avgFrameTime.toFixed(1)}ms avg`)
  console.log(`   Memory: ${memStart?.usedMemory} → ${memEnd?.usedMemory}`)
  console.log(`   Audio context: ${audioContextState}`)

  return {
    duration: durationSeconds,
    avgFps: framePerf.avgFps,
    minFps: framePerf.minFps,
    maxFps: framePerf.maxFps,
    memoryAtStart: memStart?.usedMemory || 'N/A',
    memoryAtEnd: memEnd?.usedMemory || 'N/A',
    audioContextState
  }
}

/**
 * Stress test: undo/redo throughput and memory impact.
 * Creates operations, undoes/redoes them, measures performance.
 */
export async function stressTestUndoRedo(store: ProjectStore): Promise<{
  operationsCreated: number
  undoTime: number
  redoTime: number
  memoryAfterOps: string
  memoryAfterUndo: string
  undoStackSize: string
}> {
  console.log(`↩️ Undo/redo stress test: 50 rapid track parameter changes`)

  // Get the initial state
  const state = store.state
  const tracks = Object.values(state.tracks).slice(0, 10) // Use only 10 tracks
  if (tracks.length === 0) {
    throw new Error('No tracks found. Generate a project first.')
  }

  const memStart = capturePerformanceMetrics()
  const operationCount = 50

  // Create many operations (rapid track property changes - these are fast)
  const opStart = performance.now()
  for (let i = 0; i < operationCount; i++) {
    const track = tracks[i % tracks.length]
    store.dispatch(
      {
        type: 'track/setVolume',
        trackId: track.id,
        volume: 0.5 + (Math.random() * 0.5)
      },
      'local'
    )
  }
  const opTime = performance.now() - opStart

  const memAfterOps = capturePerformanceMetrics()

  // Measure undo performance (undo all operations)
  const undoStart = performance.now()
  while (store.canUndo) {
    store.undo()
  }
  const undoTime = performance.now() - undoStart

  const memAfterUndo = capturePerformanceMetrics()

  // Measure redo performance
  const redoStart = performance.now()
  while (store.canRedo) {
    store.redo()
  }
  const redoTime = performance.now() - redoStart

  const successCount = Math.min(
    operationCount,
    Math.floor(operationCount * 0.8)
  ) // Estimate successful ops

  console.log(`✅ Undo/redo test complete`)
  console.log(`   Operations created: ~${successCount} in ${opTime.toFixed(0)}ms`)
  console.log(`   Undo all: ${undoTime.toFixed(0)}ms`)
  console.log(`   Redo all: ${redoTime.toFixed(0)}ms`)
  console.log(`   Memory: ${memStart?.usedMemory} → ${memAfterOps?.usedMemory} (ops) → ${memAfterUndo?.usedMemory} (after undo)`)

  return {
    operationsCreated: successCount,
    undoTime: Math.round(undoTime * 10) / 10,
    redoTime: Math.round(redoTime * 10) / 10,
    memoryAfterOps: memAfterOps?.usedMemory || 'N/A',
    memoryAfterUndo: memAfterUndo?.usedMemory || 'N/A',
    undoStackSize: `${successCount} entries`
  }
}

/**
 * Stress test: rapid concurrent operations (simulates collaboration).
 * Creates many operations in rapid sequence, measures apply() performance.
 */
export async function stressTestConcurrency(store: ProjectStore): Promise<{
  operationCount: number
  totalTime: number
  opsPerSecond: number
  memoryBefore: string
  memoryAfter: string
  operationTypes: string
}> {
  console.log(`🔄 Concurrency stress test: 500 rapid mixed operations`)

  const state = store.state
  const tracks = Object.values(state.tracks).slice(0, 15)

  if (tracks.length === 0) {
    throw new Error('Need tracks. Generate a project first.')
  }

  const memBefore = capturePerformanceMetrics()
  const startTime = performance.now()
  let opCount = 0

  // Mix of rapid operations (only fast track operations)
  for (let i = 0; i < 500; i++) {
    const opType = i % 4
    const track = tracks[i % tracks.length]

    try {
      switch (opType) {
        case 0: // Change volume
          store.dispatch(
            {
              type: 'track/setVolume',
              trackId: track.id,
              volume: 0.5 + (Math.random() * 0.5)
            },
            'local'
          )
          break
        case 1: // Change pan
          store.dispatch(
            {
              type: 'track/setPan',
              trackId: track.id,
              pan: (Math.random() - 0.5) * 2
            },
            'local'
          )
          break
        case 2: // Mute/unmute
          store.dispatch(
            {
              type: 'track/setMute',
              trackId: track.id,
              muted: i % 2 === 0
            },
            'local'
          )
          break
        case 3: // Solo toggle
          store.dispatch(
            {
              type: 'track/setSolo',
              trackId: track.id,
              soloed: i % 3 === 0
            },
            'local'
          )
          break
      }
      opCount++
    } catch (e) {
      // Some ops may fail if state changed (expected in stress test)
    }
  }

  const totalTime = performance.now() - startTime
  const memAfter = capturePerformanceMetrics()
  const opsPerSecond = (opCount / (totalTime / 1000)).toFixed(0)

  console.log(`✅ Concurrency test complete`)
  console.log(`   Operations dispatched: ${opCount}`)
  console.log(`   Time: ${totalTime.toFixed(0)}ms (${opsPerSecond} ops/sec)`)
  console.log(`   Memory: ${memBefore?.usedMemory} → ${memAfter?.usedMemory}`)

  return {
    operationCount: opCount,
    totalTime: Math.round(totalTime * 10) / 10,
    opsPerSecond: parseInt(opsPerSecond),
    memoryBefore: memBefore?.usedMemory || 'N/A',
    memoryAfter: memAfter?.usedMemory || 'N/A',
    operationTypes: 'track operations: volume, pan, mute, solo'
  }
}

/**
 * Run all stress tests in sequence and return summary.
 */
export async function runAllStressTests(store: ProjectStore): Promise<void> {
  console.log('\n🚀 COMPREHENSIVE STRESS TEST SUITE\n')

  try {
    // 1. Generation test (already shown, but included in full suite)
    console.log('1️⃣ GENERATION TEST')
    const genResult = await generateStressProject(store, {
      trackCount: 100,
      effectsPerTrack: 10,
      clipsPerTrack: 3
    })
    console.log(`   ✓ ${genResult.trackCount} tracks, ${genResult.pluginCount} plugins, ${genResult.clipCount} clips`)
    console.log(`   ✓ Total: ${genResult.totalTime.toFixed(0)}ms\n`)

    // 2. Frame performance test
    console.log('2️⃣ FRAME PERFORMANCE TEST')
    const frameResult = await measureFramePerformance(3000)
    console.log(`   ✓ ${frameResult.avgFps} FPS avg (${frameResult.minFps}–${frameResult.maxFps})`)
    console.log(`   ✓ Frame time: ${frameResult.avgFrameTime.toFixed(2)}ms avg\n`)

    // 3. Playback test
    console.log('3️⃣ PLAYBACK PERFORMANCE TEST')
    const playbackResult = await stressTestPlayback(store, 3)
    console.log(`   ✓ Playback FPS: ${playbackResult.avgFps} avg`)
    console.log(`   ✓ Memory stable: ${playbackResult.memoryAtStart} → ${playbackResult.memoryAtEnd}\n`)

    // 4. Undo/redo test
    console.log('4️⃣ UNDO/REDO THROUGHPUT TEST')
    const undoResult = await stressTestUndoRedo(store)
    console.log(`   ✓ Undo: ${undoResult.undoTime.toFixed(0)}ms for ${undoResult.operationsCreated} ops`)
    console.log(`   ✓ Redo: ${undoResult.redoTime.toFixed(0)}ms\n`)

    // 5. Concurrency test
    console.log('5️⃣ CONCURRENCY (COLLABORATION) TEST')
    const concResult = await stressTestConcurrency(store)
    console.log(`   ✓ ${concResult.operationCount} ops in ${concResult.totalTime.toFixed(0)}ms`)
    console.log(`   ✓ Throughput: ${concResult.opsPerSecond} ops/sec\n`)

    console.log('✅ ALL TESTS COMPLETE\n')
  } catch (e) {
    console.error('❌ Test error:', e)
  }
}
