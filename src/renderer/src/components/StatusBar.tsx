import { useProjectState } from '@/state/hooks'
import { useSessionFile } from '@/state/sessionFile'

export function StatusBar(): React.JSX.Element {
  const state = useProjectState()
  const { path, dirty } = useSessionFile()
  const trackCount = state.trackOrder.length
  const clipCount = Object.keys(state.clips).length
  const fileLabel = path ? path.split(/[\\/]/).pop() : 'not saved'

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        <span className="statusbar-project">
          {state.name}
          {dirty && <span className="statusbar-dirty" title="Unsaved changes" />}
        </span>
        <span className="statusbar-dim">Local project · {fileLabel}</span>
      </div>
      <div className="statusbar-hint statusbar-dim">
        Drop audio files on a track · Double-click a lane to add a clip · Ctrl+Wheel to zoom
      </div>
      <div className="statusbar-right statusbar-dim mono">
        {trackCount} tracks · {clipCount} clips
      </div>
    </div>
  )
}
