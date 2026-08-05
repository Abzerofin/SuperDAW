import { useEffect, useRef, useState } from 'react'
import type { CommentAnchor } from '@core/model/types'
import { repliesTo, threadsFor } from '@core/model/types'
import { newId } from '@core/model/ids'
import { useProjectState } from '@/state/hooks'
import { projectStore } from '@/state/projectStore'
import { useCollab } from '@/state/collab'
import { commentUi } from '@/state/commentUi'

/**
 * A comment popover for one anchor: its threads, replies, resolve/delete,
 * and an input. Rendered next to the object it belongs to; closes on
 * outside pointer or Escape.
 */
export function CommentThread({ anchor }: { anchor: CommentAnchor }): React.JSX.Element {
  const state = useProjectState()
  const collab = useCollab()
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) commentUi.close()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') commentUi.close()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const threads = threadsFor(state, anchor)

  const post = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    const target = replyTo
    setReplyTo(null)
    projectStore.dispatch({
      type: 'comment/add',
      comments: [
        {
          id: newId('cmt'),
          anchor,
          parentId: target,
          userId: projectStore.userId,
          authorName: collab.displayName,
          time: Date.now(),
          text,
          resolved: false
        }
      ]
    })
  }

  return (
    <div className="comment-popover" ref={rootRef} onPointerDown={(e) => e.stopPropagation()}>
      <div className="comment-popover-body">
        {threads.length === 0 && <div className="comment-empty">Start a discussion</div>}
        {threads.map((thread) => (
          <div className={`comment-thread ${thread.resolved ? 'comment-resolved' : ''}`} key={thread.id}>
            <CommentItem
              authorName={thread.authorName}
              userId={thread.userId}
              time={thread.time}
              text={thread.text}
              color={collab.colorFor(thread.userId)}
              onDelete={() => projectStore.dispatch({ type: 'comment/delete', commentId: thread.id })}
            />
            {repliesTo(state, thread.id).map((reply) => (
              <div className="comment-reply" key={reply.id}>
                <CommentItem
                  authorName={reply.authorName}
                  userId={reply.userId}
                  time={reply.time}
                  text={reply.text}
                  color={collab.colorFor(reply.userId)}
                  onDelete={() =>
                    projectStore.dispatch({ type: 'comment/delete', commentId: reply.id })
                  }
                />
              </div>
            ))}
            <div className="comment-thread-actions">
              <button className="comment-action" onClick={() => setReplyTo(thread.id)}>
                Reply
              </button>
              <button
                className="comment-action"
                onClick={() =>
                  projectStore.dispatch({
                    type: 'comment/setResolved',
                    commentId: thread.id,
                    resolved: !thread.resolved
                  })
                }
              >
                {thread.resolved ? 'Reopen' : 'Resolve'}
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="comment-compose">
        {replyTo !== null && (
          <div className="comment-replying">
            Replying…{' '}
            <button className="comment-action" onClick={() => setReplyTo(null)}>
              cancel
            </button>
          </div>
        )}
        <input
          className="chat-input"
          autoFocus
          placeholder={replyTo !== null ? 'Reply…' : 'Comment…'}
          value={draft}
          maxLength={2000}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') post()
          }}
        />
      </div>
    </div>
  )
}

interface ItemProps {
  authorName: string
  userId: string
  time: number
  text: string
  color: string
  onDelete: () => void
}

function CommentItem({ authorName, time, text, color, onDelete }: ItemProps): React.JSX.Element {
  return (
    <div className="comment-item">
      <div className="comment-item-meta">
        <span className="comment-author" style={{ color }}>
          {authorName}
        </span>
        <span className="comment-time mono">{formatDate(time)}</span>
        <button className="comment-delete" title="Delete comment" onClick={onDelete}>
          ×
        </button>
      </div>
      <div className="comment-text">{text}</div>
    </div>
  )
}

function formatDate(time: number): string {
  const d = new Date(time)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
