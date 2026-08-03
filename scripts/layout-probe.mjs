/**
 * Measure the compose screen in the *packaged* app — `node scripts/layout-probe.mjs`.
 *
 * Written because three rounds of compose-layout work were argued from
 * screenshots, and a screenshot cannot tell "the rule did not apply" from "the
 * build is older than the edit". This reads `getBoundingClientRect()` and
 * `getComputedStyle()` off the real window, so every number below is what the
 * user's machine actually laid out.
 *
 * It checks the two properties the layout is *required* to have and that are
 * invisible in a picture:
 *
 *   1. The form fits one screen with the options disclosure closed. That is a
 *      hard requirement, not a preference — a compose form that scrolls before
 *      a character is typed is the complaint this layout exists to answer.
 *   2. Nothing readable on the screen is below 16px (小四). The shared
 *      components default several hints and descriptions to 14px, which is
 *      right on a dense list screen and wrong here.
 *
 * Launch the packaged app first with `--remote-debugging-port` and a scratch
 * `--user-data-dir`; this only reads, and never touches the real data folder.
 */

const PORT = Number(process.env.CDP_PORT ?? 9445)

if (typeof WebSocket !== 'function') {
  console.error('This needs Node 22+ for a global WebSocket.')
  process.exit(1)
}

const guard = setTimeout(() => {
  console.error('\nTimed out waiting for the app to answer.')
  process.exit(1)
}, 120_000)
guard.unref?.()

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
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
    throw new Error(res.result.exceptionDetails.exception?.description ?? 'evaluate failed')
  }
  return res.result?.result?.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Text that is read as prose and must therefore be 小四 or larger.
 *
 * Numeric badges are excluded by selector, not by judgement: `--text-2xs` is
 * reserved for counts and file-type tags, which are not sentences and do not
 * read as small.
 */
const PROSE = [
  '.page-title',
  '.page-subtitle',
  '.field__label',
  '.field__hint',
  '.field__labelhint',
  '.switch__title',
  '.switch__desc',
  '.dropzone__title',
  '.dropzone__hint',
  '.moreoptions__summary',
  '.whenbar__rule',
  '.quickpicks__label',
  '.quickpick__name',
  '.quickpick__address',
  '.actionbar__line',
  '.actionbar__meta',
  '.btn',
  '.input',
  '.select',
  '.textarea',
]

const probe = `(() => {
  // .view is the scroller — it is the element carrying overflow-y: auto.
  // Measuring its parent instead reports 0 overflow always, because .main
  // never scrolls, and turns this probe into something that cannot fail.
  const scroller = document.querySelector('.view')
  const rect = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }
  }
  const small = []
  for (const sel of ${JSON.stringify(PROSE)}) {
    for (const el of document.querySelectorAll('.view--compose ' + sel + ', .actionbar ' + sel)) {
      if (!el.textContent.trim()) continue
      const px = parseFloat(getComputedStyle(el).fontSize)
      if (px < 15.9) small.push(sel + ' → ' + px.toFixed(2) + 'px :: ' + el.textContent.trim().slice(0, 24))
    }
  }
  const fonts = [...document.querySelectorAll('.view--compose .page-title, .view--compose .field__label')]
    .slice(0, 2)
    .map((el) => getComputedStyle(el).fontFamily)
  return JSON.stringify({
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    overflowPx: scroller.scrollHeight - scroller.clientHeight,
    viewport: { w: innerWidth, h: innerHeight },
    inner: rect('.view--compose .view__inner'),
    card: rect('.compose-card'),
    // Every direct child of the column, so the height budget is itemised
    // rather than reasoned about. Three rounds of this work were argued from
    // estimates; the estimates were wrong every time.
    innerKids: [...(document.querySelector('.view--compose .view__inner')?.children ?? [])]
      .map((el) => (el.className || el.tagName) + ' = ' + Math.round(el.getBoundingClientRect().height)),
    cardKids: [...(document.querySelector('.compose-layout')?.children ?? [])]
      .map((el) => (el.className || el.tagName).split(' ')[0] + ':' +
        String(el.querySelector('.field__label')?.textContent ?? '').slice(0, 8) +
        ' = ' + Math.round(el.getBoundingClientRect().height)),
    actionbar: rect('.actionbar'),
    body: rect('.textarea--body'),
    head: rect('.compose-head'),
    subject: rect('.compose-head .input'),
    whenbar: rect('.whenbar'),
    dropzone: rect('.dropzone'),
    quickpicks: rect('.quickpicks'),
    quickpickCount: document.querySelectorAll('.quickpick').length,
    detailsOpen: document.querySelector('.moreoptions')?.hasAttribute('open') ?? null,
    tooSmall: small,
    fontFamily: fonts,
  })
})()`

async function measure(label) {
  const raw = await evaluate(probe)
  return { label, ...JSON.parse(raw) }
}

const closed = await measure('disclosure closed')

/*
 * The scratch profile has no mail account, so the screen carries a first-run
 * warning banner a configured install does not. Removing it measures the state
 * every user after the first minute is actually in — labelled as the
 * simulation it is, rather than quietly reported as the general case.
 */
await evaluate(`document.querySelector('.view--compose .banner--warning')?.remove(), true`)
await sleep(300)
const configured = await measure('disclosure closed, account configured')
await evaluate(`document.querySelector('.moreoptions')?.setAttribute('open', ''), true`)
await sleep(400)
const open = await measure('disclosure open')
await evaluate(`document.querySelector('.moreoptions')?.removeAttribute('open'), true`)

const bodyShare = (m) =>
  m.body && m.viewport.h ? Math.round((m.body.h / m.viewport.h) * 100) : 0

let failed = false
for (const m of [closed, configured, open]) {
  console.log(`\n--- ${m.label} — window ${m.viewport.w}x${m.viewport.h} ---`)
  console.log(`  scroll ${m.scrollHeight} / client ${m.clientHeight}  → overflow ${m.overflowPx}px`)
  console.log(`  inner column ${m.inner?.w}x${m.inner?.h}   card ${m.card?.w}x${m.card?.h}`)
  console.log(`  body box     ${m.body?.w}x${m.body?.h}  (${bodyShare(m)}% of window height)`)
  console.log(`  head row     ${m.head?.w}x${m.head?.h}   actionbar ${m.actionbar?.h}`)
  console.log(`  page column: ${m.innerKids.join('  |  ')}`)
  console.log(`  card column: ${m.cardKids.join('  |  ')}`)
  console.log(`  when bar     ${m.whenbar?.w}x${m.whenbar?.h}`)
  console.log(`  dropzone     ${m.dropzone?.w}x${m.dropzone?.h}`)
  console.log(`  quick picks  ${m.quickpickCount} shown, box ${m.quickpicks ? m.quickpicks.w + 'x' + m.quickpicks.h : 'absent'}`)
  console.log(`  prose below 16px: ${m.tooSmall.length === 0 ? 'none' : ''}`)
  for (const line of m.tooSmall) console.log(`      ${line}`)
  if (m.tooSmall.length > 0) failed = true
}

console.log(`\n  font stack in use: ${closed.fontFamily.join(' | ')}`)

// The closed state is the requirement. Open is a disclosure the user asked
// for, and a few pixels of scroll there is a different question.
if (configured.overflowPx > 2) {
  console.log(`\n  FAIL  the form scrolls with an account configured (${configured.overflowPx}px)`)
  failed = true
} else {
  console.log(`\n  ok    fits one screen with an account configured and the disclosure closed`)
}

ws.close()
process.exit(failed ? 1 : 0)
