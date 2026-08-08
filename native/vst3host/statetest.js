// State-chunk round trip, proven by AUDIO rather than by byte equality
// (a plugin may serialize timestamps etc., so bytes can differ while the
// settings are identical — the sound is what must survive).
//
// A: instance with Dry/Wet forced to 0 via params  -> capture chunk
// B: fresh instance opened WITH that chunk, no params -> must sound like A
// C: fresh instance with defaults                     -> must NOT sound like A
//   node native/vst3host/statetest.js
const addon = require('./build/Release/vst3host.node')

const SR = 48000
const N = SR
const sine = new Float32Array(N)
for (let i = 0; i < N; i++) sine[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR)

const delta = (a, b) => {
  let s = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += (a[i] - b[i]) ** 2
  return Math.sqrt(s / Math.min(a.length, b.length))
}

const path = addon.scanPaths().find((p) => p.includes('MSaturator'))
const cls = addon.inspect(path).classes[0]
const wet = addon.parameters(path, cls.uid).parameters.find((q) => q.title === 'Dry/Wet')

const run = (handle) => addon.processInstance(handle, { channels: [sine, sine] }).channels[0]

// A: modified instance — Dry/Wet 0 applied via a param change, then let the
// change settle into the plugin's internal state before capturing.
const a = addon.openInstance(path, cls.uid, { sampleRate: SR, channels: 2 })
addon.processInstance(a.handle, { channels: [sine, sine], params: { [wet.id]: 0 } })
const outA = run(a.handle)
const captured = addon.getInstanceState(a.handle)
addon.closeInstance(a.handle)
if (captured.error) {
  console.log('getInstanceState FAILED: ' + captured.error)
  process.exit(1)
}
console.log(`captured chunk: ${captured.component.length} bytes`)

// B: fresh instance restored from the chunk — no params passed.
const b = addon.openInstance(path, cls.uid, {
  sampleRate: SR,
  channels: 2,
  state: captured.component
})
const outB = run(b.handle)
addon.closeInstance(b.handle)

// C: fresh instance at factory defaults.
const c = addon.openInstance(path, cls.uid, { sampleRate: SR, channels: 2 })
const outC = run(c.handle)
addon.closeInstance(c.handle)

const dAB = delta(outA, outB)
const dBC = delta(outB, outC)
console.log(`restored-vs-modified delta ${dAB.toFixed(6)}  (should be ~0)`)
console.log(`restored-vs-default  delta ${dBC.toFixed(6)}  (should be large)`)
const ok = dAB < 0.001 && dBC > 0.01
console.log(`state chunk round-trips: ${ok ? 'YES' : 'NO'}`)
process.exit(ok ? 0 : 1)
