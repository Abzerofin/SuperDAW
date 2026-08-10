import { useState } from 'react'

/**
 * A numeric readout you can click and TYPE into: click swaps the text for
 * an input, Enter/blur commits through `parse` (null = rejected, nothing
 * happens), Escape cancels. Used by every knob/slider/fader value label so
 * any number in the app can be set exactly.
 */
export function EditableValue({
  text,
  className,
  title,
  parse,
  onCommit
}: {
  /** The formatted readout shown when not editing. */
  text: string
  className?: string
  title?: string
  /** Turn the typed text into a value, or null to reject it. */
  parse: (raw: string) => number | null
  onCommit: (value: number) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState<string | null>(null)

  if (editing !== null) {
    const commit = (): void => {
      const value = parse(editing)
      setEditing(null)
      if (value !== null) onCommit(value)
    }
    return (
      <input
        className={`value-input mono ${className ?? ''}`}
        autoFocus
        value={editing}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setEditing(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setEditing(null)
          e.stopPropagation() // typing must not trigger app shortcuts
        }}
        onPointerDown={(e) => e.stopPropagation()}
      />
    )
  }

  return (
    <span
      className={`value-editable ${className ?? ''}`}
      title={title ?? 'Click to type an exact value'}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        setEditing(text)
      }}
    >
      {text}
    </span>
  )
}
