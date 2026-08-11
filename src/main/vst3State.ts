/**
 * The stateBlob envelope: how a VST3 plugin's opaque component chunk
 * travels through the DOCUMENT. The blob is a small JSON envelope
 * ({"component": base64}) so controller state and versioning can join it
 * later without another format change.
 *
 * Writer and reader live together here — a pure module, free of Electron —
 * so the contract between them is unit-testable: whatever `blobFromChunk`
 * writes, `chunkFromBlob` must read back byte-identical, and whatever a
 * collaborator (or a doctored file) sends must never throw.
 */

/** Wrap a captured component chunk as a document stateBlob. */
export function blobFromChunk(component: Buffer): string {
  return JSON.stringify({ component: component.toString('base64') })
}

/**
 * The component chunk out of a document stateBlob, or undefined. Arrives
 * from the DOCUMENT (possibly authored by a collaborator), so anything
 * malformed is ignored rather than trusted — this must never throw.
 */
export function chunkFromBlob(stateBlob: string | null | undefined): Buffer | undefined {
  // typeof, not just truthiness: hostile IPC could send a non-string.
  if (!stateBlob || typeof stateBlob !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(stateBlob)
    const component = (parsed as { component?: unknown })?.component
    if (typeof component !== 'string' || component.length === 0) return undefined
    return Buffer.from(component, 'base64')
  } catch {
    return undefined
  }
}
