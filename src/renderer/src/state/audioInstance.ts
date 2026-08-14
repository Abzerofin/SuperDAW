import { AudioEngine } from '@audio/engine'
import { AssetStore } from '@audio/assets'
import { projectStore } from './projectStore'
import { transport } from './transport'
import { preferences } from './preferences'
import {
  externalPluginHost,
  scanExternalPlugins,
  subscribeExternalPlugins
} from './externalPlugins'

export const assetStore = new AssetStore()
export const audioEngine = new AudioEngine(projectStore, transport, assetStore)

// Buffer-size request (Settings ▸ Audio). Read lazily when the context is
// created — always after the preferences store has loaded, since a user
// gesture starts the engine.
audioEngine.setLatencyHintProvider(() => preferences.latencyHint)

// Live VST3 preview needs the out-of-process host. The scan is async and
// Electron-only; in the browser build the host stays null and external
// inserts are silent until frozen, exactly as before.
subscribeExternalPlugins(() => audioEngine.setExternalHost(externalPluginHost()))
void scanExternalPlugins()

// Native backend (Settings ▸ Audio ▸ Audio system, Electron only): decided
// once the stored preference is known — dynamic import breaks the module
// cycle (nativeAudio needs audioEngine).
void preferences.ready.then(async () => {
  const { initNativeAudio } = await import('./nativeAudio')
  initNativeAudio()
})
