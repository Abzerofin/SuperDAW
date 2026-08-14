import { NativeAudioBackend } from '@audio/nativeBackend'
import type { HostEvent, PortLike } from '@audio/hostProtocol'
import { audioEngine } from './audioInstance'
import { preferences } from './preferences'
import { statusNotice } from './statusNotice'

/**
 * Native-backend lifecycle (Settings ▸ Audio ▸ Audio system, experimental;
 * docs/NATIVE_AUDIO_BACKEND.md §5). Boot flow when the preference says
 * native: acquire the audio utilityProcess, receive the direct
 * MessagePort (via the preload's window.postMessage relay), send 'start',
 * and only once 'started' arrives hand the engine a backend factory —
 * which is what lets the backend answer start() synchronously with real
 * stream facts. Every failure path falls back to Web Audio with a
 * status-bar notice, never a popup; a dead audio process does the same
 * mid-session through the engine's resetBackend.
 *
 * The preference applies at LAUNCH (like the latency hint): the engine
 * has no mid-session backend migration, and pretending otherwise would
 * glitch the very playback the native path exists to protect.
 */

const START_TIMEOUT_MS = 4000

let active: NativeAudioBackend | null = null

export function nativeAudioActive(): boolean {
  return active !== null
}

export function initNativeAudio(): void {
  // Headless (tests) and the browser build have no bridge and no port.
  if (typeof window === 'undefined') return
  const bridge = window.superdaw
  if (!bridge || preferences.audioSystem !== 'native') return

  const fallback = (reason: string): void => {
    active = null
    statusNotice.show(`Native audio unavailable — using Web Audio (${reason}).`)
  }

  // The port arrives from the preload relay; arm the listener FIRST so
  // the acquire's port can never race past us.
  const onPort = (event: MessageEvent): void => {
    if (event.data !== 'audiohost:port' || !event.ports[0]) return
    window.removeEventListener('message', onPort)
    const raw = event.ports[0]
    const port: PortLike = {
      postMessage: (message) => raw.postMessage(message),
      onMessage: (listener) => {
        raw.onmessage = (e) => listener(e.data)
      },
      start: () => raw.start()
    }

    const backend = new NativeAudioBackend(port)
    let settled = false
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        void bridge.audioHostRelease()
        fallback('the audio process did not start in time')
      }
    }, START_TIMEOUT_MS)

    // First event decides: 'started' arms the engine, 'startFailed' falls
    // back. The backend's own listener keeps consuming frames afterwards.
    const decide = (e: MessageEvent): void => {
      const data = e.data as HostEvent
      if (settled || (data.t !== 'started' && data.t !== 'startFailed')) return
      settled = true
      clearTimeout(timeout)
      raw.removeEventListener('message', decide)
      if (data.t === 'startFailed') {
        void bridge.audioHostRelease()
        fallback(data.message)
        return
      }
      backend.adoptStreamInfo(data.info, data.latencySec)
      active = backend
      audioEngine.setBackendFactory(() => backend)
      statusNotice.show(
        `Native audio active (WASAPI${data.info.exclusive ? ' exclusive' : ''}, ` +
          `${data.info.sampleRate} Hz, ${data.info.periodFrames}-frame periods). ` +
          'VST3 inserts play live, delay-compensated. Experimental: recording and ' +
          'input monitoring are unavailable here and need Web Audio.'
      )
    }
    raw.addEventListener('message', decide)
    raw.start()
    port.postMessage({ t: 'start', opts: {} })
  }
  window.addEventListener('message', onPort)

  bridge.onAudioHostExited(() => {
    if (active === null) return
    active = null
    // Backend gone: rebuild the engine's world on Web Audio at next use.
    audioEngine.resetBackend(null)
    statusNotice.show('The native audio process stopped — switched back to Web Audio.')
  })

  void bridge.audioHostAcquire().then((result) => {
    if (result.error) {
      window.removeEventListener('message', onPort)
      fallback(result.error)
    }
  })
}
