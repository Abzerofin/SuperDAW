import { useEffect, useState } from 'react'
import {
  comboFromEvent,
  keymap,
  SHORTCUT_DEFS,
  useKeymap,
  type ShortcutId
} from '@/state/keymap'

/**
 * Keyboard shortcuts — every action from the keymap roster, grouped by
 * category, rebindable in place: click Rebind, press the new combo (Esc
 * cancels). Overrides persist through appStorage; a combo collision
 * deactivates the loser and says so inline instead of failing silently.
 */

/** 'Ctrl+Shift+S' → 'Ctrl + Shift + S' for readable badges. */
function prettyCombo(combo: string): string {
  return combo.split('+').join(' + ')
}

export function ShortcutsPane(): React.JSX.Element {
  useKeymap()
  const [capturing, setCapturing] = useState<ShortcutId | null>(null)

  // While rebinding, swallow the next real keydown at CAPTURE phase so the
  // global shortcut handler (window bubble) never sees it.
  useEffect(() => {
    if (!capturing) return
    const onKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setCapturing(null)
        return
      }
      const combo = comboFromEvent(e)
      if (!combo) return // a bare modifier — keep listening
      keymap.set(capturing, combo)
      setCapturing(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [capturing])

  const categories: string[] = []
  for (const def of SHORTCUT_DEFS) {
    if (!categories.includes(def.category)) categories.push(def.category)
  }
  const anyOverrides = SHORTCUT_DEFS.some((def) => keymap.isOverridden(def.id))

  return (
    <div className="settings-pane">
      <h2>Keyboard Shortcuts</h2>
      <p className="settings-dim">
        Click Rebind, then press the new key combination (Esc cancels). Bindings are personal —
        they never sync to collaborators. Keys 2–9 always slice the selected clips into that
        many pieces, and letter keys only fire while no text field has focus.
      </p>

      {categories.map((category) => (
        <div key={category} className="settings-field">
          <label>{category}</label>
          {SHORTCUT_DEFS.filter((def) => def.category === category).map((def) => {
            const shadow = keymap.shadowedBy(def.id)
            return (
              <div key={def.id} className="settings-shortcut-row">
                <span className="settings-shortcut-label">
                  {def.label}
                  {shadow && (
                    <span className="settings-shortcut-conflict">
                      {' '}
                      — not active: combo taken by “{shadow.label}”
                    </span>
                  )}
                </span>
                <span className="settings-shortcut-combo mono">
                  {capturing === def.id ? 'Press keys…' : prettyCombo(keymap.comboFor(def.id))}
                </span>
                {def.aliases && def.aliases.length > 0 && (
                  <span
                    className="settings-dim settings-shortcut-alias mono"
                    title="Always bound in addition"
                  >
                    {def.aliases.map(prettyCombo).join(' · ')}
                  </span>
                )}
                <button
                  className="corner-btn"
                  onClick={() => setCapturing(capturing === def.id ? null : def.id)}
                >
                  {capturing === def.id ? 'Cancel' : 'Rebind'}
                </button>
                {keymap.isOverridden(def.id) && (
                  <button
                    className="corner-btn"
                    title={`Restore ${prettyCombo(def.combo)}`}
                    onClick={() => keymap.reset(def.id)}
                  >
                    Reset
                  </button>
                )}
              </div>
            )
          })}
        </div>
      ))}

      {anyOverrides && (
        <div className="settings-field">
          <button className="corner-btn" onClick={() => keymap.resetAll()}>
            Reset all to defaults
          </button>
        </div>
      )}
    </div>
  )
}
