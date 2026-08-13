/**
 * In-place iterative radix-2 FFT (re/im pairs, length a power of two).
 * Shared by the calibration matched filter and the phase-vocoder stretch.
 * Double precision; twiddles accumulate by multiplication, whose rounding
 * error random-walks at ~1e-14 over even the largest sizes used here —
 * far below anything either consumer could notice.
 */
export function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 1 : -1) * 2 * Math.PI) / len
    const stepRe = Math.cos(angle)
    const stepIm = Math.sin(angle)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let wRe = 1
      let wIm = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const vRe = re[b] * wRe - im[b] * wIm
        const vIm = re[b] * wIm + im[b] * wRe
        re[b] = re[a] - vRe
        im[b] = im[a] - vIm
        re[a] += vRe
        im[a] += vIm
        const nextRe = wRe * stepRe - wIm * stepIm
        wIm = wRe * stepIm + wIm * stepRe
        wRe = nextRe
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n
      im[i] /= n
    }
  }
}
