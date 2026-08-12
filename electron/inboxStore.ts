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
  /**
   * `text/calendar` parts, verbatim.
   *
   * A real meeting invitation carries its date in a `DTSTART` the sending
   * calendar wrote on purpose. Reading that is not a heuristic; reading the
   * prose beside it is. Cached with the body so the reader answers from disk
   * on the second open, like everything else here.
   */
  icsParts?: string[]
  /**
   * What each attachment file next to this body actually is.
   *
   * The bytes on disk stay the truth about *which* attachments exist; this is
   * only the table beside them saying which file answers which `cid`, what
   * type the sending client declared it to be, and whether the part was meant
   * to be embedded in the body or listed as a paperclip. None of those three
   * facts survives in a filename, and nothing recorded them until this field:
   * `readCachedAttachments` rebuilt the list by scanning the directory, which
   * can only produce attachments with no `cid` at all, `inline` always false,
   * and a type guessed from an extension that an embedded image frequently
   * does not have.
   *
   * That is the whole of "pictures in an opened message do not appear". The
   * reader drops every `<img src="cid:…">` it cannot match to an attachment,
   * silently, because a stripped `src` is also how remote-image blocking
   * looks. And because the sync prefetches bodies into this cache, the path
   * that lost the ids was the one taken the *first* time a message was opened,
   * not the second — there was no working case to compare against.
   *
   * Optional because every body file written before this field existed has no
   * such key, and those messages have to keep opening: see the fallback in
   * `readCachedAttachments`.
   */
  attachments?: CachedAttachmentMeta[]
}

/**
 * One row of that table.
 *
 * `name` is the name the file was actually written under — after the
 * de-duplication in `writeInboxAttachments`, not the name the sender chose —
 * because its only job is to be the key back to the file on disk.
 */
export interface CachedAttachmentMeta {
  name: string
  mime: string
  inline: boolean
  cid?: string
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

/** Unique per call, not just per process — two concurrent writes to the same target inside one process both take this path. */
let writeCounter = 0

async function writeAtomicFile(target: string, contents: string): Promise<void> {
  // A fixed `${target}.tmp` let two concurrent writes to the same message
  // (an eager prefetch and an on-demand open racing each other) share one
  // temp file: the second write's content, or worse a half-written buffer,
  // could land under the first write's `rename`, so the cache read back
  // afterwards was decided by scheduling luck rather than by which write
  // actually finished.
  const temp = `${target}.${process.pid}-${++writeCounter}.tmp`
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

/**
 * Attachments already on disk for a message.
 *
 * The directory listing still decides *which* attachments exist — the files are
 * the truth, and a body whose attachments were evicted must not conjure up rows
 * for bytes that are gone. What `meta` adds is everything a filename cannot
 * carry: the `cid` an embedded `<img>` has to match, whether the part was
 * inline, and the type the sender declared.
 *
 * A file with no matching entry falls back to guessing from its extension,
 * which is exactly what every attachment did before this table was written —
 * so a cache from an older build reads as it always did rather than as empty.
 */
async function readCachedAttachments(
  accountId: string,
  folderPath: string,
  uid: number,
  meta: CachedAttachmentMeta[] | undefined,
): Promise<Attachment[]> {
  const dir = attachmentDir(accountId, folderPath, uid)
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch (e) {
    // ENOENT — no attachments were ever cached for this message — is the only
    // case that means "none". A permission error or a directory locked by
    // antivirus scanning was being treated the same as "none" before this,
    // silently: logged now so it is diagnosable, but still returned as an
    // empty list rather than thrown. This is called from `readMessageBody`
    // alongside the already-parsed body text, and a transient lock on the
    // *attachments* folder is not a reason to fail reading the message
    // *text* the caller already has in hand — that would turn "no attachment
    // list this time" into "cannot open this email at all".
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    console.error(`[aevistle] could not list attachments in ${dir}:`, e)
    return []
  }
  const known = new Map((meta ?? []).map((m) => [m.name, m]))
  const out: Attachment[] = []
  for (const name of names) {
    const full = path.join(dir, name)
    try {
      const stat = await fs.stat(full)
      if (!stat.isFile()) continue
      const recorded = known.get(name)
      out.push({
        id: `inbox-att_${uid}_${name}`,
        name,
        size: stat.size,
        mime: recorded?.mime || guessMime(name),
        source: 'path',
        path: full,
        addedAt: stat.mtimeMs,
        inline: recorded?.inline ?? false,
        cid: recorded?.cid,
      })
    } catch {
      /* the file vanished between readdir and stat — skip it */
    }
  }
  return out
}

/**
 * The cached body text alone — no attachment directory walk.
 *
 * `readMessageBody` below is what a reader wants: everything needed to render
 * the message, attachment list included, which costs a `readdir` plus a `stat`
 * per file. This is for the caller that only needs to know whether a body is on
 * disk and what its first line says — the sync's snippet backfill, which asks
 * that question about every row on the page and would otherwise turn one
 * `readFile` into a directory scan per message.
 *
 * `null` for "not cached", including when the file is there but unreadable —
 * either way there is nothing to show and the message loads on demand.
 */
export async function peekMessageBody(
  accountId: string,
  folderPath: string,
  uid: number,
): Promise<CachedBody | null> {
  try {
    const raw = await fs.readFile(bodyFile(accountId, folderPath, uid), 'utf8')
    return JSON.parse(raw) as CachedBody
  } catch {
    return null
  }
}

export async function readMessageBody(
  accountId: string,
  folderPath: string,
  uid: number,
): Promise<{
  text?: string
  sanitizedHtml?: string
  attachments: Attachment[]
  remoteImages: string[]
  icsParts?: string[]
} | null> {
  const cached = await peekMessageBody(accountId, folderPath, uid)
  if (!cached) return null
  const attachments = await readCachedAttachments(accountId, folderPath, uid, cached.attachments)
  return {
    text: cached.text,
    sanitizedHtml: cached.sanitizedHtml,
    attachments,
    remoteImages: cached.remoteImages,
    icsParts: cached.icsParts,
  }
}

/**
 * One filename per attachment, within one message.
 *
 * Two parts called `image.png` is ordinary — two screenshots pasted into the
 * same reply arrive exactly like that — and both used to be written to the same
 * path, so the second silently replaced the first: one attachment's bytes were
 * lost, and whichever `cid` pointed at the loser now resolved to the winner's
 * picture. Numbered the way the save-as dialog in `main.ts` numbers a collision,
 * before the extension rather than after, so the file still opens in the right
 * application.
 *
 * The set is per call and never consults the directory, which is what keeps a
 * re-parse of the same message idempotent: the parts arrive in the same order
 * and get the same names, overwriting their own files. Asking the disk instead
 * would mint `image (2).png`, `image (3).png` … on every re-open, and every one
 * of them would be a cached attachment nothing ever deletes.
 */
function uniqueAttachmentName(taken: Set<string>, name: string): string {
  if (!taken.has(name)) {
    taken.add(name)
    return name
  }
  const ext = path.extname(name)
  const stem = path.basename(name, ext)
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken.has(candidate)) {
      taken.add(candidate)
      return candidate
    }
  }
}

/**
 * Write parsed attachment buffers to disk and return them in the same
 * `Attachment` shape the compose screen already uses — so the existing
 * attachment-list UI needs no inbox-specific variant.
 *
 * The returned list is also the only place the `cid`/`inline`/declared-type
 * facts exist, so a caller that intends the message to be readable from cache
 * later has to put it through `attachmentMeta` into the body file. See
 * `CachedBody.attachments`.
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
  const taken = new Set<string>()
  for (const [i, a] of attachments.entries()) {
    // basename() so a maliciously crafted filename cannot write outside the
    // attachment directory — the same discipline `snapshotAttachments` in
    // `main.ts` already applies on the outbound side. `.` and `..` survive
    // basename() and would name the directory itself, so they fall back to the
    // positional name alongside the unnamed parts they resemble.
    const proposed = path.basename(a.filename || '')
    const safe = proposed && proposed !== '.' && proposed !== '..' ? proposed : `attachment-${i}`
    const name = uniqueAttachmentName(taken, safe)
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

/**
 * The half of a freshly written attachment list that has to be cached: what a
 * later directory scan could not work out for itself.
 *
 * Size, path and id are all recoverable from the file, so they are not stored —
 * and must not be, since `path` embeds the data folder, which the user can move.
 */
export function attachmentMeta(attachments: Attachment[]): CachedAttachmentMeta[] {
  return attachments.map((a) => ({
    name: a.name,
    mime: a.mime,
    inline: a.inline,
    cid: a.cid,
  }))
}

/**
 * The type an attachment file was declared to have, found from its path alone.
 *
 * `readAttachment` in `main.ts` is handed a path by the renderer and nothing
 * else, and guessing from the extension is what stopped embedded images from
 * previewing: a `cid` image usually arrives with no filename, is written as
 * `attachment-3`, and an extensionless name guesses to `application/octet-
 * stream` — which the preview allowlist then, correctly, refuses. The type the
 * sending client stated has been on disk beside the body since
 * `CachedBody.attachments` existed; this reads it back.
 *
 * Derived from the layout rather than from a lookup through the account list:
 * an attachment lives at `…/<account>/attachments/<slug>/<uid>/<name>` and its
 * body at `…/<account>/bodies/<slug>/<uid>.json`, so one is reachable from the
 * other without knowing which IMAP folder the slug stands for — which is just
 * as well, because a hash cannot be reversed into one.
 *
 * `null` for anything that is not an inbox attachment path and for a cache
 * written before the table existed. The caller guesses in that case, exactly as
 * it did for every file before this.
 */
export async function cachedAttachmentMime(filePath: string): Promise<string | null> {
  const resolved = path.resolve(filePath)
  const name = path.basename(resolved)
  const uidDir = path.dirname(resolved)
  const slugDir = path.dirname(uidDir)
  const attachmentsRoot = path.dirname(slugDir)
  if (path.basename(attachmentsRoot) !== ATTACHMENTS_DIR) return null

  const body = path.join(
    path.dirname(attachmentsRoot),
    BODIES_DIR,
    path.basename(slugDir),
    `${path.basename(uidDir)}.json`,
  )
  try {
    const cached = JSON.parse(await fs.readFile(body, 'utf8')) as CachedBody
    const recorded = cached.attachments?.find((a) => a.name === name)
    if (!recorded?.mime) return null
    // `text/plain; charset=utf-8` is a legitimate thing for a sender to write,
    // and the allowlist this feeds is anchored — the parameters have to come
    // off here or a perfectly previewable text part is refused.
    return recorded.mime.split(';')[0].trim().toLowerCase() || null
  } catch {
    return null
  }
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

// ---------------------------------------------------------------------------
// Eviction
//
// `Settings.inboxCacheMaxMb` and `Settings.inboxCacheRetentionDays` are the two
// numbers on the settings screen that say how much downloaded mail this device
// keeps. Everything below is what makes them true, and three things about it
// are deliberate:
//
//   - it evicts whole *messages*, not whole files. A body kept while its
//     attachments were evicted is a message that opens with its paperclip
//     silently gone — `readCachedAttachments` builds that list from whatever is
//     on disk right now, so half an eviction is indistinguishable from a mail
//     that never had an attachment;
//   - the budget is global, matching what `inboxCacheMaxMb` has always
//     claimed ("combined across accounts"). Applying it per account meant three
//     mailboxes quietly cost three times the ceiling the user set;
//   - it never runs on the path a caller is waiting on. See `pruneInboxCache`.
//
// Nothing here can lose data: the server still holds every message it touches,
// so an eviction costs a re-download and never a message.
// ---------------------------------------------------------------------------

/** One cached message: its body file, its attachment files, and their combined weight. */
interface CachedMessage {
  files: string[]
  bytes: number
  /** The newest write across them — when this message was last put on disk. */
  mtimeMs: number
}

async function readdirSafe(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch {
    // A directory that does not exist yet contributes nothing, and one that
    // cannot be read must not stop the rest of the sweep — a locked folder
    // (antivirus, a backup tool) is a reason to skip it this time, not a
    // reason to leave the whole cache unbounded.
    return []
  }
}

async function note(
  into: Map<string, CachedMessage>,
  key: string,
  file: string,
): Promise<void> {
  const stat = await fs.stat(file).catch(() => null)
  if (!stat || !stat.isFile()) return
  const existing = into.get(key)
  if (existing) {
    existing.files.push(file)
    existing.bytes += stat.size
    existing.mtimeMs = Math.max(existing.mtimeMs, stat.mtimeMs)
  } else {
    into.set(key, { files: [file], bytes: stat.size, mtimeMs: stat.mtimeMs })
  }
}

/**
 * Every cached message across every account, keyed so that a body and its
 * attachments land under the same entry.
 *
 * The uid is taken from the leading digits of the filename rather than by
 * stripping `.json`, so a `.tmp` left behind by an interrupted
 * `writeAtomicFile` is accounted to the message it belongs to and evicted with
 * it — otherwise it would be a file nothing on earth ever deletes.
 */
async function cachedMessages(): Promise<Map<string, CachedMessage>> {
  const out = new Map<string, CachedMessage>()
  const root = path.join(dataLocation(), INBOX_DIR)

  for (const account of await readdirSafe(root)) {
    if (!account.isDirectory()) continue

    const bodies = path.join(root, account.name, BODIES_DIR)
    for (const slug of await readdirSafe(bodies)) {
      if (!slug.isDirectory()) continue
      for (const file of await readdirSafe(path.join(bodies, slug.name))) {
        if (!file.isFile()) continue
        const uid = /^(\d+)/.exec(file.name)?.[1] ?? file.name
        await note(
          out,
          `${account.name}\n${slug.name}\n${uid}`,
          path.join(bodies, slug.name, file.name),
        )
      }
    }

    const attachments = path.join(root, account.name, ATTACHMENTS_DIR)
    for (const slug of await readdirSafe(attachments)) {
      if (!slug.isDirectory()) continue
      for (const uid of await readdirSafe(path.join(attachments, slug.name))) {
        if (!uid.isDirectory()) continue
        for (const file of await readdirSafe(path.join(attachments, slug.name, uid.name))) {
          if (!file.isFile()) continue
          await note(
            out,
            `${account.name}\n${slug.name}\n${uid.name}`,
            path.join(attachments, slug.name, uid.name, file.name),
          )
        }
      }
    }
  }

  return out
}

async function evict(message: CachedMessage): Promise<void> {
  for (const file of message.files) await fs.rm(file, { force: true }).catch(() => {})
}

/**
 * Do the eviction, now, on whatever is on disk.
 *
 * Age first, then size. Age is an instruction — "keep downloaded mail for 90
 * days" means exactly that, whether or not the cache is anywhere near its
 * ceiling — while size is a ceiling, so it only bites when it is reached and
 * then takes the oldest-written messages until it stops biting.
 *
 * Both numbers are clamped to at least 1. A blank or nonsensical field on the
 * settings screen arriving here as `0` or `NaN` must not read as "delete
 * everything": `NaN` compares false against every timestamp, which would spare
 * the whole cache, but a literal `0` would condemn all of it. Neither is a
 * thing a person meant to ask for.
 */
async function runPrune(maxMb: number, retentionDays: number): Promise<void> {
  const messages = await cachedMessages()
  if (messages.size === 0) return

  const days = Number.isFinite(retentionDays) ? Math.max(1, retentionDays) : 90
  const megabytes = Number.isFinite(maxMb) ? Math.max(1, maxMb) : 500

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const kept: CachedMessage[] = []
  let total = 0
  for (const message of messages.values()) {
    if (message.mtimeMs < cutoff) {
      await evict(message)
      continue
    }
    total += message.bytes
    kept.push(message)
  }

  const maxBytes = megabytes * 1024 * 1024
  if (total <= maxBytes) return

  kept.sort((a, b) => a.mtimeMs - b.mtimeMs)
  for (const message of kept) {
    if (total <= maxBytes) break
    await evict(message)
    total -= message.bytes
  }
}

/** Long enough that a burst of syncs across several accounts becomes one sweep. */
const PRUNE_DEBOUNCE_MS = 5_000
/**
 * And a floor under how often the sweep itself happens.
 *
 * Deciding anything means walking the whole cache — a `stat` per file — and the
 * answer is almost always "nothing to do". Every five minutes is far more often
 * than a cache measured in hundreds of megabytes can fill and far less often
 * than the sync that asks. Starts at zero so the first request after launch
 * always sweeps, which is when a machine that has been off for a month wants it.
 */
const PRUNE_MIN_INTERVAL_MS = 5 * 60_000

let pruneTimer: ReturnType<typeof setTimeout> | null = null
let pruneSettings: { maxMb: number; retentionDays: number } | null = null
let lastPruneAt = 0

/**
 * Ask for the inbox cache to be trimmed. Returns before any of it has happened.
 *
 * That is the contract, and it is the point of the function rather than a
 * shortcut. The only caller is the sync IPC handler, which `await`s it before
 * answering the renderer — so every byte of work done here used to be time the
 * inbox list spent not appearing, in exchange for housekeeping the user cannot
 * see and has no reason to wait for. Now the request sets a timer and the
 * handler returns; the sweep happens a few seconds later on nobody's clock.
 *
 * Coalescing rather than queueing. Several accounts syncing together produce
 * several requests describing the same global budget, and running that sweep
 * three times would just be the same walk three times over a cache the first
 * one already brought under the ceiling.
 *
 * Failures are logged and dropped. There is no user-facing action for "the
 * cache could not be trimmed", the next sync asks again, and turning a
 * housekeeping failure into a failed sync would be trading a real feature for
 * a tidy disk.
 *
 * @param accountId only the account whose sync triggered this. The sweep itself
 *        is global — `inboxCacheMaxMb` is one ceiling for the whole cache, not
 *        one per mailbox — so this is carried for the log line and nothing else.
 */
export function pruneInboxCache(
  accountId: string,
  maxMb: number,
  retentionDays: number,
): Promise<void> {
  pruneSettings = { maxMb, retentionDays }
  if (pruneTimer) return Promise.resolve()

  pruneTimer = setTimeout(() => {
    pruneTimer = null
    const settings = pruneSettings
    if (!settings) return
    if (Date.now() - lastPruneAt < PRUNE_MIN_INTERVAL_MS) return
    lastPruneAt = Date.now()
    void runPrune(settings.maxMb, settings.retentionDays).catch((e) => {
      console.error(`[aevistle] could not trim the inbox cache (asked by ${accountId}):`, e)
    })
  }, PRUNE_DEBOUNCE_MS)
  // Never a reason for the process to stay alive: this is housekeeping, and a
  // pending sweep must not be what keeps Electron from quitting.
  pruneTimer.unref?.()

  return Promise.resolve()
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
