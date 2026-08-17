/**
 * Main-process manager for the audio utilityProcess (NATIVE_AUDIO_BACKEND
 * §5). Main's only jobs: spawn the worker with the addon paths, hand one
 * end of a MessageChannelMain to it and the other to the renderer (so
 * control traffic skips main entirely), keep it supplied with the plugin
 * index, and watch for exits — the crash signal the renderer answers by
 * falling back to Web Audio.
 *
 * The plugin index (uid → bundle path) goes over the worker's OWN port,
 * never the renderer's: a plugin's filesystem path is main's to know and
 * must not enter the renderer or the document.
 */

import { ipcMain, MessageChannelMain, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { resolveAddonPath, resolveAudiohostPath } from './addonPath'
import { currentPlugins, ensureScanned, subscribePluginIndex } from './pluginScan'
import type { HostPluginIndex } from '../audio/hostProtocol'

let worker: UtilityProcess | null = null

function pluginIndex(): HostPluginIndex {
  const paths: Record<string, string> = {}
  // vst3 only: the audio process's live host is vst3host — a CLAP path in
  // this index would be loaded by the wrong ABI (CLAP is scan-only, C1).
  for (const plugin of currentPlugins()) {
    if (plugin.format === 'vst3') paths[plugin.uid] = plugin.path
  }
  return { t: 'plugins', paths }
}

export function registerAudioHost(): void {
  // A rescan can add or remove a plugin the audio process is asked for
  // next; keep its index in step. No-op while no audio process is up.
  subscribePluginIndex(() => worker?.postMessage(pluginIndex()))

  ipcMain.handle('audiohost:acquire', async (event) => {
    const addonPath = resolveAudiohostPath()
    if (!addonPath) return { error: 'audiohost addon not found' }

    // One audio process per app; a re-acquire (renderer reload) recycles it
    // so two processes never contend for the device.
    if (worker) {
      worker.kill()
      worker = null
    }
    // The audio process hosts live VST3 inserts, so it needs the scan
    // before it can resolve one. Waiting here costs a first-launch beat and
    // saves every insert reporting "not installed" until a later refresh.
    await ensureScanned()
    try {
      worker = utilityProcess.fork(
        join(__dirname, 'audioHostWorker.js'),
        // vst3host is optional: an unbuilt addon leaves external inserts
        // bypassing, exactly as they do under the Web Audio backend.
        [addonPath, resolveAddonPath() ?? ''],
        { stdio: 'ignore' }
      )
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }

    const sender = event.sender
    worker.once('exit', () => {
      worker = null
      // The renderer resets its engine onto Web Audio and posts a notice.
      if (!sender.isDestroyed()) sender.send('audiohost:exited')
    })

    const { port1, port2 } = new MessageChannelMain()
    worker.postMessage(pluginIndex())
    worker.postMessage(null, [port1])
    sender.postMessage('audiohost:port', null, [port2])
    return {}
  })

  ipcMain.handle('audiohost:release', () => {
    worker?.kill()
    worker = null
  })
}

export function shutdownAudioHost(): void {
  worker?.kill()
  worker = null
}
