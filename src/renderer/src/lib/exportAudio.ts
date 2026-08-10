import { Mp3Encoder } from '@breezystack/lamejs'
import type { TrackId } from '@core/model/types'
import { encodeWavPcm16Async } from '@audio/wav'
import { renderTrackChannels } from '@audio/render'
import { projectStore } from '@/state/projectStore'
import { assetStore } from '@/state/audioInstance'

/**
 * Per-track audio export. The render is the track's contribution to the
 * master — soloed through its folder buses, automation and master volume —
 * so what exports is exactly what that track adds to the song.
 *
 * Formats: WAV (lossless) and MP3 (192 kbps, ~10x smaller). MP4/M4A would
 * need an AAC encoder, which Chromium doesn't expose for offline use —
 * MP3 covers the small-file need.
 */

export type ExportFormat = 'wav' | 'mp3'

const MP3_KBPS = 192
/** lamejs consumes samples in blocks of this size. */
const MP3_BLOCK = 1152

function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff
  }
  return out
}

export function encodeMp3(channels: Float32Array[], sampleRate: number): Uint8Array {
  const left = toInt16(channels[0])
  const right = toInt16(channels[1] ?? channels[0])
  const encoder = new Mp3Encoder(2, sampleRate, MP3_KBPS)
  const parts: Uint8Array[] = []
  for (let i = 0; i < left.length; i += MP3_BLOCK) {
    const chunk = encoder.encodeBuffer(
      left.subarray(i, i + MP3_BLOCK),
      right.subarray(i, i + MP3_BLOCK)
    )
    if (chunk.length > 0) parts.push(new Uint8Array(chunk))
  }
  const tail = encoder.flush()
  if (tail.length > 0) parts.push(new Uint8Array(tail))
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

async function saveBytes(data: Uint8Array, name: string, ext: ExportFormat): Promise<void> {
  const bridge = window.superdaw
  if (bridge) {
    await bridge.exportFile({
      data,
      defaultName: name,
      filterName: ext === 'wav' ? 'WAV audio' : 'MP3 audio',
      ext
    })
    return
  }
  const url = URL.createObjectURL(new Blob([data.buffer as ArrayBuffer]))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  // Revoking immediately can race the download starting; see projectFile.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Render one track offline and save it as `format`. False = nothing to export. */
export async function exportTrackAudio(trackId: TrackId, format: ExportFormat): Promise<boolean> {
  const state = projectStore.state
  const track = state.tracks[trackId]
  if (!track) return false
  const mixed = await renderTrackChannels(state, trackId, assetStore)
  if (!mixed) return false
  const data =
    format === 'wav'
      ? await encodeWavPcm16Async(mixed.channels, mixed.sampleRate)
      : encodeMp3(mixed.channels, mixed.sampleRate)
  const base = track.name.trim() || 'Track'
  await saveBytes(data, `${base}.${format}`, format)
  return true
}
