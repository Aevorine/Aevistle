/**
 * How long does it take to open a mail? — `node scripts/open-mail-probe.mjs`
 *
 * Nothing in this repository measured that. `check-perf.mjs` measures cold
 * start, screen switches, typing and scrolling; `layout-probe.mjs` measures
 * geometry. Neither of them, and nothing else under `scripts/`, asserted
 * anything about the time from tapping a message row to seeing the message —
 * no time-to-first-body-paint, no prefetch coverage, no cache hit rate, no
 * sanitize duration. "It feels slow" has therefore never been a claim anyone
 * could settle.
 *
 * This measures the one number a person actually experiences: from the click
 * on the row to the body being laid out, on screen, with the words in it.
 *
 * ===========================================================================
 * How it gets a message to open
 *
 * The Vite dev server has no mail account, so there is nothing to click. Every
 * other probe in this directory handles that by measuring synthetic markup
 * against the stylesheet, which is right for geometry and useless here: the
 * thing being timed is React's own path — state, render, iframe, layout — and
 * markup pasted into `document.body` skips all of it.
 *
 * So the app is given a bridge instead. `detectPlatform()` answers `'desktop'`
 * when `window.aevistle` exists, and `createDesktopBridge()` is a pass-through
 * to whatever that object holds (`bridge-desktop.ts` is 102 lines of
 * `foo: (a) => api.foo(a)`). Installing a stand-in for it with
 * `Page.addScriptToEvaluateOnNewDocument` — which runs before any page script —
 * gives the real application a real state document with real messages in it,
 * and the whole renderer path from the click onward is the shipping one.
 *
 * ===========================================================================
 * What this reaches, and what it does not
 *
 * A gate that cannot fail is worse than no gate, and a gate whose limits are
 * not written down turns into a gate people believe things about. So:
 *
 * REACHED — everything between the click and the pixels, in the real engine:
 *   · React's `openDetail` and every setState in it
 *   · the `bodyMemo` cache lookup, and the difference a hit makes
 *   · the reader's own render — header, chips, banners, attachment list
 *   · `MessageBodyFrame` building the iframe, the browser parsing the srcdoc,
 *     and the frame's document laying the body out with a non-zero box
 *   · the quoted-history fold and the night filter, which walk the frame's
 *     text nodes from the parent after load
 *   · the same measurement for a 200KB body, so the cost is a function of the
 *     message rather than of the fixture
 *
 * NOT REACHED, and none of it silently:
 *   · IMAP. The bridge is a stand-in, so network and server time are excluded
 *     by construction. `--fetch-ms` sets what the fake fetch costs, and the
 *     cold budget is stated as "the fake fetch plus X" so the app's own share
 *     is the thing being held.
 *   · Sanitising. `sanitize-html` runs in the Electron main process
 *     (`electron/sanitizeHtml.ts`), reached over IPC. It is not in the renderer
 *     and cannot be timed from here. The fixture is pre-sanitised, which is
 *     what the renderer receives in production too.
 *   · Prefetch coverage and real cache hit rate. Those are properties of a
 *     live mailbox over time. What is measured here is the *effect* of a hit
 *     versus a miss on one message, which is the part that is a property of
 *     this code rather than of somebody's inbox.
 *   · A presented compositor frame. The stop condition is a forced layout with
 *     a non-zero box and the expected text in it — one frame short of literal
 *     photons. Headless Chrome's frame production is not a real window's, which
 *     is why `perf-probe.mjs` refuses to run here at all; the flags in
 *     `lib/headless.mjs` turn the throttling off and the observed rAF cadence
 *     is printed below so a throttled run is visible rather than merely slow.
 *   · Android and the packaged desktop app. This is Chrome on a dev server.
 *
 * The polling loop uses `setTimeout(…, 0)`, never `requestAnimationFrame`:
 * rAF is exactly what headless throttles. Browsers clamp a zero timeout to
 * about 1ms and to 4ms once nested, so every number below has roughly 4ms of
 * granularity. That is stated rather than hidden, and it is why the budgets are
 * not tighter than they are.
 */

const PORT = Number(process.env.CDP_PORT ?? 9445)
const FETCH_MS = Number(process.env.OPEN_MAIL_FETCH_MS ?? 40)

if (typeof WebSocket !== 'function') {
  console.error('This needs Node 22+ for a global WebSocket.')
  process.exit(1)
}

const guard = setTimeout(() => {
  console.error('\nTimed out waiting for the app to answer.')
  process.exit(1)
}, 180_000)
guard.unref?.()

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page =
  targets.find(
    (t) => t.type === 'page' && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('devtools://'),
  ) ?? targets.find((t) => t.type === 'page')
if (!page) {
  console.error('No page target — is the app running with --remote-debugging-port?')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
const consoleErrors = []
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(
      'uncaught: ' + (msg.params?.exceptionDetails?.exception?.description ?? '').slice(0, 200),
    )
  }
  const resolve = pending.get(msg.id)
  if (resolve) {
    pending.delete(msg.id)
    resolve(msg)
  }
})

function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, resolve))
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.result?.exceptionDetails) {
    throw new Error(
      res.result.exceptionDetails.exception?.description ?? JSON.stringify(res.result.exceptionDetails),
    )
  }
  return res.result?.result?.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

/**
 * A string that appears in the body and nowhere else in the app.
 *
 * The stop condition requires it. Without it, "the frame has a non-zero box"
 * is satisfied by an empty document with a margin on it, and the probe would
 * be timing how long an empty rectangle takes to exist. This repository has a
 * recorded case of a probe that hid the very banner it was meant to measure;
 * the defence against that shape of mistake is to require the content by name.
 */
const MARKER = 'AEVISTLE_OPEN_MAIL_PROBE_BODY_MARKER'

/**
 * The seed, installed before any application script runs.
 *
 * `window.aevistle` is the Electron preload API. Everything named here is
 * named because the app calls it during boot or during the flow being timed;
 * everything else falls through to the Proxy, which answers `on*` with an
 * unsubscribe function (the app uses those as `useEffect` cleanups, and
 * returning a promise there breaks React) and everything else with a resolved
 * promise. That split is a heuristic, and it is the only guess in this file —
 * if the app ever needs a real answer from something not named here, it shows
 * up as a console error, which is collected and printed.
 */
function seedSource({ messageCount, fetchMs, bigBodyBytes }) {
  return `(() => {
  const MARKER = ${JSON.stringify(MARKER)}
  const now = Date.now()
  const ACCOUNT = 'probe-account'

  const messages = Array.from({ length: ${messageCount} }, (_, i) => ({
    id: 'probe-msg-' + i,
    accountId: ACCOUNT,
    folderPath: 'INBOX',
    uid: 1000 + i,
    uidValidity: 1,
    messageId: '<probe-' + i + '@example.com>',
    from: 'Zhang Wei <zhang.wei@example.com>',
    to: 'me@example.com',
    subject: '下周三上午十点的项目进度评审会议安排通知 #' + i,
    date: now - i * 600000,
    snippet: '各位同事，下周三上午十点在三号会议室召开项目进度评审会议，请提前准备材料。',
    sizeBytes: 24000,
    hasAttachments: false,
    seen: false,
    tag: 'none',
    bodyCached: false,
  }))

  /* Pre-sanitised HTML, because that is what the renderer receives: the
     sanitiser runs in the main process and its output is what crosses the
     bridge. Ordinary message shape — a greeting, a table, a quoted reply — so
     the fold and the highlight walkers have something real to walk. */
  const para = '<p>各位同事，下周三上午十点在三号会议室召开项目进度评审会议，请各位提前准备好本周的进度材料。</p>'
  const filler = (bytes) => {
    let s = ''
    while (s.length < bytes) s += para
    return s
  }
  const body = (big) =>
    '<div><h2>' + MARKER + '</h2>' +
    '<p>Hello, and thank you for the update.</p>' +
    filler(big ? ${bigBodyBytes} : 2000) +
    '<table><tr><td>Item</td><td>Owner</td></tr><tr><td>Draft</td><td>Wei</td></tr></table>' +
    '<blockquote><p>On Monday, someone wrote:</p><p>' + filler(1200) + '</p></blockquote>' +
    '</div>'

  const state = {
    schemaVersion: 2,
    accounts: [{
      id: ACCOUNT, label: 'Probe', fromName: 'Probe', fromAddress: 'me@example.com',
      host: 'smtp.example.com', port: 465, security: 'ssl', username: 'me@example.com',
      authMethod: 'password', hasSecret: true, timeoutMs: 20000, autoNegotiate: false,
      allowInvalidCert: false, poolMaxMessages: 100,
    }],
    jobs: [], contacts: [], templates: [], logs: [],
    inboxAccounts: [{
      accountId: ACCOUNT, enabled: true,
      imapHost: 'imap.example.com', imapPort: 993, imapSecurity: 'ssl',
      imapUsername: 'me@example.com', imapAllowInvalidCert: false,
      folders: [{ id: ACCOUNT + ':INBOX', accountId: ACCOUNT, path: 'INBOX', displayName: 'INBOX',
                  uidValidity: 1, unreadCount: ${messageCount}, totalCount: ${messageCount} }],
      messages,
      lastSyncAt: now,
      showRemoteImages: 'always',
      imageAllowlist: [],
      removed: [],
    }],
    draftSnapshots: [], outbox: [], codeHits: [], recentRecipients: [],
    pairedDevices: [], syncConflicts: [], deletedJobs: [],
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  const real = {
    loadState: async () => JSON.parse(JSON.stringify(state)),
    saveState: async () => true,
    hasSecret: async () => true,
    setSecret: async () => true,
    deleteSecret: async () => true,
    appInfo: async () => ({ version: '0.0.0-probe', platform: 'win32', packaged: false }),
    dataFolder: async () => ({ path: 'C:\\\\probe', optionId: 'probe', options: [] }),
    getDispatchLedgerStatus: async () => ({ ok: true, entries: [] }),
    getControlAudit: async () => [],
    checkForUpdate: async () => null,
    lanAddresses: async () => [],
    pickFiles: async () => [],
    syncJobs: async () => true,
    syncInbox: async () => ({ accountId: ACCOUNT, added: 0, removed: 0, folders: state.inboxAccounts[0].folders, messages }),
    testInbox: async () => ({ ok: true }),
    watchInbox: async () => true,
    setMessageFlags: async () => true,
    fetchRemoteImage: async () => null,
    sanitizeHtml: async (html) => html,

    /* The one call this probe exists to time the far side of. The delay is a
       stand-in for an IMAP fetch and is a parameter, not a constant, so the
       app's own share of the total can be separated from the server's. */
    getMessageBody: async (_config, _folderPath, uid) => {
      await wait(${fetchMs})
      const big = uid >= 9000
      return { text: '', sanitizedHtml: body(big), attachments: [], remoteImages: [], icsParts: [] }
    },
  }

  window.__aevistleProbe = {
    marker: MARKER,
    seeded: ${messageCount},
    /* Swap one message's uid into the "big body" range, so the large-body
       measurement uses the identical code path on the identical fixture and
       differs only in how much HTML comes back. */
    bigUid: 9000,
  }

  window.aevistle = new Proxy(real, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop !== 'string') return undefined
      // Subscriptions. The app stores the return value as a React effect
      // cleanup, so it must be a function, not a promise.
      if (/^on[A-Z]/.test(prop)) return () => () => {}
      return async () => null
    },
  })
})()`
}

// ---------------------------------------------------------------------------
// Install the seed and reload into it
// ---------------------------------------------------------------------------

await send('Runtime.enable')
await send('Page.enable')

const SEED = seedSource({ messageCount: 12, fetchMs: FETCH_MS, bigBodyBytes: 200_000 })
await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED })
await send('Page.reload', { ignoreCache: false })

/** Wait for the app to mount, rather than for a stopwatch to say it probably has. */
async function waitForApp(ms = 60_000) {
  const until = Date.now() + ms
  for (;;) {
    const ready = await evaluate(
      `!!document.querySelector('.nav__item[data-view]') && !!document.querySelector('.view')`,
    ).catch(() => false)
    if (ready === true) return true
    if (Date.now() > until) return false
    await sleep(250)
  }
}
if (!(await waitForApp())) {
  console.error('\n  ✗ The app never mounted with the probe bridge installed.')
  if (consoleErrors.length) console.error('    console: ' + consoleErrors.slice(0, 5).join(' | '))
  process.exit(1)
}

/* A phone-sized window, because that is where "slow to open a mail" is
   reported from and because the narrow shell mounts the reader full-screen
   rather than in a second pane — a different amount of work per open. */
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
await sleep(700)

const failures = []
const notes = []
const fail = (m) => {
  failures.push(m)
  console.log(`  FAIL  ${m}`)
}
const ok = (m) => console.log(`  ok    ${m}`)

// ---------------------------------------------------------------------------
// Get to the inbox, and prove there is real mail on it
// ---------------------------------------------------------------------------

await evaluate(`document.querySelector('.nav__item[data-view="inbox"]')?.click(), true`)
let rows = 0
for (let i = 0; i < 40; i += 1) {
  rows = await evaluate(`document.querySelectorAll('.swipe .job').length`)
  if (rows > 0) break
  await sleep(250)
}
const seeded = await evaluate(`window.__aevistleProbe?.seeded ?? 0`)

if (rows === 0) {
  fail(
    'the inbox rendered 0 message rows with 12 seeded — the probe bridge did not take, so nothing ' +
      'below would have been measuring an open at all',
  )
  /* What the screen actually says, not just the count. "0 rows" is true of a
     bridge that never installed, an account list that came back empty, a chip
     filter that matched nothing and a changed row class — four different
     faults with one symptom, and every minute spent guessing between them is a
     minute this gate cost instead of saved. */
  const why = await evaluate(`JSON.stringify({
    view: document.querySelector('.view')?.className ?? null,
    empty: document.querySelector('.empty__title, .empty h3, .empty')?.textContent?.trim().slice(0, 80) ?? null,
    jobs: document.querySelectorAll('.job').length,
    joblist: document.querySelectorAll('.joblist').length,
    swipe: document.querySelectorAll('.swipe').length,
    chips: document.querySelectorAll('.inboxchips__chip[aria-pressed="true"]').length,
    accounts: (window.__aevistleProbe && window.__aevistleProbe.accounts) ?? null,
  })`)
  console.log('    screen: ' + why)
  if (consoleErrors.length) console.log('    console: ' + consoleErrors.slice(0, 6).join(' | '))
  console.log(`\n  FAIL — ${failures.length} problem(s)`)
  ws.close()
  process.exit(1)
}
ok(`inbox has ${rows} real message rows from the seeded ${seeded} (virtualised, so fewer on screen is normal)`)

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

/**
 * Click row `n` and wait until its body is laid out, on screen, with the
 * marker in it.
 *
 * Four conditions, and every one of them is load-bearing:
 *   · the reader frame exists and its own box in the parent page is non-zero
 *     and inside the viewport — a frame that is off-screen or collapsed is not
 *     "body pixels on screen", and this repository has a recorded probe that
 *     measured a banner it had itself hidden;
 *   · the frame's document has a body with a non-zero box, read with
 *     `getBoundingClientRect()`, which forces layout inside the frame rather
 *     than waiting for one;
 *   · the body's text contains the marker, so an empty or a *stale* document
 *     (the previous message's, still mounted) cannot satisfy this;
 *   · `escape` first, and confirmed closed, so every open starts from the list.
 */
async function openAndTime(index, { expectBig = false } = {}) {
  const expr = `(async () => {
    const marker = window.__aevistleProbe.marker
    const rows = [...document.querySelectorAll('.swipe .job')]
    const row = rows[${index}]
    if (!row) return JSON.stringify({ error: 'no row at index ${index} (have ' + rows.length + ')' })

    const t0 = performance.now()
    row.click()

    const deadline = t0 + 20000
    let frameFound = 0
    for (;;) {
      const f = document.querySelector('iframe.reader__frame')
      if (f) {
        if (!frameFound) frameFound = performance.now() - t0
        const fr = f.getBoundingClientRect()
        const onScreen = fr.width > 0 && fr.height > 0 && fr.top < innerHeight && fr.bottom > 0
        let doc = null
        try { doc = f.contentDocument } catch { doc = null }
        if (onScreen && doc && doc.body) {
          const br = doc.body.getBoundingClientRect()
          if (br.height > 0 && (doc.body.innerText || '').includes(marker)) {
            return JSON.stringify({
              ms: Math.round((performance.now() - t0) * 10) / 10,
              frameMs: Math.round(frameFound * 10) / 10,
              frameBox: Math.round(fr.width) + 'x' + Math.round(fr.height),
              bodyH: Math.round(br.height),
              htmlBytes: (doc.documentElement.outerHTML || '').length,
            })
          }
        }
      }
      if (performance.now() > deadline) {
        return JSON.stringify({
          error: 'timed out after 20s',
          frameMs: frameFound || null,
          sawFrame: !!document.querySelector('iframe.reader__frame'),
        })
      }
      // Never requestAnimationFrame — see this file's header.
      await new Promise((r) => setTimeout(r, 0))
    }
  })()`
  const raw = await evaluate(expr)
  const out = JSON.parse(raw)
  if (out.error) return out
  if (expectBig && out.htmlBytes < 100_000) {
    out.error = `expected a large body but the frame document is only ${out.htmlBytes} bytes`
  }
  return out
}

/**
 * Wait until the list is actually showing rows again.
 *
 * `series` used to close the reader, sleep 250ms and click. The rows were
 * there at the seeding check and gone 250ms later, so every sample failed with
 * "no row at index 0 (have 0)" — the app was still settling, and the number
 * this file exists to measure was never taken. It is the same fault the layout
 * probe had with its fixed 5s settle, and the same fix: wait for the condition
 * rather than for a duration, so the gate does not expire the next time the
 * app grows.
 */
async function waitForRows(ms = 15_000) {
  const until = Date.now() + ms
  for (;;) {
    const n = await evaluate(`document.querySelectorAll('.swipe .job').length`)
    if (n > 0) return n
    if (Date.now() > until) return 0
    await sleep(150)
  }
}

/** Leave the reader and confirm it is gone, so the next open starts from the list. */
async function closeReader() {
  for (let i = 0; i < 20; i += 1) {
    const gone = await evaluate(`(() => {
      const f = document.querySelector('iframe.reader__frame')
      if (!f) return true
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return false
    })()`)
    if (gone === true) return true
    await sleep(150)
  }
  return false
}

/** Measure `runs` opens of the same row and return every sample. */
async function series(label, index, opts = {}) {
  const samples = []
  for (let i = 0; i < (opts.runs ?? 5); i += 1) {
    if (!(await closeReader())) {
      fail(`${label}: the reader would not close between runs, so run ${i + 1} did not start from the list`)
      break
    }
    if ((await waitForRows()) === 0) {
      const where = await evaluate(`JSON.stringify({
        view: document.querySelector('.view')?.className ?? null,
        tab: document.querySelector('.nav__item[aria-current="page"]')?.textContent?.trim() ?? null,
        jobs: document.querySelectorAll('.job').length,
        swipe: document.querySelectorAll('.swipe').length,
        modal: document.querySelectorAll('.modal').length,
      })`)
      fail(
        `${label}: the list had no rows to click 15s after run ${i + 1} closed the reader — ${where}`,
      )
      break
    }
    const r = await openAndTime(index, opts)
    if (r.error) {
      fail(`${label}: ${r.error}`)
      break
    }
    samples.push(r)
  }
  return samples
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : NaN
}

console.log('\n--- opening a mail, phone 390x844 ---')

/*
 * Cold: nothing in `bodyMemo`, so the click goes all the way through
 * `getInboxMessageBody` and the bridge. Measured on a *different* row each
 * time, because the memo would turn run 2 into a warm run and the average of
 * one cold and four warm opens is a number describing nothing.
 */
const cold = []
for (let i = 0; i < 4; i += 1) {
  if (!(await closeReader())) break
  await sleep(250)
  const r = await openAndTime(i)
  if (r.error) {
    fail(`cold open: ${r.error}`)
    break
  }
  cold.push(r)
}

/* Warm: the same row repeatedly, so every run after the first is a
   `getCachedBody` hit and the bridge is never reached. This is the number a
   user gets going back to a message they already opened, and it is the purest
   measurement of the app's own render path that exists here. */
await closeReader()
await sleep(200)
await openAndTime(0) // prime the memo
const warm = await series('warm open', 0, { runs: 5 })

const coldMs = cold.map((r) => r.ms)
const warmMs = warm.map((r) => r.ms)

if (cold.length) {
  console.log(
    `  cold (bridge fetch ${FETCH_MS}ms): ${coldMs.join(', ')} ms   median ${median(coldMs)}ms   ` +
      `frame mounted at ${cold[0].frameMs}ms, body box ${cold[0].bodyH}px in a ${cold[0].frameBox} frame`,
  )
}
if (warm.length) {
  console.log(`  warm (bodyMemo hit):        ${warmMs.join(', ')} ms   median ${median(warmMs)}ms`)
}

/* rAF cadence, reported rather than relied on. If this is anywhere near 1000ms
   the browser is throttling frames and every number above is a measurement of
   the throttle — which is exactly what happened to an earlier round of
   `perf-probe.mjs` and is why that file refuses to run headless at all. */
const rafMs = await evaluate(`(async () => {
  const t = []
  await new Promise((res) => {
    let last = performance.now(), n = 0
    const step = (now) => { t.push(now - last); last = now; if (++n < 8) requestAnimationFrame(step); else res() }
    requestAnimationFrame(step)
  })
  return Math.round(t.slice(1).reduce((a, b) => a + b, 0) / (t.length - 1) * 10) / 10
})()`)
console.log(`  frame cadence: ${rafMs}ms between animation frames (a throttled headless run reads ~1000)`)
if (rafMs > 100) {
  notes.push(
    `frames are ${rafMs}ms apart — the browser is throttling, so the numbers above are a floor rather ` +
      `than a measurement. Check the --disable-*-throttling flags in lib/headless.mjs.`,
  )
}

// ---------------------------------------------------------------------------
// The budgets
// ---------------------------------------------------------------------------

/*
 * Two numbers, and they are budgets on *this app's* work rather than on a
 * mailbox's.
 *
 * WARM is the whole of it: no bridge, no network, nothing but React and the
 * browser. Anything a user notices going back to a message they have already
 * read is in here. 400ms is the line at which an interface stops feeling like
 * it responded to the tap and starts feeling like it went away to think —
 * roughly four times the median this measures today, which is the headroom a
 * budget needs on a machine slower than this one and still less than the
 * doubling that would make it unfalsifiable.
 *
 * COLD is the same work plus the fake fetch, so the app's own share is
 * `cold - FETCH_MS` and that is what is held. Holding the total instead would
 * make the budget a function of `--fetch-ms`, i.e. of the fixture.
 */
const WARM_BUDGET = 400
const COLD_OVERHEAD_BUDGET = 450

if (warmMs.length < 3) {
  fail(`only ${warmMs.length} warm sample(s) completed — not enough to hold a budget against`)
} else {
  const m = median(warmMs)
  if (m > WARM_BUDGET) fail(`warm open (cache hit) median ${m}ms, over the ${WARM_BUDGET}ms budget`)
  else ok(`warm open (cache hit) median ${m}ms, budget ${WARM_BUDGET}ms`)
}

if (coldMs.length < 3) {
  fail(`only ${coldMs.length} cold sample(s) completed — not enough to hold a budget against`)
} else {
  const m = median(coldMs)
  const overhead = Math.round((m - FETCH_MS) * 10) / 10
  if (overhead > COLD_OVERHEAD_BUDGET) {
    fail(
      `cold open median ${m}ms minus the ${FETCH_MS}ms fake fetch is ${overhead}ms of app time, ` +
        `over the ${COLD_OVERHEAD_BUDGET}ms budget`,
    )
  } else {
    ok(`cold open median ${m}ms → ${overhead}ms of app time on top of the fetch, budget ${COLD_OVERHEAD_BUDGET}ms`)
  }
}

/*
 * The cache has to be worth having.
 *
 * `bodyMemo` exists so a second open is cheap. If a hit is not measurably
 * faster than a miss, either the memo is not being reached or the fetch is not
 * where the time goes — both of which are things somebody should be told, and
 * neither of which any existing check could notice. Held loosely: the claim is
 * "the hit skips the fetch", so the bar is the fetch, not a ratio.
 */
if (warmMs.length >= 3 && coldMs.length >= 3) {
  const saved = Math.round((median(coldMs) - median(warmMs)) * 10) / 10
  if (saved < FETCH_MS * 0.5) {
    fail(
      `a bodyMemo hit saves only ${saved}ms against a ${FETCH_MS}ms fetch — the cache is not being ` +
        `reached, or the open is dominated by something other than fetching the body`,
    )
  } else {
    ok(`a bodyMemo hit saves ${saved}ms of the ${FETCH_MS}ms fetch`)
  }
}

/*
 * A 200KB body, on the same path.
 *
 * Not budgeted against a fixed millisecond number — a big message is allowed to
 * cost more, and pretending otherwise would make this the first thing anyone
 * loosened. Budgeted as a *multiple* of the small-body open, which is the shape
 * of the regression that matters: parsing that goes superlinear, or a walker
 * that visits the whole document once per element.
 */
await closeReader()
await sleep(200)
const bigged = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.swipe .job')]
  return rows.length
})()`)
notes.push(
  `the large-body case reuses row 0 with its uid rewritten to the probe's big-body range; ` +
    `${bigged} rows were on screen when it ran`,
)
const bigSwap = await evaluate(`(() => {
  /* The bridge decides big-vs-small from the uid it is handed, and the uid
     comes from the message row React holds. Re-seeding through loadState would
     mean a reload; instead the bridge is told to answer big for everything from
     here on, which is the same code path with more bytes coming back. */
  const prev = window.aevistle.getMessageBody
  window.aevistle.getMessageBody = (c, f) => prev(c, f, window.__aevistleProbe.bigUid)
  return true
})()`)
let big = []
if (bigSwap === true) {
  /* A row that has never been opened, so this is a cold open of a big body and
     is comparable with the cold series above rather than with the warm one. */
  big = await series('large body', 6, { runs: 3, expectBig: true })
}
if (big.length) {
  const bm = median(big.map((r) => r.ms))
  const cm = median(coldMs)
  const ratio = Math.round((bm / cm) * 100) / 100
  console.log(`  200KB body:                 ${big.map((r) => r.ms).join(', ')} ms   median ${bm}ms   (${ratio}x the small-body cold open)`)
  if (ratio > 6) fail(`a 200KB body takes ${ratio}x a 2KB body to open (${bm}ms vs ${cm}ms), over the 6x budget`)
  else ok(`a 200KB body opens in ${ratio}x the time of a 2KB body (budget 6x)`)
} else {
  fail('the large-body case produced no samples — 100x the bytes went unmeasured')
}

// ---------------------------------------------------------------------------

if (consoleErrors.length) {
  notes.push(`${consoleErrors.length} console error(s) during the run: ${[...new Set(consoleErrors)].slice(0, 4).join(' | ')}`)
}

await send('Emulation.clearDeviceMetricsOverride')

console.log(`\n---------------------------------------------------------`)
console.log(`  what this run could not establish:`)
console.log(`    · IMAP time — the bridge is a stand-in; the fetch was a ${FETCH_MS}ms sleep`)
console.log(`    · sanitize duration — sanitize-html runs in the Electron main process, not here`)
console.log(`    · a presented compositor frame — the stop condition is a forced layout with the`)
console.log(`      marker text in it, one frame short of photons; measured to about 4ms of resolution`)
console.log(`    · Android, and the packaged desktop app`)
for (const n of notes) console.log(`    · ${n}`)
console.log(`\n  ${failures.length === 0 ? 'PASS' : `FAIL — ${failures.length} problem(s)`}`)

ws.close()
clearTimeout(guard)
process.exit(failures.length > 0 ? 1 : 0)
