/** Minimal PCM WAV encoder (16- or 24-bit) for recorded and rendered audio. */

export type WavBitDepth = 16 | 24

export function encodeWavPcm16(channels: readonly Float32Array[], sampleRate: number): Uint8Array {
  return encodeWavPcm(channels, sampleRate, 16)
}

export function encodeWavPcm(
  channels: readonly Float32Array[],
  sampleRate: number,
  bitDepth: WavBitDepth
): Uint8Array {
  const bytes = wavHeaderAndBuffer(channels, sampleRate, bitDepth)
  encodeFrames(bytes, channels, 0, channels[0]?.length ?? 0, bitDepth)
  return bytes
}

export async function encodeWavPcm16Async(
  channels: readonly Float32Array[],
  sampleRate: number
): Promise<Uint8Array> {
  return encodeWavPcmAsync(channels, sampleRate, 16)
}

/**
 * The same WAV, encoded in slices with the event loop released between
 * them. A ten-minute stereo take is ~50M sample writes — as one
 * synchronous pass it froze the app for seconds at the exact moment the
 * user hit Stop and was most anxious about whether the take survived.
 */
export async function encodeWavPcmAsync(
  channels: readonly Float32Array[],
  sampleRate: number,
  bitDepth: WavBitDepth
): Promise<Uint8Array> {
  const bytes = wavHeaderAndBuffer(channels, sampleRate, bitDepth)
  const frames = channels[0]?.length ?? 0
  const framesPerSlice = Math.max(1, Math.floor(2_000_000 / Math.max(1, channels.length)))
  for (let from = 0; from < frames; from += framesPerSlice) {
    const to = Math.min(frames, from + framesPerSlice)
    encodeFrames(bytes, channels, from, to, bitDepth)
    if (to < frames) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return bytes
}

function wavHeaderAndBuffer(
  channels: readonly Float32Array[],
  sampleRate: number,
  bitDepth: WavBitDepth
): Uint8Array {
  const channelCount = Math.max(1, channels.length)
  const frames = channels[0]?.length ?? 0
  const bytesPerSample = bitDepth / 8
  const dataBytes = frames * channelCount * bytesPerSample
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channelCount, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true)
  view.setUint16(32, channelCount * bytesPerSample, true)
  view.setUint16(34, bitDepth, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  return bytes
}

function encodeFrames(
  bytes: Uint8Array,
  channels: readonly Float32Array[],
  fromFrame: number,
  toFrame: number,
  bitDepth: WavBitDepth
): void {
  const channelCount = Math.max(1, channels.length)
  const view = new DataView(bytes.buffer)
  const bytesPerSample = bitDepth / 8
  let offset = 44 + fromFrame * channelCount * bytesPerSample
  for (let frame = fromFrame; frame < toFrame; frame++) {
    for (let ch = 0; ch < channelCount; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch]?.[frame] ?? 0))
      if (bitDepth === 16) {
        view.setInt16(offset, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true)
      } else {
        // 24-bit little-endian two's complement, written a byte at a time
        // (DataView has no setInt24). JS bitwise ops work on int32, so the
        // & 0xff masking of a negative value yields the right bytes.
        const value = Math.round(sample < 0 ? sample * 0x800000 : sample * 0x7fffff)
        bytes[offset] = value & 0xff
        bytes[offset + 1] = (value >> 8) & 0xff
        bytes[offset + 2] = (value >> 16) & 0xff
      }
      offset += bytesPerSample
    }
  }
}
