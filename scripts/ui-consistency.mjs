/**
 * Is the interface actually uniform, or does it only look uniform on the two
 * screens that were open when it was designed?
 *
 * "界面要统一" has been asked for five times, and every previous round answered
 * it by eye on one screen. This walks every view in the running app and
 * measures the properties that make a set of screens read as one product: card
 * radius and padding, section gaps, control heights, and the type sizes used
 * for the same *kind* of text.
 *
 * ===========================================================================
 * What changed, and why the previous version did not guard anything
 *
 * Two faults, and they compounded.
 *
 *   It was never run. Its header said "Run the app with
 *   `--remote-debugging-port=9445` first, exactly as `layout-probe.mjs` wants
 *   it" — and no `check:*` script pointed at this file, so the only way it ever
 *   executed was a developer typing two commands in the right order. It is the
 *   one script in `scripts/` whose stated subject is the exact complaint being
 *   made about this app, and it had never been part of the gate.
 *
 *   It could not fail. It ended `process.exit(0)`, unconditionally, after
 *   printing a count of "value(s) used once or twice — check each is
 *   deliberate". That is a report, and a report nobody is required to read is
 *   indistinguishable from silence.
 *
 * And the rule it printed was not a defect test either. `n <= 2 && top > 6`
 * flags any value used once or twice — which fires on the deliberate ones (the
 * one hero button on a screen, the one verification code) and stays quiet on a
 * genuine drift that happens to be used three times. It counted *rarity*, not
 * *wrongness*.
 *
 * ===========================================================================
 * What it asserts now
 *
 * Three rules, each of which names a defect rather than an oddity, and all
 * three read the ladder off the live `:root` rather than from numbers typed in
 * here — so they follow `--text-scale`, and they are correct in all seven
 * visual styles rather than only in the house one.
 *
 *   ladder    A control height, a corner radius or a gap must be one of the
 *             steps theme.css defines for it. This is the rule the control
 *             ladder comment already states — "which step a control gets is
 *             decided by what the control *is*" — and what it catches is the
 *             thing that comment was written about: seventeen distinct values
 *             in a 32px band, no two of which can be told apart alone.
 *
 *   unique    A selector that names one *role* must have one size. `.field__label`
 *             is the label above a field, everywhere; two different sizes for it
 *             is not a design decision, it is two people. This is the strongest
 *             rule here and it is deliberately not applied to `.btn`, which has
 *             three legitimate sizes on the ladder.
 *
 *   coverage  Every probe must have measured something. A rule computed over an
 *             empty set passes, and this repository has a recorded case of a
 *             floor asserted against a list that had no rows in it. The dev
 *             server has no mail account, so several screens really are empty —
 *             which makes "I measured nothing" the *likely* outcome here, not
 *             the unlikely one, and therefore the thing that has to be a
 *             failure rather than a note.
 *
 * Reaching a screen is also asserted. The old version printed `skip <view> — …`
 * and carried on, so a renamed nav id would have quietly reduced the tour to
 * whatever still worked while the summary line stayed the same shape.
 *
 * ===========================================================================
 * What it does not reach, stated
 *
 *   · One theme, one style, one width. It measures whatever the app opens in —
 *     the default light/aurora at the browser's own window size. A radius that
 *     is wrong only in `graphite`, or only under `@media (max-width: 599.98px)`,
 *     is outside this run. `check-visual-styles.mjs` and `layout-probe.mjs`
 *     cover those two axes respectively.
 *   · Only what is on screen. `getBoundingClientRect()` of a hidden element is
 *     0x0 and is skipped, deliberately — counting elements nobody sees would
 *     invent inconsistencies — so a dialog that is never opened is not measured.
 *   · Only the selectors in PROBES. It is a spot-check of ten properties, not a
 *     proof about the whole stylesheet.
 *
 * Run by `npm run check:ui`, which starts the app for it (`check-ui-consistency.mjs`).
 */

const PORT = Number(process.env.CDP_PORT ?? 9445)

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

/* A hard ceiling, so a wedged evaluate reports instead of hanging a build. */
const guard = setTimeout(() => {
  console.error('\nTimed out waiting for the app to answer.')
  process.exit(1)
}, 180_000)
guard.unref?.()

/** Wait for the app to mount, rather than for a stopwatch to say it probably has. */
async function waitForApp(ms = 40_000) {
  const until = Date.now() + ms
  for (;;) {
    const ready = await evaluate(
      `!!document.querySelector('.nav__item[data-view]') && !!document.querySelector('.view')`,
    )
    if (ready === true) return true
    if (Date.now() > until) return false
    await sleep(250)
  }
}
if (!(await waitForApp())) {
  console.error('The app never mounted — no .nav__item[data-view] and no .view after 40s.')
  process.exit(1)
}

/*
 * Pin the window to a desktop size before touring, and do not measure whatever
 * the tester happened to have open.
 *
 * Two reasons, and the first one is a bug this found on its first real run.
 * Headless Chrome opens at 800x600, which is under the 900px the shell uses to
 * decide it is a phone — so the sidebar collapsed to the five-tab bottom bar
 * (`nav.ts`: "Nine tabs do not fit across a 360px screen"), and the tour
 * reported `could not reach the schedule screen` for four of the nine views.
 * Half the application was unreachable and the old version of this file would
 * have printed `skip schedule — missing:…` and carried on to a clean summary.
 *
 * The second is repeatability: a check whose sample set is a function of the
 * developer's window size gives a different answer on two machines and cannot
 * be argued from. 1440x900 is the `expanded`/`large` band from theme.css's
 * breakpoint note — side rail, two panes, every nav item present.
 *
 * The consequence is stated in this file's header: what is checked is *this*
 * width. The narrow-shell geometry is `layout-probe.mjs`'s subject and is
 * measured there, at 360 and 820, against its own requirements.
 */
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(600)

/**
 * What is being measured, where, and what makes a value wrong.
 *
 * `rule`:
 *   ladder(...tokens)  every distinct value must resolve to one of these
 *                      custom properties, read off the live :root
 *   spacing            every length in the value must be 0 or one of --sp-*
 *   unique             exactly one distinct value across the whole tour
 *
 * `min` is the number of elements that must be measured for the rule to mean
 * anything. Set from what a tour of the dev server (no mail account) actually
 * finds, so it is a floor on coverage rather than an aspiration.
 */
const PROBES = [
  ['card radius', '.card', 'borderRadius', { rule: 'ladder', tokens: ['--r-xs', '--r-sm', '--r-md', '--r-lg', '--r-xl'], min: 5 }],
  ['card body padding', '.card__body', 'padding', { rule: 'spacing', min: 5 }],
  ['section gap', '.card__body', 'gap', { rule: 'spacing', min: 5 }],
  ['input height', '.input', 'height', { rule: 'ladder', tokens: ['--ctl-xs', '--ctl-sm', '--ctl-md', '--ctl-lg'], min: 3 }],
  ['button height', '.btn', 'height', { rule: 'ladder', tokens: ['--ctl-xs', '--ctl-sm', '--ctl-md', '--ctl-lg'], min: 10 }],
  ['field label size', '.field__label', 'fontSize', { rule: 'unique', min: 3 }],
  ['page title size', '.page-title', 'fontSize', { rule: 'unique', min: 3 }],
  ['section label size', '.section-label', 'fontSize', { rule: 'unique', min: 3 }],
  ['hint size', '.field__hint', 'fontSize', { rule: 'unique', min: 2 }],
  ['chip radius', '.chip', 'borderRadius', { rule: 'ladder', tokens: ['--r-xs', '--r-sm', '--r-md', '--r-full'], min: 2 }],
]

/* Every screen in `src/core/nav.ts`, not a subset. The previous list held seven
   of the ten and had no way to notice; `home`, `codes` and `workcal` were all
   missing, and `codes` is the screen carrying the app's one deliberately-
   outsized value, which is precisely the screen a uniformity check must
   include rather than skip. The sidebar is cross-checked against this below, so
   an eleventh cannot be added without this file noticing.

   `home` is the one that is not a `.nav__item`, and it is toured last for that
   reason. It is a footer `IconButton` in the sidebar (App.tsx:721) rather than
   one of the nine numbered tabs — the comment there explains why a doorway does
   not take a numbered slot — so CUSTOM_NAV below reaches it positionally. */
const VIEWS = ['compose', 'codes', 'inbox', 'schedule', 'contacts', 'templates', 'workcal', 'logs', 'settings', 'home']

/**
 * Views reached by something other than `.nav__item[data-view]`, as a click
 * expression that must return `'ok'`.
 *
 * There is exactly one, and it is reached by position because it has nothing
 * else to be reached by: the sidebar's two footer buttons are a bare
 * `IconButton` each, with no `data-view`, no id, and an `aria-label` that is
 * the *translated* string (「主页」in the locale this runs in) — matching which
 * would tie this file to a language table. The two are home then collapse, in
 * that order, and they are the only `.icon-btn`s outside `.view`.
 *
 * Positional selectors rot, so this one is not trusted: the tour asserts which
 * screen it actually arrived at immediately after every click, including this
 * one. If the footer gains a third button, this clicks the wrong thing and the
 * next line reports `clicked home but the screen on display is "…"` rather than
 * measuring the wrong screen and calling it uniform.
 */
const CUSTOM_NAV = {
  home: `(() => {
     const btn = [...document.querySelectorAll('button.icon-btn')].filter((b) => !b.closest('.view'))[0]
     if (!btn) return 'missing:no shell .icon-btn to reach Home with'
     btn.click()
     return 'ok'
   })()`,
}

/** The ladder, resolved from the live root — so this follows --text-scale and the active style. */
const ladder = JSON.parse(
  await evaluate(`(() => {
    const cs = getComputedStyle(document.documentElement)
    const out = {}
    for (const n of ['--r-xs','--r-sm','--r-md','--r-lg','--r-xl','--r-full',
                     '--ctl-xs','--ctl-sm','--ctl-md','--ctl-lg',
                     '--sp-1','--sp-2','--sp-3','--sp-4','--sp-5','--sp-6','--sp-8','--sp-10','--sp-12','--sp-16']) {
      const raw = cs.getPropertyValue(n).trim()
      // rem values have to be resolved against the root font size, which is
      // what --text-scale moves. A literal parseFloat of "1rem" is 1.
      const px = raw.endsWith('rem')
        ? parseFloat(raw) * parseFloat(getComputedStyle(document.documentElement).fontSize)
        : parseFloat(raw)
      out[n] = Math.round(px * 100) / 100
    }
    return JSON.stringify(out)
  })()`),
)

const collect = `(() => {
  const out = {}
  for (const [label, selector, prop] of ${JSON.stringify(PROBES.map((p) => [p[0], p[1], p[2]]))}) {
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
const whereSeen = {}
const failures = []
const fail = (m) => {
  failures.push(m)
  console.log(`  FAIL  ${m}`)
}

const navIds = JSON.parse(
  await evaluate(
    `JSON.stringify([...new Set([...document.querySelectorAll('.nav__item[data-view]')].map((b) => b.dataset.view))])`,
  ),
)
const unknown = navIds.filter((v) => !VIEWS.includes(v))
if (unknown.length) {
  fail(`the sidebar has view(s) this check does not tour: ${unknown.join(', ')} — add them to VIEWS`)
}

for (const view of VIEWS) {
  // The shell listens for this on the nav buttons; clicking by label would
  // depend on the current locale.
  const went = await evaluate(
    CUSTOM_NAV[view] ??
      `(() => {
    const all = [...document.querySelectorAll('.nav__item')]
    const target = all.find((b) => (b.dataset.view ?? '') === ${JSON.stringify(view)})
    if (!target) return 'missing:' + all.map((b) => b.dataset.view ?? '?').join(',')
    target.click()
    return 'ok'
  })()`,
  )
  if (went !== 'ok') {
    // A failure, not a skip. A view that cannot be reached is a view that was
    // not measured, and the summary must not read the same either way.
    fail(`could not reach the ${view} screen — ${went}`)
    continue
  }
  /*
   * Confirm arrival, do not assume it — and wait for it rather than sleep a
   * guess.
   *
   * A click that lands on nothing leaves the previous screen on display, and
   * this loop would then measure that screen ten times and report a
   * beautifully uniform interface. That is the exact shape of the failures
   * this repository keeps recording, and it costs one CDP call to rule out.
   *
   * The signal is `aria-current="page"`, not `.view[data-screen]`. Only two
   * screens stamp `data-screen` — `CodesView` and `InboxView`, both of which
   * added it for `layout-probe.mjs` — so an arrival check written against it
   * reports "unknown" for the other eight, which is what the first version of
   * this check did. `aria-current` is set by the shell for every tab and by the
   * Home button for itself, and it is an accessibility attribute rather than a
   * test hook, so it is maintained for its own reasons.
   *
   * Polled for up to 8s because every screen but Compose is a lazily-loaded
   * chunk: on a cold, unbundled dev server the click resolves to a Suspense
   * skeleton first, and a flat 500ms sleep measures the skeleton. `.view` and a
   * non-empty `.view__inner` are required alongside the attribute so a
   * half-mounted screen does not count as arrival.
   */
  const arrivalCheck = `(() => {
    if (!document.querySelector('.view')) return 'no-view'
    const tab = document.querySelector('.nav__item[aria-current="page"]')
    if (tab) return tab.dataset.view ?? 'unknown'
    if (document.querySelector('button.icon-btn[aria-current="page"]')) return 'home'
    return 'unknown'
  })()`
  let arrived = 'unknown'
  for (let i = 0; i < 32; i += 1) {
    arrived = await evaluate(arrivalCheck)
    if (arrived === view) break
    await sleep(250)
  }
  if (arrived !== view) {
    fail(`clicked ${view} but the screen on display is "${arrived}" — nothing was measured for ${view}`)
    continue
  }
  // React has to finish rendering before anything is measured. Six views once
  // reported an identical number because they were all measured before the
  // first re-paint.
  await sleep(600)
  const raw = JSON.parse(await evaluate(collect))
  for (const [label, seen] of Object.entries(raw)) {
    totals[label] ??= {}
    whereSeen[label] ??= {}
    for (const [value, n] of Object.entries(seen)) {
      totals[label][value] = (totals[label][value] ?? 0) + n
      ;(whereSeen[label][value] ??= new Set()).add(view)
    }
  }
}

/* ---- the rules ---- */

const px = (s) => parseFloat(s)
const TOL = 0.75 // a border and a rounded line box are worth a fraction of a pixel, not a step

const onLadder = (value, tokens) =>
  tokens.some((t) => ladder[t] !== undefined && Math.abs(px(value) - ladder[t]) <= TOL)

const SPACING = Object.entries(ladder).filter(([k]) => k.startsWith('--sp-'))
const isSpacingStep = (one) => {
  const n = parseFloat(one)
  if (!Number.isFinite(n)) return true // `normal`, `auto` — not a length, not this rule's business
  if (Math.abs(n) <= TOL) return true // 0
  return SPACING.some(([, v]) => Math.abs(n - v) <= TOL)
}

/**
 * Collisions that already existed when this check was first switched on.
 *
 * Listed rather than absorbed by widening a rule, so the gate fails on the
 * next one. Key is `probe label | value`. An entry that stops matching is
 * reported as STALE and fails — a baseline nobody prunes is how a gate that
 * was just repaired goes back to sleep.
 */
const BASELINE = new Map([])

const seenBaseline = new Set()
const stateOf = (key) => {
  if (BASELINE.has(key)) {
    seenBaseline.add(key)
    return 'baselined'
  }
  return 'live'
}

console.log('')
for (const [label, selector, , rule] of PROBES) {
  const seen = totals[label] ?? {}
  const entries = Object.entries(seen).sort((a, b) => b[1] - a[1])
  const count = entries.reduce((n, [, c]) => n + c, 0)
  const line = entries.map(([v, n]) => `${v}×${n}`).join('  ') || '(nothing)'

  // coverage first: every rule below is vacuous without it.
  if (count < rule.min) {
    fail(
      `${label}: only ${count} element(s) matched \`${selector}\` across the whole tour, under the ` +
        `minimum of ${rule.min}. Nothing was measured, so nothing was checked — this is not a pass.`,
    )
    console.log(`        ${label.padEnd(20)} ${line}`)
    continue
  }

  const bad = []
  if (rule.rule === 'ladder') {
    for (const [v] of entries) if (!onLadder(v, rule.tokens)) bad.push(v)
  } else if (rule.rule === 'spacing') {
    for (const [v] of entries) if (!v.split(/\s+/).every(isSpacingStep)) bad.push(v)
  } else if (rule.rule === 'unique') {
    if (entries.length > 1) bad.push(...entries.slice(1).map(([v]) => v))
  }

  const live = bad.filter((v) => stateOf(`${label}|${v}`) === 'live')
  const known = bad.filter((v) => BASELINE.has(`${label}|${v}`))

  if (live.length === 0) {
    console.log(`  ok   ${label.padEnd(20)} ${line}${known.length ? `   [${known.length} baselined]` : ''}`)
  } else {
    console.log(`  FAIL ${label.padEnd(20)} ${line}`)
    for (const v of live) {
      const where = [...(whereSeen[label]?.[v] ?? [])].join(', ')
      if (rule.rule === 'unique') {
        fail(
          `${label}: \`${selector}\` renders at ${entries[0][0]} on most screens and at ${v} on ${where}. ` +
            `One selector, one role, one size.`,
        )
      } else if (rule.rule === 'spacing') {
        fail(`${label}: \`${selector}\` is ${v} on ${where}, which is not on the --sp-* ladder.`)
      } else {
        fail(
          `${label}: \`${selector}\` is ${v} on ${where}, which is not one of ` +
            `${rule.tokens.map((t) => `${t}=${ladder[t]}px`).join(' / ')}.`,
        )
      }
    }
  }
}

const stale = [...BASELINE.keys()].filter((k) => !seenBaseline.has(k))
if (stale.length) {
  console.log(`\n  ${stale.length} baseline entr${stale.length === 1 ? 'y' : 'ies'} no longer match anything:`)
  for (const k of stale) console.log(`    STALE  ${k}`)
  console.log('  Delete them from BASELINE in scripts/ui-consistency.mjs and this goes green.')
}

console.log('')
console.log(
  failures.length === 0 && stale.length === 0
    ? `  PASS — ${PROBES.length} properties across ${VIEWS.length} screens, every value on its ladder.`
    : `  FAIL — ${failures.length} problem(s)${stale.length ? ` and ${stale.length} stale baseline entr${stale.length === 1 ? 'y' : 'ies'}` : ''}`,
)

await send('Emulation.clearDeviceMetricsOverride')
ws.close()
clearTimeout(guard)
process.exit(failures.length > 0 || stale.length > 0 ? 1 : 0)
