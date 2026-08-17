import { describe as suite, expect, test } from 'vitest'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * The CLAP scanner addon's error paths (phase C1). Like the other native
 * suites this requires the BUILT addon; the happy path (a real .clap
 * enumerating its factory) needs a plugin DLL and is exercised by the
 * fixture build documented in docs/CLAP_AU_HOSTING.md rather than a
 * committed binary.
 */

const require = createRequire(import.meta.url)
const addonPath = join(__dirname, '../../../native/claphost/build/Release/claphost.node')
const audiohostPath = join(__dirname, '../../../native/audiohost/build/Release/audiohost.node')

interface ClapHost {
  inspect(path?: unknown): { path?: string; error?: string; classes?: unknown[] }
}

const addon = require(addonPath) as ClapHost

suite('claphost.inspect', () => {
  test('a missing bundle reports a load error, never throws', () => {
    const result = addon.inspect('E:/no/such/plugin.clap')
    expect(result.error).toMatch(/could not load/)
    expect(result.classes).toBeUndefined()
  })

  test('a DLL without clap_entry is named as not-a-CLAP', () => {
    // audiohost.node is a perfectly loadable DLL that is not a CLAP.
    const result = addon.inspect(audiohostPath)
    expect(result.error).toMatch(/no clap_entry/)
  })

  test('a non-string argument reports an error result', () => {
    expect(addon.inspect().error).toMatch(/path string/)
  })
})
