/**
 * Full-text search over the on-disk body cache — the engine, kept apart from
 * `inboxStore.ts` so `check-body-search.mjs` can bundle and drive it without
 * dragging in `store.ts`'s Electron imports. `inboxStore.searchBodies`
 * composes the account's real directory onto this; the tests compose a temp
 * one. Same function either way, which is the point.
 *
 * The haystack is the plain text plus the sanitized HTML with its tags
 * struck out — `<td>12</td><td>March</td>` has to match "12 March", the same
 * reasoning `bodyAsText` records in the reader. Case folded on both sides;
 * an unreadable or half-written body file is not a match rather than an
 * error, because one corrupt cache entry must not take the whole search down.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

interface SearchableBody {
  text?: string
  sanitizedHtml?: string
}

/** What one cached body reads as, for matching. */
export function bodyHaystack(cached: SearchableBody): string {
  const html = (cached.sanitizedHtml ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
  // Whitespace folded to single spaces, or `</td><td>` leaves two where the
  // query has one and "12 March" hides inside its own table.
  return `${cached.text ?? ''}\n${html}`.toLowerCase().replace(/\s+/g, ' ')
}

/** Uids under `dir` (a bodies folder holding `<uid>.json` files) whose cached body carries `query`. */
export async function searchBodiesIn(dir: string, query: string): Promise<number[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return [] // no cache yet is an empty answer, not a failure
  }
  const hits: number[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const uid = Number(name.slice(0, -'.json'.length))
    if (!Number.isFinite(uid)) continue
    try {
      const cached = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as SearchableBody
      if (bodyHaystack(cached).includes(q)) hits.push(uid)
    } catch {
      /* an unreadable body is not a match */
    }
  }
  return hits
}
