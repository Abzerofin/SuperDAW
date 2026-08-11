import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FileNode, FileNodeId } from '@core/model/types'
import { childrenOf } from '@core/model/types'
import { newId } from '@core/model/ids'
import { projectStore } from '@/state/projectStore'
import { useProjectState } from '@/state/hooks'
import { assetStore } from '@/state/audioInstance'
import { bayUi } from '@/state/bayUi'
import {
  BAY_DRAG_MIME,
  browseForBayFiles,
  importFilesToBay,
  type BayDragPayload
} from '@/lib/importAudio'
import { contextMenuStyle } from '@/lib/contextMenu'
import { useDismiss } from '@/lib/dismiss'
import { sliceAssetToSampler } from '@/lib/sliceActions'
import { useTheme } from '@/state/theme'

/** Internal drag type for reorganizing nodes inside the bay. */
const NODE_DRAG_MIME = 'application/x-superdaw-baynode'

/**
 * The File Bay: a Content-Browser-style dock holding folders, audio and
 * MIDI. Bay structure is document state (synced, undoable); which folder
 * the user is looking at is ephemeral and stays local.
 */
export function FileBay(): React.JSX.Element {
  const state = useProjectState()
  const [folderId, setFolderId] = useState<FileNodeId | null>(null)
  const [selectedId, setSelectedId] = useState<FileNodeId | null>(null)
  const [renamingId, setRenamingId] = useState<FileNodeId | null>(null)
  /** Right-click menu: over a node, or over empty space (nodeId null). */
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; nodeId: FileNodeId | null } | null>(
    null
  )

  // If the folder being viewed disappears (deleted, undone), fall back to root.
  useEffect(() => {
    if (folderId !== null && !state.files[folderId]) setFolderId(null)
  }, [state.files, folderId])
  useEffect(() => {
    if (selectedId !== null && !state.files[selectedId]) setSelectedId(null)
  }, [state.files, selectedId])

  useDismiss(ctxMenu !== null, () => setCtxMenu(null))

  const items = childrenOf(state, folderId).sort((a, b) => {
    if ((a.kind === 'folder') !== (b.kind === 'folder')) return a.kind === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  // Breadcrumb: root ... current
  const trail: FileNode[] = []
  for (let id = folderId; id !== null; ) {
    const node: FileNode | undefined = state.files[id]
    if (!node) break
    trail.unshift(node)
    id = node.parentId
  }

  const moveNode = (nodeId: FileNodeId, parentId: FileNodeId | null): void => {
    projectStore.dispatch({ type: 'file/move', nodeId, parentId })
  }

  const acceptDrop = (e: React.DragEvent): void => {
    if (e.dataTransfer.types.includes(NODE_DRAG_MIME) || e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  const handleDropInto = (e: React.DragEvent, targetFolderId: FileNodeId | null): void => {
    e.preventDefault()
    e.stopPropagation()
    const nodeId = e.dataTransfer.getData(NODE_DRAG_MIME)
    if (nodeId) {
      if (nodeId !== targetFolderId) moveNode(nodeId, targetFolderId)
      return
    }
    if (e.dataTransfer.files.length > 0) {
      void importFilesToBay(Array.from(e.dataTransfer.files), targetFolderId)
    }
  }

  const createFolder = (): void => {
    const id = newId('fil')
    projectStore.dispatch({
      type: 'file/create',
      nodes: [{ id, parentId: folderId, kind: 'folder', name: 'New Folder', assetId: null }]
    })
    setSelectedId(id)
    setRenamingId(id)
  }

  const deleteNode = (nodeId: FileNodeId): void => {
    projectStore.dispatch({ type: 'file/delete', nodeIds: [nodeId] })
    if (selectedId === nodeId) setSelectedId(null)
  }

  const deleteSelected = (): void => {
    if (selectedId) deleteNode(selectedId)
  }

  const importHere = (): void => browseForBayFiles(folderId)

  // The dock tab's context menu sends the same actions from outside the
  // bay (one definition, two entry points). Refs so the one subscription
  // always sees the current folder.
  const importRef = useRef(importHere)
  importRef.current = importHere
  const createFolderRef = useRef(createFolder)
  createFolderRef.current = createFolder
  useEffect(
    () =>
      bayUi.subscribe((intent) => {
        if (intent === 'import') importRef.current()
        else createFolderRef.current()
      }),
    []
  )

  const menuItem = (label: string, action: () => void): React.JSX.Element => (
    <button
      key={label}
      className="menu-item"
      onClick={() => {
        setCtxMenu(null)
        action()
      }}
    >
      <span>{label}</span>
    </button>
  )

  return (
    <div
      className="bay"
      onDragOver={acceptDrop}
      onDrop={(e) => handleDropInto(e, folderId)}
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.key === 'Delete' || e.key === 'Backspace') && renamingId === null) {
          e.stopPropagation()
          deleteSelected()
        }
        if (e.key === 'F2' && selectedId) setRenamingId(selectedId)
      }}
      // On the ROOT, not the grid: every part of the panel — toolbar gaps
      // included — answers a right-click. Tiles stop propagation and open
      // their own menu; text inputs keep the native menu (paste).
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('input')) return
        e.preventDefault()
        setCtxMenu({ x: e.clientX, y: e.clientY, nodeId: null })
      }}
    >
      <div className="bay-toolbar">
        <div className="bay-crumbs">
          <button
            className={`bay-crumb ${folderId === null ? 'bay-crumb-current' : ''}`}
            onClick={() => setFolderId(null)}
            onDragOver={acceptDrop}
            onDrop={(e) => handleDropInto(e, null)}
          >
            Project
          </button>
          {trail.map((node) => (
            <span key={node.id} className="bay-crumb-wrap">
              <span className="bay-crumb-sep">/</span>
              <button
                className={`bay-crumb ${node.id === folderId ? 'bay-crumb-current' : ''}`}
                onClick={() => setFolderId(node.id)}
                onDragOver={acceptDrop}
                onDrop={(e) => handleDropInto(e, node.id)}
              >
                {node.name}
              </button>
            </span>
          ))}
        </div>
        <div className="bay-actions">
          <button
            className="bay-btn"
            title="Browse for audio or MIDI files to import here"
            onClick={importHere}
          >
            Import…
          </button>
          <button className="bay-btn" onClick={createFolder}>
            + Folder
          </button>
          <button
            className="bay-btn"
            disabled={!selectedId}
            title={selectedId ? 'Rename (F2)' : 'Select a file or folder first'}
            onClick={() => selectedId && setRenamingId(selectedId)}
          >
            Rename
          </button>
          <button
            className="bay-btn"
            disabled={!selectedId}
            title={selectedId ? 'Delete (Del)' : 'Select a file or folder first'}
            onClick={deleteSelected}
          >
            Delete
          </button>
        </div>
      </div>

      <div className="bay-grid" onPointerDown={() => setSelectedId(null)}>
        {items.length === 0 && (
          <div
            className="bay-empty"
            title="Browse for audio or MIDI files to import"
            onClick={importHere}
          >
            Drop audio or MIDI files here — or click to browse
          </div>
        )}
        {items.map((node) => (
          <BayTile
            key={node.id}
            node={node}
            selected={node.id === selectedId}
            renaming={node.id === renamingId}
            onSelect={() => setSelectedId(node.id)}
            onOpen={() => node.kind === 'folder' && setFolderId(node.id)}
            onContextMenu={(e) => {
              // Mid-rename, the input keeps the browser's own menu (paste).
              if ((e.target as HTMLElement).closest('input')) return
              e.preventDefault()
              e.stopPropagation()
              setSelectedId(node.id)
              setCtxMenu({ x: e.clientX, y: e.clientY, nodeId: node.id })
            }}
            onRenamed={(name) => {
              setRenamingId(null)
              if (name !== null && name.trim() && name !== node.name) {
                projectStore.dispatch({ type: 'file/rename', nodeId: node.id, name: name.trim() })
              }
            }}
            onDropInto={node.kind === 'folder' ? (e) => handleDropInto(e, node.id) : undefined}
            acceptDrop={acceptDrop}
          />
        ))}
      </div>

      {/* Portaled: the dock body clips and scrolls; a fixed-position menu
          rendered in place would be cut off at the panel edge. */}
      {ctxMenu &&
        createPortal(
          <div
            className="menu-panel ctx-menu"
            style={contextMenuStyle(ctxMenu.x, ctxMenu.y)}
            onPointerDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            {(() => {
              const node = ctxMenu.nodeId !== null ? state.files[ctxMenu.nodeId] : undefined
              if (!node) {
                return (
                  <>
                    {menuItem('Import files…', importHere)}
                    {menuItem('New folder', createFolder)}
                  </>
                )
              }
              return (
                <>
                  {node.kind === 'folder' && menuItem('Open', () => setFolderId(node.id))}
                  {node.kind === 'folder' &&
                    menuItem('Import into this folder…', () => browseForBayFiles(node.id))}
                  {node.kind === 'audio' &&
                    node.assetId !== null &&
                    menuItem('Slice to sampler track', () => sliceAssetToSampler(node.assetId!))}
                  {menuItem('Rename', () => setRenamingId(node.id))}
                  {menuItem('Delete', () => deleteNode(node.id))}
                </>
              )
            })()}
          </div>,
          document.body
        )}
    </div>
  )
}

interface TileProps {
  node: FileNode
  selected: boolean
  renaming: boolean
  onSelect: () => void
  onOpen: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onRenamed: (name: string | null) => void
  onDropInto?: (e: React.DragEvent) => void
  acceptDrop: (e: React.DragEvent) => void
}

function BayTile({
  node,
  selected,
  renaming,
  onSelect,
  onOpen,
  onContextMenu,
  onRenamed,
  onDropInto,
  acceptDrop
}: TileProps): React.JSX.Element {
  const [name, setName] = useState(node.name)
  useEffect(() => {
    if (renaming) setName(node.name)
  }, [renaming, node.name])

  const onDragStart = (e: React.DragEvent): void => {
    e.dataTransfer.setData(NODE_DRAG_MIME, node.id)
    if (node.assetId) {
      const payload: BayDragPayload = {
        assetId: node.assetId,
        kind: node.kind === 'midi' ? 'midi' : 'audio',
        name: node.name
      }
      e.dataTransfer.setData(BAY_DRAG_MIME, JSON.stringify(payload))
      // Kind is encoded as a type so lane dragover can filter before drop.
      e.dataTransfer.setData(`${BAY_DRAG_MIME}-${payload.kind}`, '')
    }
    e.dataTransfer.effectAllowed = 'copyMove'
  }

  return (
    <div
      className={`bay-tile ${selected ? 'bay-tile-selected' : ''}`}
      draggable={!renaming}
      onDragStart={onDragStart}
      onPointerDown={(e) => {
        e.stopPropagation()
        onSelect()
      }}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      onDragOver={onDropInto ? acceptDrop : undefined}
      onDrop={onDropInto}
      title={`${node.name} — right-click for options`}
    >
      <div className="bay-tile-icon">
        {node.kind === 'folder' ? (
          <div className="bay-icon-folder" />
        ) : node.kind === 'audio' ? (
          <ThumbWave assetId={node.assetId} />
        ) : (
          <div className="bay-icon-midi">MIDI</div>
        )}
      </div>
      {renaming ? (
        <input
          className="bay-tile-input"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => onRenamed(name)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') onRenamed(name)
            if (e.key === 'Escape') onRenamed(null)
          }}
          onPointerDown={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="bay-tile-name">{node.name}</div>
      )}
    </div>
  )
}

function ThumbWave({ assetId }: { assetId: string | null }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Repaint when the ink changes: a theme switch is not otherwise a render.
  const themeId = useTheme().themeId

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !assetId) return
    const asset = assetStore.get(assetId)
    const g = canvas.getContext('2d')
    if (!g) return
    const { width: w, height: h } = canvas
    g.clearRect(0, 0, w, h)
    if (!asset?.peaks) return
    const peaks = asset.peaks
    const buckets = peaks.length / 2
    const mid = h / 2
    g.fillStyle =
      getComputedStyle(canvas).getPropertyValue('--wave-ink').trim() ||
      'rgba(255, 255, 255, 0.6)'
    for (let x = 0; x < w; x++) {
      const b = Math.floor((x / w) * buckets)
      const min = peaks[b * 2]
      const max = peaks[b * 2 + 1]
      g.fillRect(x, mid - max * (mid - 1), 1, Math.max(1, (max - min) * (mid - 1)))
    }
  }, [assetId, themeId])

  return <canvas ref={canvasRef} width={72} height={40} className="bay-thumb" />
}
