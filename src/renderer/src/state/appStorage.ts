/**
 * App-level persistent key/value storage — settings, recent-project index.
 * Fully independent of project files. Electron persists to a JSON file in
 * userData (via the preload bridge); the browser build falls back to
 * localStorage. Values are plain JSON.
 *
 * This is deliberately the ONLY seam between app state and where it lives,
 * so future account-backed storage is one new backend, not a rewrite.
 */

const LOCAL_PREFIX = 'superdaw.appdata.'

export async function appStorageGet<T>(key: string): Promise<T | null> {
  const bridge = window.superdaw
  if (bridge) {
    try {
      return ((await bridge.appDataGet(key)) as T) ?? null
    } catch {
      return null
    }
  }
  try {
    const raw = localStorage.getItem(LOCAL_PREFIX + key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

export async function appStorageSet(key: string, value: unknown): Promise<void> {
  const bridge = window.superdaw
  if (bridge) {
    try {
      await bridge.appDataSet(key, value)
    } catch {
      // Storage failures must never break editing; the value just won't persist.
    }
    return
  }
  try {
    localStorage.setItem(LOCAL_PREFIX + key, JSON.stringify(value))
  } catch {
    // Same policy as above.
  }
}
