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
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
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

// ---------------------------------------------------------------------------
// Getting the bytes
// ---------------------------------------------------------------------------

/**
 * How a download is split, and when it is worth splitting at all.
 *
 * Four connections rather than one because a single TCP stream over a
 * long-haul path is limited by its congestion window and not by the link: a
 * sender can only have one bandwidth-delay product in flight before it has to
 * stop and wait for acknowledgements, so on a 120 ms path to a CDN edge most
 * of a fast connection sits idle no matter how fast it is. Four streams have
 * four windows, and each one's stall is another one's turn. Past four the
 * returns against a single edge fall off and the request pattern starts to
 * look like something worth rate-limiting.
 *
 * Eight megabytes is the smallest piece worth its own connection, so the
 * arithmetic never turns a small artefact into four requests that each finish
 * before the handshake that set them up was worth making. Anything under
 * 4 x 8 MB stays exactly the one stream it has always been.
 */
const DOWNLOAD_SEGMENTS = 4
const MIN_SEGMENT_BYTES = 8 * 1024 * 1024
/** Attempts per segment. Only a connection that dies mid-range consumes one. */
const SEGMENT_ATTEMPTS = 4

/** The total length out of `Content-Range: bytes 0-0/12345`, or null. */
function parseContentRangeTotal(header: string | null): number | null {
  const match = /^bytes\s+\d+-\d+\/(\d+)$/i.exec((header ?? '').trim())
  if (!match) return null
  const total = Number(match[1])
  return Number.isSafeInteger(total) && total > 0 ? total : null
}

/**
 * One segment, byte-exact, restarted from wherever it got to.
 *
 * This is what "resume" means here. A dropped connection twenty megabytes into
 * a range does not restart the range — the next attempt asks for
 * `bytes=<start + what landed>-<end>`, so a download on a flaky link converges
 * instead of looping. What it deliberately does not do is resume across a
 * *restart of the app*: that needs a manifest of which ranges completed,
 * written and fsynced as they land, and the thing it would save is a download
 * measured in minutes that the user is watching a progress bar for.
 *
 * Writes at absolute offsets into a shared handle, which is why the segments
 * can run at once and why the hash below is taken from the finished file
 * rather than from the bytes going past.
 */
async function fetchSegment(
  url: string,
  start: number,
  endInclusive: number,
  handle: fs.FileHandle,
  report: (delta: number) => void,
  signal: AbortSignal,
): Promise<void> {
  let position = start
  let attempt = 0

  for (;;) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal,
        headers: { Range: `bytes=${position}-${endInclusive}` },
      })
      if (response.status !== 206 || !response.body) {
        // A server that answered the probe with 206 and this with anything
        // else has changed its mind mid-download. Retrying the range is the
        // right move; falling back to trusting a 200 here is not, because a
        // 200 is the *whole* file and would be written at this segment's
        // offset.
        throw new Error(`Download failed: HTTP ${response.status} on a ranged request`)
      }

      const source = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>)
      for await (const chunk of source) {
        const buffer = chunk as Buffer
        // Clamped rather than trusted. A server that sends past the end of the
        // range it was given must not be able to write over the next segment.
        const room = endInclusive + 1 - position
        if (room <= 0) break
        const take = buffer.length <= room ? buffer : buffer.subarray(0, room)
        await handle.write(take, 0, take.length, position)
        position += take.length
        report(take.length)
      }

      if (position > endInclusive) return
      throw new Error('The server closed a ranged request before the range was finished')
    } catch (e) {
      // An abort is the caller hanging up, not a network blip.
      if (signal.aborted) throw e
      attempt += 1
      if (attempt >= SEGMENT_ATTEMPTS) throw e
      // …and round again from `position`, which is exactly how far this
      // segment actually got. Nothing already written is fetched twice.
    }
  }
}

interface PartFile {
  receivedBytes: number
  totalBytes: number
  /** True when the file was assembled from more than one ranged request. */
  segmented: boolean
}

/**
 * Fill `partPath` with the asset, in as many pieces as the server allows.
 *
 * Range support is detected, never assumed — and detected by asking for one
 * byte, which answers two questions for the price of one round trip: whether
 * this server honours `Range` at all, and how long the file really is
 * (`Content-Range` is authoritative in a way the GitHub API's `size` field is
 * not). The reply also resolves the redirect from `github.com` to the asset
 * host once, so the segments that follow start from the final URL instead of
 * each paying for the same hop — which is most of the probe's cost back.
 *
 * Every fallback here lands on the single stream this function used to be.
 */
async function writePart(
  url: string,
  asset: UpdateAsset,
  partPath: string,
  onProgress: (progress: DownloadProgress) => void,
  signal: AbortSignal | undefined,
  allowSegments: boolean,
): Promise<PartFile> {
  await fs.rm(partPath, { force: true })

  let receivedBytes = 0
  let totalBytes = asset.sizeBytes || 0
  let lastReport = 0
  const report = (delta: number) => {
    receivedBytes += delta
    // Throttled: a 100 MB installer would otherwise push tens of thousands of
    // IPC messages and make the progress bar the slowest part of the download.
    const now = Date.now()
    if (now - lastReport > 120) {
      lastReport = now
      onProgress({ receivedBytes, totalBytes, done: false })
    }
  }

  /** The single stream, from a response already in hand. */
  const streamWhole = async (response: Response): Promise<PartFile> => {
    if (!response.body) throw new Error('Download failed: the server sent no body')
    const declared = Number(response.headers.get('content-length') ?? 0)
    totalBytes = declared || asset.sizeBytes || 0
    const source = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>)
    source.on('data', (chunk: Buffer) => report(chunk.length))
    try {
      await pipeline(source, createWriteStream(partPath))
    } catch (e) {
      await fs.rm(partPath, { force: true })
      throw e
    }
    return { receivedBytes, totalBytes, segmented: false }
  }

  if (!allowSegments || (asset.sizeBytes || 0) < DOWNLOAD_SEGMENTS * MIN_SEGMENT_BYTES) {
    const response = await fetch(url, { redirect: 'follow', signal })
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)
    return streamWhole(response)
  }

  const probe = await fetch(url, {
    redirect: 'follow',
    signal,
    headers: { Range: 'bytes=0-0' },
  })
  if (!probe.ok) throw new Error(`Download failed: HTTP ${probe.status}`)

  if (probe.status === 200) {
    // The server ignored the Range header and is sending the whole file. Take
    // it: throwing this response away to ask again would cost a round trip and
    // re-request everything already on the wire.
    return streamWhole(probe)
  }

  const total = probe.status === 206 ? parseContentRangeTotal(probe.headers.get('content-range')) : null
  // One byte either way from here; drain it so the connection can be reused.
  await probe.arrayBuffer().catch(() => undefined)

  if (total === null) {
    // A 206 whose Content-Range this cannot read, or some other answer
    // entirely. Not worth guessing at — take the plain stream.
    return writePart(url, asset, partPath, onProgress, signal, false)
  }

  const count = Math.min(DOWNLOAD_SEGMENTS, Math.floor(total / MIN_SEGMENT_BYTES))
  if (count < 2) return writePart(url, asset, partPath, onProgress, signal, false)

  totalBytes = total
  // Re-checked, because it is a destination the *server* chose: the probe
  // followed a redirect, and the allowlist has to hold for wherever it landed
  // exactly as it did for where it started.
  const resolved = assertTrustedUrl(probe.url || url).toString()

  const span = Math.ceil(total / count)
  const ranges: Array<[number, number]> = []
  for (let i = 0; i < count; i++) {
    const start = i * span
    if (start >= total) break
    ranges.push([start, Math.min(start + span, total) - 1])
  }

  // Its own controller so that one failed segment stops the other three
  // immediately rather than leaving them downloading into a file that is
  // already being deleted.
  const controller = new AbortController()
  const relay = () => controller.abort()
  signal?.addEventListener('abort', relay, { once: true })

  const handle = await fs.open(partPath, 'w+')
  let failure: unknown = null
  try {
    const settled = await Promise.allSettled(
      ranges.map(async ([start, end]) => {
        try {
          await fetchSegment(resolved, start, end, handle, report, controller.signal)
        } catch (e) {
          controller.abort()
          throw e
        }
      }),
    )
    // allSettled rather than all, so the handle is never closed underneath a
    // segment that has not finished unwinding yet.
    for (const result of settled) {
      if (result.status === 'rejected' && failure === null) failure = result.reason
    }
  } finally {
    await handle.close()
    signal?.removeEventListener('abort', relay)
  }

  if (failure !== null) {
    await fs.rm(partPath, { force: true })
    throw failure
  }

  /*
   * The reassembly's own check, before the checksum gets a look in.
   *
   * The segments write at absolute offsets into a sparse file, so a boundary
   * off by one byte produces a file of the wrong length rather than one that
   * merely hashes wrong. Checking the length here says so in those words. The
   * hash below would catch it too — that is the guarantee that matters and it
   * has not moved — but "the file is 4 bytes short" is a fault this code can
   * name, and a checksum mismatch is not.
   */
  const written = (await fs.stat(partPath)).size
  if (written !== total) {
    await fs.rm(partPath, { force: true })
    throw new Error(`The reassembled download is ${written} bytes, not the ${total} the server declared`)
  }

  return { receivedBytes, totalBytes: total, segmented: true }
}

/**
 * SHA-256 of what is actually on disk.
 *
 * Hashing moved off the socket and onto the file when the download stopped
 * arriving in order, and that is a strengthening rather than a compromise: the
 * old version hashed the bytes as they went past, which would have agreed with
 * the manifest even if they had subsequently been written to the wrong offset.
 * This hashes the artefact that would be installed.
 */
async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
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

  let part = await writePart(url.toString(), asset, partPath, onProgress, signal, true)
  let digest = await hashFile(partPath)
  const manifest = await fetchManifestText()

  if (manifest.status === 'unreachable') {
    await fs.rm(partPath, { force: true })
    throw new Error(
      'Could not verify the download: the checksum file could not be fetched',
    )
  }
  const expectedHash = findManifestHash(manifest.text, safeName)

  /*
   * A published hash that does not match, on a file assembled from four
   * ranged requests, has two possible causes, and only one of them is the
   * artefact's fault. The other is the transport: a proxy that rewrites ranged
   * responses, a CDN edge serving a stale object for one range and a fresh one
   * for another. Those are worth one more attempt down the single stream this
   * function used before segments existed.
   *
   * It is not a second chance at passing. The retry goes through exactly the
   * same comparison against exactly the same published hash, and a second
   * mismatch throws — the verification has not been softened, only given one
   * chance to rule out the mechanism this change introduced.
   */
  if (expectedHash !== null && expectedHash !== digest && part.segmented) {
    part = await writePart(url.toString(), asset, partPath, onProgress, signal, false)
    digest = await hashFile(partPath)
  }

  if (expectedHash !== null && expectedHash !== digest) {
    await fs.rm(partPath, { force: true })
    throw new Error('The downloaded file did not match the published checksum')
  }
  const { receivedBytes, totalBytes } = part

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
