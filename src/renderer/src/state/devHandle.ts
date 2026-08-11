import { projectStore } from './projectStore'
import { transport } from './transport'
import { collab } from './collab'
import { recording } from './recording'
import { midiInputs } from './midiInputs'
import { panels } from './panels'
import { preferences } from './preferences'
import { audioEngine, assetStore } from './audioInstance'
import {
  generateStressProject,
  capturePerformanceMetrics,
  measureFramePerformance,
  stressTestPlayback,
  stressTestUndoRedo,
  stressTestConcurrency,
  runAllStressTests
} from '../../../core/stressTest'

/**
 * Dev-only debug handle: the LIVE singletons, immune to module-graph
 * duplication when tools dynamically import modules by URL. Loaded from
 * main.tsx in dev builds only.
 */
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__superdaw = {
    projectStore,
    transport,
    collab,
    recording,
    panels,
    audioEngine,
    assetStore,
    preferences,
    midiInputs,
    // MIDI without hardware: raw bytes through the real input path.
    midi: {
      inject: (data: number[], timeStampMs?: number) => midiInputs.inject(data, timeStampMs)
    },
    // Stress testing utilities
    stressTest: {
      generate: (config?: any) => generateStressProject(projectStore, config),
      memory: capturePerformanceMetrics,
      framePerf: measureFramePerformance,
      playback: (duration?: number) => stressTestPlayback(projectStore, duration),
      undoRedo: () => stressTestUndoRedo(projectStore),
      concurrency: () => stressTestConcurrency(projectStore),
      runAll: () => runAllStressTests(projectStore)
    }
  }
}

export {}
