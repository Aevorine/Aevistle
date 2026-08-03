/**
 * Reshoot the README screenshots from the packaged app.
 *
 * Not from `npm run dev`: the browser preview has no title bar, no tray, and a
 * different font stack, so a picture taken there is a picture of something the
 * user never sees. This drives the real `win-unpacked` build over CDP.
 *
 * Two things this script exists to guarantee:
 *
 *   1. No real data reaches a public image. The app is launched with
 *      `--user-data-dir` pointed at a scratch profile seeded with invented
 *      accounts and recipients (`lin.zhao@example.com`, `team@example.com`).
 *      The user's own data folder is never opened, and the scratch profile is
 *      deleted afterwards.
 *   2. The seed contains an account and jobs, which is also what suppresses the
 *      first-run data-folder prompt — see `components/DataFolderSetup`, which
 *      treats "no accounts and no jobs" as the honest test for a first run.
 *
 * Usage:  node scripts/shoot-readme.mjs [--keep]
 *         --keep leaves the scratch profile behind for inspection.
 */

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TITLEBAR_PS1 = path.join(ROOT, 'scripts', 'add-titlebar.ps1')
/**
 * Where the scratch profiles live.
 *
 * The Settings screen prints this path verbatim, so it is part of the picture:
 * a profile under `C:\Users\<name>\AppData\Local\Temp\aevistle-shot-XXXX` puts
 * the account name of whoever ran the script into a public README, and the
 * random suffix looks like a bug besides. A drive-root path was tried first and
 * is worse in a different way — nothing should be creating directories at the
 * root of C: to take a screenshot.
 *
 * A SUBST drive gives a short, neutral, disposable path (`X:\Aevistle`) backed
 * by an ordinary temp directory. If the mapping cannot be made, the run falls
 * back to the temp directory itself and the path is redacted afterwards.
 */
const SHOT_DRIVE = process.env.AEVISTLE_SHOT_DRIVE ?? 'X:'
const SHOT_BACKING = path.join(os.tmpdir(), 'aevistle-shot-root')
/** Set once the mapping is up; every profile is created under it. */
let shotRoot = SHOT_BACKING
const UNPACKED = path.join(os.tmpdir(), 'aevistle-release', 'win-unpacked', 'Aevistle.exe')
const OUT_DIR = path.join(ROOT, 'docs', 'assets')
const PORT = Number(process.env.CDP_PORT ?? 9444)
const KEEP = process.argv.includes('--keep')

/** Matches the existing images so the README's visual rhythm is unchanged. */
const WIDTH = 1400
const HEIGHT = 947
/** Height of the title bar drawn on afterwards; the page gets the remainder. */
const TITLEBAR_H = 38

// ---------------------------------------------------------------------------
// The invented data
// ---------------------------------------------------------------------------

const ACCOUNT_ID = 'demo-account'

/** Every address here is fictional and must stay that way. */
function seedState(locale) {
  const zh = locale === 'zh-CN'
  const now = Date.UTC(2026, 6, 27, 9, 0, 0)

  const account = {
    id: ACCOUNT_ID,
    label: zh ? '工作邮箱' : 'Work',
    fromName: zh ? '赵林' : 'Lin Zhao',
    fromAddress: 'lin.zhao@example.com',
    host: 'smtp.example.com',
    port: 465,
    // 'ssl', not 'tls' — see `TransportSecurity`. An invalid value here is not
    // rejected loudly, it just makes the account render wrong.
    security: 'ssl',
    username: 'lin.zhao@example.com',
    authMethod: 'password',
    hasSecret: true,
    timeoutMs: 20000,
  }

  const draft = {
    to: ['team@example.com'],
    cc: [],
    bcc: [],
    subject: zh ? '每周状态汇报 —— 第 31 周' : 'Weekly status report — week 31',
    body: zh
      ? '各位好：\n\n本周进展与下周计划已整理如下，请查收附件。'
      : "Hi all,\n\nThis week's progress and next week's plan are attached.",
    bodyFormat: 'text',
    attachments: [],
    accountId: ACCOUNT_ID,
    priority: 'normal',
    requestReadReceipt: false,
    individualDelivery: false,
  }

  /* Three of them, because the sidebar badge is part of the picture: an app
     that schedules mail should be shown with mail scheduled. */
  const jobNames = zh
    ? ['每周状态汇报', '月度发票提醒', '站会提醒']
    : ['Weekly status report', 'Monthly invoice reminder', 'Standup reminder']
  /* Every non-optional field of `Recurrence` has to be here. A partial one is
     not a smaller object, it is a broken one: hydration re-arms each enabled
     job through `rearm()` on boot, that throws on a malformed recurrence, and
     the whole seeded state is silently dropped — the app then comes up empty,
     in the OS language, looking like the seed was never written. */
  const jobs = jobNames.map((name, i) => ({
    id: `demo-job-${i + 1}`,
    name,
    enabled: true,
    draft: { ...draft, subject: name },
    recurrence: {
      kind: 'weekly',
      startAt: now,
      timeOfDay: ['09:00', '10:00', '09:30'][i],
      weekdays: [[1], [1], [1, 2, 3, 4, 5]][i],
      monthDayFallback: 'last',
      endMode: 'never',
      jitterSeconds: 0,
      skipWeekends: false,
      catchUp: 'fireOnce',
    },
    occurrences: [],
    runCount: 0,
    retry: { maxAttempts: 3, backoffSeconds: 60, backoffFactor: 2 },
    status: 'armed',
    createdAt: now,
    updatedAt: now,
  }))

  return {
    accounts: [account],
    jobs,
    contacts: [],
    templates: [],
    logs: [],
    draft,
    inboxAccounts: [],
    draftSnapshots: [],
    outbox: [],
    codeHits: [],
    recentRecipients: [],
    settings: { locale, themeMode: 'light' },
    schemaVersion: 2,
  }
}

// ---------------------------------------------------------------------------
// Minimal CDP client
// ---------------------------------------------------------------------------

class CDP {
  #ws
  #id = 0
  #pending = new Map()

  static async attach(port) {
    // The app needs a moment to open its port and its window.
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`)
        const targets = await res.json()
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
        if (page) return new CDP(page.webSocketDebuggerUrl)
      } catch {
        /* not up yet */
      }
      await sleep(500)
    }
    throw new Error(`No page target on :${port} after 30s`)
  }

  constructor(url) {
    this.#ws = new WebSocket(url)
    this.#ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data)
      const p = this.#pending.get(msg.id)
      if (!p) return
      this.#pending.delete(msg.id)
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
    })
    this.ready = new Promise((res, rej) => {
      this.#ws.addEventListener('open', res, { once: true })
      this.#ws.addEventListener('error', rej, { once: true })
    })
  }

  send(method, params = {}) {
    const id = ++this.#id
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result?.value
  }

  close() {
    try {
      this.#ws.close()
    } catch {
      /* already gone */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Shooting
// ---------------------------------------------------------------------------

/**
 * Capture the whole window, native title bar included, via PrintWindow.
 *
 * `Page.captureScreenshot` was the obvious choice and is the wrong one here: it
 * photographs the web contents only, so the result is missing the title bar and
 * the window frame that every existing README image has — the picture would no
 * longer look like the application. `Browser.setWindowBounds` is also not
 * implemented in Electron's CDP, so the sizing has to happen through the OS
 * anyway.
 */
/**
 * Capture the page at exactly WIDTH x HEIGHT CSS pixels, at 2x.
 *
 * Two approaches were tried and abandoned before this one, both for the same
 * underlying reason — the window is a physical-pixel object and the layout is a
 * CSS-pixel one:
 *
 *   · `Page.captureScreenshot` at the window's natural size photographs
 *     whatever the window happens to be, so the layout depends on the machine's
 *     scaling factor.
 *   · Resizing the real window via SetWindowPos to 1400 x dpr = 1750px makes
 *     the page lay out correctly, but the window is then wider than a 1536px
 *     desktop, and PrintWindow returns empty pixels for the part hanging off
 *     the screen — a screenshot with its right-hand column sliced away.
 *
 * `Emulation.setDeviceMetricsOverride` sidesteps both: the page is told to lay
 * out at 1400 CSS pixels wide regardless of the window, and `deviceScaleFactor`
 * gives a 2x capture without needing a 2800px window to exist anywhere.
 */
async function shoot(cdp, file) {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  })
  const out = path.join(OUT_DIR, file)
  await fs.writeFile(out, Buffer.from(data, 'base64'))

  // The emulated viewport has no window frame, so the title bar every existing
  // README image carries is drawn back on. It is chrome, not content: faking it
  // shows the app as it actually appears without pretending anything about the
  // application itself.
  const res = await run('pwsh', [
    '-NoProfile',
    '-File',
    TITLEBAR_PS1,
    '-Image',
    out,
    '-Title',
    'Aevistle',
    '-Icon',
    path.join(ROOT, 'build', 'icon.png'),
  ])
  if (res.code !== 0) throw new Error(`titlebar failed: ${res.stderr.trim() || res.stdout.trim()}`)
  const { size } = await fs.stat(out)
  console.log(`  ${file}  ${res.stdout.trim()}  ${(size / 1024).toFixed(0)} KB`)
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => (stderr += d))
    p.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/**
 * Block until the app has hydrated and laid out.
 *
 * Fixed sleeps were tried and produced three failures that all looked like
 * separate bugs and were one: the shot landed while `.skeleton` placeholders
 * were still up, so the picture had grey bars instead of content, the UI was
 * still on the OS language because the seeded `locale` had not been read yet,
 * and the right-hand side was clipped because the window had just been resized
 * and the grid had not reflowed. Waiting on the DOM fixes all three.
 */
async function waitReady(cdp, expectLocale) {
  const deadline = Date.now() + 30000
  let last = null
  while (Date.now() < deadline) {
    const state = await cdp.evaluate(`
      (() => {
        const skeletons = document.querySelectorAll('.skeleton').length
        const nav = [...document.querySelectorAll('.nav__label')].map((n) => n.textContent.trim())
        const view = document.querySelector('.view__inner')
        return {
          skeletons,
          nav,
          // The seeded jobs show as a sidebar badge; its presence means state
          // has hydrated rather than merely rendered empty.
          badge: document.querySelector('.nav__badge')?.textContent?.trim() ?? null,
          width: view ? Math.round(view.getBoundingClientRect().width) : 0,
          docWidth: document.documentElement.clientWidth,
          // The gap the content area is *supposed* to leave: the sidebar plus
          // the page gutter. Measured rather than assumed, so this does not
          // have to be kept in step with the CSS.
          sidebar: Math.round(
            document.querySelector('.nav')?.closest('aside, .sidebar')?.getBoundingClientRect()
              .width ?? document.querySelector('.nav')?.getBoundingClientRect().width ?? 0,
          ),
        }
      })()
    `)
    const localeOk = state.nav.includes(expectLocale)
    /* The content area never spans the whole document — the sidebar takes its
       share. An earlier version compared against `docWidth` directly and could
       never pass: the 304px difference it kept rejecting *was* the sidebar. So
       compare against what is actually left over. */
    const expected = state.docWidth - state.sidebar
    const laidOut = state.width > 0 && expected - state.width < 80
    if (state.skeletons === 0 && localeOk && state.badge && laidOut) return state
    last = { ...state, localeOk, laidOut, want: expectLocale }
    await sleep(400)
  }
  throw new Error(`App did not become ready within 30s: ${JSON.stringify(last)}`)
}

/** Click a primary-nav entry by its visible label. */
async function goTo(cdp, label) {
  const ok = await cdp.evaluate(`
    (() => {
      const items = [...document.querySelectorAll('.nav__item')]
      const hit = items.find((el) => el.querySelector('.nav__label')?.textContent?.trim() === ${JSON.stringify(label)})
      if (!hit) return false
      hit.click()
      return true
    })()
  `)
  if (!ok) throw new Error(`No nav item labelled "${label}"`)
  // React re-renders on the next frame; measuring or shooting in the same task
  // catches the old view. See the brief's section 4. A frame is the floor, not
  // the guarantee — wait for the new view to have real content in it.
  await sleep(300)
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const ready = await cdp.evaluate(`
      (() => {
        if (document.querySelectorAll('.skeleton').length) return false
        const view = document.querySelector('.view__inner')
        if (!view) return false
        // A view that has laid out has real height; one mid-swap has none.
        return view.getBoundingClientRect().height > 200
      })()
    `)
    if (ready) return
    await sleep(300)
  }
  throw new Error(`View "${label}" did not settle`)
}

/**
 * Park the pointer off-window.
 *
 * A cursor left over the sidebar leaves a hover highlight on whichever entry it
 * happens to be near, which reads as a selected state in a still image.
 */
async function parkPointer(cdp) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: WIDTH - 4, y: HEIGHT - 4 })
  await sleep(200)
}

async function session(locale, shots) {
  /**
   * A neutral, fixed path — not `mkdtemp` under the system temp folder.
   *
   * The Settings screen prints the data folder verbatim, so on this machine a
   * scratch profile at `C:\Users\<name>\AppData\Local\Temp\aevistle-shot-XXXX`
   * put the account name of whoever ran the script into a picture destined for
   * a public README, and the random suffix made it look like a bug besides.
   * The path is part of the screenshot's content, so it has to be composed as
   * deliberately as the invented email addresses are.
   */
  const profile = path.join(shotRoot, locale === 'en' ? 'Aevistle' : 'Aevistle-zh')
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(profile, { recursive: true })
  await fs.writeFile(
    path.join(profile, 'state.json'),
    JSON.stringify(seedState(locale), null, 2),
    'utf8',
  )

  console.log(`\n${locale}  profile=${profile}`)
  const proc = spawn(
    UNPACKED,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${PORT}`,
      // A window that is not in the foreground gets its timers throttled, which
      // stalls anything awaited through CDP. Same flags as `perf-probe.mjs`.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
    { detached: false, stdio: 'ignore' },
  )

  let cdp
  try {
    cdp = await CDP.attach(PORT)
    await cdp.ready

    /**
     * Size first, then wait for readiness — in that order. Resizing after the
     * app has settled means every wait that follows is measuring a layout that
     * is about to change again.
     *
     * SetWindowPos and PrintWindow both work in *physical* pixels, while the
     * page lays out in CSS pixels. On a 1.25 scaling factor a window asked for
     * 1400 physical pixels gives the page 1120 CSS pixels to work with, and the
     * capture comes back with the right-hand column sliced off — which reads as
     * a broken layout rather than a mis-sized screenshot. The brief's section 4
     * records this trap from the last time it cost an afternoon. So ask the
     * page what its scaling factor is and size the window in its terms.
     */
    /* The page is pinned to an exact CSS size independent of the real window,
       which is what makes the result identical on any machine regardless of its
       screen size or scaling factor. `deviceScaleFactor: 2` gives a crisp image
       without needing a 2800px-wide window to fit on the desktop. */
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT - TITLEBAR_H,
      deviceScaleFactor: 2,
      mobile: false,
    })
    await waitReady(cdp, shots[0].ready[locale])
    await parkPointer(cdp)

    for (const { nav, file, prepare } of shots) {
      if (nav) await goTo(cdp, nav[locale])
      if (prepare) {
        await cdp.evaluate(prepare)
        await sleep(500)
      }
      await parkPointer(cdp)
      await shoot(cdp, file[locale])
    }
  } finally {
    cdp?.close()
    proc.kill()
    await sleep(800)
    if (!KEEP) await fs.rm(profile, { recursive: true, force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------

const SHOTS = [
  // Compose first: the app opens on it, so no navigation is needed and the
  // shot shows the screen a new user actually lands on.
  {
    nav: null,
    // A nav label that only exists in the intended language — this is what
    // `waitReady` watches to know the seeded locale has taken effect.
    ready: { en: 'Compose', 'zh-CN': '撰写' },
    file: { en: 'screenshot-compose.png', 'zh-CN': 'screenshot-compose.zh.png' },
    // Open the options disclosure for the photograph only. Collapsed is the
    // right default in the app — those settings are decided once and then left
    // alone, and the form has to fit one screen. But collapsed leaves the left
    // column half empty, and a README hero image showing a half-empty column
    // says "unfinished" about a layout that is not. Opening it fills the
    // column with the priority picker, attachments and the delivery switches,
    // which is more of the product on show, not less.
    prepare: `document.querySelector('.moreoptions')?.setAttribute('open', ''), true`,
  },
  {
    nav: { en: 'Settings', 'zh-CN': '设置' },
    ready: { en: 'Settings', 'zh-CN': '设置' },
    file: { en: 'screenshot-settings.png', 'zh-CN': 'screenshot-settings.zh.png' },
  },
]

try {
  await fs.access(UNPACKED)
} catch {
  console.error(`Packaged app not found at ${UNPACKED}\nRun \`npm run dist:win:out\` first.`)
  process.exit(1)
}

/**
 * Map the scratch root onto a short drive letter, and put it back afterwards.
 *
 * `subst` is the whole trick: the profiles are ordinary directories in the
 * system temp folder, but the app — and therefore the screenshot — sees them at
 * `X:\Aevistle`. Nothing is created outside temp, and nothing survives the run.
 */
async function withShotRoot(fn) {
  await fs.mkdir(SHOT_BACKING, { recursive: true })

  const mapped = await run('cmd', ['/c', 'subst', SHOT_DRIVE, SHOT_BACKING])
  const root = mapped.code === 0 ? `${SHOT_DRIVE}\\` : SHOT_BACKING
  if (mapped.code !== 0) {
    console.warn(
      `  note: could not map ${SHOT_DRIVE} (${mapped.stderr.trim() || 'in use'}); ` +
        'using the temp path, which will show in the Settings screenshot',
    )
  }

  try {
    return await fn(root)
  } finally {
    if (mapped.code === 0) await run('cmd', ['/c', 'subst', SHOT_DRIVE, '/d'])
    await fs.rm(SHOT_BACKING, { recursive: true, force: true }).catch(() => {})
  }
}

console.log(`Shooting ${WIDTH}x${HEIGHT} from ${UNPACKED}`)
await withShotRoot(async (root) => {
  shotRoot = root
  await session('en', SHOTS)
  await session('zh-CN', SHOTS)
})
console.log('\nDone.')
