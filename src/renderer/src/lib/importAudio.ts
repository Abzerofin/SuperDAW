import type { Track } from '@core/model/types'
import { newId } from '@core/model/ids'
import { ticksPerSecond } from '@audio/scheduling'
import { audioEngine, assetStore } from '@/state/audioInstance'
import { projectStore } from '@/state/projectStore'

const AUDIO_EXTENSIONS = /\.(wav|mp3|flac|ogg|m4a|aac|aiff?)$/i

export function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/') || AUDIO_EXTENSIONS.test(file.name)
}

/**
 * Decode dropped files into assets and create clips for them, laid out
 * back-to-back from the drop position. Clip length is derived from the
 * audio duration at the current tempo (no time-stretching).
 */
export async function importAudioFiles(
  files: readonly File[],
  track: Track,
  startTicks: number
): Promise<void> {
  let cursor = Math.max(0, startTicks)
  for (const file of files) {
    if (!isAudioFile(file)) continue
    try {
      const buffer = await audioEngine.decode(await file.arrayBuffer())
      const asset = assetStore.add(file.name, buffer)
      const durationTicks = Math.max(
        1,
        Math.round(asset.seconds * ticksPerSecond(projectStore.state.tempo))
      )
      projectStore.dispatch({
        type: 'clip/create',
        clip: {
          id: newId('clp'),
          trackId: track.id,
          name: file.name.replace(/\.[^.]+$/, ''),
          start: cursor,
          duration: durationTicks,
          assetId: asset.id,
          offset: 0,
          color: null
        }
      })
      cursor += durationTicks
    } catch (error) {
      console.error(`Failed to import "${file.name}"`, error)
    }
  }
}
