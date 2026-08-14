/*
 * audiohost smoke test (run directly: node smoketest.js).
 *
 * Proves the device layer on real hardware: backend init, device
 * enumeration, a low-latency shared-mode stream (128-frame request),
 * a running stream clock, and the granted period honestly reported.
 * Plays 300 ms of a quiet 440 Hz tone so success is audible too.
 *
 * Then the phase-3 duplex upgrade, which needs hardware and so cannot
 * live in the unit tests: reopening with capture must bring an input side
 * up, must keep the stream clock MOVING FORWARD across the reopen (every
 * scheduled voice and the transport read it), and must deliver captured
 * frames through the same rings the renderer drains.
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

  // ---- duplex upgrade (phase 3) ----
  const duplex = host.start({ bufferFrames: 128, input: true })
  console.log('duplex stream:', duplex)
  const clockAfterReopen = host.now()
  console.log('clock after reopen:', clockAfterReopen.toFixed(4), 's (was', t1.toFixed(4) + ')')

  let captured = null
  if (duplex.inputChannels > 0) {
    console.log(
      'input latency (buffer depth):',
      (host.inputLatencySec() * 1000).toFixed(2),
      'ms'
    )
    const node = 1000
    host.createNode(node, 'input', { mode: 'mono', channel: 0 })
    host.setInputCapture(node, true, info.sampleRate * 4)
    await new Promise((r) => setTimeout(r, 500))
    const chunks = host.drainCapture()
    captured = chunks.reduce((sum, c) => sum + c.channels[0].length, 0)
    let peak = 0
    for (const chunk of chunks) {
      for (const v of chunk.channels[0]) peak = Math.max(peak, Math.abs(v))
    }
    console.log(`captured: ${captured} frames over 0.5 s, peak ${peak.toFixed(4)}`)
    host.setInputCapture(node, false, 0)
    host.disposeNode(node)
  } else {
    console.log('no capture device — duplex fell back to playback only')
  }

  host.stop()
  const ok =
    t1 - t0 > 0.2 &&
    t1 - t0 < 0.5 &&
    stats.callbacks > 0 &&
    info.sampleRate > 0 &&
    info.periodFrames > 0 &&
    // The reopen must not rewind the clock.
    clockAfterReopen >= t1 &&
    // Capture is optional (a machine may have no input), but if the
    // capture side came up it must actually deliver frames.
    (duplex.inputChannels === 0 || captured > info.sampleRate * 0.25)
  console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED')
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
