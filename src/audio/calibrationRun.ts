/**
 * Loopback latency calibration — the runtime half. Plays the reference
 * sweep at a known context time and locates it in the captured input
 * (math in calibration.ts). Measures the ACTUAL current path — Web Audio
 * scheduling → DAC → cable/air → ADC → getUserMedia → capture worklet —
 * which is exactly the path recorded takes travel, so the result is
 * precisely the compensation recording placement needs.
 *
 * The capture reuses the recording worklet (Recorder), whose announced
 * `startSec` — the context time of the first captured sample — is what
 * anchors the correlation peak back onto the context clock.
 */

import { Recorder } from './recorder'
import { CHIRP_SECONDS, MAX_LAG_SEC, findChirp, generateChirp } from './calibration'

/** Capture spin-up margin before the sweep is scheduled. */
const PRE_ROLL_SEC = 0.35
/** Extra capture beyond the largest plausible lag. */
const TAIL_SEC = 0.15
/** Sweep level: clearly audible through a cable or a speaker, never harsh. */
const STIMULUS_GAIN = 0.5

export interface LoopbackMeasurement {
  /** Scheduled play time → capture arrival, on the context clock. */
  readonly roundTripSec: number
  /** Peak-to-sidelobe ratio of the detection (gate before trusting). */
  readonly confidence: number
}

function wait(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

/**
 * One pass: play the sweep, capture `input`, correlate. The input node is
 * the caller's (normally a MediaStreamAudioSourceNode over the recording
 * device); every channel is searched and the clearest detection wins, so
 * a loopback cable plugged into ANY input of an interface is found.
 *
 * `sink` is where the stimulus plays — the context destination in real
 * use. It exists as a seam (the midiInputs.inject precedent) so the whole
 * loop is testable without hardware: wire sink → DelayNode → input and the
 * measurement must report the delay.
 */
export async function measureLoopbackOnce(
  ctx: AudioContext,
  input: AudioNode,
  sink: AudioNode = ctx.destination
): Promise<LoopbackMeasurement> {
  const reference = generateChirp(ctx.sampleRate)
  const recorder = new Recorder()
  await recorder.start(ctx, input)

  const startAt = ctx.currentTime + PRE_ROLL_SEC
  const buffer = ctx.createBuffer(1, reference.length, ctx.sampleRate)
  buffer.copyToChannel(reference as Float32Array<ArrayBuffer>, 0)
  const source = ctx.createBufferSource()
  source.buffer = buffer
  const gain = ctx.createGain()
  gain.gain.value = STIMULUS_GAIN
  source.connect(gain)
  // Straight to the sink (the destination in real use): the master fader's
  // level must not decide whether calibration hears itself.
  gain.connect(sink)
  source.start(startAt)
  try {
    await wait(PRE_ROLL_SEC + CHIRP_SECONDS + MAX_LAG_SEC + TAIL_SEC)
  } finally {
    source.disconnect()
    gain.disconnect()
  }

  const take = recorder.stop()
  if (!take || take.startSec === null) {
    throw new Error('No audio arrived from the input device')
  }
  let best: { lagSamples: number; confidence: number } | null = null
  for (const channel of take.channels) {
    const match = findChirp(channel, reference, take.sampleRate)
    if (match && (best === null || match.confidence > best.confidence)) best = match
  }
  if (!best) {
    throw new Error('The captured audio was shorter than the test tone')
  }
  const arrivalSec = take.startSec + best.lagSamples / take.sampleRate
  return { roundTripSec: arrivalSec - startAt, confidence: best.confidence }
}
