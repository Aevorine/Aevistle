/**
 * Run `perf-probe.mjs` for real, unattended, against an already-packaged
 * build — `npm run check:perf`.
 *
 * `perf-probe.mjs`'s own header explains why it never simulates a window: it
 * talks CDP to a real Electron process because headless/simulated engines
 * throttle `requestAnimationFrame` and poison exactly the numbers this probe
 * exists to measure. That means it cannot run the way the rest of `npm run
 * check` does — there is no window until something has been built and
 * launched, and `npm run check` itself runs *before* a build exists (see
 * `package.json`'s `check` script, which never calls `build` or `dist:win`).
 *
 * So this is deliberately its own script, not folded into `check`, and
 * deliberately does not build anything itself — building is expensive, and a
 * cluster of quick correctness checks should not block on packaging an
 * installer. It expects a Windows portable build to already exist under
 * `release/` (whatever `npm run dist:win` or `npm run dist:win:out` last
 * produced) and fails with a clear, actionable message rather than a
 * confusing CDP timeout if one does not.
 *
 * Usage, once a build exists:
 *
 *   npm run dist:win        # or dist:win:out — produces release/*-portable.exe
 *   npm run check:perf      # this script
 *
 * `AEVISTLE_PORTABLE_EXE` overrides the exe path directly, for a build that
 * was copied somewhere other than `release/` (see the `apk-not-copied`-shaped
 * gap this project already tracks for the Android side — the same "build
 * output and the place tooling looks for it can drift" risk applies here).
 *
 * Launches the real packaged binary with a scratch `--user-data-dir`, so this
 * never touches (or is confused by) whatever the user's own installed
 * Aevistle has on disk, and never leaves a stray process running or a temp
 * profile behind — mirroring `check-layout.mjs`'s launch/probe/teardown
 * shape for the same reasons that file documents.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** An unused port, picked rather than hard-coded — see `check-layout.mjs`'s identical helper for why. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** Wait for a URL to answer, polling rather than sleeping a fixed guess. */
async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

/** Kill a whole process tree — see `check-layout.mjs`'s identical helper for why a plain `child.kill()` is not enough on Windows. */
function killTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'])
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

/** The newest `*-portable.exe` under `release/`, by mtime — the one a fresh `dist:win` just produced. */
function findPortableExe() {
  const override = process.env.AEVISTLE_PORTABLE_EXE
  if (override) return existsSync(override) ? override : null

  const dir = path.join(process.cwd(), 'release')
  if (!existsSync(dir)) return null
  const candidates = readdirSync(dir)
    .filter((f) => /-win-x64-portable\.exe$/i.test(f))
    .map((f) => {
      const full = path.join(dir, f)
      return { full, mtime: statSync(full).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
  return candidates[0]?.full ?? null
}

const exe = findPortableExe()
if (!exe) {
  console.error(
    '\n  No packaged Windows portable build found to measure.\n' +
      '  Run `npm run dist:win` (or `dist:win:out`) first, then `npm run check:perf`.\n' +
      '  Or point AEVISTLE_PORTABLE_EXE at an existing *-win-x64-portable.exe.\n',
  )
  process.exit(1)
}

if (process.platform !== 'win32') {
  console.error('\n  check:perf measures a Windows portable build and only runs on win32.\n')
  process.exit(1)
}

const CDP_PORT = await freePort()
const userDataDir = mkdtempSync(path.join(tmpdir(), 'aevistle-perf-probe-'))

let appProc = null
let exitCode = 1
try {
  console.log(`\n  Measuring: ${exe}\n`)
  appProc = spawn(exe, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`], {
    detached: false,
  })
  appProc.on('error', () => {})

  const ready = await waitFor(`http://127.0.0.1:${CDP_PORT}/json/list`, 30_000)
  if (!ready) throw new Error('The packaged app did not open its CDP port in time')

  // The CDP port answers as soon as Chromium's debug server is up, ahead of
  // the renderer actually finishing boot (state hydration, the appearance
  // effect, first paint) — same settle rationale as `check-layout.mjs`.
  await new Promise((r) => setTimeout(r, 3000))

  const probe = spawnSync('node', ['scripts/perf-probe.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, CDP_PORT: String(CDP_PORT) },
  })
  exitCode = probe.status ?? 1
} catch (e) {
  console.error(`\n  ✗ ${e instanceof Error ? e.message : String(e)}\n`)
  exitCode = 1
} finally {
  killTree(appProc)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(userDataDir, { recursive: true, force: true })
      break
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

process.exit(exitCode)
