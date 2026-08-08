import { app, BrowserWindow, ipcMain, screen } from 'electron'
import type { WebContents } from 'electron'
import { readAppData, setAppData } from './appData'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * VST3 hosting lives in the MAIN process, not the renderer: the renderer
 * runs sandboxed, and a sandboxed preload cannot require a native addon.
 * That also rules out live streaming — SharedArrayBuffer does not cross an
 * Electron process boundary — so this exposes OFFLINE whole-buffer
 * processing only, which is what the freeze/render path wants anyway.
 * See native/README.md.
 */

interface Vst3Class {
  uid: string
  name: string
  vendor: string
  version: string
  sdkVersion: string
  subCategories: string
}

interface Vst3Addon {
  scanPaths(): string[]
  inspect(path: string): { path: string; error?: string; classes?: Vst3Class[] }
  processBuffer(
    path: string,
    uid: string,
    options: {
      channels: Float32Array[]
      sampleRate: number
      blockSize?: number
      params?: Record<string, number>
      state?: Buffer
    }
  ): { error?: string; channels?: Float32Array[] }
  parameters(
    path: string,
    uid: string
  ): { error?: string; parameters?: Vst3Param[] }
  openInstance(
    path: string,
    uid: string,
    options: { sampleRate: number; blockSize?: number; channels?: number; state?: Buffer }
  ): { error?: string; handle?: number; inputChannels?: number; outputChannels?: number }
  getInstanceState(handle: number): { error?: string; component?: Buffer }
  processInstance(
    handle: number,
    options: { channels: Float32Array[]; params?: Record<string, number> }
  ): { error?: string; channels?: Float32Array[] }
  closeInstance(handle: number): { closed: boolean }
  openEditor(
    path: string,
    uid: string,
    options: {
      title?: string
      state?: Buffer
      x?: number
      y?: number
      borderless?: boolean
      owner?: Buffer
      onEvent: (event: { type: string; a: number; b: number }) => void
    }
  ): { error?: string; editor?: number; width?: number; height?: number }
  closeEditor(editor: number): { component?: Buffer; x?: number; y?: number }
  editorResized(editor: number, width: number, height: number): { error?: string }
  moveEditor(
    editor: number,
    options: {
      x?: number
      y?: number
      visible?: boolean
      clipLeft?: number
      clipTop?: number
      clipRight?: number
      clipBottom?: number
    }
  ): { error?: string }
  setEditorParam(editor: number, paramId: number, value: number): { error?: string }
}

/** A docked overlay's placement, in the renderer's CSS viewport coords. */
export interface DockRect {
  x: number
  y: number
  clipLeft: number
  clipTop: number
  clipRight: number
  clipBottom: number
  visible: boolean
}

/** One automatable parameter. Values are VST3 NORMALIZED (0..1). */
export interface Vst3Param {
  id: number
  title: string
  units: string
  defaultNormalized: number
  stepCount: number
  defaultDisplay: string
  isBypass: boolean
  canAutomate: boolean
}

/** A discovered plugin, flattened to one entry per audio class. */
export interface Vst3Plugin {
  path: string
  uid: string
  name: string
  vendor: string
  version: string
  subCategories: string
}

let addon: Vst3Addon | null = null
let loadError: string | null = null

function loadAddon(): Vst3Addon | null {
  if (addon || loadError) return addon
  const candidates = [
    join(app.getAppPath(), 'native/vst3host/build/Release/vst3host.node'),
    join(process.cwd(), 'native/vst3host/build/Release/vst3host.node'),
    join(process.resourcesPath ?? '', 'native/vst3host/build/Release/vst3host.node')
  ]
  const found = candidates.find((path) => existsSync(path))
  if (!found) {
    loadError = 'vst3host addon not built (see native/README.md)'
    return null
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    addon = require(found) as Vst3Addon
    return addon
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error)
    return null
  }
}

/**
 * The component chunk out of a document stateBlob, or undefined. The blob
 * is a small JSON envelope ({"component": base64}) so controller state and
 * versioning can join it later without another format change. Arrives from
 * the DOCUMENT (possibly authored by a collaborator), so anything
 * malformed is ignored rather than trusted.
 */
function chunkFromBlob(stateBlob: string | null | undefined): Buffer | undefined {
  if (!stateBlob) return undefined
  try {
    const parsed: unknown = JSON.parse(stateBlob)
    const component = (parsed as { component?: unknown })?.component
    if (typeof component !== 'string' || component.length === 0) return undefined
    return Buffer.from(component, 'base64')
  } catch {
    return undefined
  }
}

/** Cached across calls — scanning re-loads every bundle off disk. */
let cachedScan: Vst3Plugin[] | null = null

function scan(): Vst3Plugin[] {
  if (cachedScan) return cachedScan
  const host = loadAddon()
  if (!host) return []
  const plugins: Vst3Plugin[] = []
  for (const path of host.scanPaths()) {
    const info = host.inspect(path)
    // A bundle that fails to load is skipped, never thrown: one broken
    // plugin must not abort the scan.
    if (info.error || !info.classes) continue
    for (const cls of info.classes) {
      plugins.push({
        path,
        uid: cls.uid,
        name: cls.name,
        vendor: cls.vendor,
        version: cls.version,
        subCategories: cls.subCategories
      })
    }
  }
  cachedScan = plugins
  return plugins
}

/**
 * Open editors by plugin-instance id. The WINDOW is the addon's own native
 * top-level (an Electron window cannot display a plugin's GL/GDI painting
 * — Chromium windows have no classic paint surface); main only routes
 * events and owns the close/capture sequence.
 */
const editors = new Map<string, number>()

/** Editors reopen where the user last left them, per PLUGIN (all inserts
 * of one plugin share a spot). Machine-local by nature — monitor layouts
 * differ — so this lives in appData, never the document. */
const POSITIONS_KEY = 'vst3EditorPositions'

async function savedPosition(uid: string): Promise<{ x: number; y: number } | null> {
  const all = (await readAppData())[POSITIONS_KEY] as
    | Record<string, { x?: unknown; y?: unknown }>
    | undefined
  const pos = all?.[uid]
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return null
  return { x: pos.x, y: pos.y }
}

async function savePosition(uid: string, x: number, y: number): Promise<void> {
  const all = { ...((await readAppData())[POSITIONS_KEY] as object | undefined) } as Record<
    string,
    { x: number; y: number }
  >
  all[uid] = { x, y }
  await setAppData(POSITIONS_KEY, all)
}

/** uid of each open editor, for position saving at close. */
const editorUids = new Map<string, string>()

/** Instance ids whose editor is a DOCKED overlay rather than a floating
 * window. Their coordinates are dock geometry, not a user choice — never
 * saved as a remembered position. */
const dockedEditors = new Set<string>()

/** Last reported dock rect per instance, re-applied when the app window
 * itself moves — viewport coords don't change then, so the renderer has
 * no way to know. */
const lastDockRects = new Map<string, DockRect>()
const watchedWindows = new WeakSet<BrowserWindow>()

function placeDocked(host: Vst3Addon, win: BrowserWindow, instanceId: string): void {
  const rect = lastDockRects.get(instanceId)
  const editorHandle = editors.get(instanceId)
  if (!rect || editorHandle === undefined) return
  const content = win.getContentBounds()
  const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor
  // dipToScreenPoint is the authoritative DIP→physical mapping and stays
  // correct across mixed-DPI monitors, where multiplying global DIP
  // coords by one display's factor drifts (Windows-only API).
  const dip = { x: content.x + rect.x, y: content.y + rect.y }
  const phys =
    typeof screen.dipToScreenPoint === 'function'
      ? screen.dipToScreenPoint(dip)
      : { x: Math.round(dip.x * scale), y: Math.round(dip.y * scale) }
  try {
    host.moveEditor(editorHandle, {
      visible: rect.visible,
      x: phys.x,
      y: phys.y,
      clipLeft: Math.round(rect.clipLeft * scale),
      clipTop: Math.round(rect.clipTop * scale),
      clipRight: Math.round(rect.clipRight * scale),
      clipBottom: Math.round(rect.clipBottom * scale)
    })
  } catch {
    // a dying plugin must not break window moves
  }
}

function watchWindow(host: Vst3Addon, win: BrowserWindow): void {
  if (watchedWindows.has(win)) return
  watchedWindows.add(win)
  const reposition = (): void => {
    for (const instanceId of dockedEditors) placeDocked(host, win, instanceId)
  }
  win.on('move', reposition)
  win.on('resize', reposition)
}

/** Capture the final chunk and tear the editor down. Idempotent. */
function finalizeEditor(host: Vst3Addon, instanceId: string, sender: WebContents): void {
  const editorHandle = editors.get(instanceId)
  if (editorHandle === undefined) return
  editors.delete(instanceId)
  const uid = editorUids.get(instanceId)
  editorUids.delete(instanceId)
  const wasDocked = dockedEditors.delete(instanceId)
  lastDockRects.delete(instanceId)
  try {
    const final = host.closeEditor(editorHandle)
    if (!wasDocked && uid && typeof final.x === 'number' && typeof final.y === 'number') {
      void savePosition(uid, final.x, final.y)
    }
    // The chunk becomes document state — for GUI-only plugins it is the
    // only place their edits exist.
    if (final.component && !sender.isDestroyed()) {
      sender.send('vst3:editor-event', {
        instanceId,
        kind: 'state',
        stateBlob: JSON.stringify({ component: final.component.toString('base64') })
      })
    }
  } catch {
    // The plugin failing during teardown must not take the app down.
  }
}

export function registerVst3Ipc(): void {
  ipcMain.handle(
    'vst3:open-editor',
    async (
      event,
      args: { instanceId: string; uid: string; stateBlob?: string | null; title?: string }
    ): Promise<{ opened?: boolean; error?: string }> => {
      const host = loadAddon()
      if (!host) return { error: loadError ?? 'vst3 host unavailable' }
      if (editors.has(args.instanceId)) return { opened: true } // already open
      const plugin = scan().find((p) => p.uid === args.uid)
      if (!plugin) return { error: `plugin not installed: ${args.uid}` }

      const sender = event.sender
      try {
        const remembered = await savedPosition(plugin.uid)
        const opened = host.openEditor(plugin.path, plugin.uid, {
          title: args.title ?? plugin.name,
          state: chunkFromBlob(args.stateBlob),
          ...(remembered ?? {}),
          onEvent: (e) => {
            // The user closed the editor window: capture state, then die.
            if (e.type === 'close') {
              finalizeEditor(host, args.instanceId, sender)
              return
            }
            // begin/edit/end knob gestures → the renderer turns them into
            // ops (one per gesture, on 'end').
            if (!sender.isDestroyed()) {
              sender.send('vst3:editor-event', {
                instanceId: args.instanceId,
                kind: e.type,
                paramId: e.a,
                value: e.b
              })
            }
          }
        })
        if (opened.error || opened.editor === undefined) {
          return { error: opened.error ?? 'could not open editor' }
        }
        editors.set(args.instanceId, opened.editor)
        editorUids.set(args.instanceId, plugin.uid)
        return { opened: true }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle('vst3:close-editor', async (event, instanceId: string): Promise<void> => {
    const host = loadAddon()
    if (host) finalizeEditor(host, instanceId, event.sender)
  })

  /**
   * DOCKED editors: a borderless native overlay glued over a reserved
   * area of the app window (a plugin cannot paint inside a Chromium
   * window — see the native-window commit). The renderer reports the
   * reserved area's CSS-viewport rect on every change; rect: null
   * collapses the editor, which captures its state exactly like closing
   * a floating window does.
   */
  ipcMain.handle(
    'vst3:dock-editor',
    async (
      event,
      args: {
        instanceId: string
        uid: string
        stateBlob?: string | null
        rect: DockRect | null
      }
    ): Promise<{ width?: number; height?: number; error?: string }> => {
      const host = loadAddon()
      if (!host) return { error: loadError ?? 'vst3 host unavailable' }
      const sender = event.sender
      const win = BrowserWindow.fromWebContents(sender)
      if (!win) return { error: 'no window' }

      if (args.rect === null) {
        finalizeEditor(host, args.instanceId, sender)
        return {}
      }

      let editorHandle = editors.get(args.instanceId)
      let dims: { width?: number; height?: number } = {}
      if (editorHandle === undefined) {
        const plugin = scan().find((p) => p.uid === args.uid)
        if (!plugin) return { error: `plugin not installed: ${args.uid}` }
        try {
          const opened = host.openEditor(plugin.path, plugin.uid, {
            borderless: true,
            owner: win.getNativeWindowHandle(),
            state: chunkFromBlob(args.stateBlob),
            onEvent: (e) => {
              if (e.type === 'close') {
                finalizeEditor(host, args.instanceId, sender)
                return
              }
              if (!sender.isDestroyed()) {
                sender.send('vst3:editor-event', {
                  instanceId: args.instanceId,
                  kind: e.type,
                  paramId: e.a,
                  value: e.b
                })
              }
            }
          })
          if (opened.error || opened.editor === undefined) {
            return { error: opened.error ?? 'could not open editor' }
          }
          editorHandle = opened.editor
          dims = { width: opened.width, height: opened.height }
          editors.set(args.instanceId, editorHandle)
          editorUids.set(args.instanceId, plugin.uid)
          dockedEditors.add(args.instanceId)
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
      }

      // CSS-viewport → physical screen pixels happens in placeDocked. DIP
      // coords scale by the window's display factor; correct on
      // single-display placement, approximate while the window straddles
      // mixed-DPI monitors.
      lastDockRects.set(args.instanceId, args.rect)
      watchWindow(host, win)
      placeDocked(host, win, args.instanceId)
      return dims
    }
  )

  ipcMain.handle('vst3:scan', async (): Promise<Vst3Plugin[]> => scan())

  ipcMain.handle(
    'vst3:parameters',
    async (_event, uid: string): Promise<{ parameters?: Vst3Param[]; error?: string }> => {
      const host = loadAddon()
      if (!host) return { error: loadError ?? 'vst3 host unavailable' }
      const plugin = scan().find((p) => p.uid === uid)
      if (!plugin) return { error: `plugin not installed: ${uid}` }
      try {
        const result = host.parameters(plugin.path, plugin.uid)
        if (result.error || !result.parameters) {
          return { error: result.error ?? 'could not read parameters' }
        }
        // Only host-controllable parameters. MSaturator reports 154
        // non-read-only params but just 24 automatable ones — the rest are
        // internal state that a generic parameter UI should not surface.
        return { parameters: result.parameters.filter((p) => p.canAutomate) }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  // --- Persistent instances (live playback) ---
  //
  // Handles are opaque ints owned by the addon. The renderer must close
  // what it opens: a leaked handle holds the plugin loaded for the life of
  // the process.
  ipcMain.handle(
    'vst3:open-instance',
    async (
      _event,
      args: {
        uid: string
        sampleRate: number
        blockSize?: number
        channels?: number
        stateBlob?: string | null
      }
    ): Promise<{ handle?: number; outputChannels?: number; error?: string }> => {
      const host = loadAddon()
      if (!host) return { error: loadError ?? 'vst3 host unavailable' }
      const plugin = scan().find((p) => p.uid === args.uid)
      if (!plugin) return { error: `plugin not installed: ${args.uid}` }
      try {
        const result = host.openInstance(plugin.path, plugin.uid, {
          sampleRate: args.sampleRate,
          blockSize: args.blockSize,
          channels: args.channels,
          state: chunkFromBlob(args.stateBlob)
        })
        if (result.error || result.handle === undefined) {
          return { error: result.error ?? 'could not open instance' }
        }
        return { handle: result.handle, outputChannels: result.outputChannels }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle(
    'vst3:process-instance',
    async (
      _event,
      args: { handle: number; channels: Float32Array[]; params?: Record<string, number> }
    ): Promise<{ channels?: Float32Array[]; error?: string }> => {
      const host = loadAddon()
      if (!host) return { error: loadError ?? 'vst3 host unavailable' }
      try {
        const result = host.processInstance(args.handle, {
          channels: args.channels,
          params: args.params
        })
        if (result.error || !result.channels) {
          return { error: result.error ?? 'processing failed' }
        }
        return { channels: result.channels }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle(
    'vst3:instance-state',
    async (_event, handle: number): Promise<{ stateBlob?: string; error?: string }> => {
      const host = loadAddon()
      if (!host) return { error: loadError ?? 'vst3 host unavailable' }
      try {
        const result = host.getInstanceState(handle)
        if (result.error || !result.component) {
          return { error: result.error ?? 'could not capture state' }
        }
        return {
          stateBlob: JSON.stringify({ component: result.component.toString('base64') })
        }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle(
    'vst3:close-instance',
    async (_event, handle: number): Promise<{ closed: boolean }> => {
      const host = loadAddon()
      if (!host) return { closed: false }
      try {
        return host.closeInstance(handle)
      } catch {
        return { closed: false }
      }
    }
  )

  ipcMain.handle(
    'vst3:process',
    async (
      _event,
      args: {
        uid: string
        channels: Float32Array[]
        sampleRate: number
        params?: Record<string, number>
        stateBlob?: string | null
      }
    ): Promise<{ channels?: Float32Array[]; error?: string }> => {
      const host = loadAddon()
      if (!host) return { error: loadError ?? 'vst3 host unavailable' }
      // The renderer sends a descriptor uid, never a filesystem path —
      // paths are machine-specific and must not enter the document. Main
      // resolves uid -> path against its own scan.
      const plugin = scan().find((p) => p.uid === args.uid)
      if (!plugin) return { error: `plugin not installed: ${args.uid}` }
      try {
        const result = host.processBuffer(plugin.path, plugin.uid, {
          channels: args.channels,
          sampleRate: args.sampleRate,
          params: args.params,
          state: chunkFromBlob(args.stateBlob)
        })
        if (result.error || !result.channels) {
          return { error: result.error ?? 'processing failed' }
        }
        return { channels: result.channels }
      } catch (error) {
        // A third-party binary throwing must not take the app down.
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}
