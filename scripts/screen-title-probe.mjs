/**
 * Does any screen print its own name back at the user?
 *
 * The rule this asserts is one line long: *the control you pressed already
 * said where you were going, so the destination does not say it again.* It is
 * the reason `PageHead` has `hideTitle` and every view passes it — and it was
 * being broken anyway, on a phone, by a component nobody thought of as a
 * heading. `HomeView` opens the eleven screens that are not bottom-bar tabs
 * inside a full-screen `Modal`, and `Modal` drew `title` — which is
 * `labelOf(open)`, the text on the tile just pressed — at the top-left of
 * every one of them. Source review could not have caught it: every `PageHead`
 * in the app was already correct.
 *
 * So this asks the running app instead. It tours a phone-sized window through
 * every bottom-bar tab and every Home tile, and fails if the name of the thing
 * just pressed is drawn anywhere in the top band of the screen it opened.
 *
 * Not run by hand: `check-screen-titles.mjs` starts Vite and headless Chrome
 * around it, the same way `check-layout.mjs` and `check-ui-consistency.mjs` do.
 *
 * What it deliberately does not check: the *word* appearing anywhere on the
 * screen. 定时任务 is a legitimate string inside the schedule screen's own
 * empty state. The claim is narrower and is about position — the corner, the
 * first band, where a heading goes.
 */

const PORT = process.env.CDP_PORT ?? '9445'

/** The band a heading would occupy. Below this is content, and content may say anything. */
const HEAD_BAND_PX = 60

const failures = []
const notes = []
function fail(msg) {
  failures.push(msg)
}

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
    throw new Error(res.result.exceptionDetails.exception?.description ?? 'evaluate failed')
  }
  return res.result?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* A phone, because that is where the space costs most and where the eleven
   Home screens are the only way in. `mobile: true` so the same media queries
   the device resolves are the ones measured. */
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
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
  console.error('The app never mounted — no .shell .view after 15s.')
  process.exit(1)
}
await sleep(600)

/**
 * Every visible run of text whose own box starts inside the head band.
 *
 * `childNodes` text only, so a wrapper is not credited with its children's
 * words; `getComputedStyle` so the clipped `.sr-only` heading — which is still
 * laid out, deliberately — is excluded by its 1px box rather than by a class
 * name this check would then be coupled to.
 */
const bandScan = (band) => `(() => {
  const out = []
  document.querySelectorAll('*').forEach((c) => {
    const own = [...c.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('').trim()
    if (!own) return
    const b = c.getBoundingClientRect()
    if (b.width < 2 || b.height < 2) return
    if (b.top < -4 || b.top > ${band}) return
    const s = getComputedStyle(c)
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return
    out.push({ cls: String(c.className || c.tagName).slice(0, 60), txt: own, top: Math.round(b.top), left: Math.round(b.left) })
  })
  return out
})()`

/** The name the user pressed, and the name the screen drew — same string is the failure. */
function checkBand(where, label, band) {
  const hit = band.find((e) => e.txt === label)
  if (hit) {
    fail(
      `${where}: the screen draws its own name "${label}" at ${hit.top}px from the top ` +
        `(\`${hit.cls}\`) — the control that opened it already said that word.`,
    )
  }
}

const tabs = JSON.parse(
  await evaluate(
    `JSON.stringify([...document.querySelectorAll('.nav__item[data-view]')].map((b) => ({ v: b.dataset.view, label: b.textContent.trim() })))`,
  ),
)
if (tabs.length === 0) {
  console.error('No bottom-bar tabs found — the tour has nothing to walk.')
  process.exit(1)
}

for (const tab of tabs) {
  await evaluate(`document.querySelector('.nav__item[data-view="${tab.v}"]').click(), true`)
  await sleep(550)
  checkBand(`tab ${tab.v}`, tab.label, await evaluate(bandScan(HEAD_BAND_PX)))
}
notes.push(`${tabs.length} bottom-bar tabs`)

await evaluate(`document.querySelector('.nav__item[data-view="home"]').click(), true`)
await sleep(500)
const tiles = JSON.parse(
  await evaluate(
    `JSON.stringify([...document.querySelectorAll('.homegrid__cell[data-view]')].map((b) => ({ v: b.dataset.view, label: b.textContent.trim() })))`,
  ),
)
if (tiles.length === 0) {
  console.error('No Home tiles found — this check exists for the screens behind them.')
  process.exit(1)
}

for (const tile of tiles) {
  await evaluate(
    `(() => { const s = document.querySelector('.modal-scrim .modal__header .icon-btn'); if (s) s.click(); })(), true`,
  )
  await sleep(250)
  await evaluate(`document.querySelector('.nav__item[data-view="home"]').click(), true`)
  await sleep(350)
  const cell = await evaluate(
    `Boolean(document.querySelector('.homegrid__cell[data-view="${tile.v}"]'))`,
  )
  if (!cell) {
    fail(`Home tile ${tile.v} vanished between being listed and being pressed.`)
    continue
  }
  await evaluate(`document.querySelector('.homegrid__cell[data-view="${tile.v}"]').click(), true`)
  await sleep(700)
  checkBand(`Home tile ${tile.v}`, tile.label, await evaluate(bandScan(HEAD_BAND_PX)))
}
notes.push(`${tiles.length} Home tiles`)

await send('Emulation.clearDeviceMetricsOverride')
ws.close()

console.log('')
console.log('check:screen-titles — no screen repeats the name of the control that opened it')
for (const n of notes) console.log(`  · ${n}`)
if (failures.length > 0) {
  console.log('')
  for (const f of failures) console.log(`  FAIL  ${f}`)
  console.log('')
  console.log(`  ${failures.length} screen(s) print their own name back at the user.`)
  process.exit(1)
}
console.log('')
console.log('  All clear.')
process.exit(0)
