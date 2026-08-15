/**
 * The app-wide undo stack: `pushUndo`/`undo`, moved out of `AppState.tsx`'s
 * `AppProvider` unchanged — see that file for how this is wired in.
 *
 * Deliberately *not* persisted. An undo offered after a restart would claim
 * to restore something from a session whose other half is gone — and the
 * things worth undoing here (a deleted reminder, a cleared log) are decisions
 * people reverse within seconds, not next Tuesday.
 *
 * Stored as the *inverse actions* rather than a snapshot of the whole state,
 * so undoing a deleted contact does not also roll back the four unrelated
 * things that happened while the toast was still on screen.
 */

import { useCallback, useRef, useState } from 'react'

export interface UndoApi<Action> {
  undoStack: Array<{ label: string; actions: Action[] }>
  pushUndo: (label: string, actions: Action[]) => void
  undo: () => string | null
}

export function useUndo<Action>(dispatch: (action: Action) => void): UndoApi<Action> {
  type UndoEntry = { label: string; actions: Action[] }
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([])
  /**
   * The same stack, readable synchronously.
   *
   * `undo()` has to return what it just restored so the caller can name it in
   * a toast, and a functional `setState` updater cannot be relied on to have
   * run by the time the call returns. The state copy exists only to re-render
   * whatever shows that an undo is available.
   */
  const undoRef = useRef<UndoEntry[]>([])

  const pushUndo = useCallback((label: string, actions: Action[]) => {
    undoRef.current = [{ label, actions }, ...undoRef.current].slice(0, 20)
    setUndoStack(undoRef.current)
  }, [])

  const undo = useCallback((): string | null => {
    const [top, ...rest] = undoRef.current
    if (!top) return null
    for (const action of top.actions) dispatch(action)
    undoRef.current = rest
    setUndoStack(rest)
    return top.label
  }, [dispatch])

  return { undoStack, pushUndo, undo }
}
