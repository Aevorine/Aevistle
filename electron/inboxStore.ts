/**
 * On-disk cache for received mail: sanitized bodies and attachments.
 *
 * Deliberately its own file rather than an addition to `store.ts` (already
 * four concerns across 400+ lines) and deliberately separate from
 * `state.json`: message headers are small enough to live in `AppState` and
 * ride the existing debounced whole-document save, but bodies and
 * attachments are not — `state.json`'s "small enough that a whole-document
 * write is atomic" assumption would break the moment a multi-megabyte
 * attachment landed inside it.
 *
 * Everything here is a *cache*, not a second copy of the truth: the server
 * still has the message, so eviction on a size/age ceiling is safe — a
 * re-open just re-fetches.
 */

import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Attachment } from '../src/core/types'
import { dataLocation } from './store'

const INBOX_DIR = 'inbox'
const BODIES_DIR = 'bodies'
const ATTACHMENTS_DIR = 'attachments'

export interface CachedBody {
  text?: string
  sanitizedHtml?: string
  /** URLs stripped out during sanitization, kept so a later "load images" can restore them. */
  remoteImages: string[]
}

export interface MailparserAttachment {
  filename?: string
  contentType: string
  content: Buffer
  cid?: string
  contentDisposition?: string
}

/** Filesystem-safe stand-in for an IMAP folder path, which may contain `/`, spaces, or characters Windows rejects in filenames. */
function folderSlug(folderPath: string): string {
  return createHash('sha1').update(folderPath).digest('hex').slice(0, 16)
}

function accountRoot(accountId: string): string {
  // accountId is always our own generated id (see newId()), never
  // server-supplied — safe to use directly as a path segment.
  return path.join(dataLocation(), INBOX_DIR, accountId)
}

function bodyDir(accountId: string, folderPath: string): string {
  return path.join(accountRoot(accountId), BODIES_DIR, folderSlug(folderPath))
}

function bodyFile(accountId: string, folderPath: string, uid: number): string {
  return path.join(bodyDir(accountId, folderPath), `${uid}.json`)
}

function attachmentDir(accountId: string, folderPath: string, uid: number): string {
  return path.join(accountRoot(accountId), ATTACHMENTS_DIR, folderSlug(folderPath), String(uid))
}

async function writeAtomicFile(target: string, contents: string): Promise<void> {
  const temp = `${target}.tmp`
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(temp, contents, { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temp, target)
}

export async function writeMessageBody(
  accountId: string,
  folderPath: string,
  uid: number,
  body: CachedBody,
): Promise<void> {
  await writeAtomicFile(bodyFile(accountId, folderPath, uid), JSON.stringify(body))
}

/** Attachments already on disk for a message, read fresh rather than trusted from a side-index — the files are the truth. */
async function readCachedAttachments(
  accountId: string,
  folderPath: string,
  uid: number,
): Promise<Attachment[]> {
  const dir = attachmentDir(accountId, folderPath, uid)
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: Attachment[] = []
  for (const name of names) {
    const full = path.join(dir, name)
    try {
      const stat = await fs.stat(full)
      if (!stat.isFile()) continue
      out.push({
        id: `inbox-att_${uid}_${name}`,
        name,
        size: stat.size,
        mime: guessMime(name),
        source: 'path',
        path: full,
        addedAt: stat.mtimeMs,
        inline: false,
      })
    } catch {
      /* the file vanished between readdir and stat — skip it */
    }
  }
  return out
}

export async function readMessageBody(
  accountId: string,
  folderPath: string,
  uid: number,
): Promise<{ text?: string; sanitizedHtml?: string; attachments: Attachment[]; remoteImages: string[] } | null> {
  let cached: CachedBody
  try {
    const raw = await fs.readFile(bodyFile(accountId, folderPath, uid), 'utf8')
    cached = JSON.parse(raw) as CachedBody
  } catch {
    return null
  }
  const attachments = await readCachedAttachments(accountId, folderPath, uid)
  return {
    text: cached.text,
    sanitizedHtml: cached.sanitizedHtml,
    attachments,
    remoteImages: cached.remoteImages,
  }
}

/**
 * Write parsed attachment buffers to disk and return them in the same
 * `Attachment` shape the compose screen already uses — so the existing
 * attachment-list UI needs no inbox-specific variant.
 */
export async function writeInboxAttachments(
  accountId: string,
  folderPath: string,
  uid: number,
  attachments: MailparserAttachment[],
): Promise<Attachment[]> {
  const dir = attachmentDir(accountId, folderPath, uid)
  await fs.mkdir(dir, { recursive: true })
  const out: Attachment[] = []
  for (const [i, a] of attachments.entries()) {
    // basename() so a maliciously crafted filename cannot write outside the
    // attachment directory — the same discipline `snapshotAttachments` in
    // `main.ts` already applies on the outbound side.
    const name = path.basename(a.filename || `attachment-${i}`)
    const target = path.join(dir, name)
    await fs.writeFile(target, a.content, { mode: 0o600 })
    const stat = await fs.stat(target)
    out.push({
      id: `inbox-att_${uid}_${name}`,
      name,
      size: stat.size,
      mime: a.contentType || guessMime(name),
      source: 'path',
      path: target,
      addedAt: Date.now(),
      inline: a.contentDisposition === 'inline',
      cid: a.cid,
    })
  }
  return out
}

export async function deleteMessageCache(
  accountId: string,
  items: Array<{ folderPath: string; uid: number }>,
): Promise<void> {
  for (const { folderPath, uid } of items) {
    await fs.rm(bodyFile(accountId, folderPath, uid), { force: true })
    await fs.rm(attachmentDir(accountId, folderPath, uid), { recursive: true, force: true })
  }
}

export async function deleteAccountInboxCache(accountId: string): Promise<void> {
  await fs.rm(accountRoot(accountId), { recursive: true, force: true })
}

interface CacheEntry {
  path: string
  size: number
  mtimeMs: number
}

async function walk(dir: string): Promise<CacheEntry[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: CacheEntry[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await walk(full)))
    } else if (entry.isFile()) {
      const stat = await fs.stat(full).catch(() => null)
      if (stat) out.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs })
    }
  }
  return out
}

/**
 * Evict oldest-touched cache files once an account's inbox cache is over
 * budget, by size or by age. Never touches `state.json`'s message rows —
 * only the body/attachment cache, which is always re-fetchable from the
 * server, so eviction here is a tidiness operation, not a data-loss risk.
 */
export async function pruneInboxCache(
  accountId: string,
  maxMb: number,
  retentionDays: number,
): Promise<void> {
  const root = accountRoot(accountId)
  const files = await walk(root)
  if (files.length === 0) return

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const byAge = files.filter((f) => f.mtimeMs < cutoff)
  for (const f of byAge) await fs.rm(f.path, { force: true }).catch(() => {})

  const remaining = files.filter((f) => f.mtimeMs >= cutoff)
  const maxBytes = maxMb * 1024 * 1024
  let total = remaining.reduce((sum, f) => sum + f.size, 0)
  if (total <= maxBytes) return

  // Oldest-touched first, until back under budget.
  const ordered = [...remaining].sort((a, b) => a.mtimeMs - b.mtimeMs)
  for (const f of ordered) {
    if (total <= maxBytes) break
    await fs.rm(f.path, { force: true }).catch(() => {})
    total -= f.size
  }
}

function guessMime(fileName: string): string {
  const ext = path.extname(fileName).slice(1).toLowerCase()
  const table: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    txt: 'text/plain',
    csv: 'text/csv',
    zip: 'application/zip',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
  return table[ext] ?? 'application/octet-stream'
}
