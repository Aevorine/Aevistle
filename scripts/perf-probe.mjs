/**
 * Performance measurements against the *packaged* app — `node scripts/perf-probe.mjs`.
 *
 * Deliberately not a headless browser. An earlier round of these numbers had to
 * be thrown away entirely because headless Chromium throttles `requestAnimationFrame`
 * to roughly 1 Hz, which silently turned every frame-based measurement into a
 * measurement of the throttle. Everything here either runs in a real Electron
 * window over CDP, or avoids rAF altogether.
 *
 * Usage: launch the packaged app with
 *   Aevistle.exe --remote-debugging-port=9333 --user-data-dir=<scratch>
 * then run this. It only reads and clicks; it never writes to the user's data
 * folder, which is why the launch above takes a separate one.
 */

const PORT = Number(process.env.CDP_PORT ?? 9333)

// Node's global WebSocket. Importing one from `undici` instead hung this
// script for three minutes with no error — the failure mode of a bad import in
// a top-level-await module is a silent stall, not a stack trace.
if (typeof WebSocket !== 'function') {
  console.error('This needs Node 22+ for a global WebSocket.')
  process.exit(1)
}

// A hard ceiling, so a wedged evaluate reports instead of hanging a build.
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

/** Evaluate in the page and return the resolved value, surfacing real errors. */
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

const results = []
const record = (name, value, unit, target, lowerIsBetter = true) => {
  const pass = target === null ? null : lowerIsBetter ? value <= target : value >= target
  results.push({ name, value, unit, target, pass })
}

// --- start-up -------------------------------------------------------------
// Navigation timing is recorded by the browser itself, so this is the real
// cold-start figure rather than something measured after the fact.
const nav = await evaluate(`(() => {
  const [n] = performance.getEntriesByType('navigation')
  const paint = performance.getEntriesByType('paint').find(p => p.name === 'first-contentful-paint')
  return JSON.stringify({
    domContentLoaded: Math.round(n.domContentLoadedEventEnd),
    loadEvent: Math.round(n.loadEventEnd),
    firstContentfulPaint: paint ? Math.round(paint.startTime) : null,
    transferredJs: performance.getEntriesByType('resource')
      .filter(r => r.name.endsWith('.js'))
      .reduce((a, r) => a + (r.decodedBodySize || 0), 0),
    jsChunksOnBoot: performance.getEntriesByType('resource').filter(r => r.name.endsWith('.js')).length,
  })
})()`)
const boot = JSON.parse(nav)
record('cold start → first contentful paint', boot.firstContentfulPaint, 'ms', 1000)
record('cold start → DOM ready', boot.domContentLoaded, 'ms', 1500)
// Electron loads the renderer over `file://`, which the Resource Timing API
// does not record. A zero here means "not measurable in the packaged app",
// never "nothing was downloaded" — reporting it as a pass would be inventing
// a result. The chunk split is verified from the build output instead.
if (boot.jsChunksOnBoot > 0) {
  record('JS decoded on boot', Math.round(boot.transferredJs / 1024), 'kB', 900)
  record('JS chunks fetched on boot', boot.jsChunksOnBoot, 'chunks', 8)
} else {
  results.push({ name: 'JS decoded on boot', value: 'n/a (file:// has no resource timing)', unit: '', target: null, pass: null })
}

// --- view switching -------------------------------------------------------
// Each screen is a separate lazily-loaded chunk, so the first switch includes
// its fetch and parse. That is the number a user actually experiences.
/*
 * The screens are read out of the sidebar rather than listed here, and driven
 * by clicking rather than by Ctrl+N.
 *
 * Both were wrong before, and wrong silently. The list was six hard-coded ids
 * against a sidebar that has since grown to nine, so `Ctrl+2` stopped meaning
 * "inbox"; and every measurement returned -1 because it waited on
 * `.page-title`, which the screen it started from does not render. The -1s
 * were then *filtered out*, leaving `Math.max()` of an empty array —
 * `-Infinity`, which passed a `≤ 400 ms` target. A probe reporting PASS for a
 * measurement that never happened is worse than no probe.
 */
const navLabels = JSON.parse(
  await evaluate(
    `JSON.stringify([...document.querySelectorAll('.nav__item')].map(e => e.textContent.trim()).filter(Boolean))`,
  ),
)
if (navLabels.length === 0) {
  console.error('No `.nav__item` elements — the sidebar markup changed; fix this probe.')
  process.exit(1)
}

// Start somewhere that is not the first screen, so clicking the first screen
// is a real switch. Without this the screen the app opens on is measured as
// "never changed", which looks like a stall and is only a sampling artefact.
await evaluate(
  `(() => { const n = [...document.querySelectorAll('.nav__item')]; if (n.length > 1) n[n.length - 1].click() })()`,
)
await new Promise((r) => setTimeout(r, 400))

const switchTimes = {}
for (const label of navLabels) {
  const ms = await evaluate(`(async () => {
    const target = [...document.querySelectorAll('.nav__item')]
      .find(e => e.textContent.trim() === ${JSON.stringify(label)})
    if (!target) return -1
    // The whole main region, not one heading: the screen this starts from has
    // no title element, so a title-only check can never see a change.
    const main = document.querySelector('.main') || document.body
    const before = main.textContent.slice(0, 400)
    const t0 = performance.now()
    target.click()
    const deadline = performance.now() + 5000
    while (performance.now() < deadline) {
      if (main.textContent.slice(0, 400) !== before) {
        return Math.round((performance.now() - t0) * 10) / 10
      }
      await new Promise(r => setTimeout(r, 2))
    }
    return -1
  })()`)
  switchTimes[label] = ms
}

const stalled = Object.entries(switchTimes).filter(([, ms]) => ms < 0)
const measuredSwitches = Object.values(switchTimes).filter((ms) => ms >= 0)
if (stalled.length > 0 || measuredSwitches.length === 0) {
  // Recorded as a failure rather than skipped. "Nothing could be measured" is
  // a result, and it is not a pass.
  console.error('Screens that never changed:', stalled.map(([k]) => k).join(', ') || '(all)')
  record(`screens measured (${navLabels.length - stalled.length}/${navLabels.length})`, stalled.length, 'stalled', 0)
}
if (measuredSwitches.length > 0) {
  record('slowest first-visit screen switch', Math.max(...measuredSwitches), 'ms', 400)
}

// Second visit: the chunk is cached, so this is pure render cost. Measured
// between two screens that both exist by name, and reported as unmeasurable
// rather than as a fast number if the click never lands.
const revisit = await evaluate(`(async () => {
  const items = [...document.querySelectorAll('.nav__item')]
  if (items.length < 2) return -1
  const first = items[0], second = items[items.length - 1]
  const main = document.querySelector('.main') || document.body
  first.click()
  await new Promise(r => setTimeout(r, 250))
  const before = main.textContent.slice(0, 400)
  const t0 = performance.now()
  second.click()
  const deadline = performance.now() + 2000
  while (performance.now() < deadline) {
    if (main.textContent.slice(0, 400) !== before) {
      return Math.round((performance.now() - t0) * 10) / 10
    }
    await new Promise(r => setTimeout(r, 2))
  }
  return -1
})()`)
if (revisit < 0) {
  console.error('Cached screen switch never completed — reporting as a failure, not a fast number.')
  record('cached screen switch', 'not measurable', '', null)
  results[results.length - 1].pass = false
} else {
  record('cached screen switch', revisit, 'ms', 150)
}

// --- typing latency -------------------------------------------------------
// Measured as the synchronous block each keystroke causes, plus any long task
// it spawns. Neither uses rAF, so neither can be poisoned by frame throttling.
await evaluate(`(() => { const n = document.querySelector('.nav__item'); if (n) n.click() })()`)
await new Promise((r) => setTimeout(r, 400))
const typing = await evaluate(`(async () => {
  const area = document.querySelector('textarea.textarea')
  if (!area) return null
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  const longTasks = []
  const po = new PerformanceObserver(l => { for (const e of l.getEntries()) longTasks.push(Math.round(e.duration)) })
  po.observe({ entryTypes: ['longtask'] })
  const blocks = []
  let text = ''
  for (let i = 0; i < 20; i++) {
    text += '提醒各位本周例会照常召开 '
    const t0 = performance.now()
    setValue.call(area, text)
    area.dispatchEvent(new Event('input', { bubbles: true }))
    blocks.push(performance.now() - t0)
    await new Promise(r => setTimeout(r, 30))
  }
  await new Promise(r => setTimeout(r, 500))
  po.disconnect()
  setValue.call(area, '')
  area.dispatchEvent(new Event('input', { bubbles: true }))
  return JSON.stringify({
    worstBlockMs: Math.round(Math.max(...blocks) * 10) / 10,
    medianBlockMs: Math.round(blocks.sort((a,b)=>a-b)[Math.floor(blocks.length/2)] * 10) / 10,
    longTasks,
  })
})()`)
if (typing) {
  const t = JSON.parse(typing)
  record('worst keystroke block', t.worstBlockMs, 'ms', 50)
  record('median keystroke block', t.medianBlockMs, 'ms', 16)
  record('long tasks while typing', t.longTasks.length, 'tasks', 0)
}

// --- scrolling a long list ------------------------------------------------
// The screens that hold real volume — a thousand log entries, hundreds of
// messages — were not measured at all before, and a list is where jank lives.
// Measured as the synchronous cost of each scroll step plus any long task it
// causes: no rAF, so frame throttling cannot fake a good number.
for (const label of navLabels) {
  const stats = await evaluate(`(async () => {
    const item = [...document.querySelectorAll('.nav__item')]
      .find(e => e.textContent.trim() === ${JSON.stringify(label)})
    if (!item) return null
    item.click()
    await new Promise(r => setTimeout(r, 350))

    // The element that actually scrolls, not its parent. Measuring the parent
    // is how an earlier probe got a constant zero out of a page that scrolls.
    const scroller = [...document.querySelectorAll('*')]
      .filter(el => {
        const s = getComputedStyle(el)
        return (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
               el.scrollHeight > el.clientHeight + 200
      })
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
    if (!scroller) return null

    const longTasks = []
    const po = new PerformanceObserver(l => { for (const e of l.getEntries()) longTasks.push(Math.round(e.duration)) })
    po.observe({ entryTypes: ['longtask'] })

    const blocks = []
    const step = Math.max(200, Math.floor(scroller.clientHeight * 0.9))
    for (let i = 0; i < 25 && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight; i++) {
      const t0 = performance.now()
      scroller.scrollTop += step
      // Force layout so the cost of the scroll is paid inside the measurement
      // rather than after it.
      void scroller.scrollHeight
      blocks.push(performance.now() - t0)
      await new Promise(r => setTimeout(r, 24))
    }
    await new Promise(r => setTimeout(r, 250))
    po.disconnect()
    if (blocks.length === 0) return null
    const sorted = [...blocks].sort((a, b) => a - b)
    return JSON.stringify({
      steps: blocks.length,
      rows: scroller.querySelectorAll('.log, .row, li, .msg').length,
      scrollHeight: Math.round(scroller.scrollHeight),
      medianMs: Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100,
      worstMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
      longTasks: longTasks.length,
      worstLongTaskMs: longTasks.length ? Math.max(...longTasks) : 0,
    })
  })()`)
  if (!stats) continue
  const s = JSON.parse(stats)
  // Only screens with something substantial to scroll are worth a verdict.
  if (s.scrollHeight < 1500) continue
  record(`scroll ${label} — worst block`, s.worstMs, 'ms', 50)
  record(`scroll ${label} — long tasks`, s.longTasks, 'tasks', 0)
  console.error(
    `  [scroll] ${label}: ${s.steps} steps over ${s.scrollHeight}px, ${s.rows} rows in DOM, ` +
      `median ${s.medianMs}ms worst ${s.worstMs}ms, ${s.longTasks} long task(s) worst ${s.worstLongTaskMs}ms`,
  )
}

// --- memory ---------------------------------------------------------------
const heap = await evaluate(`(() => {
  if (!performance.memory) return null
  return Math.round(performance.memory.usedJSHeapSize / 1048576)
})()`)
if (heap !== null) record('JS heap after touring every screen', heap, 'MB', 120)

// --- report ---------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n)
console.log('\nMeasured in the packaged app, real Electron window (not headless).\n')
console.log(`  ${pad('metric', 42)}${pad('measured', 14)}${pad('target', 12)}result`)
console.log(`  ${'-'.repeat(42)}${'-'.repeat(14)}${'-'.repeat(12)}------`)
for (const r of results) {
  const measured = r.unit ? `${r.value} ${r.unit}` : String(r.value)
  const target = r.target === null ? '—' : `≤ ${r.target} ${r.unit}`
  const verdict = r.pass === null ? '' : r.pass ? 'PASS' : 'FAIL'
  console.log(`  ${pad(r.name, 42)}${pad(measured, 14)}${pad(target, 12)}${verdict}`)
}
console.log('\n  per-screen first visit:', JSON.stringify(switchTimes))

const failed = results.filter((r) => r.pass === false)
console.log(failed.length === 0 ? '\nAll targets met.' : `\n${failed.length} target(s) missed.`)
clearTimeout(guard)
ws.close()
process.exit(failed.length === 0 ? 0 : 1)
