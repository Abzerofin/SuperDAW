import { Mp3Encoder } from '@breezystack/lamejs'
import { zip } from 'fflate'
import type { ProjectState, Route, TrackId } from '@core/model/types'
import {
  isTrackEffectivelyAudible,
  MASTER_BUS_ID,
  pluginsOfTrack,
  routesOfTrack
} from '@core/model/types'
import type { ProjectExportFormat } from '@core/model/projectSettings'
import { encodeWavPcmAsync, type WavBitDepth } from '@audio/wav'
import { renderMixdownChannels, renderTrackChannels, soloTrackState } from '@audio/render'
import { measureIntegratedLufs, formatLufs } from '@audio/loudness'
import { pluginRegistry } from '@audio/pluginRegistry'
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

/** Browser-build save: a plain download through a temporary anchor. */
function downloadBytes(data: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([data.buffer as ArrayBuffer]))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  // Revoking immediately can race the download starting; see projectFile.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
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
  downloadBytes(data, name)
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
 * Instance ids sitting on some in→out path of a track's routing graph.
 * Every node passes audio through (bypassed or unresolvable inserts short
 * inlet→outlet), so plain reachability decides whether an insert touches
 * the rendered signal; an unwired node cannot be "missing" from a bounce.
 */
function liveGraphInstanceIds(routes: readonly Route[]): Set<string> {
  const reach = (start: string, follow: (r: Route) => [string, string]): Set<string> => {
    const seen = new Set<string>([start])
    const queue = [start]
    while (queue.length > 0) {
      const node = queue.pop()!
      for (const route of routes) {
        const [from, to] = follow(route)
        if (from === node && !seen.has(to)) {
          seen.add(to)
          queue.push(to)
        }
      }
    }
    return seen
  }
  const fromIn = reach('in', (r) => [r.from, r.to])
  const toOut = reach('out', (r) => [r.to, r.from])
  const live = new Set<string>()
  for (const id of fromIn) {
    if (id !== 'in' && id !== 'out' && toOut.has(id)) live.add(id)
  }
  return live
}

export interface Vst3BypassReport {
  /** Linear-chain tracks: freezing genuinely bakes their VST3s in. */
  freezable: string[]
  /** Graph-routed tracks: NO render path includes their VST3s today —
   * live playback, freeze (the graph fast path) and export all short
   * them, frozen or not, so freeze advice would be a lie. */
  graph: string[]
  /** Enabled VST3s on the MASTER bus: no freeze exists there, so a Web
   * Audio bounce always bypasses them. */
  master: boolean
}

/**
 * Tracks whose sound this bounce is missing: audible in the rendered
 * state, with at least one enabled insert only the out-of-process host
 * can run ('offline' = an installed VST3). The offline render goes
 * through Web Audio alone, so those inserts are bypassed. The export must
 * SAY so rather than silently sound different from the frozen/live mix —
 * split by whether freezing is a real remedy (see Vst3BypassReport).
 * Builtin-only projects (and the browser build, where nothing is
 * 'offline') always produce empty lists.
 */
export function vst3BypassedTrackNames(state: ProjectState): Vst3BypassReport {
  const freezable: string[] = []
  const graph: string[] = []
  const master = pluginsOfTrack(state, MASTER_BUS_ID).some(
    (p) => p.enabled && pluginRegistry.status(p.descriptor) === 'offline'
  )
  for (const trackId of state.trackOrder) {
    const track = state.tracks[trackId]
    if (!track) continue
    if (!isTrackEffectivelyAudible(state, trackId)) continue
    const offline = pluginsOfTrack(state, trackId).filter(
      (p) => p.enabled && pluginRegistry.status(p.descriptor) === 'offline'
    )
    if (offline.length === 0) continue
    const routes = routesOfTrack(state, trackId)
    if (routes.length > 0) {
      // Freezing a graph track shorts externals too (renderTrackFreeze's
      // fast path), so frozenAssetId does NOT clear the warning here.
      const live = liveGraphInstanceIds(routes)
      if (offline.some((p) => live.has(p.id))) graph.push(track.name.trim() || 'Track')
    } else if (!track.frozenAssetId) {
      // Frozen linear tracks are silenced: the freeze baked the VST3s in.
      freezable.push(track.name.trim() || 'Track')
    }
  }
  return { freezable, graph, master }
}

/** The one-shot warning folded into the export notice, or null. */
export function vst3BypassWarning(state: ProjectState): string | null {
  return formatVst3BypassWarning(vst3BypassedTrackNames(state))
}

/** Render a bypass report (possibly a union over several) as notice text. */
export function formatVst3BypassWarning({
  freezable,
  graph,
  master
}: Vst3BypassReport): string | null {
  const parts: string[] = []
  if (freezable.length > 0) {
    parts.push(`VST3 inserts bypassed on ${freezable.join(', ')} (freeze to include them)`)
  }
  if (graph.length > 0) {
    parts.push(`VST3 inserts in routing graphs are not rendered (${graph.join(', ')})`)
  }
  if (master) {
    parts.push('VST3 inserts on the Master bus are bypassed in bounces')
  }
  return parts.length > 0 ? parts.join('; ') : null
}

/**
 * Offline-render the whole project and save it in the project's default
 * export format and bit depth. Resolves when saved (or cancelled); false =
 * empty project, nothing to bounce.
 */
export async function exportMixdown(): Promise<boolean> {
  const state = projectStore.state
  const { exportFormat, exportBitDepth } = state.settings
  // Bounce at the DECODE rate — the rate every asset was decoded at — so
  // the mixdown resamples nothing on the way out and a bounce re-imported
  // on this machine round-trips rate-exact (backend design §6).
  const mixed = await renderMixdownChannels(
    state,
    assetStore,
    audioEngine.decodeSampleRate()
  )
  if (!mixed) return false
  const data = await encode(mixed.channels, mixed.sampleRate, exportFormat, exportBitDepth)
  const name = `${state.name.trim() || 'Untitled'}.${exportFormat}`
  const saved = await saveBytes(data, name, exportFormat)
  if (saved) {
    const loudness = loudnessReport(mixed.channels, mixed.sampleRate)
    // One notice per bounce: the VST3 warning joins the loudness report
    // rather than stacking a second notice on top of it.
    const warning = vst3BypassWarning(state)
    statusNotice.show(
      `Exported ${name}${loudness ? ` — ${loudness}` : ''}${warning ? ` — ${warning}` : ''}`
    )
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
    audioEngine.decodeSampleRate()
  )
  if (!mixed) return false
  const data = await encode(mixed.channels, mixed.sampleRate, format, state.settings.exportBitDepth)
  const base = track.name.trim() || 'Track'
  const saved = await saveBytes(data, `${base}.${format}`, format)
  if (saved) {
    // Evaluate the bypass against the state the render actually used (the
    // same soloTrackState renderTrackChannels renders) so ancestor buses
    // and, for folders, descendants are counted exactly as they were
    // heard. A track export posts no notice normally — the warning is the
    // only reason to speak.
    const warning = vst3BypassWarning(soloTrackState(state, trackId))
    if (warning) statusNotice.show(`Exported ${base}.${format} — ${warning}`)
  }
  return true
}

// ----- Stems: every track to its own file in one action -----

/**
 * The stem set: every non-folder track that actually sounds in the current
 * mix. Folder buses are excluded — their audio is exactly the sum of their
 * children, so exporting them too would double every child.
 */
export function stemTrackIds(state: ProjectState): TrackId[] {
  return state.trackOrder.filter((id) => {
    const track = state.tracks[id]
    return track !== undefined && track.kind !== 'folder' && isTrackEffectivelyAudible(state, id)
  })
}

/** Windows refuses these as bare file names regardless of extension. */
const RESERVED_FILE_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/**
 * A track name as a safe cross-platform file name: path separators,
 * Windows-reserved punctuation and control characters collapse to '_',
 * trailing dots/spaces are trimmed (Windows strips them silently), and
 * reserved device names (CON, NUL, …) get an underscore prefix. Empty in,
 * 'Track' out — same fallback the bypass warning uses.
 */
export function sanitizeStemFileName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
  if (cleaned.length === 0) return 'Track'
  return RESERVED_FILE_NAMES.test(cleaned) ? `_${cleaned}` : cleaned
}

/**
 * De-duplicate sanitized stem names in order: the second 'Drums' becomes
 * 'Drums 2', the third 'Drums 3', … Case-insensitive because the target
 * filesystems (Windows, macOS) are.
 */
export function uniqueStemFileNames(names: readonly string[]): string[] {
  const used = new Set<string>()
  return names.map((name) => {
    let candidate = name
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${name} ${n}`
    used.add(candidate.toLowerCase())
    return candidate
  })
}

/**
 * Pack encoded stems into one ZIP (the browser fallback for the missing
 * directory picker). Level 0 and worker-backed for the same reasons as
 * project saves: speed, and no main-thread CRC pass over big WAVs.
 */
export function packStemsZip(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, { level: 0 }, (error, data) => {
      if (error) reject(error)
      else resolve(data)
    })
  })
}

/** True when every sample of every channel is exactly zero. */
function isSilent(channels: Float32Array[]): boolean {
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      if (channel[i] !== 0) return false
    }
  }
  return true
}

/**
 * Bounce every audible non-folder track to its own audio file in one
 * action. Each stem uses renderTrackChannels semantics — the project
 * soloed to that track, so folder buses, automation, masterVolume and the
 * whole master path apply, exactly like the single-track export ("the
 * track's contribution to the master"). Tracks that render null or pure
 * silence are skipped.
 *
 * Electron: ONE directory picker up front, then `<track>.<ext>` files
 * written into it. Browser: a single `<project> stems.zip` download.
 * Renders run sequentially — each stem is a full offline mixdown, and
 * parallel OfflineAudioContexts would only fight over the same cores.
 *
 * False = nothing to export. A cancelled picker aborts silently (true),
 * matching the single-file dialogs.
 */
export async function exportStems(): Promise<boolean> {
  const state = projectStore.state
  const { exportFormat, exportBitDepth } = state.settings
  const trackIds = stemTrackIds(state)
  if (trackIds.length === 0) {
    statusNotice.show('No audible tracks to export as stems')
    return false
  }

  // The picker comes FIRST so cancelling costs nothing (no renders yet).
  const bridge = window.superdaw
  let directory: string | null = null
  if (bridge) {
    directory = await bridge.pickExportDirectory()
    if (directory === null) return true
  }

  const names = uniqueStemFileNames(
    trackIds.map((id) => sanitizeStemFileName(state.tracks[id]?.name ?? ''))
  )
  const sampleRate = audioEngine.decodeSampleRate()
  const zipFiles: Record<string, Uint8Array> = {}
  // Union of every rendered state's bypass report: ONE warning at the end
  // names each affected track once, however many stems tripped it.
  const bypass: Vst3BypassReport = { freezable: [], graph: [], master: false }
  const mergeUnique = (into: string[], add: string[]): void => {
    for (const name of add) if (!into.includes(name)) into.push(name)
  }
  let exported = 0
  for (let i = 0; i < trackIds.length; i++) {
    const fileName = `${names[i]}.${exportFormat}`
    statusNotice.show(`Exporting stem ${i + 1}/${trackIds.length}: ${fileName}…`)
    // Sequential on purpose — see the doc comment.
    const mixed = await renderTrackChannels(state, trackIds[i], assetStore, sampleRate)
    if (!mixed || isSilent(mixed.channels)) continue
    const report = vst3BypassedTrackNames(soloTrackState(state, trackIds[i]))
    mergeUnique(bypass.freezable, report.freezable)
    mergeUnique(bypass.graph, report.graph)
    bypass.master ||= report.master
    const data = await encode(mixed.channels, mixed.sampleRate, exportFormat, exportBitDepth)
    if (bridge && directory !== null) {
      await bridge.exportFileInto({ directory, name: fileName, data })
    } else {
      zipFiles[fileName] = data
    }
    exported++
  }

  if (exported === 0) {
    statusNotice.show('No stems exported — every audible track rendered silence')
    return false
  }

  let destination: string
  if (bridge && directory !== null) {
    destination = directory
  } else {
    destination = `${state.name.trim() || 'Untitled'} stems.zip`
    downloadBytes(await packStemsZip(zipFiles), destination)
  }
  const warning = formatVst3BypassWarning(bypass)
  statusNotice.show(
    `Exported ${exported} stem${exported === 1 ? '' : 's'} to ${destination}${warning ? ` — ${warning}` : ''}`
  )
  return true
}
