import { useEffect, useRef, useState } from 'react'
import { newId } from '@core/model/ids'
import { useProjectState } from '@/state/hooks'
import { projectStore } from '@/state/projectStore'
import { useCollab } from '@/state/collab'

export function ChatPanel(): React.JSX.Element {
  const chat = useProjectState().chat
  const collab = useCollab()
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  // Keep pinned to the newest message.
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [chat.length])

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    projectStore.dispatch({
      type: 'chat/post',
      message: {
        id: newId('msg'),
        userId: projectStore.userId,
        authorName: collab.displayName,
        time: Date.now(),
        text
      }
    })
  }

  return (
    <aside className="activity chat">
      <div className="activity-header">Chat</div>
      <div className="chat-list" ref={listRef}>
        {chat.length === 0 && (
          <div className="activity-empty">No messages yet — chat is saved with the project</div>
        )}
        {chat.map((message) => (
          <div className="chat-msg" key={message.id}>
            <div className="chat-msg-meta">
              <span className="chat-msg-author" style={{ color: collab.colorFor(message.userId) }}>
                {message.authorName}
              </span>
              <span className="chat-msg-time mono">{formatTime(message.time)}</span>
            </div>
            <div className="chat-msg-text">{message.text}</div>
          </div>
        ))}
      </div>
      <div className="chat-compose">
        <input
          className="chat-input"
          placeholder="Message…"
          value={draft}
          maxLength={2000}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send()
          }}
        />
        <button
          className="chat-send"
          disabled={!draft.trim()}
          title={draft.trim() ? 'Send (Enter)' : 'Type a message first'}
          onClick={send}
        >
          Send
        </button>
      </div>
    </aside>
  )
}

function formatTime(time: number): string {
  const d = new Date(time)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
