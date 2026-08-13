/*
 * audiohost smoke test (run directly: node smoketest.js).
 *
 * Proves the stage-1 device layer on real hardware: backend init, device
 * enumeration, a low-latency shared-mode stream (128-frame request),
 * a running stream clock, and the granted period honestly reported.
 * Plays 300 ms of a quiet 440 Hz tone so success is audible too.
 */
const host = require('./build/Release/audiohost.node')

async function main() {
  const backend = host.init()
  console.log('backend:', backend)

  const devices = host.enumerateDevices()
  console.log(`devices: ${devices.length}`)
  for (const d of devices) {
    console.log(`  [${d.kind}]${d.isDefault ? ' *' : '  '} ${d.label}`)
  }

  const info = host.start({ bufferFrames: 128 })
  console.log('stream:', info)

  const t0 = host.now()
  host.setTestTone(440, 0.1)
  await new Promise((r) => setTimeout(r, 300))
  host.setTestTone(0, 0)
  const t1 = host.now()
  const stats = host.stats()
  console.log('clock advanced:', (t1 - t0).toFixed(4), 's over 0.3 s wall')
  console.log('latency (buffer depth):', (host.latencySec() * 1000).toFixed(2), 'ms')
  console.log('stats:', stats)

  host.stop()
  const ok =
    t1 - t0 > 0.2 &&
    t1 - t0 < 0.5 &&
    stats.callbacks > 0 &&
    info.sampleRate > 0 &&
    info.periodFrames > 0
  console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED')
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
