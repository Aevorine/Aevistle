/**
 * Run `layout-probe.mjs` for real, unattended — `npm run check:layout`.
 *
 * The probe itself only talks CDP to a window that is already open (see its
 * own header for why: it has to measure a real engine's layout, not a
 * simulation of one). Nothing in `npm run check` used to start that window,
 * so the 85% requirement it asserts was only ever checked when a developer
 * remembered to run it by hand — which is exactly the failure mode that left
 * the requirement undocumented-and-unenforced for as long as it was.
 *
 * This starts the two things the probe needs — the Vite dev server (the
 * "no mail account" path the probe's header already documents and accounts
 * for) and a headless Chrome pointed at it with remote debugging on — runs
 * the probe, and tears both down again whether it passed or not.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** An unused port, picked rather than hard-coded — a fixed 9445 collided with a Chrome another tool had already parked there. */
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

const CDP_PORT = await freePort()

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  const candidates =
    process.platform === 'win32'
      ? [
          'C:/Program Files/Google/Chrome/Application/chrome.exe',
          'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
          `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
          'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium']
  return candidates.find((c) => c && existsSync(c)) ?? null
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

/** Strip the ANSI color codes Vite wraps its port number in — otherwise `\x1B[1m` sits between the colon and the digits. */
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '')
}

/** Parse the port Vite actually bound — `strictPort` is off, so it can differ from the config default under contention. */
function waitForVitePort(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('Vite dev server did not report a URL in time')), timeoutMs)
    const onData = (chunk) => {
      buf += stripAnsi(chunk.toString('utf8'))
      const m = /Local:\s+https?:\/\/[^:]+:(\d+)/.exec(buf)
      if (m) {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        resolve(Number(m[1]))
      }
    }
    child.stdout.on('data', onData)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Vite dev server exited early (code ${code})`))
    })
  })
}

/** Kill a whole process tree — a plain `child.kill()` leaves Chrome's helper processes behind, on Windows especially. */
function killTree(child) {
  if (!child.pid) return
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

const chrome = findChrome()
if (!chrome) {
  console.error(
    '\n  Could not find Chrome (or Edge) to run the layout probe against.\n' +
      '  Set CHROME_PATH to its executable, or install Chrome.\n',
  )
  process.exit(1)
}

// Windows needs `shell: true` to resolve `npx`'s `.cmd` shim, and passing an
// argv array alongside `shell: true` is a deprecated no-op Node warns about —
// so Windows gets one command string and everywhere else gets a real argv
// array. Nothing here is user input, so string-vs-array is a warning to
// silence, not an escaping concern.
const vite =
  process.platform === 'win32'
    ? spawn('npx vite --host 127.0.0.1', { shell: true })
    : spawn('npx', ['vite', '--host', '127.0.0.1'], { detached: true })
// Node throws an uncaught exception — past the try/catch below, cleanup
// skipped entirely — if a spawned process is unspawnable (bad path, no
// permission) and nothing is listening for its 'error' event. Both children
// get a listener that does nothing but keep that from happening.
vite.on('error', () => {})
let chromeProc = null
let exitCode = 1

try {
  const port = await waitForVitePort(vite, 20_000)
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'aevistle-layout-probe-'))
  try {
    chromeProc = spawn(
      chrome,
      [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${userDataDir}`,
        '--headless=new',
        '--no-first-run',
        '--disable-extensions',
        `http://127.0.0.1:${port}`,
      ],
      { detached: process.platform !== 'win32' },
    )
    chromeProc.on('error', () => {})

    const ready = await waitFor(`http://127.0.0.1:${CDP_PORT}/json/list`, 20_000)
    if (!ready) throw new Error('Chrome did not open its CDP port in time')
    // The CDP port answers as soon as Chrome's debug server is up, well before
    // the page it was launched with has actually loaded and React has
    // hydrated. The probe's own settle waits are tuned against a warm window;
    // its first interaction in a session is the narrow-viewport nav click,
    // and racing that against a cold Vite dev-server load — many unbundled
    // module requests, not a production bundle — landed on "unknown" often
    // enough to be worth a settle here rather than intermittently. Backed up
    // by a retry inside `layout-probe.mjs`'s own `goto()` now too, so a
    // slower machine than this one gets a second chance instead of a flat
    // false failure.
    await new Promise((r) => setTimeout(r, 5000))

    const probe = spawnSync('node', ['scripts/layout-probe.mjs'], {
      stdio: 'inherit',
      env: { ...process.env, CDP_PORT: String(CDP_PORT) },
    })
    exitCode = probe.status ?? 1
  } finally {
    if (chromeProc) killTree(chromeProc)
    // `taskkill /T /F` returns before Windows has actually released every file
    // handle the process tree held — an immediate rmSync of the profile dir
    // it just wrote logs and caches into hit EPERM often enough to need a
    // couple of retries rather than one immediate attempt.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(userDataDir, { recursive: true, force: true })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
  }
} catch (e) {
  console.error(`\n  ✗ ${e instanceof Error ? e.message : String(e)}\n`)
  exitCode = 1
} finally {
  killTree(vite)
}

process.exit(exitCode)
