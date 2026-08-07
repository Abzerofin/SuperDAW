// Does plugin state survive between chunks?
//
// The test: chunk 1 is a short burst then silence; chunk 2 is pure
// silence. A reverb/delay fed this way MUST bleed its tail into chunk 2.
// A persistent instance does; creating the plugin per chunk cannot, and
// that difference is exactly what would make live playback click every
// chunk boundary.
//   node native/vst3host/continuitytest.js
const addon = require('./build/Release/vst3host.node')

const SR = 48000
const CHUNK = SR / 2 // 0.5s

const rms = (a) => {
  let s = 0
  for (const v of a) s += v * v
  return Math.sqrt(s / a.length)
}

// 0.1s of tone, then silence for the rest of the chunk.
function burst() {
  const out = new Float32Array(CHUNK)
  for (let i = 0; i < SR * 0.1; i++) {
    out[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR)
  }
  return out
}
const silence = () => new Float32Array(CHUNK)

for (const name of ['MCharmVerb', 'MDelay']) {
  const path = addon.scanPaths().find((p) => p.includes(name))
  if (!path) {
    console.log(`${name}: not installed`)
    continue
  }
  const cls = addon.inspect(path).classes[0]
  console.log(`\n=== ${cls.name} ===`)

  // --- persistent instance: state carries across chunks ---
  const opened = addon.openInstance(path, cls.uid, {
    sampleRate: SR,
    blockSize: 512,
    channels: 2
  })
  if (opened.error) {
    console.log(`  openInstance failed: ${opened.error}`)
    continue
  }
  const b = burst()
  const c1 = addon.processInstance(opened.handle, { channels: [b, b] })
  const s = silence()
  const c2 = addon.processInstance(opened.handle, { channels: [s, s] })
  addon.closeInstance(opened.handle)

  if (c1.error || c2.error) {
    console.log(`  process failed: ${c1.error || c2.error}`)
    continue
  }

  // --- one-shot per chunk: no state to carry ---
  const one2 = addon.processBuffer(path, cls.uid, {
    channels: [silence(), silence()],
    sampleRate: SR
  })

  const persistentTail = rms(c2.channels[0])
  const oneShotTail = one2.error ? 0 : rms(one2.channels[0])

  console.log(`  chunk 1 (burst)          rms ${rms(c1.channels[0]).toFixed(6)}`)
  console.log(`  chunk 2 persistent       rms ${persistentTail.toFixed(6)}  <- tail`)
  console.log(`  chunk 2 fresh each time  rms ${oneShotTail.toFixed(6)}  <- no tail`)
  console.log(
    `  state carries across chunks: ${
      persistentTail > oneShotTail * 10 + 1e-7 ? 'YES' : 'NO'
    }`
  )
}
