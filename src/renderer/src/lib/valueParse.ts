import { MAX_GAIN } from '@core/model/types'

/**
 * Parsers for the typed-value inputs (see EditableValue): forgiving about
 * units and formats, returning null for anything unintelligible.
 */

/** "50L" / "50R" / "C" / "-50" / "50" → pan -1..1 (numbers are percent). */
export function parsePan(raw: string): number | null {
  const t = raw.trim().toUpperCase()
  if (t === 'C' || t === '') return 0
  const m = t.match(/^(-?\d+(?:\.\d+)?)\s*(L|R)?$/)
  if (!m) return null
  let n = Number(m[1])
  if (m[2] === 'L') n = -Math.abs(n)
  if (m[2] === 'R') n = Math.abs(n)
  return Math.min(1, Math.max(-1, n / 100))
}

/** dB text ("-6", "+3.5", "-inf") → linear gain 0..MAX_GAIN. */
export function parseDb(raw: string): number | null {
  const t = raw.trim().toLowerCase().replace(/\s*db$/, '')
  if (t === '-inf' || t === '-∞' || t === 'inf-' || t === '-oo') return 0
  const n = Number(t.replace(/^\+/, ''))
  if (!Number.isFinite(n)) return null
  return Math.min(MAX_GAIN, Math.max(0, Math.pow(10, n / 20)))
}

/** Plain number with an optional unit suffix, clamped to min..max. */
export function parseNumberIn(min: number, max: number): (raw: string) => number | null {
  return (raw) => {
    const m = raw.trim().match(/^[-+]?\d*\.?\d+/)
    if (!m) return null
    const n = Number(m[0])
    if (!Number.isFinite(n)) return null
    return Math.min(max, Math.max(min, n))
  }
}
