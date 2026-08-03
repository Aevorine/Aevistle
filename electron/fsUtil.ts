/**
 * Small path-containment helper shared by `store.ts` and `main.ts`.
 *
 * Pulled out on its own because both files need the same answer to "is this
 * path actually inside that directory" — `store.ts` for the data-folder move
 * guard, `main.ts` for IPC handlers that take a renderer-supplied path
 * (`revealPath`) and must refuse to act on anything outside the data root.
 */

import path from 'node:path'

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}
