/** Minimal PCM16 WAV encoder for recorded audio. */
export function encodeWavPcm16(channels: readonly Float32Array[], sampleRate: number): Uint8Array {
  const bytes = wavHeaderAndBuffer(channels, sampleRate)
  encodeFrames(bytes, channels, 0, channels[0]?.length ?? 0)
  return bytes
}

/**
 * The same WAV, encoded in slices with the event loop released between
 * them. A ten-minute stereo take is ~50M setInt16 calls — as one
 * synchronous pass it froze the app for seconds at the exact moment the
 * user hit Stop and was most anxious about whether the take survived.
 */
export async function encodeWavPcm16Async(
  channels: readonly Float32Array[],
  sampleRate: number
): Promise<Uint8Array> {
  const bytes = wavHeaderAndBuffer(channels, sampleRate)
  const frames = channels[0]?.length ?? 0
  const framesPerSlice = Math.max(1, Math.floor(2_000_000 / Math.max(1, channels.length)))
  for (let from = 0; from < frames; from += framesPerSlice) {
    const to = Math.min(frames, from + framesPerSlice)
    encodeFrames(bytes, channels, from, to)
    if (to < frames) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return bytes
}

function wavHeaderAndBuffer(channels: readonly Float32Array[], sampleRate: number): Uint8Array {
  const channelCount = Math.max(1, channels.length)
  const frames = channels[0]?.length ?? 0
  const dataBytes = frames * channelCount * 2
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
  view.setUint32(28, sampleRate * channelCount * 2, true)
  view.setUint16(32, channelCount * 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  return bytes
}

function encodeFrames(
  bytes: Uint8Array,
  channels: readonly Float32Array[],
  fromFrame: number,
  toFrame: number
): void {
  const channelCount = Math.max(1, channels.length)
  const view = new DataView(bytes.buffer)
  let offset = 44 + fromFrame * channelCount * 2
  for (let frame = fromFrame; frame < toFrame; frame++) {
    for (let ch = 0; ch < channelCount; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch]?.[frame] ?? 0))
      view.setInt16(offset, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true)
      offset += 2
    }
  }
}
