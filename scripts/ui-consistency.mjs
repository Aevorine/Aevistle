/**
 * Is the interface actually uniform, or does it only look uniform on the two
 * screens that were open when it was designed?
 *
 * "界面要统一" has been asked for four times, and every previous round answered
 * it by eye on one screen. This walks every view in the running app and reports
 * the distinct computed values of the properties that make a set of screens
 * read as one product: card radius and padding, section gaps, control heights,
 * and the type sizes used for the same *kind* of text.
 *
 * A value used once is the interesting output. It is not automatically wrong —
 * the verification-code display is deliberately 2rem — but it is the list a
 * person has to defend, which is a much shorter list than "look at everything".
 *
 * Run the app with `--remote-debugging-port=9445` first, exactly as
 * `layout-probe.mjs` wants it.
 */

const PORT = Number(process.env.CDP_PORT ?? 9445)

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) {
  console.error('No page target — is the app running with --remote-debugging-port?')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
let nextId = 1
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  const r = pending.get(m.id)
  if (r) {
    pending.delete(m.id)
    r(m)
  }
})
const send = (method, params = {}) => {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((r) => pending.set(id, r))
}
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.result?.exceptionDetails) {
    throw new Error(res.result.exceptionDetails.exception?.description ?? 'evaluate failed')
  }
  return res.result?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** What is being measured, and where. One entry per thing that must match. */
const PROBES = [
  ['card radius', '.card', 'borderRadius'],
  ['card body padding', '.card__body', 'padding'],
  ['section gap', '.card__body', 'gap'],
  ['input height', '.input', 'height'],
  ['button height', '.btn', 'height'],
  ['field label size', '.field__label', 'fontSize'],
  ['page title size', '.page-title', 'fontSize'],
  ['section label size', '.section-label', 'fontSize'],
  ['hint size', '.field__hint', 'fontSize'],
  ['chip radius', '.chip', 'borderRadius'],
]

const VIEWS = ['compose', 'inbox', 'schedule', 'contacts', 'templates', 'logs', 'settings']

const collect = `(() => {
  const out = {}
  for (const [label, selector, prop] of ${JSON.stringify(PROBES)}) {
    const seen = {}
    for (const el of document.querySelectorAll(selector)) {
      const r = el.getBoundingClientRect()
      // Hidden elements have no layout and would report a height of 0 that no
      // user ever sees — counting them would invent inconsistencies.
      if (r.width === 0 && r.height === 0) continue
      const v = getComputedStyle(el)[prop]
      seen[v] = (seen[v] ?? 0) + 1
    }
    out[label] = seen
  }
  return JSON.stringify(out)
})()`

const totals = {}
for (const view of VIEWS) {
  // The shell listens for this on the nav buttons; clicking by label would
  // depend on the current locale.
  const went = await evaluate(`(() => {
    const all = [...document.querySelectorAll('.nav__item')]
    const target = all.find((b) => (b.dataset.view ?? '') === ${JSON.stringify(view)})
    if (!target) return 'missing:' + all.map((b) => b.dataset.view ?? '?').join(',')
    target.click()
    return 'ok'
  })()`)
  if (went !== 'ok') {
    console.log(`  skip ${view} — ${went}`)
    continue
  }
  // React has to render before anything is measured. Six views once reported
  // an identical number because they were all measured before the first
  // re-paint.
  await sleep(500)
  const raw = JSON.parse(await evaluate(collect))
  for (const [label, seen] of Object.entries(raw)) {
    totals[label] ??= {}
    for (const [value, n] of Object.entries(seen)) {
      totals[label][value] = (totals[label][value] ?? 0) + n
    }
  }
}

let outliers = 0
for (const [label, seen] of Object.entries(totals)) {
  const entries = Object.entries(seen).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) continue
  const line = entries.map(([v, n]) => `${v}×${n}`).join('  ')
  const odd = entries.filter(([, n]) => n <= 2 && entries[0][1] > 6)
  outliers += odd.length
  console.log(`${odd.length > 0 ? '  ?  ' : '  ok '} ${label.padEnd(20)} ${line}`)
}
console.log(`\n${outliers === 0 ? 'no outliers' : outliers + ' value(s) used once or twice — check each is deliberate'}`)

ws.close()
process.exit(0)
