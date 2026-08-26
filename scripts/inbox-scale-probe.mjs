/**
 * Does the mailbox still draw its day separators once it is big enough to be
 * windowed?
 *
 * ## The bug this exists because of
 *
 * Every inbox gate before this one seeded five messages. `VirtualList` only
 * windows a list at sixty rows (`threshold`), so five messages exercise the
 * plain path and nothing else — and the windowed path had been broken on
 * screen for as long as day separators existed, in a way no DOM query used
 * here noticed: the rows container is `position: absolute` and was moved into
 * place with `transform: translateY(...)`, but a transform moves paint, not
 * layout. `.daysep` is `position: sticky`, and sticky offsets are computed
 * from *layout* coordinates against the scrollport. The moment the window
 * slides (`range.start > 0`), every separator in the slice computes that it is
 * thousands of pixels above the viewport, pins itself as far down its
 * containing block as it may go, and paints there — a blank band where each
 * separator belongs, and a pile of separators over the rows at the bottom of
 * the slice. 界面内容显示不全，不正确 — and `check:date-labels` stayed green
 * throughout, because the *text* of every label was correct in the DOM.
 *
 * ## What this asserts
 *
 * Against a seeded six-account, 140-message mailbox spanning 45 days — enough
 * that the list is genuinely windowed — at three widths, and in four scroll
 * states (top, middle, bottom, and after a fast flick):
 *
 *   1. any gap between two consecutive message rows big enough to be a
 *      separator's flow slot actually has a separator painted in it;
 *   2. no separator paints over a message row, except the one legitimately
 *      stuck at the top of the pane;
 *   3. rows never overlap each other and are never blank;
 *   4. nothing overflows horizontally, no separator text is Invalid/NaN, and
 *      the page logs no errors or exceptions while any of this happens.
 *
 * These are claims about painted rectangles, not about state, which is why
 * this needs a real engine (same CDP harness as `inbox-reader-probe.mjs`).
 */

const PORT = process.env.CDP_PORT ?? '9445'

const failures = []
const notes = []
const consoleHits = []
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
  if (msg.method === 'Runtime.consoleAPICalled') {
    if (msg.params.type === 'error') {
      consoleHits.push(
        msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300),
      )
    }
    return
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleHits.push(String(msg.params.exceptionDetails?.exception?.description ?? 'exception').slice(0, 300))
    return
  }
  if (msg.method) return
  const resolve = pending.get(msg.id)
  if (resolve) {
    pending.delete(msg.id)
    resolve(msg)
  }
})

let step = 'starting up'
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
//
// Fixture text, not app copy — the one kind of string these checks may assert
// on. Six accounts because the account chip changes the row's height budget;
// 140 messages over 45 days because the report this reproduces only exists
// past `VirtualList`'s sixty-row threshold; several messages per day so every
// day-run is a run and not a lone row.

const NOW = Date.now()
const DAY = 86_400_000
const ACCOUNTS = [
  ['acct_1', 'Fixture Work'],
  ['acct_2', 'Fixture Personal'],
  ['acct_3', 'Fixture Newsletters'],
  ['acct_4', 'Fixture Billing'],
  ['acct_5', 'Fixture Backup'],
  ['acct_6', 'Fixture School'],
]
const dates = []
for (let i = 0; i < 8; i++) dates.push(NOW - i * 3_600_000)
for (let i = 0; i < 6; i++) dates.push(NOW - DAY - i * 2_700_000)
let d = 2
while (dates.length < 140) {
  const perDay = d < 7 ? 5 : 3
  for (let j = 0; j < perDay && dates.length < 140; j++) {
    dates.push(NOW - d * DAY - j * 5_400_000 - 3_600_000)
  }
  d += d < 7 ? 1 : 2
}
const perAccount = new Map(ACCOUNTS.map(([id]) => [id, []]))
dates.forEach((date, i) => {
  const [accountId] = ACCOUNTS[i % ACCOUNTS.length]
  perAccount.get(accountId).push({
    id: `msg_${i}`,
    accountId,
    folderPath: 'INBOX',
    uid: 1000 + i,
    uidValidity: 1,
    messageId: `<m${i}@example.com>`,
    from: `Fixture Sender ${i % 9} <s${i % 9}@example.com>`,
    to: 'me@example.com',
    /* A Re:-chained family from day 2 back, for the thread grouping — kept
       out of the newest rows so the archive walk's identity-following still
       lands on a unique subject. */
    subject:
      i >= 20 && i % 9 === 4
        ? 'Re: Fixture thread topic'
        : i >= 20 && i % 9 === 8
          ? 'Fixture thread topic'
          : `Fixture subject ${i}`,
    date,
    snippet: `Fixture preview text ${i}`,
    sizeBytes: 2048 + i,
    hasAttachments: i % 4 === 0,
    seen: i % 3 !== 0,
    tag: i % 11 === 0 ? 'flagged' : 'none',
    bodyCached: false,
  })
})
const state = {
  accounts: ACCOUNTS.map(([id, label]) => ({
    id,
    label,
    fromName: 'Me',
    fromAddress: `${id}@example.com`,
    host: 'smtp.example.com',
    port: 465,
    security: 'ssl',
    username: `${id}@example.com`,
    authMethod: 'password',
    hasSecret: true,
    timeoutMs: 20_000,
    autoNegotiate: true,
    allowInvalidCert: false,
    poolMaxMessages: 50,
    createdAt: NOW,
    updatedAt: NOW,
  })),
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
  inboxAccounts: ACCOUNTS.map(([id]) => ({
    accountId: id,
    enabled: true,
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapSecurity: 'ssl',
    imapUsername: `${id}@example.com`,
    imapAllowInvalidCert: false,
    folders: [
      {
        id: `f_${id}`,
        accountId: id,
        path: 'INBOX',
        displayName: 'INBOX',
        uidValidity: 1,
        unreadCount: perAccount.get(id).filter((m) => !m.seen).length,
        serverTotal: perAccount.get(id).length,
      },
    ],
    messages: perAccount.get(id),
    removed: [],
    showRemoteImages: 'always',
    imageAllowlist: [],
    lastSyncAt: NOW,
  })),
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
await send('Runtime.enable')
await evaluate(
  `localStorage.setItem('aevistle.state.v1', ${JSON.stringify(JSON.stringify(state))}), true`,
)

/**
 * The painted geometry of the list, reduced to the questions above.
 *
 * A separator "covers" a gap when at least half the gap's height is separator;
 * a separator is "stuck" when it sits at the top edge of the pane's content
 * box (the chip strip's reserved padding included), which is the one place a
 * sticky bar is allowed to sit on top of rows scrolling under it.
 */
const SCAN = `(() => {
  const pane = document.querySelector('.view--list .list-pane')
  if (!pane) return { pane: false }
  const paneR = pane.getBoundingClientRect()
  const padTop = parseFloat(getComputedStyle(pane).paddingTop) || 0
  const jobs = [...pane.querySelectorAll('.job')]
    .map((j) => { const r = j.getBoundingClientRect(); return { t: r.top, b: r.bottom, text: String(j.innerText).trim().length } })
    .sort((a, b) => a.t - b.t)
  const seps = [...pane.querySelectorAll('.daysep')].map((s) => {
    const r = s.getBoundingClientRect()
    return { t: r.top, b: r.bottom, label: String(s.textContent).trim() }
  })
  let rowOverlaps = 0
  let blankRows = 0
  const uncoveredGaps = []
  for (let i = 0; i < jobs.length; i++) {
    if (jobs[i].text < 3) blankRows++
    if (i === 0) continue
    const gapTop = jobs[i - 1].b
    const gapBottom = jobs[i].t
    const gap = gapBottom - gapTop
    if (gap < -2) rowOverlaps++
    // Only gaps that are inside the viewport and big enough to be a
    // separator's slot; the list's own row gap is 4px.
    if (gap > 30 && gapBottom > paneR.top + padTop && gapTop < paneR.bottom) {
      let covered = 0
      for (const s of seps) covered = Math.max(covered, Math.min(s.b, gapBottom) - Math.max(s.t, gapTop))
      if (covered < gap / 2) uncoveredGaps.push(Math.round(gap))
    }
  }
  let sepOverRow = 0
  for (const s of seps) {
    const stuck = s.t <= paneR.top + padTop + 6
    if (stuck) continue
    for (const j of jobs) {
      const overlap = Math.min(s.b, j.b) - Math.max(s.t, j.t)
      if (overlap > 2) { sepOverRow++; break }
    }
  }
  const badSep = seps.map((s) => s.label).filter((l) => !l || /invalid|NaN|undefined/i.test(l))
  // A *day* separator carrying a clock time is naming one message's moment as
  // if it were the day's — the default timeStyle leaking through a
  // dateStyle-only request.
  const timedSep = seps.map((s) => s.label).filter((l) => /\\d{1,2}:\\d{2}/.test(l))
  const de = document.documentElement
  return {
    pane: true,
    jobCount: jobs.length,
    sepCount: seps.length,
    blankRows,
    rowOverlaps,
    uncoveredGaps,
    sepOverRow,
    badSep,
    timedSep,
    hOverflowDoc: de.scrollWidth - de.clientWidth,
    hOverflowPane: pane.scrollWidth - pane.clientWidth,
    scrollTop: Math.round(pane.scrollTop),
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
  await sleep(1000)

  const states = [
    ['top', `p.scrollTop = 0`],
    ['middle', `p.scrollTop = (p.scrollHeight - p.clientHeight) / 2`],
    ['bottom', `p.scrollTop = p.scrollHeight`],
  ]
  let inspected = 0
  for (const [name, move] of states) {
    step = `${label}/${name}`
    await evaluate(`(() => { const p = document.querySelector('.view--list .list-pane'); if (p) { ${move} } })(), true`)
    await sleep(700)
    const s = await evaluate(SCAN)
    if (!s.pane) {
      fail(`${label}/${name}: no list pane on screen.`)
      break
    }
    inspected++
    if (s.jobCount === 0) fail(`${label}/${name}: the windowed list drew no rows at all.`)
    if (s.blankRows) fail(`${label}/${name}: ${s.blankRows} row(s) rendered blank.`)
    if (s.rowOverlaps) fail(`${label}/${name}: ${s.rowOverlaps} row(s) painted over each other.`)
    if (s.uncoveredGaps.length)
      fail(
        `${label}/${name}: ${s.uncoveredGaps.length} separator slot(s) rendered as blank bands ` +
          `(${s.uncoveredGaps.join(', ')}px) — the sticky separators are not where their rows are.`,
      )
    if (s.sepOverRow) fail(`${label}/${name}: ${s.sepOverRow} separator(s) painted on top of message rows.`)
    if (s.badSep.length) fail(`${label}/${name}: unreadable separator label(s): ${JSON.stringify(s.badSep)}`)
    if (s.timedSep.length)
      fail(`${label}/${name}: day separator(s) carrying a clock time: ${JSON.stringify(s.timedSep.slice(0, 3))}`)
    if (s.hOverflowDoc > 1) fail(`${label}/${name}: the document overflows horizontally by ${s.hOverflowDoc}px.`)
    if (s.hOverflowPane > 1) fail(`${label}/${name}: the list pane overflows horizontally by ${s.hOverflowPane}px.`)
  }

  // A fast flick outruns the scroll handler on purpose; the question is what
  // is on screen once things settle.
  step = `${label}/flick`
  await evaluate(`(() => { const p = document.querySelector('.view--list .list-pane'); if (p) p.scrollTop = 0 })(), true`)
  await sleep(400)
  await evaluate(
    `(async () => { const p = document.querySelector('.view--list .list-pane'); if (!p) return; for (let i = 0; i < 30; i++) { p.scrollTop += 400; await new Promise(r => setTimeout(r, 16)) } })()`,
  )
  await sleep(700)
  const s = await evaluate(SCAN)
  if (s.pane) {
    inspected++
    if (s.uncoveredGaps.length)
      fail(`${label}/flick: ${s.uncoveredGaps.length} blank separator band(s) after a fast flick.`)
    if (s.rowOverlaps) fail(`${label}/flick: ${s.rowOverlaps} row(s) painted over each other after a fast flick.`)
    if (s.sepOverRow) fail(`${label}/flick: ${s.sepOverRow} separator(s) painted on top of rows after a fast flick.`)
  }
  // Leaving and returning must not cost the reader their place. The views
  // unmount on switch, so without an explicit memory the list restarts at the
  // top — the assertion is against "forgot", not against pixel identity,
  // because a remount re-measures row heights from estimates and may land a
  // handful of pixels away from where it left.
  step = `${label}/return`
  await evaluate(
    `(() => { const p = document.querySelector('.view--list .list-pane'); if (p) p.scrollTop = (p.scrollHeight - p.clientHeight) / 2 })(), true`,
  )
  await sleep(500)
  const savedTop = await evaluate(
    `(() => { const p = document.querySelector('.view--list .list-pane'); return p ? Math.round(p.scrollTop) : -1 })()`,
  )
  await evaluate(`(() => { const b = document.querySelector('.nav__item[data-view="settings"]'); if (b) b.click() })(), true`)
  await sleep(700)
  await evaluate(`(() => { const b = document.querySelector('.nav__item[data-view="inbox"]'); if (b) b.click() })(), true`)
  await sleep(900)
  const backTop = await evaluate(
    `(() => { const p = document.querySelector('.view--list .list-pane'); return p ? Math.round(p.scrollTop) : -1 })()`,
  )
  if (savedTop > 500 && backTop < savedTop / 2) {
    fail(`${label}/return: left the mailbox at ${savedTop}px and came back at ${backTop}px — the list forgot where you were.`)
  } else {
    inspected++
  }
  notes.push(`${label}: ${inspected} scroll state(s) inspected, ${s.pane ? s.jobCount : 0} rows mounted at rest`)
}

// --- 已读到此为止 -----------------------------------------------------------
//
// The bulk action's claim is positional: everything *newer* than the selected
// row becomes read, everything older is untouched. Walked as a user walks it —
// overflow menu, 编辑, a checkbox, the button — via `data-action` hooks, since
// the labels are translated copy no check may match on. Every step that can
// come up empty reports itself; the assertion cannot pass vacuously.
step = 'read-to-here'
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.reload', { ignoreCache: false })
{
  let mounted = false
  for (let i = 0; i < 60; i += 1) {
    await sleep(250)
    if (await evaluate(`Boolean(document.querySelector('.shell .view'))`)) {
      mounted = true
      break
    }
  }
  if (!mounted) {
    fail('read-to-here: the app never mounted.')
  } else {
    await sleep(700)
    await evaluate(
      `(() => { const b = document.querySelector('.nav__item[data-view="inbox"]'); if (b) b.click(); })(), true`,
    )
    await sleep(1000)
    const r2h = await evaluate(`(async () => {
      const menuBtn = document.querySelector('.inboxmenu > button')
      if (!menuBtn) return { failed: 'no overflow menu trigger' }
      menuBtn.click()
      await new Promise((r) => setTimeout(r, 300))
      const editItem = document.querySelector('[data-action="edit"]')
      if (!editItem) return { failed: 'no edit item in the menu' }
      editItem.click()
      await new Promise((r) => setTimeout(r, 300))
      const boxes = [...document.querySelectorAll('.job__select')]
      if (boxes.length < 8) return { failed: 'fewer than 8 selectable rows on screen' }
      const unreadBefore = document.querySelectorAll('.job[data-unread="true"]').length
      const row = boxes[6].closest('.job')
      const rowTop = row.getBoundingClientRect().top
      boxes[6].click()
      await new Promise((r) => setTimeout(r, 200))
      const btn = document.querySelector('[data-action="read-to-here"]')
      if (!btn) return { failed: 'no read-to-here control in the edit bar' }
      btn.click()
      await new Promise((r) => setTimeout(r, 700))
      const jobs = [...document.querySelectorAll('.job')]
      const unreadAbove = jobs.filter(
        (j) => j.getBoundingClientRect().top < rowTop - 2 && j.dataset.unread === 'true',
      ).length
      const unreadAfter = document.querySelectorAll('.job[data-unread="true"]').length
      return { unreadBefore, unreadAfter, unreadAbove }
    })()`)
    if (r2h.failed) {
      fail(`read-to-here: ${r2h.failed}.`)
    } else {
      if (r2h.unreadAbove > 0)
        fail(`read-to-here: ${r2h.unreadAbove} row(s) above the selected one are still unread.`)
      if (r2h.unreadAfter >= r2h.unreadBefore)
        fail(`read-to-here: the unread count did not fall (${r2h.unreadBefore} -> ${r2h.unreadAfter}).`)
      if (r2h.unreadAfter === 0)
        fail(`read-to-here: every message went read — the boundary was ignored, this is mark-all-read.`)
      if (failures.every((f) => !f.startsWith('read-to-here')))
        notes.push(`read-to-here: unread ${r2h.unreadBefore} -> ${r2h.unreadAfter}, none above the boundary`)
    }
  }
}

// --- archive ---------------------------------------------------------------
//
// Archiving one message must take exactly one row out of the list, the
// archived panel must offer it back, and putting it back must restore the
// count — walked in one continuous session right after the read-to-here
// check, which left the app in edit mode's aftermath at desktop width.
step = 'archive'
{
  await evaluate(`(() => { const b = document.querySelector('.nav__item[data-view="inbox"]'); if (b) b.click(); })(), true`)
  await sleep(600)
  // Identity, not row counts: a windowed list refills its slice from below,
  // so archiving one of 140 messages leaves the number of *mounted* rows
  // exactly where it was — the first draft of this check asserted the count
  // and failed against a working feature. What archiving actually promises
  // is that *this* message leaves the list, is offered in the panel, and
  // comes back — so the subject (fixture text, the one kind of string a
  // check may match) is followed through all three places.
  const arc = await evaluate(`(async () => {
    const holds = (sel, text) => [...document.querySelectorAll(sel)].some((el) => el.textContent.includes(text))
    const menu = () => document.querySelector('.inboxmenu > button')
    if (!menu()) return { failed: 'no overflow menu trigger' }
    menu().click()
    await new Promise((r) => setTimeout(r, 300))
    const editItem = document.querySelector('[data-action="edit"]')
    if (!editItem) return { failed: 'no edit item' }
    editItem.click()
    await new Promise((r) => setTimeout(r, 300))
    const box = document.querySelectorAll('.job__select')[2]
    if (!box) return { failed: 'no selectable row' }
    const subject = ((box.closest('.job') ?? {}).querySelector?.('.job__subject') ?? {}).textContent ?? ''
    if (!subject.startsWith('Fixture subject')) return { failed: 'could not read the fixture subject off the row' }
    box.click()
    await new Promise((r) => setTimeout(r, 200))
    const btn = document.querySelector('[data-action="archive"]')
    if (!btn) return { failed: 'no archive control in the edit bar' }
    btn.click()
    await new Promise((r) => setTimeout(r, 600))
    const goneFromList = !holds('.job', subject)
    menu().click()
    await new Promise((r) => setTimeout(r, 300))
    const archivedItem = document.querySelector('[data-action="archived"]')
    if (!archivedItem) return { failed: 'no archived entry in the menu' }
    archivedItem.click()
    await new Promise((r) => setTimeout(r, 400))
    const inPanel = holds('.inbox-bin .bin-row', subject)
    const un = document.querySelector('[data-action="unarchive"]')
    if (!un) return { failed: 'no unarchive control in the panel' }
    un.click()
    await new Promise((r) => setTimeout(r, 600))
    const p = document.querySelector('.view--list .list-pane')
    if (p) p.scrollTop = 0
    await new Promise((r) => setTimeout(r, 400))
    const backInList = holds('.job', subject)
    return { subject, goneFromList, inPanel, backInList }
  })()`)
  if (arc.failed) {
    fail(`archive: ${arc.failed}.`)
  } else {
    if (!arc.goneFromList) fail(`archive: "${arc.subject}" was archived and is still in the list.`)
    if (!arc.inPanel) fail(`archive: "${arc.subject}" is not offered in the archived panel.`)
    if (!arc.backInList) fail(`archive: "${arc.subject}" was put back and did not return to the list.`)
    if (arc.goneFromList && arc.inPanel && arc.backInList)
      notes.push(`archive: "${arc.subject}" left the list, sat in the panel, and came back`)
  }
}

// --- group by sender ---------------------------------------------------------
//
// Toggling the grouping must fence the same rows differently: sender labels
// on the separators while it is on, and none of them left once it is off
// again. Counts are cross-checked so a fence with the wrong rows inside it
// cannot pass on labels alone.
step = 'group-by-sender'
{
  const grp = await evaluate(`(async () => {
    const menu = () => document.querySelector('.inboxmenu > button')
    const toggle = async () => {
      if (!menu()) return 'no menu trigger'
      menu().click()
      await new Promise((r) => setTimeout(r, 300))
      const item = document.querySelector('[data-action="group-sender"]')
      if (!item) return 'no group-sender item'
      item.click()
      await new Promise((r) => setTimeout(r, 600))
      return 'ok'
    }
    const senderSeps = () =>
      [...document.querySelectorAll('.daysep__label')].filter((s) => s.textContent.startsWith('Fixture Sender')).length
    let r = await toggle()
    if (r !== 'ok') return { failed: r }
    const on = senderSeps()
    const firstSep = document.querySelector('.daysep')
    const count = firstSep ? Number(firstSep.querySelector('.daysep__count')?.textContent ?? '0') : 0
    r = await toggle()
    if (r !== 'ok') return { failed: r + ' (second toggle)' }
    const off = senderSeps()
    return { on, off, count }
  })()`)
  if (grp.failed) {
    fail(`group-by-sender: ${grp.failed}.`)
  } else {
    if (grp.on === 0) fail('group-by-sender: no sender-labelled separators appeared after toggling on.')
    if (grp.count < 2) fail(`group-by-sender: the first group claims ${grp.count} message(s) — grouping did not gather.`)
    if (grp.off !== 0) fail(`group-by-sender: ${grp.off} sender separator(s) survived toggling back to days.`)
    if (grp.on > 0 && grp.off === 0)
      notes.push(`group-by-sender: ${grp.on} sender fence(s) on, first holds ${grp.count}, clean off`)
  }
}

// --- group by conversation ---------------------------------------------------
//
// The Re:-chained family seeded above must gather under one fence whose count
// says how many the chain holds — scrolled for, because the thread's newest
// message is days old and its fence sits below the windowed slice at rest.
step = 'group-by-thread'
{
  const thr = await evaluate(`(async () => {
    const menu = () => document.querySelector('.inboxmenu > button')
    const toggle = async (action) => {
      if (!menu()) return 'no menu trigger'
      menu().click()
      await new Promise((r) => setTimeout(r, 300))
      const item = document.querySelector('[data-action="' + action + '"]')
      if (!item) return 'no ' + action + ' item'
      item.click()
      await new Promise((r) => setTimeout(r, 600))
      return 'ok'
    }
    let r = await toggle('group-thread')
    if (r !== 'ok') return { failed: r }
    const p = document.querySelector('.view--list .list-pane')
    if (!p) return { failed: 'no list pane' }
    let found = 0
    for (let stepDown = 0; stepDown < 24 && !found; stepDown++) {
      for (const sep of document.querySelectorAll('.daysep')) {
        const label = sep.querySelector('.daysep__label')?.textContent ?? ''
        if (label.toLowerCase().includes('fixture thread topic')) {
          found = Number(sep.querySelector('.daysep__count')?.textContent ?? '0')
          break
        }
      }
      if (!found) {
        p.scrollTop += p.clientHeight
        await new Promise((r2) => setTimeout(r2, 250))
      }
    }
    p.scrollTop = 0
    await new Promise((r2) => setTimeout(r2, 300))
    r = await toggle('group-thread')
    if (r !== 'ok') return { failed: r + ' (toggle off)' }
    return { found }
  })()`)
  if (thr.failed) {
    fail(`group-by-thread: ${thr.failed}.`)
  } else if (thr.found < 2) {
    fail(`group-by-thread: the Re: family never gathered — best fence found holds ${thr.found}.`)
  } else {
    notes.push(`group-by-thread: the Re: family gathered ${thr.found} messages under one fence`)
  }
}

// --- reply -------------------------------------------------------------------
//
// One press in the reader has to land on the compose screen holding the right
// half-written mail: the sender's bare address as the recipient and the
// subject wearing exactly one Re:. Asserted against the fixture address —
// the reader was opened on the newest row, whose sender the fixture fixes.
step = 'reply'
{
  // A fresh page, because the archive walk above deliberately left 编辑 mode
  // behind it — and in edit mode a row click selects instead of opening.
  await send('Page.reload', { ignoreCache: false })
  let mounted = false
  for (let i = 0; i < 60; i += 1) {
    await sleep(250)
    if (await evaluate(`Boolean(document.querySelector('.shell .view'))`)) {
      mounted = true
      break
    }
  }
  if (!mounted) fail('reply: the app never mounted.')
  await sleep(700)
  await evaluate(
    `(() => { const b = document.querySelector('.nav__item[data-view="inbox"]'); if (b) b.click(); })(), true`,
  )
  await sleep(1000)
  const rep = await evaluate(`(async () => {
    const row = document.querySelector('.job')
    const body = row && (row.querySelector('.job__body') || row)
    if (!body) return { failed: 'no row to open' }
    body.click()
    await new Promise((r) => setTimeout(r, 900))
    const more = document.querySelector('.reader__more button')
    if (!more) return { failed: 'no reader overflow button' }
    more.click()
    await new Promise((r) => setTimeout(r, 300))
    const btn = document.querySelector('[data-action="reply"]')
    if (!btn) return { failed: 'no reply item in the reader menu' }
    btn.click()
    await new Promise((r) => setTimeout(r, 800))
    const compose = document.querySelector('.view--compose')
    if (!compose) return { failed: 'reply did not land on the compose screen' }
    const text = compose.innerText
    const inputs = [...compose.querySelectorAll('input, textarea')].map((i) => i.value).join(' | ')
    return {
      hasAddress: text.includes('s0@example.com') || inputs.includes('s0@example.com'),
      subjectOnce: (inputs.match(/Re: Fixture subject 0/g) ?? []).length === 1 && !inputs.includes('Re: Re:'),
    }
  })()`)
  if (rep.failed) {
    fail(`reply: ${rep.failed}.`)
  } else {
    if (!rep.hasAddress) fail('reply: the compose screen does not carry the sender address s0@example.com.')
    if (!rep.subjectOnce) fail('reply: the subject is not exactly one "Re: Fixture subject 0".')
    if (rep.hasAddress && rep.subjectOnce) notes.push('reply: compose holds s0@example.com and a single Re:')
  }
}

if (consoleHits.length) {
  fail(`the page logged ${consoleHits.length} error(s): ${consoleHits.slice(0, 3).join(' | ')}`)
}

await send('Emulation.clearDeviceMetricsOverride')
ws.close()

console.log('')
console.log('check:inbox-scale — a windowed mailbox still draws its separators where its rows are')
for (const n of notes) console.log(`  · ${n}`)
if (failures.length > 0) {
  console.log('')
  for (const f of failures) console.log(`  FAIL  ${f}`)
  console.log('')
  console.log(`  ${failures.length} finding(s).`)
  process.exit(1)
}
const widthsSeen = notes.length
if (widthsSeen < WIDTHS.length) {
  console.log('')
  console.log(`  FAIL  only ${widthsSeen} of ${WIDTHS.length} widths were actually inspected.`)
  process.exit(1)
}
console.log('')
console.log('  All clear.')
process.exit(0)
