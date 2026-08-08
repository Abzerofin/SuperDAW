import { AudioEngine } from '@audio/engine'
import { AssetStore } from '@audio/assets'
import { projectStore } from './projectStore'
import { transport } from './transport'
import {
  externalPluginHost,
  scanExternalPlugins,
  subscribeExternalPlugins
} from './externalPlugins'

export const assetStore = new AssetStore()
export const audioEngine = new AudioEngine(projectStore, transport, assetStore)

// Live VST3 preview needs the out-of-process host. The scan is async and
// Electron-only; in the browser build the host stays null and external
// inserts are silent until frozen, exactly as before.
subscribeExternalPlugins(() => audioEngine.setExternalHost(externalPluginHost()))
void scanExternalPlugins()
