import { projectStore } from './projectStore'
import { transport } from './transport'
import { collab } from './collab'
import { recording } from './recording'
import { midiInputs } from './midiInputs'
import { panels } from './panels'
import { preferences } from './preferences'
import { audioEngine, assetStore } from './audioInstance'
import { encodeWavPcm16 } from '@audio/wav'
import {
  generateStressProject,
  capturePerformanceMetrics,
  measureFramePerformance,
  stressTestPlayback,
  stressTestUndoRedo,
  stressTestDispatchThroughput,
  stressTestRouting,
  stressTestFolderNesting,
  stressTestAutomation,
  stressTestDensePianoRoll,
  stressTestStructuralStorm,
  stressTestRemoteDelivery,
  stressTestOpLogFold,
  stressTestPersistence,
  runAllStressTests,
  type StressTestConfig
} from '../../../core/stressTest'

/**
 * Dev-only debug handle: the LIVE singletons, immune to module-graph
 * duplication when tools dynamically import modules by URL. Loaded from
 * main.tsx in dev builds only.
 */

/**
 * Synthetic audio assets for stress runs, so generated audio clips
 * reference REAL registered buffers instead of dangling ids (which made
 * audio-playback stress hollow). Registered via addAudio — origin 'local'
 * — so an active collab session announces them to peers like recorded or
 * imported audio (restore() tags 'restored', which attachAssetOffers
 * ignores, leaving remote stress clips silent). addAudio mints ids, so
 * reuse across runs is by name lookup instead of a fixed id.
 * Feature-detected: absent AudioBuffer (old browsers) just means empty
 * audio clips, same as headless runs.
 */
function ensureStressAssets(): string[] {
  const ids: string[] = []
  if (typeof AudioBuffer === 'undefined') return ids
  try {
    const sampleRate = 48000
    for (let k = 0; k < 4; k++) {
      const name = `Stress tone ${k + 1}`
      const existing = assetStore.all().find((a) => a.kind === 'audio' && a.name === name)
      if (existing) {
        ids.push(existing.id)
        continue
      }
      const length = sampleRate // 1 second
      const data = new Float32Array(length)
      const freq = 110 * (k + 1)
      for (let i = 0; i < length; i++) {
        const env = Math.min(1, i / 480, (length - i) / 4800)
        data[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.4 * env
      }
      const buffer = new AudioBuffer({ numberOfChannels: 1, length, sampleRate })
      buffer.copyToChannel(data, 0)
      const encoded = encodeWavPcm16([data], sampleRate)
      ids.push(assetStore.addAudio(name, 'wav', encoded, buffer).id)
    }
  } catch {
    return []
  }
  return ids
}

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
    // Stress testing utilities — every scenario returns structured JSON.
    stressTest: {
      generate: (config?: Partial<StressTestConfig>) =>
        generateStressProject(projectStore, { audioAssetIds: ensureStressAssets(), ...config }),
      memory: capturePerformanceMetrics,
      framePerf: measureFramePerformance,
      playback: (duration?: number) => stressTestPlayback(projectStore, duration),
      undoRedo: (config?: { operations?: number }) => stressTestUndoRedo(projectStore, config),
      dispatchThroughput: (config?: { operations?: number }) =>
        stressTestDispatchThroughput(projectStore, config),
      routing: (config?: { tracks?: number; pluginsPerTrack?: number }) =>
        stressTestRouting(projectStore, config),
      folders: (config?: { trees?: number; depth?: number }) =>
        stressTestFolderNesting(projectStore, config),
      automation: (config?: { points?: number; moves?: number }) =>
        stressTestAutomation(projectStore, config),
      pianoRoll: (config?: { notes?: number; storms?: number }) =>
        stressTestDensePianoRoll(projectStore, config),
      structuralStorm: (config?: { iterations?: number; seed?: number }) =>
        stressTestStructuralStorm(projectStore, config),
      remoteDelivery: (config?: { ops?: number }) => stressTestRemoteDelivery(config),
      logFold: () => stressTestOpLogFold(),
      persistence: () => stressTestPersistence(projectStore),
      runAll: (options?: { generate?: Partial<StressTestConfig> }) =>
        runAllStressTests(projectStore, {
          ...options,
          generate: { audioAssetIds: ensureStressAssets(), ...options?.generate }
        })
    }
  }
}

export {}
