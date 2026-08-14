/**
 * Main-process manager for the audio utilityProcess (NATIVE_AUDIO_BACKEND
 * §5). Main's only jobs: spawn the worker with the addon path, hand one
 * end of a MessageChannelMain to it and the other to the renderer (so
 * control traffic skips main entirely), and watch for exits — the crash
 * signal the renderer answers by falling back to Web Audio.
 */

import { ipcMain, MessageChannelMain, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { resolveAudiohostPath } from './addonPath'

let worker: UtilityProcess | null = null

export function registerAudioHost(): void {
  ipcMain.handle('audiohost:acquire', (event) => {
    const addonPath = resolveAudiohostPath()
    if (!addonPath) return { error: 'audiohost addon not found' }

    // One audio process per app; a re-acquire (renderer reload) recycles it
    // so two processes never contend for the device.
    if (worker) {
      worker.kill()
      worker = null
    }
    try {
      worker = utilityProcess.fork(join(__dirname, 'audioHostWorker.js'), [addonPath], {
        stdio: 'ignore'
      })
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
