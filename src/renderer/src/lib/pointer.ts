/** Pointer capture that tolerates already-released or synthetic pointers. */
export function capturePointer(e: React.PointerEvent): void {
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    // Pointer gone (or synthetic in tests) — dragging still works via bubbling.
  }
}
