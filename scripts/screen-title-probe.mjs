/**
 * Two questions about every screen a phone can reach: does it repeat its own
 * name at you, and is every button on it wired to anything?
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
 *
 * ## The second question: 每个按钮应该有其的功能，而不是装饰
 *
 * A button that does nothing is invisible to every gate this repository has.
 * It compiles, it renders, it has the right size and the right contrast, it
 * passes `check:tap` because it is 44px, and it fails only when a person
 * presses it and nothing happens. That is precisely the shape of bug this
 * project keeps finding late.
 *
 * ### Why it does not click anything
 *
 * The obvious implementation — press every button and watch for a change — is
 * not available here and never will be. Some of these buttons send mail. Some
 * delete a contact. A gate whose method is "press everything" is a gate that
 * cannot be run on a machine with a real account on it, so it would be run on
 * a fixture, and a fixture is exactly where a real wiring bug hides.
 *
 * ### What it does instead
 *
 * It reads the handler off the element. React attaches the props of the fibre
 * that owns each host node to the node itself, under a `__reactProps$…` key,
 * and that object is the ground truth about what pressing this element would
 * call — not the source, not a guess from the class name. A `<button>` with no
 * `onClick`, no `onPointerDown`, no `onPointerUp`, no `form`, and no
 * `type="submit"` is a decoration, and this says so by name, position and
 * label.
 *
 * Three things are legitimately not wired and are not failures:
 *
 *   - `disabled` — a button that says it cannot be pressed is not lying.
 *   - `aria-disabled="true"` — same claim, made the accessible way for a
 *     control that must stay focusable.
 *   - an element inside a `<label>` or with a `form` attribute, where the
 *     browser supplies the behaviour and React has nothing to attach.
 *
 * And every button must be *nameable*: text, `aria-label` or `title`. A 44px
 * square with an icon in it and no accessible name is a button a screen reader
 * announces as "button", which is a decoration to anyone not looking at it.
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
/** What the tour is doing right now, so a timeout can say so. */
let step = 'starting up'

/*
 * Every call is bounded.
 *
 * A CDP request whose response never arrives — a renderer busy, a page that
 * navigated out from under an in-flight `Runtime.evaluate` — leaves a
 * top-level `await` unsettled, and Node's report for that is a line number and
 * nothing else. A rejection here says which method and which step, which is
 * the difference between a five-minute diagnosis and an afternoon.
 */
function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP ${method} did not answer within 20s (step: ${step})`))
    }, 20_000)
    /* Deliberately not `unref`'d. An unreferenced timer does not hold the event
       loop open, so with nothing else pending Node exits before it fires and
       reports "unsettled top-level await" — the exact unhelpful message this
       timeout exists to replace. */
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

/**
 * Every visible button on the screen, with what React would call and what a
 * screen reader would say.
 *
 * `offsetParent === null` skips a control inside a collapsed section — it is
 * not on screen, so it is not this screen's claim to make. Everything drawn is
 * fair game, including what a `VirtualList` has actually rendered.
 */
const BUTTON_SCAN = `(() => {
  const out = []
  const seen = new Set()
  document.querySelectorAll('button, [role="button"]').forEach((el) => {
    const b = el.getBoundingClientRect()
    if (b.width < 2 || b.height < 2) return
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return

    const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'))
    const props = key ? el[key] : null
    const wired = Boolean(
      props && (props.onClick || props.onPointerDown || props.onPointerUp || props.onMouseDown),
    )
    const excused =
      el.disabled === true ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.getAttribute('type') === 'submit' ||
      el.hasAttribute('form') ||
      el.closest('label') !== null

    const name = (
      (el.textContent || '').trim() ||
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      ''
    ).trim()

    /* One row per distinct control, not per rendered copy: a list of forty
       contacts has forty identical delete buttons, and forty lines saying the
       same thing would bury the one that is different. */
    const cls = String(el.className || '').slice(0, 40)
    const id = cls + '|' + name.slice(0, 20)
    if (seen.has(id)) return
    seen.add(id)

    out.push({
      cls,
      name: name.slice(0, 30),
      wired,
      excused,
      hasProps: Boolean(props),
      top: Math.round(b.top),
      left: Math.round(b.left),
    })
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

let buttonsSeen = 0
/** Every button either does something, says it cannot, or is a finding. */
function checkButtons(where, buttons) {
  buttonsSeen += buttons.length
  for (const b of buttons) {
    const named = b.name.length > 0
    if (!named) {
      fail(
        `${where}: a button at ${b.left},${b.top} (\`${b.cls}\`) has no text, no ` +
          `aria-label and no title — nothing announces what it does.`,
      )
      continue
    }
    if (b.excused) continue
    if (!b.hasProps) {
      fail(
        `${where}: button "${b.name}" (\`${b.cls}\`) carries no React props at all — ` +
          `it is not a rendered control, or the probe is reading the wrong node.`,
      )
      continue
    }
    if (!b.wired) {
      fail(
        `${where}: button "${b.name}" (\`${b.cls}\`) has no onClick, no pointer handler ` +
          `and is not disabled — pressing it does nothing.`,
      )
    }
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
  checkButtons(`tab ${tab.v}`, await evaluate(BUTTON_SCAN))
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
  checkButtons(`Home tile ${tile.v}`, await evaluate(BUTTON_SCAN))
}
notes.push(`${tiles.length} Home tiles`)

/*
 * The preview sheet, which is reached by a gesture and therefore by nothing
 * else in this tour. Held rather than clicked: `ARRANGE_HOLD_MS` is what
 * separates a tap from a hold, and a synthetic `pointerdown` with no matching
 * `pointerup` is exactly what a finger held down looks like to the handler.
 */
await evaluate(
  `(() => { const s = document.querySelector('.modal-scrim .modal__header .icon-btn'); if (s) s.click(); })(), true`,
)
await sleep(250)
await evaluate(`document.querySelector('.nav__item[data-view="home"]').click(), true`)
await sleep(400)
const firstTile = tiles.find((x) => x.v !== 'more')
if (firstTile) {
  await evaluate(
    `(async () => {
       const cell = document.querySelector('.homegrid__cell[data-view="${firstTile.v}"]')
       const r = cell.getBoundingClientRect()
       const at = { bubbles: true, pointerId: 5, pointerType: 'touch', clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
       cell.dispatchEvent(new PointerEvent('pointerdown', at))
       /* Past the hold threshold, then let go. The release is what a real hold
          does and is what endHold and unlessHeld are written against, so a
          press with no matching release would be testing a state no finger
          ever leaves the app in. (No backticks in here: this comment lives
          inside a template literal.) */
       await new Promise((done) => setTimeout(done, 800))
       cell.dispatchEvent(new PointerEvent('pointerup', at))
       /* And the click a browser fires after every pointerup, which the app
          swallows on purpose (unlessHeld) so a hold does not also open the
          destination. Skipping it leaves that flag armed, and the *next*
          genuine tap in the tour is the one that gets swallowed instead —
          which looked exactly like a broken tile. */
       cell.click()
     })()`,
  )
  await sleep(400)
  const sheet = await evaluate(`Boolean(document.querySelector('.tilesheet'))`)
  if (!sheet) {
    fail('Holding a Home tile did not open the preview sheet — the gesture is wired to nothing.')
  } else {
    checkButtons('tile preview sheet', await evaluate(BUTTON_SCAN))
    notes.push('the preview sheet a held tile opens')
  }
}

/* -------------------------------------------------------------------------
 * The back gesture — drag in from the leading edge of a full-screen sheet.
 *
 * Asserted here rather than in `check:gestures`, which owns the arithmetic in
 * `core/platform/gestures.ts` and tests it without a DOM. The arithmetic being
 * right is not the claim in question: the claim is that a finger arriving at
 * the left edge of a sheet reaches that arithmetic at all, past a pointer
 * capture, an axis lock and whatever else is listening. That is only true or
 * false in an engine.
 * ---------------------------------------------------------------------- */

step = 'closing the preview sheet'
await evaluate(
  `(() => { const s = document.querySelector('.tilesheet__x'); if (s) s.click(); })(), true`,
)
await sleep(250)
await evaluate(`document.querySelector('.nav__item[data-view="home"]').click(), true`)
await sleep(400)
const gestureTile = tiles.find((x) => x.v !== 'more')
if (gestureTile) {
  await evaluate(`document.querySelector('.homegrid__cell[data-view="${gestureTile.v}"]').click(), true`)
  await sleep(700)
  const opened = await evaluate(`Boolean(document.querySelector('.modal-scrim .modal'))`)
  if (!opened) {
    fail(`Could not open the ${gestureTile.v} sheet to test the back gesture.`)
  } else {
    const closed = await evaluate(`(async () => {
      const panel = document.querySelector('.modal-scrim .modal')
      const r = panel.getBoundingClientRect()
      const y = r.top + r.height / 2
      const send = (type, x, extra) => panel.dispatchEvent(new PointerEvent(type, {
        bubbles: true, pointerId: 7, pointerType: 'touch', clientX: x, clientY: y, ...extra,
      }))
      /* Starting 6px in, which is inside EDGE_ZONE_PX and outside "exactly 0",
         because a real thumb never lands on the pixel column. */
      send('pointerdown', r.left + 6)
      /* Several moves, not one: the axis has to lock before anything is
         captured, and a single jump from 6 to 300 is a gesture no finger makes
         and a shape the lock has never seen. */
      for (const dx of [20, 60, 120, 200, 300]) {
        send('pointermove', r.left + 6 + dx)
        await new Promise((r2) => setTimeout(r2, 16))
      }
      send('pointerup', r.left + 6 + 300)
      await new Promise((r2) => setTimeout(r2, 500))
      return !document.querySelector('.modal-scrim .modal')
    })()`)
    if (!closed) {
      fail(
        'Dragging in from the leading edge of a full-screen sheet did not close it — ' +
          'the back gesture is not reaching `useEdgeBack`.',
      )
    } else {
      notes.push('the back gesture on a full-screen sheet')
    }
  }
}

/* -------------------------------------------------------------------------
 * The tablet band — a list and the thing it opens, side by side.
 *
 * 800x1200 is a portrait tablet and sits inside `TWO_PANE_QUERY` (600–839).
 * The reload is not optional: `useTwoPane` is a `matchMedia` subscription, and
 * a window resized under a React tree that has already decided it is a phone
 * will update — but the tiles, the sheet and the scroll position all carry
 * state from the previous width, and measuring that is measuring the resize
 * rather than the layout.
 * ---------------------------------------------------------------------- */

step = 'switching to a 800x1200 tablet'
await send('Emulation.setDeviceMetricsOverride', {
  width: 800,
  height: 1200,
  deviceScaleFactor: 2,
  mobile: true,
})
await send('Page.reload', { ignoreCache: false })
for (let i = 0; i < 60; i += 1) {
  await sleep(250)
  if (await evaluate(`Boolean(document.querySelector('.shell .view'))`)) break
}
await sleep(700)

for (const screen of ['contacts', 'templates']) {
  await evaluate(`document.querySelector('.nav__item[data-view="home"]').click(), true`)
  await sleep(400)
  const cell = await evaluate(`Boolean(document.querySelector('.homegrid__cell[data-view="${screen}"]'))`)
  if (!cell) {
    /* Reachable from the grid's overflow rather than the grid itself, which is
       a legitimate arrangement and not this check's business. */
    await evaluate(`document.querySelector('.homegrid__cell[data-view="more"]').click(), true`)
    await sleep(500)
    const row = await evaluate(`Boolean(document.querySelector('.hometile[data-view="${screen}"]'))`)
    if (!row) {
      fail(`Could not reach ${screen} from Home at 800px to check the two-pane layout.`)
      continue
    }
    await evaluate(`document.querySelector('.hometile[data-view="${screen}"]').click(), true`)
  } else {
    await evaluate(`document.querySelector('.homegrid__cell[data-view="${screen}"]').click(), true`)
  }
  await sleep(800)

  const shape = await evaluate(`(() => {
    const view = document.querySelector('.view--${screen}')
    if (!view) return { found: false }
    const list = view.querySelector(':scope > .twopane__list')
    const detail = view.querySelector(':scope > .twopane__detail')
    const box = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { w: Math.round(r.width), left: Math.round(r.left) }
    }
    return {
      found: true,
      twopane: view.classList.contains('view--twopane'),
      list: box(list),
      detail: box(detail),
    }
  })()`)

  if (!shape.found) {
    fail(`At 800px the ${screen} screen did not render — nothing matched \`.view--${screen}\`.`)
    continue
  }
  if (!shape.twopane || !shape.list || !shape.detail) {
    fail(
      `At 800px the ${screen} screen is still one column — ` +
        `twopane=${shape.twopane}, list=${Boolean(shape.list)}, detail=${Boolean(shape.detail)}.`,
    )
    continue
  }
  /* Side by side, not stacked. Two boxes both starting at the same x are a
     column layout that happens to have two class names on it. */
  if (Math.abs(shape.list.left - shape.detail.left) < 40) {
    fail(
      `At 800px the ${screen} panes are stacked, not side by side ` +
        `(list at ${shape.list.left}, detail at ${shape.detail.left}).`,
    )
    continue
  }
  if (shape.detail.w < 200) {
    fail(`At 800px the ${screen} detail pane is only ${shape.detail.w}px wide — too narrow to edit in.`)
    continue
  }
  notes.push(`${screen}: ${shape.list.w}px list + ${shape.detail.w}px pane at 800px`)
}

/* Everything is measured; hand the window back before reporting. Down here and
   nowhere else — an earlier teardown closed the socket out from under the two
   sections above it, and every `evaluate` after it hung until the CDP timeout
   named the step. */
await send('Emulation.clearDeviceMetricsOverride')
ws.close()

console.log('')
console.log('check:screen-titles')
console.log('  no screen repeats the name of the control that opened it,')
console.log('  and every button on it is named and wired to something')
for (const n of notes) console.log(`  · ${n}`)
console.log(`  · ${buttonsSeen} distinct controls inspected`)
/*
 * A tour that inspected nothing is not a pass. `check-ui-consistency.mjs`
 * learned this the expensive way — "nothing was measured, so nothing was
 * checked" — and a selector rename here would otherwise turn this gate green
 * and silent in the same commit.
 */
if (buttonsSeen < 40) {
  console.log('')
  console.log(`  FAIL  only ${buttonsSeen} controls were found across the whole tour, which is`)
  console.log('        too few to be real — a selector has probably been renamed.')
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
