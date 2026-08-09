import { THEMES, theme as themeStore, useTheme } from '@/state/theme'

/**
 * Themes settings pane. A theme is app-level and personal — switching it
 * touches no project state and is never sent to collaborators, so it
 * applies on click with no confirmation and no reload.
 */
export function ThemesPane(): React.JSX.Element {
  const themeState = useTheme()

  return (
    <div className="settings-pane">
      <h2>Themes</h2>

      <div className="settings-field theme-field">
        <label>Theme</label>
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`theme-card ${themeState.themeId === t.id ? 'theme-card-active' : ''}`}
              aria-pressed={themeState.themeId === t.id}
              onClick={() => themeStore.setTheme(t.id)}
            >
              <span className={`theme-swatch theme-swatch-${t.id}`} aria-hidden="true" />
              <span className="theme-card-name">{t.label}</span>
              <span className="theme-card-desc">{t.description}</span>
            </button>
          ))}
        </div>
        <p className="settings-dim">
          Applies instantly across the whole app and is remembered on this machine. Personal to you
          — collaborators in a session keep their own.
        </p>
      </div>
    </div>
  )
}
