/**
 * Is the sender still readable in the message reader, at every width?
 *
 * ## The bug this exists because of
 *
 * `.reader__meta` is a flex row holding the avatar, the sender (name over
 * address), the timestamp, the account chip and a chevron. Three of those
 * cannot shrink — the avatar is fixed, the timestamp is `flex: 0 0 auto`, the
 * chevron has a 48px tap floor — so on a narrow screen every missing pixel is
 * taken from the one item that can shrink, which is the sender.
 *
 * Measured at 360x800 before the fix: the sender got **36px**. That would be
 * survivable if the address ellipsised, but `.reader__senderAddress` carries
 * `overflow-wrap: anywhere` (right, and deliberate — an address running off the
 * side of a dialog is worse) and at 36px "anywhere" means every three
 * characters: `zhangsan@example.com` rendered as five lines, in a bar 126px
 * tall. In the 600-840px two-pane band it was worse still — sender **0px**,
 * address across **20 lines**, a 399px header.
 *
 * ## Why this is a probe and not a static check
 *
 * Nothing about the stylesheet is wrong to read. Every rule involved is
 * individually correct and defensible; the defect is what they sum to at one
 * width, and a sum of flex bases, gaps and tap floors is not something a regex
 * over CSS can evaluate. It needs a real engine to lay it out. That is the same
 * argument `layout-probe.mjs` makes, and this reuses its harness.
 *
 * ## What is asserted
 *
 * Per width, on a message whose sender has both a display name and an address:
 *
 *   1. the address occupies at most `MAX_ADDRESS_LINES` lines — the direct
 *      statement of the bug;
 *   2. the sender column is at least `MIN_SENDER_PX` wide — the cause, checked
 *      separately so a regression is reported as "the column was starved"
 *      rather than only as its symptom;
 *   3. the whole bar is at most `MAX_BAR_PX` tall — the consequence, and the
 *      thing a reader actually notices;
 *   4. in the compact (scrolled) state the bar is exactly one line, because
 *      that is the promise the header's `flex-wrap: nowrap` was protecting and
 *      the fix must not have spent it.
 *
 * A second message with a bare, very long address and no display name is
 * measured too: that one has no `.reader__senderAddress` at all — the name
 * *is* the address — and it must ellipsise rather than wrap.
 *
 * Run by `npm run check:reader-meta`, which starts Vite and headless Chrome
 * around it. Exit code 1 if anything needs attention.
 */

const PORT = Number(process.env.CDP_PORT ?? 9445)

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
    (t) =>
      t.type === 'page' &&
      !t.url.startsWith('chrome-extension://') &&
      !t.url.startsWith('devtools://'),
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
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (res.result?.exceptionDetails) {
    throw new Error(
      res.result.exceptionDetails.exception?.description ??
        JSON.stringify(res.result.exceptionDetails),
    )
  }
  return res.result?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* -------------------------------------------------------------------------- */
/*  The thresholds                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Two, not one.
 *
 * A long address on a narrow column legitimately takes a second line — the
 * stylesheet chooses breaking over clipping there on purpose, because an
 * address with its tail cut off is worse than one on two lines. Five is the
 * defect. Three would already mean the column is being starved again.
 */
const MAX_ADDRESS_LINES = 2

/**
 * Enough for a short address to exist on one line: `zhangsan@example.com` is
 * about 140px at the 14px rank. Below this the column is being starved even if
 * the particular fixture in this file happens to fit.
 */
const MIN_SENDER_PX = 120

/** The resting bar. Two clean lines plus its padding come to about 91px. */
const MAX_BAR_PX = 150

/** The pane in the two-pane band carries three more buttons; see the CSS note. */
const MAX_BAR_PX_PANE = 170

/* -------------------------------------------------------------------------- */
/*  The fixture                                                               */
/* -------------------------------------------------------------------------- */

/** `src/core/bridge-web.ts`'s STATE_KEY — the whole seeding mechanism. */
const STATE_KEY = 'aevistle.state.v1'
const NOW = Date.UTC(2026, 7, 6, 9, 0, 0)

const SEED = {
  schemaVersion: 2,
  accounts: [
    {
      id: 'acct_probe',
      label: 'Primary',
      fromName: 'Probe',
      fromAddress: 'probe@example.com',
      host: 'smtp.example.com',
      port: 465,
      security: 'ssl',
      username: 'probe@example.com',
      authMethod: 'password',
      hasSecret: true,
      timeoutMs: 20000,
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
  settings: { locale: 'zh-CN', defaultAccountId: 'acct_probe', updateCheckOnStart: false },
  draft: {
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    body: '',
    bodyFormat: 'plain',
    attachments: [],
    accountId: 'acct_probe',
  },
  inboxAccounts: [
    {
      accountId: 'acct_probe',
      enabled: true,
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapSecurity: 'ssl',
      imapUsername: 'probe@example.com',
      imapAllowInvalidCert: false,
      folders: [],
      removed: [],
      imageAllowlist: [],
      messages: [
        {
          id: 'msg_named',
          accountId: 'acct_probe',
          uid: 1,
          folder: 'INBOX',
          // A display name *and* an address: the case that renders
          // `.reader__senderAddress`, which is the element that shattered.
          from: '张三 <zhangsan@example.com>',
          subject: 'PROBE named sender',
          date: Date.UTC(2026, 7, 11, 14, 30),
          seen: false,
          hasAttachments: false,
          bodyCached: false,
        },
        {
          id: 'msg_bare',
          accountId: 'acct_probe',
          uid: 2,
          folder: 'INBOX',
          // No display name: the name line *is* the address, and it must
          // ellipsise rather than wrap.
          from: 'first.last+newsletter@some-very-long-subdomain.example.coop',
          subject: 'PROBE bare address',
          date: Date.UTC(2026, 7, 10, 9, 15),
          seen: true,
          hasAttachments: false,
          bodyCached: false,
        },
      ],
    },
  ],
  draftSnapshots: [],
  outbox: [],
  codeHits: [],
  recentRecipients: [],
}

/* -------------------------------------------------------------------------- */

let failures = 0
let passes = 0
const fail = (msg) => {
  failures++
  console.log(`  FAIL  ${msg}`)
}
const ok = (msg) => {
  passes++
  console.log(`  ok    ${msg}`)
}

await send('Page.enable')

/** Seed, reload, and wait for the shell to exist. */
async function boot(width, height) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluate(
    `localStorage.clear(), localStorage.setItem(${JSON.stringify(STATE_KEY)}, ${JSON.stringify(
      JSON.stringify(SEED),
    )}), true`,
  )
  await send('Page.reload', { ignoreCache: false })
  const shell = await until(`Boolean(document.querySelector('.shell .view'))`, 40_000)
  if (!shell) {
    fail(`the app never rendered at ${width}x${height}`)
    return false
  }
  await sleep(300)
  return true
}

/**
 * Open the inbox and click the row whose subject contains `marker`.
 *
 * Polled at every step rather than slept through. The inbox list is virtualised
 * and the app is being served unbundled by Vite, so how long a row takes to
 * exist depends on the machine — and a fixed sleep that is usually long enough
 * produces a gate that fails at random, which is worse than no gate at all:
 * the first flake teaches everyone to re-run it, and the first real regression
 * is then re-run until it is ignored.
 */
async function until(expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await evaluate(expression)
    if (value) return value
    if (Date.now() > deadline) return null
    await sleep(200)
  }
}

async function openMessage(marker) {
  const tabbed = await until(
    `(() => {
      const tab = [...document.querySelectorAll('button, .nav__item')]
        .find((b) => (b.dataset && b.dataset.view === 'inbox') || (b.textContent || '').trim().startsWith('收件箱'))
      if (!tab) return false
      tab.click()
      return true
    })()`,
  )
  if (!tabbed) return 'no-inbox-tab'

  // The row has to exist before it can be clicked, and the list is virtualised.
  const found = await until(
    `[...document.querySelectorAll('.job__subject')]
       .some((s) => (s.textContent || '').includes(${JSON.stringify(marker)}))`,
  )
  if (!found) return 'no-row'

  const clicked = await evaluate(
    `(() => {
      const subject = [...document.querySelectorAll('.job__subject')]
        .find((s) => (s.textContent || '').includes(${JSON.stringify(marker)}))
      const row = subject && subject.closest('.swipe, .job')
      if (!row) return false
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return true
    })()`,
  )
  if (!clicked) return 'no-row-container'

  // And the reader has to have mounted before it can be measured.
  const opened = await until(`Boolean(document.querySelector('.reader__meta'))`)
  if (!opened) return 'reader-never-mounted'

  // One frame for the fonts and the sticky header to settle, so a width is a
  // width rather than a width mid-layout.
  await sleep(250)
  return 'clicked'
}

/** Everything measured about the sender line, in one round trip. */
async function measure() {
  return evaluate(`(() => {
    const meta = document.querySelector('.reader__meta')
    if (!meta) return { missing: true }
    const sender = meta.querySelector('.reader__sender')
    const addr = meta.querySelector('.reader__senderAddress')
    const name = meta.querySelector('.reader__senderName')
    const round = (n) => Math.round(n)
    const lineHeight = (el) => {
      const lh = parseFloat(getComputedStyle(el).lineHeight)
      return Number.isFinite(lh) && lh > 0 ? lh : parseFloat(getComputedStyle(el).fontSize) * 1.2
    }
    const out = {
      missing: false,
      barHeight: round(meta.getBoundingClientRect().height),
      senderWidth: sender ? round(sender.getBoundingClientRect().width) : 0,
      hasAddress: Boolean(addr),
      addressLines: addr ? Math.round(addr.getBoundingClientRect().height / lineHeight(addr)) : 0,
      nameLines: name ? Math.round(name.getBoundingClientRect().height / lineHeight(name)) : 0,
      wrap: getComputedStyle(meta).flexWrap,
    }
    // Compact is the scrolled state. Toggled here rather than by scrolling the
    // body frame, because the attribute is what the stylesheet keys off and
    // driving the real scroll would measure the animation instead.
    meta.setAttribute('data-compact', 'true')
    const boxes = [...meta.children]
      .filter((c) => c.getBoundingClientRect().width > 0)
      .map((c) => c.getBoundingClientRect())
    // One visual line means every child's box overlaps every other's vertically.
    const top = Math.min(...boxes.map((b) => b.top))
    const bottom = Math.max(...boxes.map((b) => b.bottom))
    const tallest = Math.max(...boxes.map((b) => b.height))
    out.compactSpan = round(bottom - top)
    out.compactTallestChild = round(tallest)
    out.compactHeight = round(meta.getBoundingClientRect().height)
    meta.removeAttribute('data-compact')
    return out
  })()`)
}

const BANDS = [
  { label: 'phone 360x800', width: 360, height: 800, maxBar: MAX_BAR_PX },
  { label: 'two-pane 760x1024', width: 760, height: 1024, maxBar: MAX_BAR_PX_PANE },
]

console.log('\n  The reader’s sender line, measured in a real engine\n')

for (const band of BANDS) {
  console.log(`  --- ${band.label} ---`)
  if (!(await boot(band.width, band.height))) continue

  const openedNamed = await openMessage('PROBE named sender')
  if (openedNamed !== 'clicked') {
    fail(`${band.label}: could not open the named-sender message (${openedNamed})`)
    continue
  }

  const named = await measure()
  if (named.missing) {
    fail(`${band.label}: the reader opened but has no .reader__meta`)
    continue
  }

  console.log(
    `        bar ${named.barHeight}px · sender column ${named.senderWidth}px · ` +
      `address ${named.addressLines} line(s) · wrap ${named.wrap}`,
  )

  if (!named.hasAddress) {
    fail(`${band.label}: the fixture has a display name, so .reader__senderAddress must render`)
  } else if (named.addressLines <= MAX_ADDRESS_LINES) {
    ok(`${band.label}: the address reads on ${named.addressLines} line(s)`)
  } else {
    fail(
      `${band.label}: the address broke across ${named.addressLines} lines ` +
        `(max ${MAX_ADDRESS_LINES}). The sender column is being starved — it is ` +
        `${named.senderWidth}px. See the note on .reader__meta in 24-inbox.css.`,
    )
  }

  if (named.senderWidth >= MIN_SENDER_PX) {
    ok(`${band.label}: the sender column keeps ${named.senderWidth}px`)
  } else {
    fail(
      `${band.label}: the sender column is ${named.senderWidth}px, under the ${MIN_SENDER_PX}px ` +
        `floor. Something unshrinkable was added to the row, or the flex-basis ` +
        `in 24-inbox.css no longer matches what shares its line.`,
    )
  }

  if (named.barHeight <= band.maxBar) {
    ok(`${band.label}: the resting bar is ${named.barHeight}px`)
  } else {
    fail(`${band.label}: the resting bar is ${named.barHeight}px, over the ${band.maxBar}px ceiling`)
  }

  /*
   * The promise the original `flex-wrap: nowrap` was protecting: while the
   * reader scrolls, this bar is one line and does not change height under the
   * eye. The fix is allowed to add a line at rest and is not allowed to add one
   * here.
   */
  if (named.compactSpan <= named.compactTallestChild + 2) {
    ok(`${band.label}: compact is one line (${named.compactHeight}px)`)
  } else {
    fail(
      `${band.label}: compact wrapped to more than one line — span ${named.compactSpan}px ` +
        `against a tallest child of ${named.compactTallestChild}px. The scrolled header ` +
        `must stay one line; check the :not([data-compact]) guard.`,
    )
  }

  // The bare-address message: no display name, so the name line *is* the
  // address and must ellipsise rather than wrap to a second line.
  const openedBare = await openMessage('PROBE bare address')
  if (openedBare !== 'clicked') {
    fail(`${band.label}: could not open the bare-address message (${openedBare})`)
    continue
  }
  const bare = await measure()
  if (bare.missing) {
    fail(`${band.label}: the bare-address reader has no .reader__meta`)
  } else if (bare.nameLines <= 1) {
    ok(`${band.label}: a bare long address ellipsises on one line`)
  } else {
    fail(
      `${band.label}: a bare long address wrapped to ${bare.nameLines} lines. ` +
        `.reader__senderName is meant to clip, not wrap.`,
    )
  }
}

await send('Emulation.clearDeviceMetricsOverride')

console.log(`\n  ${passes} passed, ${failures} failed\n`)
clearTimeout(guard)
ws.close()
process.exit(failures > 0 ? 1 : 0)
