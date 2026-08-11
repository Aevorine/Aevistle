/**
 * Disk persistence for the desktop build.
 *
 * Three things live in the data folder:
 *   state.json    — accounts, jobs, contacts, templates, logs, settings
 *   secrets.json  — SMTP passwords, each encrypted with Electron `safeStorage`
 *                   (DPAPI on Windows, Keychain on macOS, libsecret on Linux)
 *   attachments/  — copies of files a scheduled job will need later
 *
 * `state.json` and `secrets.json` are separate on purpose. `state.json` is the
 * file a user might copy to another machine or paste into a bug report; it must
 * never contain a credential. `secrets.json` is bound to the OS user account
 * and is useless anywhere else.
 *
 * ---------------------------------------------------------------------------
 * Where the data folder is
 * ---------------------------------------------------------------------------
 * By default it is `app.getPath('userData')`. The user can point it anywhere
 * they can write — a synced folder, a second drive, a USB stick.
 *
 * The choice itself is stored in `location.json`, which *always* stays in
 * `userData`. A pointer that lived inside the folder it points at could not be
 * found again after a restart, and the app would silently fall back to the
 * default folder with the user's schedules apparently gone.
 */

import { app, safeStorage } from 'electron'
import { promises as fs, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { isInside } from './fsUtil'
import type { SecretKind } from '../src/core/types'
import { mintMessageId, type DispatchLedgerEntry } from '../src/core/dispatchLedger'
import type { ControlAuditEntry } from '../src/core/control'

const STATE_FILE = 'state.json'
const SECRET_FILE = 'secrets.json'
const POINTER_FILE = 'location.json'
/** Durable per-occurrence send state — see the "Dispatch ledger" section below. Follows the data folder like everything else the jobs it describes move with. */
const LEDGER_FILE = 'dispatch-ledger.json'
/** Durable control-API request log — see the "Control audit log" section below. */
const CONTROL_AUDIT_FILE = 'control-audit.json'
const ATTACHMENTS_DIR = 'attachments'
/** Images pasted from the clipboard straight into a compose body. */
const PASTED_DIR = 'pasted'
/** Plain-text copy of the data root, for the uninstaller. */
const PATH_HINT_FILE = 'datapath.txt'

/** What follows the user when the data folder moves. */
const MOVABLE = [
  STATE_FILE,
  SECRET_FILE,
  LEDGER_FILE,
  CONTROL_AUDIT_FILE,
  ATTACHMENTS_DIR,
  PASTED_DIR,
] as const

/**
 * Rebuildable on demand, so it is discarded at the old location rather than
 * carried to the new one. Copying up to 200 MB of downloaded remote images to
 * save re-fetching them is a bad trade; leaving them behind to rot in a folder
 * the user has stopped using is worse.
 */
const DISPOSABLE = ['imagecache'] as const

let activeRoot: string | null = null

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

export function defaultDataRoot(): string {
  return app.getPath('userData')
}

function pointerPath(): string {
  return path.join(defaultDataRoot(), POINTER_FILE)
}

/**
 * Resolve the data folder once, at startup, before anything reads or writes.
 *
 * Deliberately synchronous and deliberately forgiving: a pointer to a drive
 * that is not plugged in must degrade to "use the default folder", not to a
 * crash on launch or — worse — an app that starts up empty and looks like it
 * lost everything.
 */
export function initDataRoot(): { root: string; fellBack: boolean } {
  let fellBack = false
  let root = defaultDataRoot()

  try {
    const raw = readFileSync(pointerPath(), 'utf8')
    const parsed = JSON.parse(raw) as { root?: unknown }
    if (typeof parsed.root === 'string' && parsed.root.trim()) {
      const candidate = path.resolve(parsed.root)
      try {
        mkdirSync(candidate, { recursive: true })
        root = candidate
      } catch {
        // Removable drive missing, network share offline, permission revoked.
        fellBack = true
      }
    }
  } catch {
    // No pointer yet, or an unreadable one — the default is correct.
  }

  activeRoot = root
  try {
    mkdirSync(root, { recursive: true })
  } catch {
    activeRoot = defaultDataRoot()
    fellBack = true
  }

  // Refreshed every launch, so the uninstaller's "delete my data" finds the
  // right folder even for someone who has never opened the data settings —
  // and so a stale note from a folder that has since fallen back is corrected.
  try {
    writeFileSync(path.join(defaultDataRoot(), PATH_HINT_FILE), `${activeRoot}\n`, 'utf8')
  } catch {
    // A read-only userData folder is survivable; only the uninstaller's
    // convenience depends on this file.
  }

  return { root: activeRoot, fellBack }
}

/**
 * Where each unreadable file was moved to, if that happened this session.
 *
 * Module state rather than a return value because the read that discovers it
 * has to keep returning `null` — the app must still start. Reported through
 * `appInfo` so the window can say what happened instead of opening empty.
 *
 * An array, not a single slot: `readJson` recovers both the state file and
 * the secrets file through this same path, and a crash can corrupt more than
 * one of them. A single shared variable let a second corruption silently
 * overwrite the first — the settings banner would name only the file that
 * broke *last*, so a secrets file full of account passwords could be moved
 * aside and never mentioned at all if the state file happened to fail too.
 */
const recoveredPaths: string[] = []

export function recoveredFrom(): string[] | undefined {
  return recoveredPaths.length > 0 ? recoveredPaths : undefined
}

export function dataLocation(): string {
  return activeRoot ?? defaultDataRoot()
}

export function isDefaultLocation(): boolean {
  return path.resolve(dataLocation()) === path.resolve(defaultDataRoot())
}

function dataPath(file: string): string {
  return path.join(dataLocation(), file)
}

function writePointer(root: string | null): void {
  mkdirSync(defaultDataRoot(), { recursive: true })
  // Writing `null` rather than deleting the file: an orphaned pointer left by a
  // failed delete would send the next launch straight back to the folder the
  // user just told us to stop using.
  writeFileSync(pointerPath(), JSON.stringify({ root }, null, 2), 'utf8')

  // The same fact in a form the Windows uninstaller can read. It has no JSON
  // parser and no app to ask, and "delete my data" has to find the folder even
  // when the user moved it to another drive.
  writeFileSync(
    path.join(defaultDataRoot(), PATH_HINT_FILE),
    `${root ?? defaultDataRoot()}
`,
    'utf8',
  )
}

/**
 * Can we actually write there? Checked by writing, not by inspecting permission
 * bits — a read-only network share, a full disk and a folder owned by another
 * user all look fine until you try.
 */
export async function probeWritable(dir: string): Promise<string | null> {
  try {
    await fs.mkdir(dir, { recursive: true })
    const probe = path.join(dir, `.aevistle-write-test-${process.pid}`)
    await fs.writeFile(probe, 'ok', 'utf8')
    await fs.rm(probe, { force: true })
    return null
  } catch (e) {
    return (e as Error).message
  }
}

export interface MoveOutcome {
  root: string
  moved: boolean
  /** Set when the switch worked but something the user should know happened. */
  warning?: string
}

/** The folder name Aevistle always keeps its data in. */
export const DATA_DIR_NAME = 'AevistleData'

/**
 * Put the data inside an `AevistleData` folder, whatever the user picked.
 *
 * Picking a folder in the OS dialog usually means "put it in here", not "spray
 * state.json, secrets.json and attachments/ directly into my Documents". Making
 * the container explicit also makes it obvious what to delete, and makes the
 * uninstaller's "remove my data" safe to point at a single directory.
 *
 * Already-named folders are not nested again: choosing an existing
 * `D:\Backup\AevistleData` keeps that path rather than creating
 * `D:\Backup\AevistleData\AevistleData`.
 *
 * Applied only where the *user* picked a folder. Resetting to the default
 * passes `userData`, which is already an app-private directory — nesting there
 * would move every existing install's data out from under it.
 */
export function withDataDir(target: string): string {
  const resolved = path.resolve(target)
  return path.basename(resolved).toLowerCase() === DATA_DIR_NAME.toLowerCase()
    ? resolved
    : path.join(resolved, DATA_DIR_NAME)
}

/**
 * Point the app at another folder.
 *
 * `move: true` copies the existing data across first. Copy-then-delete, never
 * rename: source and target are frequently on different volumes, where rename
 * fails outright, and a half-finished move is the one outcome that loses a
 * user's schedules. If the delete afterwards fails the switch still stands — a
 * stale copy left behind is a tidiness problem, not a data problem.
 */
export async function setDataRoot(target: string, move: boolean): Promise<MoveOutcome> {
  const resolved = path.resolve(target)
  const current = path.resolve(dataLocation())

  if (resolved === current) return { root: current, moved: false }

  const failure = await probeWritable(resolved)
  if (failure) throw new Error(`That folder cannot be written to: ${failure}`)

  // Copying the data folder into itself would recurse forever.
  if (isInside(resolved, current)) {
    throw new Error('Choose a folder that is not inside the current data folder.')
  }

  let warning: string | undefined
  let moved = false

  if (move) {
    for (const entry of MOVABLE) {
      const from = path.join(current, entry)
      const to = path.join(resolved, entry)
      try {
        await fs.access(from)
      } catch {
        continue // nothing of this kind yet
      }
      try {
        await fs.cp(from, to, { recursive: true, force: true, errorOnExist: false })
        moved = true
      } catch (e) {
        throw new Error(`Could not copy ${entry}: ${(e as Error).message}`)
      }
    }

    // Only now, with every copy done, is it safe to remove the originals.
    if (moved) {
      for (const entry of MOVABLE) {
        await fs.rm(path.join(current, entry), { recursive: true, force: true }).catch(() => {
          warning = 'The data was copied, but the old folder could not be emptied.'
        })
      }
    }

    // Caches are dropped whether or not anything else moved: they cost nothing
    // to rebuild, and a failure to delete one is not worth telling the user
    // about when their actual data arrived safely.
    for (const entry of DISPOSABLE) {
      await fs.rm(path.join(current, entry), { recursive: true, force: true }).catch(() => {})
    }
  }

  activeRoot = resolved
  const usingDefault = resolved === path.resolve(defaultDataRoot())
  try {
    writePointer(usingDefault ? null : resolved)
  } catch (e) {
    warning = `The folder is in use for this session, but the choice could not be saved: ${
      (e as Error).message
    }`
  }

  return { root: resolved, moved, warning }
}

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

/**
 * Serial number for temp files, so two writes never share a name.
 *
 * The old code used a fixed `<target>.tmp`. That is fine for one writer and
 * silently catastrophic for two: `saveState` is called from the debounce, from
 * the retry after a failed write, and from the flush on the way out, and any
 * two of those overlapping had both handles appending into the *same* temp
 * file. The bytes interleave, the second `rename` publishes the mixture, and
 * `state.json` is now a file that parses as nothing and gets moved aside as
 * corrupt on the next launch. The window is small — one debounce tick — which
 * is exactly why it would have been diagnosed as "it lost my data once".
 *
 * The pid is in the name too, because the data folder can be a synced folder
 * that another machine's copy of the app also writes to.
 */
let tempSeq = 0

/**
 * Write via a temp file + rename so a crash mid-write cannot truncate the
 * only copy of the user's schedules.
 *
 * `fsync` before the rename, and this is the part that is easy to leave out.
 * Rename is atomic with respect to the *directory*: after it, the name points
 * at the new file or the old one, never at half a name. It says nothing about
 * whether the new file's contents have reached the platter. A power cut in the
 * window between `write` returning (data in the OS cache) and the cache being
 * flushed leaves a renamed `state.json` whose tail is zeroes — which is the one
 * outcome atomic-rename is supposed to make impossible, and it looks exactly
 * like the corruption it was meant to prevent. So the handle is flushed while
 * it is still under the temp name, where a failure costs nothing.
 *
 * The flush is allowed to fail. `fsync` is not implemented on every filesystem
 * an ambitious user can point the data folder at — SMB shares and some FUSE
 * mounts return EINVAL — and refusing to save at all there would be a much
 * worse trade than saving without the durability guarantee.
 */
async function writeAtomic(file: string, contents: string | Buffer): Promise<void> {
  const target = dataPath(file)
  const temp = `${target}.${process.pid}.${++tempSeq}.tmp`
  await fs.mkdir(path.dirname(target), { recursive: true })
  try {
    const handle = await fs.open(temp, 'w', 0o600)
    try {
      await handle.writeFile(contents, typeof contents === 'string' ? 'utf8' : null)
      try {
        await handle.sync()
      } catch {
        /* see above — no fsync here, so the rename is the only guarantee */
      }
    } finally {
      await handle.close()
    }
    await fs.rename(temp, target)
  } catch (e) {
    // A temp file that never became the real one is litter, and unique names
    // mean it would never be reused. Removing it is best-effort: the failure
    // that brought us here is the one worth reporting.
    await fs.rm(temp, { force: true }).catch(() => {})
    throw e
  }
}

/**
 * How old a stray temp file has to be before it is assumed abandoned.
 *
 * Unique temp names cost one thing: nothing overwrites yesterday's crashed
 * write any more, so they pile up in the folder the settings screen reports the
 * size of. Sweeping them is easy; sweeping one that another process is *still
 * writing* is not, and the data folder may be a synced folder that a second
 * machine also writes to. Five minutes is far longer than any single write and
 * far shorter than "the user notices stray files".
 */
const TEMP_SWEEP_AGE_MS = 5 * 60_000

/** Clear temp files left behind by a write that never finished. Best effort. */
async function sweepStaleTemps(): Promise<void> {
  const root = dataLocation()
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    return
  }
  const cutoff = Date.now() - TEMP_SWEEP_AGE_MS
  for (const entry of entries) {
    if (!entry.endsWith('.tmp')) continue
    if (!entry.startsWith(`${STATE_FILE}.`) && !entry.startsWith(`${SECRET_FILE}.`)) continue
    const full = path.join(root, entry)
    try {
      const stat = await fs.stat(full)
      if (stat.mtimeMs < cutoff) await fs.rm(full, { force: true })
    } catch {
      /* vanished, or not ours to delete */
    }
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(dataPath(file), 'utf8')
    return JSON.parse(raw) as T
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return null
    /*
     * A corrupt file should not brick the app. Move it aside so the user can
     * recover it manually, and start fresh — but *say so*.
     *
     * Renaming silently and returning null gave the user an app that opened
     * factory-fresh with no accounts, no reminders and no explanation, which
     * from the inside is indistinguishable from having lost everything. The
     * file is still there and still readable; nobody was ever told.
     */
    if (e instanceof SyntaxError) {
      const moved = dataPath(`${file}.corrupt-${Date.now()}`)
      try {
        await fs.rename(dataPath(file), moved)
        recoveredPaths.push(moved)
      } catch {
        // Could not even move it, so the file is still sitting at `dataPath(file)`
        // and every later read of it (credentials are re-read on every send and
        // every IMAP connection) hits this exact branch again. Deduplicated so
        // that stays one banner line instead of growing once per read.
        if (!recoveredPaths.includes(dataPath(file))) recoveredPaths.push(dataPath(file))
      }
      return null
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

export async function loadState<T>(): Promise<T | null> {
  // Startup is the one moment nothing is mid-write, which makes it the only
  // safe moment to tidy up after a write that never finished.
  void sweepStaleTemps()
  return readJson<T>(STATE_FILE)
}

/*
 * ---------------------------------------------------------------------------
 * Why saving is incremental
 * ---------------------------------------------------------------------------
 *
 * `AppState` is one document, but it is not one *kind* of thing. `draft`
 * changes on every keystroke and is a few kilobytes. `logs`, `inboxAccounts`
 * and `outbox` are the bulk of the file — thousands of cached message rows and
 * hundreds of log entries on a real mailbox — and they change when a sync runs
 * or a send completes, which is to say rarely, and never while someone is
 * typing.
 *
 * The old implementation did not distinguish them: every save was
 * `JSON.stringify(state, null, 2)` over the whole document. That is a
 * *synchronous* walk of every object in the store, on the main process, tens of
 * milliseconds per debounce tick on a large mailbox — and the main process is
 * the thread that answers the renderer's IPC, drives the tray, and runs the
 * scheduler. Typing a subject line into a store with 5000 cached messages meant
 * re-serialising all 5000 of them three times a second to record a change to
 * one string.
 *
 * So the document is now assembled from per-key fragments. Each top-level key
 * is serialised on its own and the resulting string is kept; on the next save a
 * key whose value is structurally unchanged reuses its fragment instead of
 * being walked again. A keystroke re-serialises `draft` and concatenates the
 * rest.
 *
 * Three properties this design was chosen *for*:
 *
 *   - It is still one file. Splitting the big slices into sidecars with a
 *     manifest would have removed the concatenation too, but it would have
 *     bought a genuinely hard problem — several files that must be mutually
 *     consistent across a crash — in exchange for the cheapest part of the
 *     work. One file keeps the existing temp-and-rename as the *entire*
 *     consistency argument: `state.json` is replaced whole, in one operation,
 *     or it is not replaced at all. There is no interleaving of an old slice
 *     with a new one because there is no moment at which they are separate.
 *
 *   - It is invisible on disk. What is written is a plain JSON object with the
 *     same keys as before; only the whitespace differs. A build from before
 *     this change reads it with `JSON.parse` and cannot tell. A store written
 *     by an older build loads here unchanged. There is no version marker
 *     because there is nothing to version.
 *
 *   - It is invisible to the renderer. `saveState(state)` is the same call it
 *     always was. The renderer has no business knowing how persistence is
 *     chunked, and an IPC surface that exposed slices would have to be kept in
 *     agreement with `AppState`'s shape forever.
 *
 * What it costs is memory: the values that produced the cached fragments are
 * retained, so the main process now holds roughly one extra copy of the store
 * plus the document as strings, where before both were garbage the moment the
 * write started. That is a real cost — tens of megabytes on a large mailbox —
 * and it is the right trade, because the renderer already holds the same data
 * and the thing being bought is a main process that does not stall.
 *
 * The comparison is deliberately conservative: `sameJson` returns true only
 * when it is certain the two values serialise identically, and answers "no" for
 * anything it does not fully understand. A wrong "no" costs one re-serialise. A
 * wrong "yes" would write a document describing a state that never existed.
 */

/** The values behind `sliceFragments`, kept only to compare the next save against. */
let sliceValues: Record<string, unknown> | null = null
/**
 * Each of `sliceValues` as `JSON.stringify` output, already encoded to UTF-8.
 *
 * Buffers rather than strings, and this is not a micro-optimisation. Handing a
 * string to `writeFile` makes Node encode the whole document to UTF-8 before it
 * can queue the write, and that encoding runs on the event loop — so the
 * megabytes of unchanged mail we just went to the trouble of *not*
 * re-serialising were being walked again anyway, one save later, out of sight
 * of any profiler pointed at `JSON.stringify`. Encoding each fragment once, at
 * the moment it is produced, is what makes an unchanged slice genuinely free.
 */
let sliceFragments: Record<string, Buffer> | null = null

const DOC_OPEN = Buffer.from('{\n', 'utf8')
const DOC_CLOSE = Buffer.from('\n}\n', 'utf8')
const DOC_EMPTY = Buffer.from('{}\n', 'utf8')

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/** Objects `JSON.stringify` treats as plain records — not Date, Map, RegExp, … */
function isPlainRecord(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Would these two values produce byte-identical JSON?
 *
 * "Would" is the whole contract, and it is stricter than "are these equal".
 * Key *order* is compared positionally because `{a:1,b:2}` and `{b:2,a:1}` are
 * the same object and different JSON, and reusing a fragment for the other
 * order would write a document that is correct but not the one this state
 * describes — at which point the cache no longer means what the rest of this
 * file assumes it means.
 *
 * Anything exotic returns false rather than being reasoned about. A `Date`
 * survives structured clone and serialises through `toJSON`; a `Map`
 * serialises to `{}` whatever is in it. Neither appears in `AppState`, and the
 * cost of being wrong about them is unbounded while the cost of re-serialising
 * them is one walk of a slice that does not exist.
 */
function sameJson(a: unknown, b: unknown): boolean {
  // Covers every primitive, including the NaN-vs-NaN case `===` gets wrong.
  // `Object.is(0, -0)` is false where JSON agrees they are both `0`; that
  // errs towards re-serialising, which is the safe direction.
  if (Object.is(a, b)) return true
  if (a === null || b === null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!sameJson(a[i], b[i])) return false
    }
    return true
  }
  if (Array.isArray(b)) return false
  if (!isPlainRecord(a) || !isPlainRecord(b)) return false

  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  const recA = a as Record<string, unknown>
  const recB = b as Record<string, unknown>
  for (let i = 0; i < keysA.length; i++) {
    const key = keysA[i]
    if (key !== keysB[i]) return false
    if (!sameJson(recA[key], recB[key])) return false
  }
  return true
}

/**
 * The document, rebuilt from whichever fragments are still good.
 *
 * One top-level key per line rather than the two-space indent this used to
 * write. The old format pretty-printed the entire tree, which on a real mailbox
 * meant a 25 MB file of mostly leading spaces and put V8's slow indenting path
 * on the hot path of every keystroke. Per-key lines keep the file greppable and
 * diffable at the granularity anyone actually reads it at — "which slice got
 * big", "did settings change" — while letting each fragment be produced by the
 * fast compact `JSON.stringify` and reused as-is with no re-indenting pass.
 *
 * The cache is *not* invalidated when a write fails. It records what was last
 * encoded, not what reached the disk, and since every write emits the whole
 * document a failed one simply means the same bytes are produced again next
 * time. Tying it to write outcomes would add a way for the two to disagree.
 */
function encodeState(state: unknown): Buffer {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    // Not a document with slices — an array, a primitive, a null. Nothing to
    // cache, and leaving a stale cache behind would compare the next real
    // state against values from a different shape entirely.
    sliceValues = null
    sliceFragments = null
    return Buffer.from(JSON.stringify(state) ?? 'null', 'utf8')
  }

  const record = state as Record<string, unknown>
  const previousValues = sliceValues
  const previousFragments = sliceFragments
  const values: Record<string, unknown> = {}
  const fragments: Record<string, Buffer> = {}
  const chunks: Buffer[] = [DOC_OPEN]

  for (const key of Object.keys(record)) {
    const value = record[key]
    let fragment: Buffer | undefined
    if (
      previousValues !== null &&
      previousFragments !== null &&
      hasOwn(previousFragments, key) &&
      sameJson(value, previousValues[key])
    ) {
      fragment = previousFragments[key]
    } else {
      const json = JSON.stringify(value)
      // `undefined`, a function or a symbol: `JSON.stringify` drops the key
      // entirely, and so must this, or the document would gain a key that
      // stringifying the same object would not have produced.
      if (json === undefined) continue
      fragment = Buffer.from(json, 'utf8')
    }
    values[key] = value
    fragments[key] = fragment
    chunks.push(Buffer.from(`${chunks.length > 1 ? ',\n' : ''}${JSON.stringify(key)}:`, 'utf8'))
    chunks.push(fragment)
  }

  sliceValues = values
  sliceFragments = fragments
  if (chunks.length === 1) return DOC_EMPTY
  chunks.push(DOC_CLOSE)
  return Buffer.concat(chunks)
}

/*
 * ---------------------------------------------------------------------------
 * One write at a time
 * ---------------------------------------------------------------------------
 *
 * `saveState` has three callers that do not know about each other — the
 * renderer's debounce, its retry after a failed write, and its flush on the way
 * out — so overlapping calls happen. Letting them run concurrently was the bug
 * `tempSeq` fixes; letting them run at all is still waste, because the loser of
 * a race writes a document that is superseded before anyone reads it.
 *
 * So there is one slot. A save that arrives while a write is in flight replaces
 * whatever was waiting, and every caller waiting on that slot resolves together
 * when it lands. That is honest towards the renderer, which uses the resolution
 * to mark state as persisted: the promise for save N resolves only once a
 * document at least as new as N is on disk, which is exactly the fact "no need
 * to write N again" depends on.
 */
type QueuedWrite = { contents: Buffer; resolve: () => void; reject: (e: unknown) => void }

let queuedWrite: QueuedWrite | null = null
let queuedPromise: Promise<void> | null = null
let writeLoop: Promise<void> | null = null

/**
 * Drain the slot until it is empty, then stand down — in one synchronous turn.
 *
 * The teardown is inside this function rather than in a `.finally()` chained
 * onto the promise it returns, and the difference is worth writing down because
 * the chained form *looks* equivalent and is only accidentally safe:
 *
 *   1. The last job settles. `job.resolve()` does not *run* the continuations
 *      waiting on it — it queues them as microtasks.
 *   2. The `while` sees an empty slot and the function returns. Its promise
 *      resolving queues the external `.finally` as a *later* microtask.
 *   3. A continuation from step 1 runs first and calls `saveState` again.
 *   4. `enqueueStateWrite` sees `writeLoop` still set, so it parks the job in
 *      the slot and does not start a loop — relying on a loop that has already
 *      exited. The job sits there with nobody to write it and a promise that
 *      never settles: a lost save on the quit path, a hang anywhere else.
 *
 * Step 3 is not currently reachable. The only continuation that runs in that
 * gap is `saveState`'s own `await`, which does nothing but return, so every
 * external caller resumes a microtask later — after the teardown. That was
 * checked by reverting to the chained form and re-running the concurrency
 * tests, which still passed.
 *
 * It is written this way regardless. "Safe because of where exactly one `await`
 * sits in the caller" is not a property anybody will re-derive before adding a
 * second one, and not depending on it costs a `try/finally`. Doing the teardown
 * in the same synchronous turn as the loop exit means any
 * continuation that runs later sees `writeLoop === null` and starts a new
 * loop. The re-check afterwards costs nothing and closes the case where the
 * slot was refilled by a `job.reject()` handler running synchronously.
 */
async function runWriteQueue(): Promise<void> {
  try {
    while (queuedWrite) {
      const job = queuedWrite
      queuedWrite = null
      queuedPromise = null
      try {
        await writeAtomic(STATE_FILE, job.contents)
        job.resolve()
      } catch (e) {
        job.reject(e)
      }
    }
  } finally {
    writeLoop = null
    if (queuedWrite) startWriteLoop()
  }
}

function startWriteLoop(): void {
  if (writeLoop) return
  // Not `.finally()` — see `runWriteQueue`, which owns its own teardown.
  writeLoop = runWriteQueue()
}

function enqueueStateWrite(contents: Buffer): Promise<void> {
  if (queuedWrite && queuedPromise) {
    // Superseded before it ever reached the disk. Whoever is waiting on this
    // slot wanted "my state is saved", and newer bytes satisfy that.
    queuedWrite.contents = contents
    return queuedPromise
  }
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  queuedWrite = { contents, resolve, reject }
  queuedPromise = promise
  startWriteLoop()
  return promise
}

export async function saveState(state: unknown): Promise<void> {
  // Encoding is synchronous and has to be: the object belongs to the caller,
  // and yielding first would let the next IPC message hand us a newer one
  // while this one is half-read. It is also the part this whole section exists
  // to make cheap, so it is no longer the reason to worry about doing it here.
  await enqueueStateWrite(encodeState(state))
}

/** Is there a state write that has not reached the disk yet? */
export function stateWritePending(): boolean {
  return writeLoop !== null
}

/**
 * Settle every outstanding state write.
 *
 * Quitting is the one moment a dropped write is unrecoverable rather than
 * merely late, and the coalescing above means a save the renderer already
 * considers "in progress" may not have started. The loop rather than a single
 * await is deliberate: a save can arrive while the previous one is draining,
 * and returning after the first drain would leave exactly that one behind.
 *
 * Never rejects. The caller is a quit handler, and a failed write there has
 * nowhere useful to be reported to — the individual `saveState` promise already
 * carried the error to whoever asked for the write.
 */
export async function flushState(): Promise<void> {
  while (writeLoop) {
    await writeLoop.catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Dispatch ledger
// ---------------------------------------------------------------------------
//
// `electron/scheduler.ts` keeps an in-memory `fired` set so the same
// occurrence is never paid twice by this process — but "this process" is the
// gap. SMTP can accept a send and the process can die before that in-memory
// fact ever reaches `state.json`, which is written on a debounce several
// steps downstream of the send. On restart `job.occurrences` (still holding
// the just-sent instant) looks exactly like a missed occurrence.
//
// This file is where that gets resolved, and it replaces the old boolean
// "fired-occurrences" claim entirely — one entry per occurrence, tracking
// *how far* the send got (`'claimed'` -> `'sending'` -> `'accepted'`), not
// just whether it started. See `src/core/dispatchLedger.ts` for the entry
// shape and `resolveLedgerEntryOnRestart`, the pure decision table restart
// recovery is built on. It mirrors `JobStore`'s ledger on the Android side,
// down to writing the `'sending'` transition durably before the SMTP call
// rather than after — the same reasoning applies to a process `kill` as to a
// worker OS-killed mid-send.

/** How old an entry can be before no restart recovery could still make sense of the occurrence it names — see `pruneLedger`. Same bound the old claim file used. */
const CLAIM_MAX_AGE_MS = 24 * 60 * 60 * 1000

type LedgerMap = Record<string, DispatchLedgerEntry>

async function readLedger(): Promise<LedgerMap> {
  return (await readJson<LedgerMap>(LEDGER_FILE)) ?? {}
}

/** Drop entries old enough that no `rearm()` could still resurrect the occurrence — keeps the file from growing for the life of the install. Entries are normally removed the moment they are done (see `deleteLedgerEntry`); this is the safety net for the ones a crash left behind with nobody left to clean them up. */
function pruneLedger(map: LedgerMap): LedgerMap {
  const cutoff = Date.now() - CLAIM_MAX_AGE_MS
  const out: LedgerMap = {}
  for (const [key, entry] of Object.entries(map)) {
    if (entry.claimedAt >= cutoff) out[key] = entry
  }
  return out
}

async function writeLedger(map: LedgerMap): Promise<void> {
  await writeAtomic(LEDGER_FILE, JSON.stringify(pruneLedger(map)))
}

/**
 * Every entry on disk — read once at startup so `Scheduler.restoreDispatchLedger`
 * can resolve each one (resend, or complete the bookkeeping only) before the
 * first `sync()`/`tick()` runs.
 */
export async function loadDispatchLedger(): Promise<DispatchLedgerEntry[]> {
  return Object.values(await readLedger())
}

/**
 * One ledger write at a time — two jobs due in the same 15-second tick would
 * otherwise both read-modify-write this file concurrently, and the loser's
 * transition is exactly the one this exists to not lose. Nothing else in this
 * module needs the same treatment: `state.json` already serializes through
 * `enqueueStateWrite`/`writeLoop`, and secrets are read-then-written only from
 * user-triggered, non-concurrent calls.
 */
let ledgerQueue: Promise<unknown> = Promise.resolve()

function enqueueLedgerWrite<T>(job: () => Promise<T>): Promise<T> {
  const next = ledgerQueue.catch(() => {}).then(job)
  ledgerQueue = next.catch(() => {})
  return next
}

/**
 * Durably record that this occurrence has been picked to fire. Callers must
 * `await` this *before* evaluating send conditions, not after — writing it
 * after would reopen exactly the crash window this exists to close.
 *
 * Reuses the existing entry's `messageId` (and bumps `attempts`) when this
 * claimKey was already claimed by a prior attempt — a restart-recovered
 * resend, or a retry after a durable-write failure — so the message a
 * recipient eventually gets carries the same `Message-Id` across every
 * attempt at the same occurrence. A claimKey with no prior entry mints a
 * fresh one.
 */
export function claimLedgerEntry(
  claimKey: string,
  jobId: string,
  occurrenceMs: number,
): Promise<DispatchLedgerEntry> {
  return enqueueLedgerWrite(async () => {
    const map = await readLedger()
    const existing = map[claimKey]
    const entry: DispatchLedgerEntry = {
      claimKey,
      jobId,
      occurrenceMs,
      state: 'claimed',
      messageId: existing?.messageId ?? mintMessageId(claimKey),
      claimedAt: Date.now(),
      attempts: (existing?.attempts ?? 0) + 1,
    }
    map[claimKey] = entry
    await writeLedger(map)
    return entry
  })
}

/**
 * Durably record that an SMTP attempt for this claimKey is starting right
 * now. Callers must `await` this *before* the SMTP call, not after — this is
 * the transition that matters most, the one a process `kill` mid-send needs
 * to have already reached disk. Written once per actual attempt, so
 * `sendOnce`'s in-process retry loop calls this again on every retry.
 *
 * A no-op if the claim itself never made it to disk (a prior durable write
 * failed) — there is nothing to transition, and the send proceeds anyway; see
 * the caller in `electron/scheduler.ts`.
 */
export function markLedgerSending(claimKey: string): Promise<void> {
  return enqueueLedgerWrite(async () => {
    const map = await readLedger()
    const entry = map[claimKey]
    if (!entry) return
    map[claimKey] = { ...entry, state: 'sending', sendingAt: Date.now() }
    await writeLedger(map)
  })
}

/** Durably record that the SMTP server accepted the message — the one state with positive proof of delivery. Callers should await this immediately after the send call resolves successfully. */
export function markLedgerAccepted(claimKey: string): Promise<void> {
  return enqueueLedgerWrite(async () => {
    const map = await readLedger()
    const entry = map[claimKey]
    if (!entry) return
    map[claimKey] = { ...entry, state: 'accepted', acceptedAt: Date.now() }
    await writeLedger(map)
  })
}

/**
 * Remove the ledger entry for this claimKey — the completion signal. Called
 * once the job's own bookkeeping (runCount / lastRunAt / status /
 * occurrences) has recorded this occurrence's outcome, whatever that outcome
 * was: a missing entry means "fully done", not "fully sent".
 */
export function deleteLedgerEntry(claimKey: string): Promise<void> {
  return enqueueLedgerWrite(async () => {
    const map = await readLedger()
    if (!(claimKey in map)) return
    delete map[claimKey]
    await writeLedger(map)
  })
}

// ---------------------------------------------------------------------------
// Control audit log
// ---------------------------------------------------------------------------
//
// One durable record per control-API request, granted or refused — see
// `src/core/control.ts`'s `ControlAuditEntry`. Kept as its own file rather
// than folded into `state.json` for the same reason the dispatch ledger is:
// a request can be refused before the renderer is even asked (a bad bearer
// token, a scope the settings screen has not granted — see
// `electron/controlServer.ts`), so anything that waited for a round trip
// through application state, on its 350ms debounce, would simply never
// record that refusal. `electron/controlServer.ts` is the only writer; it
// sees every request on every doorway (HTTP, the drop folder) and appends
// exactly once per request, whatever became of it.

/** Oldest entries fall off once the file holds this many — a bearer token that never rotates could otherwise grow this file for the life of the install. Matches `Settings.logMaxEntries`'s default, which the same install already treats as "big enough to matter, small enough to not think about". */
const AUDIT_MAX_ENTRIES = 500

async function readAuditLog(): Promise<ControlAuditEntry[]> {
  return (await readJson<ControlAuditEntry[]>(CONTROL_AUDIT_FILE)) ?? []
}

/** One write at a time, same reasoning as `enqueueLedgerWrite`: two requests landing in the same tick must not read-modify-write this file concurrently and have the loser's entry vanish. */
let auditQueue: Promise<unknown> = Promise.resolve()

function enqueueAuditWrite<T>(job: () => Promise<T>): Promise<T> {
  const next = auditQueue.catch(() => {}).then(job)
  auditQueue = next.catch(() => {})
  return next
}

/**
 * Append one entry and trim to `AUDIT_MAX_ENTRIES`, oldest first out.
 *
 * Never rejects into the caller's request handling — `electron/controlServer.ts`
 * awaits this before answering, and a disk hiccup writing the audit trail must
 * not be the reason a legitimate request also fails to get an answer. Logged
 * to the console instead, the same fallback `hooks.log` already uses for
 * every other control-server event.
 */
export async function appendControlAudit(entry: ControlAuditEntry): Promise<void> {
  await enqueueAuditWrite(async () => {
    const list = await readAuditLog()
    list.push(entry)
    const trimmed = list.length > AUDIT_MAX_ENTRIES ? list.slice(list.length - AUDIT_MAX_ENTRIES) : list
    await writeAtomic(CONTROL_AUDIT_FILE, JSON.stringify(trimmed))
  }).catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[control] failed to write audit log entry', e)
  })
}

/** Every entry currently on disk, oldest first — for the Settings screen. */
export async function loadControlAudit(): Promise<ControlAuditEntry[]> {
  return readAuditLog()
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

type SecretMap = Record<string, string>

/**
 * The map key a credential is stored under.
 *
 * `'smtp'` keeps the bare `accountId` — every secret ever written used this
 * shape, and changing it would orphan every existing password. `'imap'` gets
 * a suffixed key so a receiving credential for the same account never
 * collides with (and silently overwrites) the sending one; most providers
 * issue separate app passwords for SMTP and IMAP even on one mailbox.
 */
function secretKey(accountId: string, kind: SecretKind): string {
  return kind === 'smtp' ? accountId : `${accountId}:${kind}`
}

async function readSecrets(): Promise<SecretMap> {
  return (await readJson<SecretMap>(SECRET_FILE)) ?? {}
}

async function writeSecrets(map: SecretMap): Promise<void> {
  await writeAtomic(SECRET_FILE, JSON.stringify(map))
}

/**
 * `safeStorage` needs the app to be ready and, on Linux, a working keyring.
 * When it is unavailable we refuse to store rather than silently falling back
 * to plaintext — a password the user believes is encrypted but is not is worse
 * than an error message.
 */
function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'The operating system keystore is unavailable, so the password cannot be stored securely.',
    )
  }
}

export async function setSecret(
  accountId: string,
  secret: string,
  kind: SecretKind = 'smtp',
): Promise<void> {
  assertEncryptionAvailable()
  const map = await readSecrets()
  let blob: string
  try {
    blob = safeStorage.encryptString(secret).toString('base64')
  } catch (err) {
    // `isEncryptionAvailable()` answers "is there a keystore", not "can this
    // process use the key in it". On Windows the AES key lives DPAPI-wrapped in
    // Chromium's `Local State`; if that file was copied from another machine or
    // profile, unwrapping fails here — and it fails inside BoringSSL, so the
    // raw message is `error:1e000065 ... BAD_DECRYPT`, which tells the user
    // nothing. Fail with something they can act on instead of that.
    //
    // The raw text is logged, not interpolated. Pasting it into the message
    // made every layer above treat this as an unrecognised crash — the main
    // process matched `BAD_DECRYPT` in the string and opened a modal titled
    // "Aevistle hit an unexpected problem" over an app that was working.
    console.error('[aevistle] keystore encrypt failed:', err)
    throw new Error(
      "This computer's keystore would not accept the password. Aevistle can " +
        'only store passwords the operating system agrees to encrypt, and this ' +
        'usually means the app data was copied from another computer or Windows ' +
        'account. Signing in as that account, or removing and re-adding this mail ' +
        'account, lets it be saved again.',
    )
  }
  map[secretKey(accountId, kind)] = blob
  await writeSecrets(map)
}

export async function getSecret(
  accountId: string,
  kind: SecretKind = 'smtp',
): Promise<string | null> {
  const map = await readSecrets()
  const blob = map[secretKey(accountId, kind)]
  if (!blob) return null
  try {
    return safeStorage.decryptString(Buffer.from(blob, 'base64'))
  } catch {
    // Wrong OS user, restored backup from another machine, or rotated DPAPI
    // key — the ciphertext is simply not ours to read.
    return null
  }
}

/**
 * Whether a password is stored *and* this machine can still read it.
 *
 * The cheap version of this — "is there a blob under that key" — was a silent
 * failure waiting to happen, and it happened. When the OS keystore key changes
 * (a restored backup, a new Windows profile, a rotated DPAPI key) the blob is
 * still sitting there, so every reader agreed the password was set: the account
 * row said "password saved", `health.noSecret` counted zero accounts missing
 * one, and preflight raised no warning. Meanwhile `getSecret` returned null and
 * every send failed at sign-in. Nothing was broken loudly enough to look
 * broken.
 *
 * Decrypting is what makes the answer true. It costs one keystore call per
 * account — this runs when the account list is read, not per message — and in
 * exchange the existing "no saved password" banner and preflight warning start
 * firing, which is exactly what should happen when the password is unusable.
 *
 * Note this deliberately does not delete the unreadable blob. It may become
 * readable again (the user signs back into the right OS account), and throwing
 * away a credential the user cannot see is not a decision to make for them.
 */
export async function hasSecret(accountId: string, kind: SecretKind = 'smtp'): Promise<boolean> {
  return (await getSecret(accountId, kind)) !== null
}

export async function deleteSecret(accountId: string, kind: SecretKind = 'smtp'): Promise<void> {
  const map = await readSecrets()
  const key = secretKey(accountId, kind)
  if (!(key in map)) return
  delete map[key]
  await writeSecrets(map)
}

// ---------------------------------------------------------------------------
// Attachment snapshots
// ---------------------------------------------------------------------------

export function snapshotDir(jobId: string): string {
  return path.join(dataLocation(), ATTACHMENTS_DIR, jobId)
}

/** Where a pasted clipboard image lands before it becomes an `Attachment`. */
export function pastedDir(): string {
  return path.join(dataLocation(), PASTED_DIR)
}

export async function pruneSnapshots(liveJobIds: string[]): Promise<void> {
  const root = path.join(dataLocation(), ATTACHMENTS_DIR)
  const keep = new Set(liveJobIds)
  try {
    for (const entry of await fs.readdir(root)) {
      if (!keep.has(entry)) {
        await fs.rm(path.join(root, entry), { recursive: true, force: true }).catch(() => {})
      }
    }
  } catch {
    // No snapshot directory yet — nothing to prune.
  }
}

/** Rough size of everything in the data folder, for the settings panel. */
export async function dataFolderSize(): Promise<number> {
  let total = 0
  const walk = async (dir: string): Promise<void> => {
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry)
      try {
        const stat = await fs.stat(full)
        if (stat.isDirectory()) await walk(full)
        else total += stat.size
      } catch {
        /* vanished mid-walk */
      }
    }
  }
  await walk(dataLocation())
  return total
}
