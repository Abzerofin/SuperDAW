import { Mp3Encoder } from '@breezystack/lamejs'
import type { TrackId } from '@core/model/types'
import type { ProjectExportFormat } from '@core/model/projectSettings'
import { encodeWavPcmAsync, type WavBitDepth } from '@audio/wav'
import { renderMixdownChannels, renderTrackChannels } from '@audio/render'
import { measureIntegratedLufs, formatLufs } from '@audio/loudness'
import { projectStore } from '@/state/projectStore'
import { assetStore, audioEngine } from '@/state/audioInstance'
import { statusNotice } from '@/state/statusNotice'

/**
 * Audio export: the whole mix or one track's contribution to it. Formats
 * and WAV bit depth default from the PROJECT settings (Settings ▸ Project)
 * — they are properties of the song, shared by every collaborator.
 *
 * Formats: WAV (lossless, 16- or 24-bit) and MP3 (192 kbps, ~10x smaller).
 * MP4/M4A would need an AAC encoder, which Chromium doesn't expose for
 * offline use — MP3 covers the small-file need.
 *
 * After a mixdown the integrated loudness (BS.1770) is measured and posted
 * to the status bar against the project's loudness target, so "am I at
 * −14?" is answered on every bounce without a metering plugin.
 */

export type ExportFormat = ProjectExportFormat

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

/** True when the bytes reached disk (Electron reports cancelled dialogs). */
async function saveBytes(data: Uint8Array, name: string, ext: ExportFormat): Promise<boolean> {
  const bridge = window.superdaw
  if (bridge) {
    const path = await bridge.exportFile({
      data,
      defaultName: name,
      filterName: ext === 'wav' ? 'WAV audio' : 'MP3 audio',
      ext
    })
    return path !== null
  }
  const url = URL.createObjectURL(new Blob([data.buffer as ArrayBuffer]))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  // Revoking immediately can race the download starting; see projectFile.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return true
}

async function encode(
  channels: Float32Array[],
  sampleRate: number,
  format: ExportFormat,
  bitDepth: WavBitDepth
): Promise<Uint8Array> {
  return format === 'wav'
    ? await encodeWavPcmAsync(channels, sampleRate, bitDepth)
    : encodeMp3(channels, sampleRate)
}

/** "loudness −12.3 LUFS — 1.7 LU above the −14.0 target" (or no target). */
function loudnessReport(channels: Float32Array[], sampleRate: number): string | null {
  const measured = measureIntegratedLufs(channels, sampleRate)
  if (measured === null) return null
  const target = projectStore.state.settings.loudnessTargetLufs
  if (target === null) return `loudness ${formatLufs(measured)}`
  const diff = Math.round((measured - target) * 10) / 10
  const verdict =
    Math.abs(diff) <= 0.5
      ? 'on target'
      : `${Math.abs(diff).toFixed(1)} LU ${diff > 0 ? 'above' : 'below'} the ${formatLufs(target)} target`
  return `loudness ${formatLufs(measured)} — ${verdict}`
}

/**
 * Offline-render the whole project and save it in the project's default
 * export format and bit depth. Resolves when saved (or cancelled); false =
 * empty project, nothing to bounce.
 */
export async function exportMixdown(): Promise<boolean> {
  const state = projectStore.state
  const { exportFormat, exportBitDepth } = state.settings
  // Bounce at the live context rate — the rate every asset was decoded at
  // — so the mixdown resamples nothing on the way out and a bounce
  // re-imported on this machine round-trips rate-exact.
  const mixed = await renderMixdownChannels(
    state,
    assetStore,
    audioEngine.ensureContext().sampleRate
  )
  if (!mixed) return false
  const data = await encode(mixed.channels, mixed.sampleRate, exportFormat, exportBitDepth)
  const name = `${state.name.trim() || 'Untitled'}.${exportFormat}`
  const saved = await saveBytes(data, name, exportFormat)
  if (saved) {
    const loudness = loudnessReport(mixed.channels, mixed.sampleRate)
    statusNotice.show(`Exported ${name}${loudness ? ` — ${loudness}` : ''}`)
  }
  return true
}

/** Render one track offline and save it as `format`. False = nothing to export. */
export async function exportTrackAudio(trackId: TrackId, format: ExportFormat): Promise<boolean> {
  const state = projectStore.state
  const track = state.tracks[trackId]
  if (!track) return false
  // Same rationale as the mixdown: render at the decode rate.
  const mixed = await renderTrackChannels(
    state,
    trackId,
    assetStore,
    audioEngine.ensureContext().sampleRate
  )
  if (!mixed) return false
  const data = await encode(mixed.channels, mixed.sampleRate, format, state.settings.exportBitDepth)
  const base = track.name.trim() || 'Track'
  await saveBytes(data, `${base}.${format}`, format)
  return true
}
