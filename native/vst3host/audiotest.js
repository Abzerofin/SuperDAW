// Manual audio test: run a sine through real plugins and confirm the
// signal actually changed. Compiling proves nothing about whether audio
// flows — this measures the output.
//   node native/vst3host/audiotest.js
const addon = require('./build/Release/vst3host.node')

const SAMPLE_RATE = 48000
const FRAMES = SAMPLE_RATE // 1 second

function sine(freq, amp = 0.5) {
  const data = new Float32Array(FRAMES)
  for (let i = 0; i < FRAMES; i++) {
    data[i] = amp * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE)
  }
  return data
}

function peak(a) {
  let p = 0
  for (const v of a) p = Math.max(p, Math.abs(v))
  return p
}

function rms(a) {
  let sum = 0
  for (const v of a) sum += v * v
  return Math.sqrt(sum / a.length)
}

// How different is the output from the input? 0 = identical.
function difference(a, b) {
  const n = Math.min(a.length, b.length)
  let sum = 0
  for (let i = 0; i < n; i++) sum += (a[i] - b[i]) ** 2
  return Math.sqrt(sum / n)
}

function nonFinite(a) {
  for (const v of a) if (!Number.isFinite(v)) return true
  return false
}

const targets = process.argv.slice(2)
const paths = addon.scanPaths().filter((p) => {
  const name = p.split(/[\\/]/).pop()
  return targets.length === 0 ? true : targets.some((t) => name.includes(t))
})

const left = sine(440)
const right = sine(440)

for (const path of paths) {
  const meta = addon.inspect(path)
  if (meta.error || !meta.classes.length) continue
  const cls = meta.classes[0]
  // Effects only — instruments ignore audio input and would look "broken".
  if (!cls.subCategories.startsWith('Fx')) continue

  const t0 = Date.now()
  const result = addon.processBuffer(path, cls.uid, {
    channels: [left, right],
    sampleRate: SAMPLE_RATE,
    blockSize: 512
  })
  const ms = Date.now() - t0

  if (result.error) {
    console.log(`FAIL  ${cls.name.padEnd(18)} ${result.error}`)
    continue
  }

  const out = result.channels[0]
  const flags = []
  if (nonFinite(out)) flags.push('NON-FINITE!')
  if (peak(out) > 1.5) flags.push('CLIPPING?')

  console.log(
    `ok    ${cls.name.padEnd(18)} ` +
      `in ${result.inputChannels}ch -> out ${result.outputChannels}ch  ` +
      `peak ${peak(out).toFixed(4)}  rms ${rms(out).toFixed(4)}  ` +
      `delta ${difference(left, out).toFixed(4)}  ${ms}ms ${flags.join(' ')}`
  )
}

console.log(`\ninput reference: peak ${peak(left).toFixed(4)}  rms ${rms(left).toFixed(4)}`)
