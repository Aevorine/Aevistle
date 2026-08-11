/**
 * Downloading a new version, on the desktop.
 *
 * The check itself is shared with Android (`src/core/platform/update.ts`); only the
 * download needs the main process, because a browser download would leave the
 * user to find the file themselves and because the integrity check has to
 * happen somewhere with a real hash implementation.
 *
 * Three things this deliberately does *not* do:
 *   - install silently. Replacing a running program behind the user's back is
 *     how updaters get treated as malware, and the app may be mid-send.
 *   - trust the file. The release publishes SHA256SUMS; if it is there, the
 *     download is verified against it and refused on mismatch.
 *   - keep the partial file. A half-downloaded installer that still runs is
 *     worse than no installer.
 *
 * A fourth thing worth spelling out, because the earlier version of this file
 * got it wrong: a release that ships with *no* SHA256SUMS at all (human error
 * during publishing) is still installable — the UI just has to say so and ask
 * before proceeding, rather than silently skipping the check. But a checksum
 * file that cannot be *fetched* at all, when the multi-hundred-MB installer
 * right next to it just downloaded fine, is not the same situation — that
 * selective failure is refused outright rather than downgraded to a warning.
 */

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { createWriteStream, promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { UpdateAsset, DownloadProgress } from '../src/core/platform/update'
import { UPDATE_SIGNING_PUBLIC_KEY_SPKI_BASE64 } from './updateSigningKey'

const UPDATE_SIGNING_PUBLIC_KEY = createPublicKey({
  key: Buffer.from(UPDATE_SIGNING_PUBLIC_KEY_SPKI_BASE64, 'base64'),
  format: 'der',
  type: 'spki',
})

/**
 * Both spellings are tried because the checksum file has shipped under each,
 * and a name mismatch here fails *open* — `expectedHash` returns null and the
 * download is accepted unverified. That is precisely the kind of silent
 * weakening that never shows up in testing.
 */
const SUMS_URLS = [
  'https://github.com/Aevorine/Aevistle/releases/latest/download/SHA256SUMS.txt',
  'https://github.com/Aevorine/Aevistle/releases/latest/download/SHA256SUMS',
]

/**
 * Only ever fetch from *this project's* releases.
 *
 * The host allowlist alone was not enough. The asset to download arrives from
 * the renderer, and `github.com` is a host anyone can publish a release on — so
 * a URL pointing at `github.com/someone-else/their-repo/releases/...` passed,
 * the checksum lookup then found no line for it (that file belongs to this
 * repo), and the download was offered as installable-but-unverified. Reaching
 * that state needs a compromised renderer, which contextIsolation, the sandbox
 * and the CSP all exist to prevent — but "you would need another bug first" is
 * the argument every defence-in-depth layer is there to stop relying on.
 *
 * The path is now pinned too. `objects.githubusercontent.com` is where GitHub
 * redirects asset downloads to and carries an opaque path, so it is checked on
 * host alone; the human-facing hosts must additionally be under this repo.
 */
const REPO_PATH = '/Aevorine/Aevistle/'

function assertTrustedUrl(url: string): URL {
  const parsed = new URL(url)
  const host = parsed.hostname.toLowerCase()
  const isRedirectTarget =
    host === 'objects.githubusercontent.com' || host.endsWith('.githubusercontent.com')
  const isRepoHost = host === 'github.com' || host === 'api.github.com'
  if (parsed.protocol !== 'https:' || !(isRepoHost || isRedirectTarget)) {
    throw new Error(`Refusing to download from ${parsed.host}`)
  }
  if (isRepoHost && !parsed.pathname.startsWith(REPO_PATH)) {
    throw new Error(`Refusing to download from outside ${REPO_PATH}: ${parsed.pathname}`)
  }
  return parsed
}

type ManifestFetch = { status: 'reached'; text: string } | { status: 'unreachable' }

/**
 * Fetch the checksum manifest's exact text, tried under both spellings it
 * has shipped under. Returned as one string rather than pre-parsed: the
 * signature below has to cover the exact bytes that were signed, and parsing
 * first would mean re-serializing to get them back — an unnecessary place
 * for the two to quietly drift apart.
 */
async function fetchManifestText(): Promise<ManifestFetch> {
  for (const url of SUMS_URLS) {
    try {
      const response = await fetch(url, { redirect: 'follow' })
      if (!response.ok) continue
      return { status: 'reached', text: await response.text() }
    } catch {
      /* try the next spelling */
    }
  }
  return { status: 'unreachable' }
}

/**
 * The published hash for `fileName`, or `null` if the manifest has no line
 * for it — kept distinct from "the manifest itself could not be fetched" one
 * level up, which is exactly the kind of silent weakening that never shows
 * up in testing: a stripped-out checksum line looked identical to a release
 * that simply never published one.
 */
function findManifestHash(manifestText: string, fileName: string): string | null {
  for (const line of manifestText.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)
    if (match && path.basename(match[2].trim()) === fileName) return match[1].toLowerCase()
  }
  return null
}

const SIG_URL = 'https://github.com/Aevorine/Aevistle/releases/latest/download/SHA256SUMS.txt.ed25519'

type SignatureCheck =
  /** The manifest's signature verified against the key embedded in this build. */
  | { status: 'verified' }
  /**
   * A signature was published but does not verify. Never downgrade this to
   * "unverified" — a manifest and its signature that disagree is exactly the
   * shape a forged release takes: an attacker who can write to the release
   * can replace `SHA256SUMS.txt` and the installer together (the checksum
   * would still "match"), but cannot produce a signature this key accepts
   * without the private half, which never leaves the maintainer's machine.
   */
  | { status: 'invalid' }
  /** This release predates the feature, or hasn't been signed yet — not a failure. */
  | { status: 'missing' }
  /** Could not be checked this run — a network problem, not a verdict. */
  | { status: 'unreachable' }

/**
 * Verify `manifestText` (the exact bytes `fetchManifestText` returned)
 * against the update-signing key baked into this build.
 *
 * Only `missing` (HTTP 404 — this release genuinely has no signature yet) is
 * soft: a manifest that fetched and hashed fine is still installable without
 * one, exactly like a release with no SHA256SUMS.txt at all always has been.
 * That is a deliberate rollout choice, since older releases will never
 * retroactively grow a signature — not an oversight. `invalid` and
 * `unreachable` are both hard failures at the call site: by the time this
 * runs, the installer and the manifest have both already been fetched
 * successfully, so a failure that selectively hits only the signature
 * request is not an ordinary outage.
 */
async function verifyManifestSignature(manifestText: string): Promise<SignatureCheck> {
  let response: Response
  try {
    response = await fetch(SIG_URL, { redirect: 'follow' })
  } catch {
    return { status: 'unreachable' }
  }
  if (response.status === 404) return { status: 'missing' }
  if (!response.ok) return { status: 'unreachable' }

  const sigText = (await response.text()).trim()
  let signature: Buffer
  try {
    signature = Buffer.from(sigText, 'base64')
  } catch {
    return { status: 'invalid' }
  }
  if (signature.length === 0) return { status: 'invalid' }

  const ok = verifySignature(null, Buffer.from(manifestText, 'utf8'), UPDATE_SIGNING_PUBLIC_KEY, signature)
  return { status: ok ? 'verified' : 'invalid' }
}

/**
 * Stream the asset to disk, reporting progress.
 *
 * Written to a `.part` file and renamed only after the hash matches, so an
 * interrupted download can never be mistaken for a finished one.
 */
export async function downloadUpdate(
  asset: UpdateAsset,
  targetDir: string,
  onProgress: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<DownloadProgress> {
  const url = assertTrustedUrl(asset.url)
  // basename() so a crafted asset name cannot escape the download directory.
  const safeName = path.basename(asset.name).replace(/[^A-Za-z0-9._-]/g, '_')
  const finalPath = path.join(targetDir, safeName)
  const partPath = `${finalPath}.part`

  await fs.mkdir(targetDir, { recursive: true })
  await fs.rm(partPath, { force: true })

  const response = await fetch(url, { redirect: 'follow', signal })
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status}`)
  }

  const declared = Number(response.headers.get('content-length') ?? 0)
  const totalBytes = declared || asset.sizeBytes || 0
  let receivedBytes = 0
  let lastReport = 0

  const hash = createHash('sha256')
  const source = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>)

  source.on('data', (chunk: Buffer) => {
    receivedBytes += chunk.length
    hash.update(chunk)
    // Throttled: a 100 MB installer would otherwise push tens of thousands of
    // IPC messages and make the progress bar the slowest part of the download.
    const now = Date.now()
    if (now - lastReport > 120) {
      lastReport = now
      onProgress({ receivedBytes, totalBytes, done: false })
    }
  })

  try {
    await pipeline(source, createWriteStream(partPath))
  } catch (e) {
    await fs.rm(partPath, { force: true })
    throw e
  }

  const digest = hash.digest('hex')
  const manifest = await fetchManifestText()

  if (manifest.status === 'unreachable') {
    await fs.rm(partPath, { force: true })
    throw new Error(
      'Could not verify the download: the checksum file could not be fetched',
    )
  }
  const expectedHash = findManifestHash(manifest.text, safeName)
  if (expectedHash !== null && expectedHash !== digest) {
    await fs.rm(partPath, { force: true })
    throw new Error('The downloaded file did not match the published checksum')
  }

  /*
   * A checksum proves the download matches what SHA256SUMS.txt says — not
   * who published either of them, since both come from the same release the
   * same credential writes to. The signature is what proves that: it is
   * checked against a key baked into this build rather than fetched
   * alongside the thing it verifies, so replacing the manifest and the
   * installer together (which a compromised release credential *can* do) is
   * no longer enough on its own.
   */
  const signature = await verifyManifestSignature(manifest.text)
  if (signature.status === 'invalid') {
    await fs.rm(partPath, { force: true })
    throw new Error(
      'The checksum file is signed, but the signature does not match — refusing to install',
    )
  }
  /*
   * `missing` (HTTP 404 — this release genuinely has no signature published,
   * expected for a while after this feature ships) is the only soft outcome.
   * `unreachable` is refused for the same reason the manifest fetch above
   * is: by this point the installer and SHA256SUMS.txt have both already
   * been fetched successfully, so a network condition that selectively
   * blocks only the signature request is not an ordinary outage — it is
   * exactly the shape blocking it to force a downgrade to hash-only
   * verification would take.
   */
  if (signature.status === 'unreachable') {
    await fs.rm(partPath, { force: true })
    throw new Error(
      'Could not verify the download: the update signature could not be fetched',
    )
  }

  await fs.rm(finalPath, { force: true })
  await fs.rename(partPath, finalPath)

  const result: DownloadProgress = {
    receivedBytes,
    totalBytes: totalBytes || receivedBytes,
    done: true,
    path: finalPath,
    // `expectedHash === null` means this release simply did not publish a
    // checksum for this file, which is installable but unverified.
    checksumVerified: expectedHash !== null,
    // Only `verified` and `missing` (this release has no signature yet) ever
    // reach here — `invalid` and `unreachable` both throw above.
    signatureVerified: signature.status === 'verified',
  }
  onProgress(result)
  return result
}
