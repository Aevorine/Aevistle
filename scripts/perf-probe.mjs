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
const views = ['inbox', 'schedule', 'contacts', 'templates', 'logs', 'settings']
const switchTimes = {}
for (let i = 0; i < views.length; i++) {
  const ms = await evaluate(`(async () => {
    // Read the heading *before* switching. The first version compared against
    // null, so it matched on its first check and returned ~0.2 ms for screens
    // that had not switched yet — a number that measured nothing.
    const before = document.querySelector('.page-title')?.textContent ?? ''
    const t0 = performance.now()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '${i + 2}', ctrlKey: true, bubbles: true }))
    const deadline = performance.now() + 5000
    let changed = false
    while (performance.now() < deadline) {
      const h = document.querySelector('.page-title')
      if (h && h.textContent && h.textContent !== before) { changed = true; break }
      await new Promise(r => setTimeout(r, 2))
    }
    return changed ? Math.round((performance.now() - t0) * 10) / 10 : -1
  })()`)
  switchTimes[views[i]] = ms
}
const stalled = Object.entries(switchTimes).filter(([, ms]) => ms < 0)
if (stalled.length > 0) {
  console.error('Screens whose heading never changed:', stalled.map(([k]) => k).join(', '))
}
const worstSwitch = Math.max(...Object.values(switchTimes).filter((ms) => ms >= 0))
record('slowest first-visit screen switch', worstSwitch, 'ms', 400)

// Second visit: the chunk is cached, so this is pure render cost.
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true }))`)
const revisit = await evaluate(`(async () => {
  const t0 = performance.now()
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '6', ctrlKey: true, bubbles: true }))
  const deadline = performance.now() + 2000
  while (performance.now() < deadline) {
    if (document.querySelector('.listcontrols')) break
    await new Promise(r => setTimeout(r, 4))
  }
  return Math.round((performance.now() - t0) * 10) / 10
})()`)
record('cached screen switch', revisit, 'ms', 150)

// --- typing latency -------------------------------------------------------
// Measured as the synchronous block each keystroke causes, plus any long task
// it spawns. Neither uses rAF, so neither can be poisoned by frame throttling.
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true }))`)
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
