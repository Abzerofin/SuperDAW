/**
 * Loopback latency calibration — the runtime half. Plays the reference
 * sweep at a known stream time and locates it in the captured input (math
 * in calibration.ts). Measures the ACTUAL current path — scheduling → DAC
 * → cable/air → ADC → capture — which is exactly the path recorded takes
 * travel, so the result is precisely the compensation recording placement
 * needs.
 *
 * It runs entirely on the backend seam, so the SAME code measures the Web
 * Audio path and the native duplex one; the native run simply reports a
 * much smaller round trip (§7). The capture reuses the recorder, whose
 * announced `startSec` — the stream time of the first captured sample —
 * anchors the correlation peak back onto the clock.
 */

import type { IAudioBackend, InputHandle } from './backend'
import { Recorder } from './recorder'
import { CHIRP_SECONDS, MAX_LAG_SEC, findChirp, generateChirp } from './calibration'

/** Capture spin-up margin before the sweep is scheduled. */
const PRE_ROLL_SEC = 0.35
/** Extra capture beyond the largest plausible lag. */
const TAIL_SEC = 0.15
/** Sweep level: clearly audible through a cable or a speaker, never harsh. */
const STIMULUS_GAIN = 0.5

export interface LoopbackMeasurement {
  /** Scheduled play time → capture arrival, on the stream clock. */
  readonly roundTripSec: number
  /** Peak-to-sidelobe ratio of the detection (gate before trusting). */
  readonly confidence: number
}

function wait(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

let sweepCounter = 0

/**
 * One pass: play the sweep, capture every supplied input, correlate.
 * Callers hand in one handle per channel pair they want searched, and the
 * clearest detection across all of them wins — so a loopback cable
 * plugged into ANY input of an interface is found.
 *
 * `sink` is where the stimulus plays; it defaults to the backend's OUTPUT
 * node rather than the master gain, so the master fader's position cannot
 * decide whether calibration hears itself. It stays a parameter as a test
 * seam (the midiInputs.inject precedent): wire sink → delay → input and
 * the measurement must report the delay.
 */
export async function measureLoopbackOnce(
  backend: IAudioBackend,
  inputs: readonly InputHandle[],
  sink: number = backend.outputNode()
): Promise<LoopbackMeasurement> {
  const handles = inputs
  if (handles.length === 0) throw new Error('No audio input is open')
  const sampleRate = handles[0].sampleRate
  if (!(sampleRate > 0)) throw new Error('The input reported no sample rate')

  const reference = generateChirp(sampleRate)
  const recorders = handles.map((handle) => {
    const recorder = new Recorder()
    recorder.start(handle)
    return recorder
  })

  // Registered at the STREAM rate so the voice plays it 1:1 — the sweep's
  // own timebase is what the lag is measured in.
  const bufferId = `superdaw-calibration-${++sweepCounter}`
  backend.registerBuffer(bufferId, [reference], sampleRate)
  const gain = backend.createNode('gain')
  backend.scheduleParam(gain, 'gain', [{ kind: 'setValue', value: STIMULUS_GAIN, time: 0 }])
  backend.connect(gain, sink)

  const startAt = backend.now() + PRE_ROLL_SEC
  const voice = backend.play({ bufferId, when: startAt, destination: gain })
  try {
    await wait(PRE_ROLL_SEC + CHIRP_SECONDS + MAX_LAG_SEC + TAIL_SEC)
  } finally {
    if (voice !== null) backend.stopVoice(voice)
    backend.disconnect(gain)
    backend.disposeNode(gain)
    backend.releaseBuffer(bufferId)
  }

  const takes = await Promise.all(recorders.map((recorder) => recorder.stop()))
  const anchored = takes.filter((take) => take !== null && take.startSec !== null)
  if (anchored.length === 0) throw new Error('No audio arrived from the input device')

  let best: { arrivalSec: number; confidence: number } | null = null
  for (const take of anchored) {
    for (const channel of take!.channels) {
      const match = findChirp(channel, reference, take!.sampleRate)
      if (!match) continue
      if (best === null || match.confidence > best.confidence) {
        best = {
          arrivalSec: take!.startSec! + match.lagSamples / take!.sampleRate,
          confidence: match.confidence
        }
      }
    }
  }
  if (!best) throw new Error('The captured audio was shorter than the test tone')
  return { roundTripSec: best.arrivalSec - startAt, confidence: best.confidence }
}
