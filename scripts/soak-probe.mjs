/**
 * Does the app leak while it is being used? — `npm run check:soak`
 *
 * ## What "a 24-hour run" can and cannot be
 *
 * A literal day of wall-clock cannot gate anything, so this compresses the
 * *activity* of a long session instead of its idle time: every cycle switches
 * through the screens, scrolls a windowed mailbox, and opens and closes the
 * reader — the mount/unmount churn that leaks actually live in. Idle hours
 * contribute almost nothing to a renderer leak; churn is the accelerant.
 *
 * ## How the measurement avoids lying
 *
 *   · The heap is sampled only after `HeapProfiler.collectGarbage` — without
 *     a forced GC the numbers measure the collector's mood, not the app.
 *   · The verdict is a *slope*, not a before/after pair: caches legitimately
 *     warm up early, so the first quarter of cycles is discarded and a linear
 *     regression is fitted over the rest. A leak is a line that keeps going up.
 *   · DOM node count is asserted alongside, because a detached-subtree leak
 *     can hold nodes while the JS heap number stays polite.
 *
 * Runtime is ~SOAK_MINUTES (default 3) and deliberately not part of
 * `npm run check` — like `check:perf`, minutes-long gates run when asked:
 *
 *   npm run check:soak                 # ~3 minutes
 *   SOAK_MINUTES=20 npm run check:soak # longer, same assertions
 *
 * Thresholds: slope ≤ 40 kB/cycle over the fitted region, total DOM node
 * growth ≤ 15% from the warmup boundary, and an absolute 150 MB ceiling.
 * Calibrated against a clean run (see the numbers this prints); a regression
 * has to beat all three to sneak through.
 */

const PORT = process.env.CDP_PORT ?? '9445'
const MINUTES = Number(process.env.SOAK_MINUTES ?? 3)

const failures = []
const fail = (m) => failures.push(m)

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
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.method) return
  const resolve = pending.get(msg.id)
  if (resolve) {
    pending.delete(msg.id)
    resolve(msg)
  }
})
let step = 'starting'
function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP ${method} timeout (step ${step})`))
    }, 30_000)
    pending.set(id, (m) => {
      clearTimeout(timer)
      resolve(m)
    })
  })
}
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.result?.exceptionDetails) {
    throw new Error(res.result.exceptionDetails.exception?.description ?? 'evaluate failed')
  }
  return res.result?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- fixture: a mailbox big enough to be windowed (same shape as inbox-scale) -
const NOW = Date.now()
const DAY = 86_400_000
const dates = []
for (let i = 0; i < 8; i++) dates.push(NOW - i * 3_600_000)
for (let i = 0; i < 6; i++) dates.push(NOW - DAY - i * 2_700_000)
let d = 2
while (dates.length < 140) {
  const perDay = d < 7 ? 5 : 3
  for (let j = 0; j < perDay && dates.length < 140; j++) dates.push(NOW - d * DAY - j * 5_400_000 - 3_600_000)
  d += d < 7 ? 1 : 2
}
const messages = dates.map((date, i) => ({
  id: `msg_${i}`,
  accountId: 'acct_1',
  folderPath: 'INBOX',
  uid: 1000 + i,
  uidValidity: 1,
  messageId: `<m${i}@example.com>`,
  from: `Fixture Sender ${i % 9} <s${i % 9}@example.com>`,
  to: 'me@example.com',
  subject: `Fixture subject ${i}`,
  date,
  snippet: `Fixture preview text ${i}`,
  sizeBytes: 2048 + i,
  hasAttachments: i % 4 === 0,
  seen: i % 3 !== 0,
  tag: 'none',
  bodyCached: false,
}))
const state = {
  accounts: [
    {
      id: 'acct_1',
      label: 'Fixture',
      fromName: 'Me',
      fromAddress: 'me@example.com',
      host: 'smtp.example.com',
      port: 465,
      security: 'ssl',
      username: 'me@example.com',
      authMethod: 'password',
      hasSecret: true,
      timeoutMs: 20_000,
      autoNegotiate: true,
      allowInvalidCert: false,
      poolMaxMessages: 50,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  jobs: [],
  contacts: [],
  templates: [],
  logs: [],
  settings: { locale: 'en', defaultAccountId: 'acct_1', updateCheckOnStart: false },
  draft: {
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    body: '',
    bodyFormat: 'plain',
    attachments: [],
    accountId: 'acct_1',
    priority: 'normal',
    requestReadReceipt: false,
    individualDelivery: false,
  },
  inboxAccounts: [
    {
      accountId: 'acct_1',
      enabled: true,
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapSecurity: 'ssl',
      imapUsername: 'me@example.com',
      imapAllowInvalidCert: false,
      folders: [
        {
          id: 'f1',
          accountId: 'acct_1',
          path: 'INBOX',
          displayName: 'INBOX',
          uidValidity: 1,
          unreadCount: messages.filter((m) => !m.seen).length,
          serverTotal: messages.length,
        },
      ],
      messages,
      removed: [],
      showRemoteImages: 'always',
      imageAllowlist: [],
      lastSyncAt: NOW,
    },
  ],
  draftSnapshots: [],
  outbox: [],
  codeHits: [],
  recentRecipients: [],
  pairedDevices: [],
  syncConflicts: [],
  deletedJobs: [],
  schemaVersion: 2,
}

await send('Page.enable')
await send('HeapProfiler.enable')
await evaluate(`localStorage.setItem('aevistle.state.v1', ${JSON.stringify(JSON.stringify(state))}), true`)
await send('Page.reload', { ignoreCache: false })
let mounted = false
for (let i = 0; i < 60; i += 1) {
  await sleep(250)
  if (await evaluate(`Boolean(document.querySelector('.shell .view'))`)) {
    mounted = true
    break
  }
}
if (!mounted) {
  console.error('The app never mounted.')
  process.exit(1)
}
await sleep(1000)

const escape = async () => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
}
const nav = (view) =>
  evaluate(`(() => { const b = document.querySelector('.nav__item[data-view=${JSON.stringify(view)}]'); if (b) b.click(); return Boolean(b) })()`)

async function sample() {
  await send('HeapProfiler.collectGarbage')
  await sleep(150)
  return evaluate(
    `JSON.stringify({ heap: performance.memory ? performance.memory.usedJSHeapSize : -1, nodes: document.querySelectorAll('*').length })`,
  ).then(JSON.parse)
}

/** One compressed "hour" of use: every screen, a scrolled mailbox, a message opened and closed. */
async function cycle(i) {
  step = `cycle ${i}`
  for (const v of ['codes', 'schedule', 'contacts', 'templates', 'logs', 'settings']) {
    await nav(v)
    await sleep(120)
  }
  await nav('inbox')
  await sleep(250)
  await evaluate(
    `(() => { const p = document.querySelector('.view--list .list-pane'); if (p) p.scrollTop = ((${i} % 5) + 1) / 6 * (p.scrollHeight - p.clientHeight) })(), true`,
  )
  await sleep(200)
  await evaluate(
    `(() => { const row = document.querySelector('.job'); const b = row && (row.querySelector('.job__body') || row); if (b) b.click(); })(), true`,
  )
  await sleep(350)
  await escape()
  await sleep(120)
  await escape()
  await sleep(150)
}

const deadline = Date.now() + MINUTES * 60_000
const samples = []
let i = 0
while (Date.now() < deadline) {
  await cycle(i)
  const s = await sample()
  samples.push(s)
  i += 1
}

if (samples.length < 8) {
  console.error(`Only ${samples.length} cycles fit in ${MINUTES} minute(s) — too few to fit a slope. Raise SOAK_MINUTES.`)
  process.exit(1)
}
if (samples[0].heap < 0) {
  console.error('performance.memory is unavailable in this engine — nothing was measured.')
  process.exit(1)
}

// Warmup discarded, straight line fitted over the rest.
const from = Math.floor(samples.length / 4)
const fitted = samples.slice(from)
const n = fitted.length
const xs = fitted.map((_, k) => k)
const ys = fitted.map((s) => s.heap)
const mx = xs.reduce((a, b) => a + b, 0) / n
const my = ys.reduce((a, b) => a + b, 0) / n
const slope =
  xs.reduce((a, x, k) => a + (x - mx) * (ys[k] - my), 0) / Math.max(1, xs.reduce((a, x) => a + (x - mx) ** 2, 0))

const kb = (b) => Math.round(b / 102.4) / 10
const first = fitted[0]
const last = fitted[n - 1]
const nodeGrowth = (last.nodes - first.nodes) / Math.max(1, first.nodes)

console.log('')
console.log(`check:soak — ${samples.length} cycles over ~${MINUTES} min (${from} warmup cycle(s) discarded)`)
console.log(`  heap  ${kb(first.heap)} kB -> ${kb(last.heap)} kB   slope ${kb(slope)} kB/cycle`)
console.log(`  nodes ${first.nodes} -> ${last.nodes}   (${Math.round(nodeGrowth * 1000) / 10}%)`)

if (slope > 40 * 1024) fail(`the JS heap climbs ${kb(slope)} kB per cycle after warmup — a leak, not a warm cache.`)
if (nodeGrowth > 0.15) fail(`the DOM grew ${Math.round(nodeGrowth * 100)}% after warmup — detached subtrees are accumulating.`)
if (last.heap > 150 * 1024 * 1024) fail(`the heap ended at ${kb(last.heap)} kB, past the 150 MB ceiling.`)

ws.close()
if (failures.length > 0) {
  console.log('')
  for (const f of failures) console.log(`  FAIL  ${f}`)
  process.exit(1)
}
console.log('')
console.log('  All clear.')
process.exit(0)
