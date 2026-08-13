/*
 * Native engine verification (run: node enginetest.js).
 *
 * Drives the graph/param/voice engine through renderOffline — the same
 * code the device callback runs — and asserts Web Audio semantics
 * numerically: sample-accurate voice starts, gain application, linear
 * ramps, equal-power panning, scheduled stops with end notification,
 * resampled rates, and tap capture.
 */
const host = require('./build/Release/audiohost.node')

const SR = 48000
let failures = 0

function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) failures++
}

function sine(freq, seconds, amp = 1) {
  const out = new Float32Array(Math.round(seconds * SR))
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR)
  return out
}

function rmsAt(data, fromSec, toSec) {
  const from = Math.round(fromSec * SR)
  const to = Math.round(toSec * SR)
  let sum = 0
  let n = 0
  for (let i = from; i < to; i++) {
    sum += data[i * 2] * data[i * 2] // left channel
    n++
  }
  return Math.sqrt(sum / Math.max(1, n))
}

async function main() {
  host.init()
  const master = 0

  // ---- 1: sample-accurate start through a half-gain node ----
  const tone = sine(440, 0.5, 0.8)
  host.registerBuffer('tone', [tone], SR)
  let nextId = 1000; const gainNode = nextId++; host.createNode(gainNode, 'gain')
  host.scheduleParam(gainNode, 'gain', [{ kind: 'setValue', value: 0.5, time: 0 }])
  host.connect(gainNode, master)
  const v1 = nextId++; host.play({ id: v1, bufferId: 'tone', when: 0.1, destination: gainNode })
  check('play accepted the caller-minted voice id', v1 > 0)

  let out = host.renderOffline(0, SR, SR)
  check('silence before the start time', rmsAt(out, 0, 0.09) < 1e-6, rmsAt(out, 0, 0.09).toExponential(2))
  const expectedRms = (0.8 * 0.5) / Math.SQRT2
  const heard = rmsAt(out, 0.15, 0.55)
  check(
    'voice audible at half gain after start',
    Math.abs(heard - expectedRms) < 0.01,
    `rms ${heard.toFixed(4)} vs ${expectedRms.toFixed(4)}`
  )
  const startIndex = out.findIndex((v) => Math.abs(v) > 1e-6)
  check(
    'start is sample-accurate',
    Math.abs(startIndex / 2 - 0.1 * SR) <= 1,
    `first sample at frame ${Math.floor(startIndex / 2)}`
  )
  check('voice ends by itself and notifies', host.drainEnded().includes(v1))

  // ---- 2: linear ramp shapes the gain ----
  host.scheduleParam(gainNode, 'gain', [
    { kind: 'cancel', afterTime: 0 },
    { kind: 'setValue', value: 0, time: 0 },
    { kind: 'linearRamp', value: 1, endTime: 1 }
  ])
  host.play({ id: nextId++, bufferId: 'tone', when: 0.5, destination: gainNode })
  out = host.renderOffline(0, SR, SR)
  const early = rmsAt(out, 0.5, 0.6) // ramp ≈ 0.55
  const late = rmsAt(out, 0.9, 1.0) // ramp ≈ 0.95
  check(
    'linear ramp rises through the take',
    late > early * 1.5 && late < early * 2.2,
    `early ${early.toFixed(4)} late ${late.toFixed(4)} ratio ${(late / early).toFixed(2)}`
  )

  // ---- 3: equal-power pan hard left / hard right ----
  const panner = nextId++; host.createNode(panner, 'stereoPanner')
  host.connect(panner, master)
  host.scheduleParam(panner, 'pan', [{ kind: 'setValue', value: 1, time: 0 }])
  host.play({ id: nextId++, bufferId: 'tone', when: 0, destination: panner })
  out = host.renderOffline(0, Math.round(0.4 * SR), SR)
  let leftEnergy = 0
  let rightEnergy = 0
  for (let i = 0; i < out.length / 2; i++) {
    leftEnergy += out[i * 2] * out[i * 2]
    rightEnergy += out[i * 2 + 1] * out[i * 2 + 1]
  }
  check(
    'pan +1 sends everything right',
    leftEnergy < 1e-6 && rightEnergy > 0.1,
    `L ${leftEnergy.toExponential(2)} R ${rightEnergy.toFixed(2)}`
  )

  // ---- 4: scheduled stop truncates ----
  host.disconnect(panner)
  host.scheduleParam(gainNode, 'gain', [
    { kind: 'cancel', afterTime: 0 },
    { kind: 'setValue', value: 1, time: 0 }
  ])
  const v4 = nextId++; host.play({ id: v4, bufferId: 'tone', when: 0, destination: gainNode })
  host.stopVoice(v4, 0.2)
  out = host.renderOffline(0, Math.round(0.5 * SR), SR)
  check(
    'stopVoice(at) silences from the stop time',
    rmsAt(out, 0.05, 0.19) > 0.3 && rmsAt(out, 0.21, 0.5) < 1e-6,
    `before ${rmsAt(out, 0.05, 0.19).toFixed(3)} after ${rmsAt(out, 0.21, 0.5).toExponential(2)}`
  )
  check('stopped voice notifies', host.drainEnded().includes(v4))

  // ---- 5: rate consumes the buffer proportionally ----
  const v5 = nextId++; host.play({ id: v5, bufferId: 'tone', when: 0, rate: 2, destination: gainNode })
  out = host.renderOffline(0, SR, SR)
  check(
    'rate 2 halves the audible length',
    rmsAt(out, 0.05, 0.24) > 0.3 && rmsAt(out, 0.27, 0.5) < 1e-3,
    `head ${rmsAt(out, 0.05, 0.24).toFixed(3)} tail ${rmsAt(out, 0.27, 0.5).toExponential(2)}`
  )
  host.drainEnded()
  void v5

  // ---- 6: taps capture the node's output ----
  const tap = nextId++; host.createTap(tap, gainNode, 256)
  const v6 = nextId++; host.play({ id: v6, bufferId: 'tone', when: 0, destination: gainNode })
  host.renderOffline(0, Math.round(0.2 * SR), SR)
  const window = new Float32Array(256)
  const got = host.readTap(tap, window)
  let peak = 0
  for (const v of window) peak = Math.max(peak, Math.abs(v))
  check('tap returns a live window', got && peak > 0.3, `peak ${peak.toFixed(3)}`)
  host.disposeTap(tap)
  // The 0.2 s render left this 0.5 s voice mid-material; the engine is
  // deliberately stateful across renders, so end it before the next test.
  host.stopVoice(v6)
  host.renderOffline(0.2, 128, SR)
  host.drainEnded()

  // ---- 7: offset/duration select buffer regions ----
  const v7 = nextId++
  host.play({
    id: v7,
    bufferId: 'tone',
    when: 0,
    offsetSec: 0.25,
    durationSec: 0.1,
    destination: gainNode
  })
  out = host.renderOffline(0, Math.round(0.3 * SR), SR)
  check(
    'offset+duration bound the material',
    rmsAt(out, 0.01, 0.09) > 0.3 && rmsAt(out, 0.11, 0.3) < 1e-6,
    `head ${rmsAt(out, 0.01, 0.09).toFixed(3)} tail ${rmsAt(out, 0.11, 0.3).toExponential(2)}`
  )
  host.drainEnded()
  void v7

  console.log(failures === 0 ? 'ENGINE OK' : `ENGINE FAILED (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

