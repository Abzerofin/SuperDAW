import { useState } from 'react'
import { collab, useCollab } from '@/state/collab'

/**
 * Files collaborators shared, awaiting the user's go-ahead (Settings ▸
 * Collaboration, auto-download off). A single compact card groups every
 * pending file — never one popup per file — with "see all" expanding the
 * individual list. Clips referencing an undownloaded file just play
 * silent, so dismissing is always safe.
 */
export function AssetDownloadPrompt(): React.JSX.Element | null {
  useCollab()
  const [expanded, setExpanded] = useState(false)
  const pending = [...collab.pendingDownloads.values()]
  if (pending.length === 0) return null

  const totalBytes = pending.reduce((sum, p) => sum + (p.size ?? 0), 0)

  return (
    <div className="download-prompt">
      <div className="download-prompt-head">
        <span>
          {pending.length === 1
            ? `“${pending[0].name}” from a collaborator`
            : `${pending.length} files from collaborators`}
          {totalBytes > 0 && <span className="download-prompt-size"> · {formatBytes(totalBytes)}</span>}
        </span>
        <button
          className="download-prompt-close"
          title="Not now (clips using these files stay silent)"
          onClick={() => collab.dismissPendingDownloads()}
        >
          ×
        </button>
      </div>
      <div className="download-prompt-actions">
        <button className="corner-btn" onClick={() => collab.downloadAllPending()}>
          Download {pending.length === 1 ? '' : 'all'}
        </button>
        {pending.length > 1 && (
          <button className="corner-btn" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Hide list' : 'See all'}
          </button>
        )}
      </div>
      {expanded && (
        <div className="download-prompt-list">
          {pending.map((p) => (
            <div key={p.assetId} className="download-prompt-row">
              <span className="download-prompt-name" title={p.name}>
                {p.name}
              </span>
              {p.size !== null && (
                <span className="download-prompt-size mono">{formatBytes(p.size)}</span>
              )}
              <button className="corner-btn" onClick={() => collab.downloadPending(p.assetId)}>
                Download
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}
