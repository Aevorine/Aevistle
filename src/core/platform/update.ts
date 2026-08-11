/**
 * In-app update checking, shared by the desktop and Android builds.
 *
 * Deliberately built on the public GitHub Releases API rather than an update
 * framework. The app is distributed as one installer and one APK from one
 * repository; a framework would add a second distribution channel to keep in
 * sync, a signing story, and a background service — for a check that is three
 * fields of JSON.
 *
 * What leaves the device: an unauthenticated GET to api.github.com. No account
 * identifier, no telemetry, no message content. It can be switched off in
 * Settings, and nothing else in the app ever talks to the network except SMTP.
 */

import type { Platform } from '../types'

export const RELEASES_API = 'https://api.github.com/repos/Aevorine/Aevistle/releases/latest'
export const RELEASES_PAGE = 'https://github.com/Aevorine/Aevistle/releases/latest'

export interface UpdateAsset {
  name: string
  url: string
  sizeBytes: number
}

export interface UpdateInfo {
  /** The version this build is. */
  current: string
  /** The newest published version, or `current` when the check could not run. */
  latest: string
  available: boolean
  /** Release page, always safe to open in a browser. */
  pageUrl: string
  /** The artefact for this platform, when the release published one. */
  asset?: UpdateAsset
  notes?: string
  publishedAt?: number
  /** Set when the check itself failed; `available` is then false. */
  error?: string
  checkedAt: number
}

/**
 * Compare two dotted versions numerically.
 *
 * String comparison gets `0.10.0 < 0.9.0` wrong, which would leave everyone on
 * the older build for as long as the app existed. A pre-release suffix
 * (`0.2.0-beta.1`) sorts *below* the release it precedes, matching semver.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = '', pre = ''] = String(v).replace(/^v/i, '').split('-', 2)
    return {
      parts: core.split('.').map((n) => Number.parseInt(n, 10) || 0),
      pre,
    }
  }
  const left = split(a)
  const right = split(b)

  const length = Math.max(left.parts.length, right.parts.length)
  for (let i = 0; i < length; i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }

  if (left.pre === right.pre) return 0
  if (!left.pre) return 1 // a release outranks its own pre-releases
  if (!right.pre) return -1
  return left.pre < right.pre ? -1 : 1
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

/** Shape of the two fields we read from the GitHub API. */
interface GithubRelease {
  tag_name?: string
  name?: string
  body?: string
  draft?: boolean
  prerelease?: boolean
  published_at?: string
  html_url?: string
  assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>
}

/**
 * Pick the artefact this platform can actually install.
 *
 * The desktop prefers the installer over the portable build: someone who ran
 * the installer expects an update to replace what they installed, not to leave
 * a second copy in their Downloads folder.
 */
export function pickAsset(
  release: GithubRelease,
  platform: Platform,
  /**
   * True when the running build is the portable one.
   *
   * Without it every desktop user was offered the installer, so someone
   * running Aevistle from a USB stick who pressed Update ended up with a
   * second, *installed* copy — and the portable one they were using still
   * sitting there at the old version. Like for like is the only sane default
   * for an update.
   */
  portable = false,
): UpdateAsset | undefined {
  const assets = (release.assets ?? []).filter((a) => a.name && a.browser_download_url)
  const match = (test: (name: string) => boolean) =>
    assets.find((a) => test(a.name!.toLowerCase()))

  const chosen =
    platform === 'android'
      ? match((n) => n.endsWith('.apk'))
      : portable
        ? (match((n) => n.endsWith('.exe') && n.includes('portable')) ??
          match((n) => n.endsWith('.exe')))
        : (match((n) => n.endsWith('.exe') && n.includes('setup')) ??
          match((n) => n.endsWith('.exe')))

  if (!chosen) return undefined
  return {
    name: chosen.name!,
    url: chosen.browser_download_url!,
    sizeBytes: chosen.size ?? 0,
  }
}

/**
 * Turn an API response into the shape the UI renders.
 *
 * Drafts and pre-releases are ignored: `/releases/latest` already excludes
 * them, but a repository can be reconfigured and shipping users a draft build
 * would be a bad surprise.
 */
export function parseRelease(
  raw: unknown,
  current: string,
  platform: Platform,
  now: number,
  /** See `pickAsset`. */
  portable = false,
): UpdateInfo {
  const release = (raw ?? {}) as GithubRelease
  const base: UpdateInfo = {
    current,
    latest: current,
    available: false,
    pageUrl: release.html_url || RELEASES_PAGE,
    checkedAt: now,
  }

  if (release.draft || release.prerelease) return base

  const tag = (release.tag_name || release.name || '').trim()
  if (!tag) return { ...base, error: 'The release feed did not include a version' }

  const latest = tag.replace(/^v/i, '')
  const available = isNewer(latest, current)

  return {
    ...base,
    latest,
    available,
    notes: release.body?.trim() || undefined,
    publishedAt: release.published_at ? Date.parse(release.published_at) : undefined,
    asset: available ? pickAsset(release, platform, portable) : undefined,
  }
}

/**
 * Ask GitHub what the newest release is.
 *
 * Failure is normal — no network, a corporate proxy, GitHub rate-limiting an
 * office full of unauthenticated requests — so it resolves with `error` set
 * rather than throwing. An update check is never worth an error dialog.
 */
export async function fetchLatest(
  current: string,
  platform: Platform,
  timeoutMs = 10_000,
  /** See `pickAsset`. Only the shell knows how this copy was installed. */
  portable = false,
  /**
   * How to make the request.
   *
   * Defaults to the global, which is right in the desktop main process and
   * wrong everywhere a renderer runs: `connect-src 'self'` refuses it, and the
   * refusal arrives as a bare `TypeError: Failed to fetch`. Android passes a
   * bridge-backed implementation — see `core/feeds.ts`. That this parameter
   * did not exist is why the Android update check never worked.
   */
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateInfo> {
  const now = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      return {
        current,
        latest: current,
        available: false,
        pageUrl: RELEASES_PAGE,
        checkedAt: now,
        error: `GitHub replied ${response.status}`,
      }
    }
    return parseRelease(await response.json(), current, platform, now, portable)
  } catch (e) {
    return {
      current,
      latest: current,
      available: false,
      pageUrl: RELEASES_PAGE,
      checkedAt: now,
      error: e instanceof Error ? e.message : String(e),
    }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// One check per launch, shared between whoever runs it and whoever shows it
// ---------------------------------------------------------------------------

/**
 * The check used to live inside the Settings card, which meant it only ever ran
 * for someone who opened Settings — the setting is called "check when Aevistle
 * starts" and it did not do that. Anyone who installed a build and never went
 * near Settings was never told about the next one.
 *
 * Moving the trigger to `App` splits it in two: the shell decides *when* to
 * check, the card decides *how to draw* the answer. This module is where the
 * answer sits in between, because it is the one place both already import and
 * because it keeps the plumbing out of `AppState` — a check result is not part
 * of the document that gets written to disk, and putting it there would mean
 * persisting a timestamp that is meaningless on the next launch.
 */
let lastCheck: UpdateInfo | null = null
const listeners = new Set<(info: UpdateInfo) => void>()

/** What the last check said, for a card that mounts after it finished. */
export function lastUpdateCheck(): UpdateInfo | null {
  return lastCheck
}

/** …and for a card that is already open when it finishes. */
export function onUpdateCheck(listener: (info: UpdateInfo) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

let startupCheckClaimed = false

/**
 * True exactly once per launch, for the caller that owns the startup check.
 *
 * A module-level flag rather than a ref, deliberately: a ref lives and dies
 * with the component holding it, which is how the old version ended up firing
 * again on every visit to Settings despite a comment claiming it ran once.
 * This one survives any amount of mounting and unmounting.
 */
export function claimStartupUpdateCheck(): boolean {
  if (startupCheckClaimed) return false
  startupCheckClaimed = true
  return true
}

/**
 * Run a check, publish the result, and never reject.
 *
 * `checkForUpdate` is documented as never throwing and `fetchLatest` honours
 * that, but the desktop route is an `ipcRenderer.invoke` — a main process that
 * throws, or a channel that is not registered, rejects. A rejection from a
 * fire-and-forget update check surfaces as `unhandledRejection`, and this app
 * has already shipped one of those once: Electron puts a native error dialog on
 * top of an otherwise perfectly working window. So the failure is turned into
 * the same `error`-bearing `UpdateInfo` a network failure produces, which the
 * card already knows how to draw.
 */
export async function runUpdateCheck(
  check: () => Promise<UpdateInfo>,
  current: string,
): Promise<UpdateInfo> {
  let info: UpdateInfo
  try {
    info = await check()
  } catch (e) {
    info = {
      current,
      latest: current,
      available: false,
      pageUrl: RELEASES_PAGE,
      checkedAt: Date.now(),
      error: e instanceof Error ? e.message : String(e),
    }
  }
  lastCheck = info
  // Copied first: a listener that unsubscribes on notify would otherwise
  // mutate the set being iterated.
  for (const listener of [...listeners]) listener(info)
  return info
}

/** Test seam, matching `__setBridge` — lets a check script start from clean. */
export function __resetUpdateChecks(): void {
  lastCheck = null
  startupCheckClaimed = false
  listeners.clear()
}

export interface DownloadProgress {
  receivedBytes: number
  totalBytes: number
  done: boolean
  /** Where the finished file landed. */
  path?: string
  error?: string
  /**
   * Set once `done`. `false` means the release published no checksum for
   * this file (installable, but the UI must say so and ask before
   * proceeding) — not to be confused with a hash *mismatch*, which is a
   * hard failure that throws before a result ever reaches this shape.
   */
  checksumVerified?: boolean
  /**
   * Set once `done`, desktop only. `false` covers two different things the
   * same way: the release hasn't published a manifest signature yet
   * (expected for a while after this field was added), or fetching it
   * failed — neither blocks install, both mean this download's authenticity
   * rests on the checksum alone. A signature that was published but did not
   * verify is never surfaced here: `downloadUpdate` throws before a result
   * reaches this shape, the same as a checksum mismatch does.
   */
  signatureVerified?: boolean
}
