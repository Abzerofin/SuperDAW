// Polyverse Wider is a stereo widener: on identical L/R it correctly does
// nothing. This feeds it DECORRELATED channels and measures mid/side
// energy, which is what "width" actually means.
//   node native/vst3host/widertest.js
const addon = require('./build/Release/vst3host.node')

const SAMPLE_RATE = 48000
const FRAMES = SAMPLE_RATE

// Decorrelated-but-musical: same root, different partials per side.
function tone(freqs) {
  const out = new Float32Array(FRAMES)
  for (let i = 0; i < FRAMES; i++) {
    let v = 0
    for (const f of freqs) v += Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE)
    out[i] = (0.4 * v) / freqs.length
  }
  return out
}

const rms = (a) => {
  let s = 0
  for (const v of a) s += v * v
  return Math.sqrt(s / a.length)
}

// Width = how much energy is in the difference between the channels.
function width(l, r) {
  const mid = new Float32Array(l.length)
  const side = new Float32Array(l.length)
  for (let i = 0; i < l.length; i++) {
    mid[i] = (l[i] + r[i]) / 2
    side[i] = (l[i] - r[i]) / 2
  }
  const m = rms(mid)
  return { mid: m, side: rms(side), ratio: m > 0 ? rms(side) / m : 0 }
}

const path = addon.scanPaths().find((p) => p.includes('Wider'))
if (!path) {
  console.log('Wider not found in the VST3 scan')
  process.exit(1)
}
const cls = addon.inspect(path).classes[0]
console.log(`${cls.name} ${cls.version} by ${cls.vendor}\n`)

for (const [label, left, right] of [
  ['MONO      (identical L/R)', tone([220, 440]), tone([220, 440])],
  ['STEREO (decorrelated L/R)', tone([220, 440, 660]), tone([220, 550, 770])]
]) {
  const before = width(left, right)
  const res = addon.processBuffer(path, cls.uid, {
    channels: [left, right],
    sampleRate: SAMPLE_RATE
  })
  if (res.error) {
    console.log(`${label}  ERROR ${res.error}`)
    continue
  }
  const after = width(res.channels[0], res.channels[1])
  const change = before.ratio > 0 ? ((after.ratio / before.ratio - 1) * 100).toFixed(1) : 'n/a'
  console.log(
    `${label}\n` +
      `   side/mid before ${before.ratio.toFixed(4)}   after ${after.ratio.toFixed(4)}   ` +
      `change ${change}%\n`
  )
}
