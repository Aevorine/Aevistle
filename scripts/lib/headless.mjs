/**
 * Start the app for real, unattended, and hand a CDP port to a probe.
 *
 * Three probes now need the same thing — `layout-probe.mjs`, `ui-consistency.mjs`
 * and `open-mail-probe.mjs` — and each of them talks CDP to a window that is
 * already open, because each has to measure a real engine rather than a
 * simulation of one. Nothing in `npm run check` used to start that window, so
 * the requirements those probes assert were only ever checked when a developer
 * remembered to run them by hand. Two of the three had been sitting like that
 * for their whole lives: `ui-consistency.mjs` still says "Run the app with
 * `--remote-debugging-port=9445` first" in its header and no `check:*` script
 * pointed at it.
 *
 * This starts the two things they need — the Vite dev server (the "no mail
 * account" path each probe's header already documents and accounts for) and a
 * headless Chrome pointed at it with remote debugging on — runs the probe, and
 * tears both down again whether it passed or not.
 *
 * Extracted from `check-layout.mjs`, which had all of it inline. The reason it
 * is a library now rather than copied twice is the one `lib/stylesheets.mjs`
 * records: a gate that carries its own copy of the harness drifts from the
 * other copies, and the drift is invisible because both copies still run.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** An unused port, picked rather than hard-coded — a fixed 9445 collided with a Chrome another tool had already parked there. */
export async function freePort() {
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

export function findChrome() {
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
export async function waitFor(url, timeoutMs) {
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
export function killTree(child) {
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

/**
 * Start Vite + headless Chrome, run `probeScript` against them, return its exit
 * code. Everything is torn down whether the probe passed or not.
 *
 * `env` is merged into the probe's environment on top of `CDP_PORT`, so a
 * caller can pass its own knobs through without this file knowing about them.
 */
export async function runProbeAgainstApp(probeScript, env = {}) {
  const chrome = findChrome()
  if (!chrome) {
    console.error(
      '\n  Could not find Chrome (or Edge) to run the probe against.\n' +
        '  Set CHROME_PATH to its executable, or install Chrome.\n',
    )
    return 1
  }

  const cdpPort = await freePort()

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
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'aevistle-probe-'))
    try {
      chromeProc = spawn(
        chrome,
        [
          `--remote-debugging-port=${cdpPort}`,
          `--user-data-dir=${userDataDir}`,
          '--headless=new',
          '--no-first-run',
          '--disable-extensions',
          /*
           * Headless Chrome treats its window as never quite foreground and
           * throttles timers and rAF accordingly — `perf-probe.mjs`'s header
           * records an entire round of measurements thrown away because rAF had
           * been quietly clamped to ~1 Hz, which turned every frame-based number
           * into a measurement of the clamp.
           *
           * These three flags turn the clamping off. They do not make headless
           * equal to a real window, and nothing here pretends they do: the
           * latency probe still asserts against a layout milestone rather than
           * a presented frame, and reports the rAF cadence it observed so a
           * throttled run is visible in the output instead of silently slow.
           */
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          `http://127.0.0.1:${port}`,
        ],
        { detached: process.platform !== 'win32' },
      )
      chromeProc.on('error', () => {})

      const ready = await waitFor(`http://127.0.0.1:${cdpPort}/json/list`, 20_000)
      if (!ready) throw new Error('Chrome did not open its CDP port in time')
      // The CDP port answers as soon as Chrome's debug server is up, well before
      // the page it was launched with has actually loaded and React has
      // hydrated. Every probe that uses this waits for the app itself as well
      // (`waitForApp`), so this settle is only about not firing the first CDP
      // command into a browser that is still opening its first tab.
      await new Promise((r) => setTimeout(r, 3000))

      const probe = spawnSync('node', [probeScript], {
        stdio: 'inherit',
        env: { ...process.env, ...env, CDP_PORT: String(cdpPort) },
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

  return exitCode
}
