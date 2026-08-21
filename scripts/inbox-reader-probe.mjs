/**
 * Does the mailbox actually show you a mailbox, and does an opened message
 * ever show you nothing?
 *
 * ## The bug this exists because of
 *
 * `InboxView` rendered the reader's body region as
 *
 *     loadingBody ? <skeleton/> : openBody ? <body/> : null
 *
 * and that third branch is reachable on every platform: no stored IMAP
 * password, a server that will not answer, a message deleted since the last
 * sync, or — always — the browser build, which has no `getMessageBody` at all.
 * When it was reached, the reader drew a subject, a sender, a date and then
 * *nothing*: no error, no explanation, no way to try again. A toast said so
 * for four seconds and then that was gone too.
 *
 * Every gate in this repository passed on that screen. It rendered, it was the
 * right size, its contrast was fine, all its buttons worked. Nothing threw and
 * nothing was logged. It is the exact shape of 运行正常，不报错，但是内容为空,
 * and no amount of reading the source finds it, because `: null` is a
 * perfectly ordinary thing to write.
 *
 * ## What this asserts
 *
 * Three claims, at three widths, against a seeded mailbox:
 *
 *   1. the list draws one row per message, with the sender and the subject on
 *      it — a mailbox that renders an empty scroller is the other half of the
 *      same report;
 *   2. opening a message fills the reader's *body* region with something. Not
 *      the header — the header always rendered, which is what made the failure
 *      so hard to see. Either a message frame, or a failure panel that names
 *      the reason;
 *   3. when it is the failure panel, it carries a working retry control. A
 *      dead end that explains itself is still a dead end.
 *
 * ## Why it seeds instead of syncing
 *
 * There is no mail server here and there must not be: a gate that needs a real
 * account is a gate that only runs on one machine. The fixture is written
 * straight into `aevistle.state.v1`, which is exactly what `bridge-web.ts`
 * reads, so the app boots on it the way it boots on a real document.
 *
 * The browser build then genuinely cannot fetch a body, which makes it the
 * ideal harness for claim 2: the failure path is not simulated here, it is the
 * real one, reached for a real reason.
 */

const PORT = process.env.CDP_PORT ?? '9445'

const failures = []
const notes = []
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

let step = 'starting up'
/* Bounded, for the reason `screen-title-probe.mjs` records: an unanswered CDP
   request otherwise ends as "unsettled top-level await" and a line number. */
function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP ${method} did not answer within 20s (step: ${step})`))
    }, 20_000)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      resolve(msg)
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

// --- the fixture -----------------------------------------------------------

const NOW = Date.now()
const MESSAGES = 5
const state = {
  accounts: [
    {
      id: 'acct_1',
      label: 'Primary',
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
  /* `updateCheckOnStart: false` or the first render fires a real request at
     GitHub's release API, which is neither this gate's business nor reliable. */
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
          unreadCount: 2,
          serverTotal: MESSAGES,
        },
      ],
      /* Fixture text, not app copy — the one kind of string these checks are
         allowed to assert on (see `tests/support/app.ts`). */
      messages: Array.from({ length: MESSAGES }, (_, i) => ({
        id: `msg_${i}`,
        accountId: 'acct_1',
        folderPath: 'INBOX',
        uid: 100 + i,
        uidValidity: 1,
        messageId: `<m${i}@example.com>`,
        from: `Fixture Sender ${i} <s${i}@example.com>`,
        to: 'me@example.com',
        subject: `Fixture subject ${i}`,
        date: NOW - i * 3_600_000,
        snippet: `Fixture preview text ${i}`,
        sizeBytes: 2048,
        hasAttachments: false,
        seen: i > 2,
        tag: 'none',
        bodyCached: false,
      })),
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
await evaluate(
  `localStorage.setItem('aevistle.state.v1', ${JSON.stringify(JSON.stringify(state))}), true`,
)

/**
 * The reader's *body* region, told apart from its header.
 *
 * The header is not evidence: it renders from the list row and rendered
 * perfectly throughout the bug this gate exists for. What counts is one of the
 * three things that may follow it — a frame with the message in it, the
 * loading skeleton, or the failure panel.
 */
const BODY_SCAN = `(() => {
  const host = document.querySelector('.modal__body--reader') || document.querySelector('.detailpane__body') || document.querySelector('.modal')
  if (!host) return { host: false }
  const seen = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return null
    return { w: Math.round(r.width), h: Math.round(r.height) }
  }
  const failPanel = host.querySelector('.readerfail')
  const retry = failPanel ? failPanel.querySelector('button') : null
  const retryKey = retry ? Object.keys(retry).find((k) => k.startsWith('__reactProps$')) : null
  return {
    host: true,
    frame: seen(host.querySelector('iframe')),
    skeleton: seen(host.querySelector('.reader__loading')),
    failure: seen(failPanel),
    failureText: failPanel ? String(failPanel.innerText).replace(/\\s+/g, ' ').trim().slice(0, 500) : '',
    retryWired: Boolean(retryKey && retry[retryKey] && retry[retryKey].onClick),
    /* Everything the body region draws, header excluded, so "it rendered
       something" cannot be satisfied by the header alone. */
    bodyChars: String(host.innerText).trim().length,
  }
})()`

const WIDTHS = [
  ['desktop', 1440, 900],
  ['tablet', 800, 1200],
  ['phone', 390, 844],
]

for (const [label, width, height] of WIDTHS) {
  step = `opening the mailbox at ${label}`
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 840,
  })
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
    fail(`${label}: the app never mounted.`)
    continue
  }
  await sleep(700)
  await evaluate(
    `(() => { const b = document.querySelector('.nav__item[data-view="inbox"]'); if (b) b.click(); })(), true`,
  )
  await sleep(800)

  // --- 1. the list ---------------------------------------------------------

  const list = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.job')]
    return {
      rows: rows.length,
      first: rows[0] ? String(rows[0].innerText).replace(/\\s+/g, ' ').trim().slice(0, 90) : '',
    }
  })()`)
  if (list.rows !== MESSAGES) {
    fail(`${label}: the mailbox drew ${list.rows} rows for ${MESSAGES} seeded messages.`)
    continue
  }
  if (!list.first.includes('Fixture Sender 0') || !list.first.includes('Fixture subject 0')) {
    fail(
      `${label}: the first row is missing its sender or subject — it reads "${list.first}".`,
    )
    continue
  }

  // --- 2 & 3. the reader ---------------------------------------------------

  step = `opening a message at ${label}`
  const opened = await evaluate(`(() => {
    const row = document.querySelector('.job')
    const body = row && (row.querySelector('.job__body') || row)
    if (!body) return false
    body.click()
    return true
  })()`)
  if (!opened) {
    fail(`${label}: no message row could be pressed.`)
    continue
  }
  await sleep(1600)

  const body = await evaluate(BODY_SCAN)
  if (!body.host) {
    fail(`${label}: pressing a message opened no reader at all.`)
    continue
  }
  const showing = body.frame ?? body.skeleton ?? body.failure
  if (!showing) {
    fail(
      `${label}: the reader opened with an empty body — no message frame, no loading state ` +
        `and no failure panel. This is the blank-reader bug; the header alone rendered ` +
        `${body.bodyChars} characters.`,
    )
    continue
  }
  if (showing.h < 40) {
    fail(`${label}: the reader's body region is only ${showing.h}px tall — nothing is readable in it.`)
    continue
  }
  if (body.failure) {
    if (!body.retryWired) {
      fail(`${label}: the reader's failure panel has no working retry control.`)
      continue
    }
    if (!body.failureText.includes('Fixture preview text 0')) {
      fail(`${label}: the failure panel does not offer the preview line already stored for this message.`)
      continue
    }
    if (body.failureText.length < 20) {
      fail(`${label}: the failure panel says almost nothing — "${body.failureText}".`)
      continue
    }
    notes.push(`${label}: ${list.rows} rows; body unavailable and said so, with a retry`)
  } else if (body.frame) {
    notes.push(`${label}: ${list.rows} rows; message body rendered (${body.frame.h}px)`)
  } else {
    fail(`${label}: the reader was still loading after 1.6s and never resolved.`)
  }
}

await send('Emulation.clearDeviceMetricsOverride')
ws.close()

console.log('')
console.log('check:inbox-reader — the mailbox lists mail, and an opened message is never blank')
for (const n of notes) console.log(`  · ${n}`)
if (notes.length < WIDTHS.length && failures.length === 0) {
  console.log('')
  console.log(`  FAIL  only ${notes.length} of ${WIDTHS.length} widths were actually inspected.`)
  process.exit(1)
}
if (failures.length > 0) {
  console.log('')
  for (const f of failures) console.log(`  FAIL  ${f}`)
  console.log('')
  console.log(`  ${failures.length} finding(s).`)
  process.exit(1)
}
console.log('')
console.log('  All clear.')
process.exit(0)
