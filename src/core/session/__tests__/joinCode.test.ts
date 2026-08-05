import { describe as suite, expect, test } from 'vitest'
import { decodeJoinCode, encodeJoinCode } from '../joinCode'

suite('join codes', () => {
  test('round-trips address, port, and token', () => {
    const target = { host: '192.168.1.42', port: 45071, token: 'a3f09c' }
    const code = encodeJoinCode(target)
    expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/)
    expect(decodeJoinCode(code)).toEqual(target)
  })

  test('is forgiving about case, spacing, and lookalike characters', () => {
    const code = encodeJoinCode({ host: '10.0.0.7', port: 8080, token: '00ff00' })
    const sloppy = code.toLowerCase().replace(/-/g, ' ').replace(/1/g, 'l').replace(/0/g, 'o')
    expect(decodeJoinCode(sloppy)).toEqual({ host: '10.0.0.7', port: 8080, token: '00ff00' })
  })

  test('rejects malformed codes and inputs', () => {
    expect(() => decodeJoinCode('HELLO')).toThrow()
    expect(() => decodeJoinCode('UUUUU-UUUUU-UUUUU')).toThrow() // U not in alphabet
    expect(() => encodeJoinCode({ host: '300.1.1.1', port: 80, token: 'aabbcc' })).toThrow()
    expect(() => encodeJoinCode({ host: '10.0.0.1', port: 0, token: 'aabbcc' })).toThrow()
    expect(() => encodeJoinCode({ host: '10.0.0.1', port: 80, token: 'xyz' })).toThrow()
  })

  test('distinct sessions produce distinct codes', () => {
    const a = encodeJoinCode({ host: '192.168.0.5', port: 40001, token: 'aaaaaa' })
    const b = encodeJoinCode({ host: '192.168.0.5', port: 40001, token: 'aaaaab' })
    expect(a).not.toBe(b)
  })
})
