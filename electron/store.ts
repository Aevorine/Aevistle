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

const STATE_FILE = 'state.json'
const SECRET_FILE = 'secrets.json'
const POINTER_FILE = 'location.json'
const ATTACHMENTS_DIR = 'attachments'
/** Images pasted from the clipboard straight into a compose body. */
const PASTED_DIR = 'pasted'
/** Plain-text copy of the data root, for the uninstaller. */
const PATH_HINT_FILE = 'datapath.txt'

/** What follows the user when the data folder moves. */
const MOVABLE = [STATE_FILE, SECRET_FILE, ATTACHMENTS_DIR, PASTED_DIR] as const

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
 * Write via a temp file + rename so a crash mid-write cannot truncate the
 * only copy of the user's schedules.
 */
async function writeAtomic(file: string, contents: string): Promise<void> {
  const target = dataPath(file)
  const temp = `${target}.tmp`
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(temp, contents, { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temp, target)
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(dataPath(file), 'utf8')
    return JSON.parse(raw) as T
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return null
    // A corrupt file should not brick the app. Move it aside so the user can
    // recover it manually, and start fresh.
    if (e instanceof SyntaxError) {
      await fs
        .rename(dataPath(file), dataPath(`${file}.corrupt-${Date.now()}`))
        .catch(() => {})
      return null
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

export async function loadState<T>(): Promise<T | null> {
  return readJson<T>(STATE_FILE)
}

export async function saveState(state: unknown): Promise<void> {
  await writeAtomic(STATE_FILE, JSON.stringify(state, null, 2))
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
    throw new Error(
      `The password could not be encrypted with this computer's keystore (${
        err instanceof Error ? err.message : String(err)
      }).`,
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
