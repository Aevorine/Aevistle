/**
 * Downloading a new version, on the desktop.
 *
 * The check itself is shared with Android (`src/core/update.ts`); only the
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

import { createHash } from 'node:crypto'
import { createWriteStream, promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { UpdateAsset, DownloadProgress } from '../src/core/update'

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

/** Only ever fetch from the project's own release host. */
function assertTrustedUrl(url: string): URL {
  const parsed = new URL(url)
  const host = parsed.hostname.toLowerCase()
  const allowed =
    host === 'github.com' ||
    host === 'api.github.com' ||
    host === 'objects.githubusercontent.com' ||
    host.endsWith('.githubusercontent.com')
  if (parsed.protocol !== 'https:' || !allowed) {
    throw new Error(`Refusing to download from ${parsed.host}`)
  }
  return parsed
}

type ChecksumLookup =
  | { status: 'matched'; hash: string }
  /** A checksum file was fetched successfully but had no line for this asset. */
  | { status: 'not-listed' }
  /** Neither spelling of the checksum file could be fetched at all. */
  | { status: 'unreachable' }

/**
 * Look up the published hash for `fileName`, distinguishing "the release
 * genuinely has no checksum for this file" from "the checksum file itself
 * could not be reached" — those two used to collapse into the same `null`,
 * which is exactly the kind of silent weakening that never shows up in
 * testing: a stripped-out checksum file looked identical to a release that
 * simply never published one.
 */
async function lookupChecksum(fileName: string): Promise<ChecksumLookup> {
  let reached = false
  for (const url of SUMS_URLS) {
    try {
      const response = await fetch(url, { redirect: 'follow' })
      if (!response.ok) continue
      reached = true
      const text = await response.text()
      for (const line of text.split(/\r?\n/)) {
        const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)
        if (match && path.basename(match[2].trim()) === fileName) {
          return { status: 'matched', hash: match[1].toLowerCase() }
        }
      }
    } catch {
      /* try the next spelling */
    }
  }
  return reached ? { status: 'not-listed' } : { status: 'unreachable' }
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
  const checksum = await lookupChecksum(safeName)

  if (checksum.status === 'unreachable') {
    await fs.rm(partPath, { force: true })
    throw new Error(
      'Could not verify the download: the checksum file could not be fetched',
    )
  }
  if (checksum.status === 'matched' && checksum.hash !== digest) {
    await fs.rm(partPath, { force: true })
    throw new Error('The downloaded file did not match the published checksum')
  }

  await fs.rm(finalPath, { force: true })
  await fs.rename(partPath, finalPath)

  const result: DownloadProgress = {
    receivedBytes,
    totalBytes: totalBytes || receivedBytes,
    done: true,
    path: finalPath,
    // Only 'matched' counts as verified — 'not-listed' means this release
    // simply did not publish a checksum, which is installable but unverified.
    checksumVerified: checksum.status === 'matched',
  }
  onProgress(result)
  return result
}
