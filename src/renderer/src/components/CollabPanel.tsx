import { useState } from 'react'
import { useCollab, USER_COLORS } from '@/state/collab'
import { projectStore } from '@/state/projectStore'

/**
 * The collaboration popover: start/stop hosting, join/leave via code,
 * roster. One small anchored panel — no dialogs, nothing modal.
 */
export function CollabPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const collab = useCollab()
  const [codeInput, setCodeInput] = useState('')
  const [copied, setCopied] = useState(false)

  return (
    <div className="collab-panel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="collab-row">
        <span className="collab-label">Your name</span>
        <input
          className="collab-name-input"
          value={collab.displayName}
          disabled={collab.mode !== 'off'}
          onChange={(e) => collab.setDisplayName(e.target.value)}
          maxLength={24}
        />
      </div>

      {collab.mode === 'off' && (
        <>
          <button className="collab-primary" onClick={() => void collab.startHosting()}>
            Start collaboration
          </button>
          <div className="collab-divider">or join a session</div>
          <div className="collab-row">
            <input
              className="collab-code-input mono"
              placeholder="XXXXX-XXXXX-XXXXX"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && codeInput.trim()) collab.join(codeInput)
              }}
            />
            <button
              className="collab-primary collab-join-btn"
              disabled={!codeInput.trim()}
              onClick={() => collab.join(codeInput)}
            >
              Join
            </button>
          </div>
        </>
      )}

      {collab.mode === 'hosting' && collab.joinCode && (
        <>
          <div className="collab-label">Share this code</div>
          <button
            className="collab-code mono"
            title="Click to copy"
            onClick={() => {
              void navigator.clipboard.writeText(collab.joinCode ?? '')
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            {collab.joinCode}
            <span className="collab-copied">{copied ? ' copied' : ''}</span>
          </button>
        </>
      )}

      {collab.mode !== 'off' && (
        <div className="collab-users">
          {collab.users.map((user) => (
            <div className="collab-user" key={user.userId}>
              <span
                className="collab-user-dot"
                style={{ background: USER_COLORS[user.colorIndex % USER_COLORS.length] }}
              />
              {user.userId === projectStore.userId ? `${user.name} (you)` : user.name}
              {user.colorIndex === 0 && <span className="collab-host-tag">host</span>}
            </div>
          ))}
          {collab.mode === 'joined' && collab.reconnecting && (
            <div className="collab-reconnecting">Reconnecting… (edits continue locally)</div>
          )}
        </div>
      )}

      {collab.mode !== 'off' && (
        <button
          className="collab-secondary"
          onClick={() => {
            if (collab.mode === 'hosting') collab.stopHosting()
            else collab.leave()
            onClose()
          }}
        >
          {collab.mode === 'hosting' ? 'Stop collaboration' : 'Leave session'}
        </button>
      )}

      {collab.lastError && <div className="collab-error">{collab.lastError}</div>}
    </div>
  )
}
