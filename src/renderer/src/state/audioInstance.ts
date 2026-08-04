import { AudioEngine } from '@audio/engine'
import { AssetStore } from '@audio/assets'
import { projectStore } from './projectStore'
import { transport } from './transport'

export const assetStore = new AssetStore()
export const audioEngine = new AudioEngine(projectStore, transport, assetStore)
