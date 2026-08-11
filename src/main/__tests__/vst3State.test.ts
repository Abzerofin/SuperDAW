import { describe as suite, expect, test } from 'vitest'
import { blobFromChunk, chunkFromBlob } from '../vst3State'

/**
 * The stateBlob envelope is written when an editor closes and read back on
 * every open/process — possibly on ANOTHER collaborator's machine, after a
 * save/load round trip. The writer and reader must agree byte-for-byte,
 * and the reader must shrug off anything a doctored document can carry.
 */

suite('writer -> reader contract', () => {
  test('a captured chunk round-trips byte-identical through the envelope', () => {
    const chunk = Buffer.from([0, 1, 2, 3, 250, 255, 128, 64, 7])
    const blob = blobFromChunk(chunk)
    expect(typeof blob).toBe('string')
    const back = chunkFromBlob(blob)
    expect(back).toBeDefined()
    expect(Buffer.compare(back!, chunk)).toBe(0)
  })

  test('a realistic multi-kilobyte chunk survives intact', () => {
    const chunk = Buffer.alloc(64 * 1024)
    for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31) & 0xff
    const back = chunkFromBlob(blobFromChunk(chunk))
    expect(back).toBeDefined()
    expect(Buffer.compare(back!, chunk)).toBe(0)
  })

  test('the envelope is the documented JSON shape (versionable later)', () => {
    const blob = blobFromChunk(Buffer.from('abc'))
    const parsed = JSON.parse(blob) as { component: string }
    expect(typeof parsed.component).toBe('string')
    expect(Buffer.from(parsed.component, 'base64').toString()).toBe('abc')
  })

  test('an EMPTY chunk reads back as "no state" (same as null)', () => {
    // The writer can emit it, the reader treats it like an absent blob —
    // restoring zero bytes into a plugin is meaningless either way.
    expect(chunkFromBlob(blobFromChunk(Buffer.alloc(0)))).toBeUndefined()
  })
})

suite('malformed blobs are rejected without throwing', () => {
  test.each([null, undefined, ''])('absent blob (%s) yields undefined', (blob) => {
    expect(chunkFromBlob(blob)).toBeUndefined()
  })

  test.each([
    'not json {',
    '42',
    '"just a string"',
    '[1,2,3]',
    '{}',
    '{"component":42}',
    '{"component":null}',
    '{"component":{}}',
    '{"component":""}',
    '{"wrongKey":"QUJD"}'
  ])('wrong shape %j yields undefined', (blob) => {
    expect(chunkFromBlob(blob)).toBeUndefined()
  })

  test('non-string values smuggled past the type system are rejected', () => {
    for (const junk of [42, { component: 'QUJD' }, ['x'], true, Symbol('s')]) {
      expect(chunkFromBlob(junk as unknown as string)).toBeUndefined()
    }
  })

  test('huge garbage neither throws nor produces a chunk', () => {
    expect(chunkFromBlob('x'.repeat(2_000_000))).toBeUndefined()
    expect(chunkFromBlob(`{"component":${'9'.repeat(100_000)}}`)).toBeUndefined()
  })

  test('invalid base64 degrades to best-effort bytes, never an exception', () => {
    // Buffer.from(_, 'base64') skips invalid characters; the chunk is
    // opaque to us anyway — the plugin itself validates what it gets.
    expect(() => chunkFromBlob('{"component":"!!!not base64@@@"}')).not.toThrow()
  })
})
