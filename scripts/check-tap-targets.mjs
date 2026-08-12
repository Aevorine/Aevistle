/**
 * Walks every screen of the running app at five device sizes and measures
 * every control on each.
 *
 * Reading the stylesheet cannot answer this. A control's rendered height is the
 * result of a cascade the source does not show you — this round found a send
 * button at 50px where `--control-h` said 48 (a `font` shorthand three files
 * away had reset its line-height), a chip cross declared at both 16px and 24px
 * in two places that both matched, and a `.markup__toggle` at 22px whose 48px
 * floor lived behind `@media (any-pointer: coarse)` and had therefore never run
 * on any machine anyone had checked it on. None of those is visible in CSS.
 * All three are visible in `getBoundingClientRect`.
 *
 * What it enforces:
 *
 *   1. no control below 44px in any direction on a touch shell
 *   2. one kind of control, one height (a `.btn` is a `.btn` on every screen)
 *   3. one type size per kind of text (a label is a label on every screen)
 *
 * 2 and 3 are pooled across every screen at a viewport, not asserted per
 * screen. That is the whole point: screens that are each internally tidy but
 * disagree with one another is exactly the complaint, and a per-screen
 * assertion cannot see it.
 *
 * Rule 2 used to be "no more than 4 distinct control heights at any one size",
 * counted globally. That was dropped because it measures the wrong thing in
 * both directions.
 *
 * It reports false defects. `--ctl-*` is in px and deliberately does not scale
 * with the text-size setting, but control *content* does, so at the largest
 * text setting every control with a `min-height` and growable content
 * legitimately grows past its floor. Measured on Home: 48/56/88 at standard
 * scale, 48/64/97 at `larger`. Nothing drifted — a stat tile with a 20px figure
 * in it is simply taller when the figure is 25px — but a global count sees
 * three new numbers and fails.
 *
 * And it misses real ones. The defects this project has actually shipped are a
 * spread *within one kind of thing* — "a 50px button in a row of 48s", "a label
 * one rank smaller than its four siblings" — and a global count is blind to
 * kind. Eleven heights on the laptop is not a number anyone can act on; `.btn`
 * rendering at two heights is. The per-kind rule is the stricter of the two: it
 * fails a two-value spread inside one kind that a ceiling of 4 would wave
 * through.
 *
 * It needs a dev server, and it starts its own: a free port is picked, `npx
 * vite` is spawned on it, the measurements run against that, and the server is
 * torn down in a `finally` whether they passed or not. This used to say a
 * wrapper started one — nothing did. `npm run check:tap` was a bare `node
 * scripts/check-tap-targets.mjs` with no pre-script, and the URL it aimed at
 * (127.0.0.1:5199) was not the port `vite.config.ts` binds (5273), so even a
 * dev server running by hand in another terminal would not have been hit. The
 * gate had therefore never once measured this app, through the whole of the
 * round it was written for. Set `CHECK_URL` to point it at an already-running
 * server instead; then no server is spawned.
 *
 * Run by `npm run check:tap`, and part of `npm run check`.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'

/*
 * Resolved out of `tests/`, which carries its own dependency island so the root
 * lockfile stays still (see the note in .gitignore). Playwright is a ~300MB
 * install with browser binaries; it is a test dependency, not a build one, and
 * this script is the only thing outside `tests/` that needs it.
 *
 * A fresh clone has not run `npm run e2e:install` yet, and this script is in
 * the `npm run check` chain — so a missing Playwright skips loudly rather than
 * failing, which would leave the whole chain permanently red on any machine
 * that has not opted into the test island.
 */
import { createRequire } from 'node:module'
const require = createRequire(new URL('../tests/package.json', import.meta.url))
let chromium
try {
  ;({ chromium } = require('playwright'))
} catch {
  console.log('\n  SKIPPED — playwright is not installed in tests/.')
  console.log('  This gate measures real rendered controls and cannot run without it.')
  console.log('  Run `npm run e2e:install` to turn it on.\n')
  process.exit(0)
}

/** An unused port, picked rather than hard-coded, so a dev server the developer already has open is never collided with. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** Strip the ANSI color codes Vite wraps its port number in — otherwise `\x1B[1m` sits between the colon and the digits. */
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '')
}

/** Parse the port Vite actually bound — `strictPort` is off, so it can differ from the one asked for under contention. */
function waitForVitePort(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('Vite dev server did not report a URL in time')), timeoutMs)
    const onData = (chunk) => {
      buf += stripAnsi(chunk.toString('utf8'))
      const m = /Local:\s+https?:\/\/[^:]+:(\d+)/.exec(buf)
      if (m) {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        resolve(Number(m[1]))
      }
    }
    child.stdout.on('data', onData)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Vite dev server exited early (code ${code})`))
    })
  })
}

/** Wait for a URL to answer, polling rather than sleeping a fixed guess. */
async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

/** Kill a whole process tree — a plain `child.kill()` leaves Vite's child processes behind, on Windows especially. */
function killTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'])
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

/** The sizes this app is actually used at, not a sweep. */
const SIZES = [
  { name: 'phone portrait', width: 360, height: 800, touch: true },
  { name: 'phone landscape', width: 800, height: 360, touch: true },
  { name: 'tablet portrait', width: 768, height: 1024, touch: true },
  { name: 'laptop', width: 1024, height: 768, touch: false },
  /*
   * The large-text setting, on the size that has least room for it.
   *
   * `textScale: larger` moves the root font-size to 125%, and the whole type
   * and spacing scale is in `rem`, so every control on this screen grows at
   * once. That is the intent — but it is also exactly the condition under
   * which a row that fitted stops fitting, and the setting has no other guard.
   * Measured here rather than assumed: a 48px button becomes 50px and stops,
   * which is what the four-height ceiling below is checking.
   */
  { name: 'phone, largest text', width: 360, height: 800, touch: true, textScale: 'larger' },
]

const MIN_TAP = 44
/**
 * How far apart two instances of the same kind may render before it counts.
 *
 * 2px, because a height is `Math.round`ed off a fractional
 * `getBoundingClientRect`, and the type scale is in `rem` — at the 125% text
 * setting a control's box can land on a .5 boundary and round in opposite
 * directions on two screens. That is worth 1px each way and no more. Anything
 * above 2px is a real difference in the stylesheet: the defects this project
 * has actually shipped were 50-vs-48 and 22-vs-48, both of which this catches.
 */
const HEIGHT_TOLERANCE = 2

/** What counts as a control. Passed into the page rather than duplicated there,
    so the "has this screen finished rendering" wait and the measurement itself
    can never drift apart. */
const CONTROL_SELECTOR =
  'button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=tab],[role=checkbox],[role=switch]'

/** Runs inside the page. Written as a function, not a string: Playwright
    evaluates a string as an *expression*, so a stringified arrow returns the
    arrow rather than calling it. */
const MEASURE = (CONTROL) => {
  /*
   * What kind of control this is, in the stylesheet's own vocabulary.
   *
   * The class lists here are BEM-ish — `btn btn--ghost btn--icon composeacts__x`,
   * `icon-btn page-head__search`, `textarea textarea--body` — so the first token
   * that is not a `--` modifier is the block, and the block is the kind. That
   * deliberately folds every modifier of a block together: `btn--lg` and
   * `btn--primary` are both `.btn` and are both expected to sit on the same rung
   * of the control ladder, which is the thing being asserted.
   *
   * Falling back through form tag, then role, then `other` means a control can
   * never be silently dropped — and `other` is counted and printed rather than
   * quietly ignored.
   */
  const kindOf = (el, cls) => {
    const block = cls.split(/\s+/).filter(Boolean).find((t) => !t.includes('--'))
    if (block) return block
    const tag = el.tagName.toLowerCase()
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return tag
    const role = el.getAttribute('role')
    if (role) return `role=${role}`
    return 'other'
  }
  const rows = []
  for (const el of document.querySelectorAll(CONTROL)) {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    if (getComputedStyle(el).visibility === 'hidden') continue
    const cls = typeof el.className === 'string' ? el.className : ''
    rows.push({
      cls: cls || el.tagName.toLowerCase(),
      kind: kindOf(el, cls),
      w: Math.round(r.width), h: Math.round(r.height),
      inline: getComputedStyle(el).display === 'inline',
    })
  }
  const kind = (label, sel) => {
    const set = new Set()
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect(); if (r.height < 1) continue
      set.add(getComputedStyle(el).fontSize)
    }
    return [label, [...set]]
  }
  return {
    shell: document.documentElement.getAttribute('data-shell'),
    rootFontSize: getComputedStyle(document.documentElement).fontSize,
    sizeClass: document.documentElement.getAttribute('data-size-class'),
    controls: rows,
    kinds: [
      kind('field label', '.field__label'),
      kind('button text', '.btn'),
      kind('input text', 'input.input, .select, .textarea'),
      kind('card title', '.card__title'),
    ].filter(([, v]) => v.length),
  }
}

/**
 * Every screen at one viewport, not just the one the app happens to open on.
 *
 * This is the difference between the gate working and the gate being theatre.
 * Measuring only the landing screen (Compose) saw 13 controls and exactly one
 * `.field__label`, one `.textarea` and zero `.card__title` — and "this one
 * element renders at one size" is a check that cannot fail. Home, Inbox,
 * Settings and the rest were never loaded at all, which is precisely where
 * 界面不统一 was being reported from.
 *
 * `.nav__item` is the one selector that holds at every width (5 tabs on a
 * phone, 9 in the desktop rail), and the active one carries `aria-current`, so
 * walking it needs no per-screen knowledge and stays correct as tabs are added.
 */
/**
 * Wait for a freshly-clicked screen to stop moving before measuring it.
 *
 * Getting this wrong does not make the gate fail — it makes it *pass*, which
 * is far worse. Routes are lazily loaded, so under a dev server the click
 * commits the route (the tab takes `aria-current`) while the chunk is still in
 * flight and Suspense is showing a fallback with no controls in it. A flat
 * 250ms wait measured four of the five phone screens as "nav bar only" and
 * reported All clear; the same screens carry 9, 19, 5 and 18 controls once
 * they arrive.
 *
 * So: let the chunk request start, wait for the network to go quiet, then poll
 * until the control geometry is byte-identical three times running. An empty
 * screen is a legitimate stable state (the Inbox tab really is nav-bar-only on
 * mobile), which is why this waits for *stillness* rather than for content.
 */
async function settleScreen(page) {
  // A floor, so stillness is never sampled before the lazy chunk is even asked for.
  await page.waitForTimeout(400)
  await page.waitForLoadState('networkidle').catch(() => {})
  const signature = () =>
    page.evaluate(
      (sel) =>
        [...document.querySelectorAll(sel)]
          .map((el) => {
            const r = el.getBoundingClientRect()
            return `${Math.round(r.width)}x${Math.round(r.height)}`
          })
          .join(','),
      CONTROL_SELECTOR,
    )
  const deadline = Date.now() + 10_000
  let last = null
  let stable = 0
  while (Date.now() < deadline) {
    const now = await signature()
    if (now === last) {
      stable += 1
      if (stable >= 3) return
    } else {
      stable = 0
      last = now
    }
    await page.waitForTimeout(200)
  }
}

async function measureScreens(page) {
  const screens = []
  const count = await page.locator('.nav__item').count()
  for (let i = 0; i < count; i += 1) {
    const item = page.locator('.nav__item').nth(i)
    // `innerText` is empty for a label the layout has visually collapsed (the
    // phone-landscape rail does this), so fall back to textContent rather than
    // reporting every violation against an unhelpful "tab 3".
    let name = `tab ${i + 1}`
    try {
      const raw = await item.evaluate((el) => (el.innerText || el.textContent || '').trim())
      name = raw.split('\n')[0].trim() || name
      await item.click({ timeout: 5000 })
      await settleScreen(page)
    } catch {
      // A tab that will not open is a finding of a different kind — record the
      // screen as unreachable rather than losing the whole viewport to it.
      screens.push({ name, unreachable: true })
      continue
    }
    screens.push({ name, m: await page.evaluate(MEASURE, CONTROL_SELECTOR) })
  }
  return screens
}

/** The measurements themselves. Separated from the server plumbing so the
    `CHECK_URL` path and the spawned-server path run identically. */
async function measureAll(target) {
  const browser = await chromium.launch()
  const problems = []
  const report = []

  try {
    for (const size of SIZES) {
      const page = await browser.newPage({
        viewport: { width: size.width, height: size.height },
        hasTouch: size.touch,
        isMobile: size.touch,
      })
      await page.goto(target, { waitUntil: 'networkidle' })
      // The shell writes data-shell / data-size-class in an effect; wait for it.
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-size-class'), null, { timeout: 5000 })
      if (size.textScale) {
        // Set directly rather than through Settings: this is a check of the
        // stylesheet's behaviour at that scale, not of the switch that sets it.
        await page.evaluate((v) => document.documentElement.setAttribute('data-text-scale', v), size.textScale)
        await page.waitForTimeout(120)
      }

      const screens = await measureScreens(page)
      const reached = screens.filter((s) => !s.unreachable)
      if (!reached.length) throw new Error(`${size.name}: no screen could be measured`)
      const head = reached[0].m

      report.push(`  ${size.name.padEnd(19)} ${String(size.width + 'x' + size.height).padEnd(10)} ` +
        `shell=${String(head.shell ?? '-').padEnd(7)} class=${String(head.sizeClass).padEnd(9)} root=${String(head.rootFontSize).padEnd(5)} ` +
        `${reached.length} screens`)

      // Heights and type sizes are pooled across every screen at this viewport,
      // which is what "one kind of X, one size" actually means: the screens have
      // to agree with *each other*, not merely be internally consistent one at
      // a time.
      const byKind = new Map()
      const tooSmall = new Map()
      const kinds = new Map()
      let otherCount = 0

      for (const s of screens) {
        if (s.unreachable) {
          problems.push(`${size.name}: the "${s.name}" tab could not be opened, so it was never measured`)
          continue
        }
        // A screen that measures as nothing is a hole in the gate, not a pass.
        if (!s.m.controls.length) {
          problems.push(`${size.name}: the "${s.name}" screen rendered no controls at all — it was not measured`)
          continue
        }
        const perScreen = new Set()
        for (const c of s.m.controls) {
          // An inline `<a>` inside a sentence is text, not a target — it is sized by
          // its line box and making it 44px tall would break the paragraph it is in.
          if (c.inline) continue
          if (c.kind === 'other') otherCount += 1
          // Above 120px a thing is a panel, a body box or a list row — sized by
          // its content or by the space it was given, not a rung on the control
          // ladder. The 485px compose textarea is the obvious case.
          if (c.h <= 120) {
            perScreen.add(c.h)
            if (!byKind.has(c.kind)) byKind.set(c.kind, new Map())
            const seen = byKind.get(c.kind)
            if (!seen.has(c.h)) seen.set(c.h, new Set())
            seen.get(c.h).add(s.name)
          }
          // A textarea or a tall list row is not a violation of a *minimum*.
          if (c.h < MIN_TAP || c.w < MIN_TAP) {
            const key = `${c.cls.slice(0, 34)}|${c.w}x${c.h}`
            if (!tooSmall.has(key)) tooSmall.set(key, { c, screens: new Set() })
            tooSmall.get(key).screens.add(s.name)
          }
        }
        for (const [label, sizes] of s.m.kinds) {
          if (!kinds.has(label)) kinds.set(label, new Map())
          for (const fs of sizes) {
            if (!kinds.get(label).has(fs)) kinds.get(label).set(fs, new Set())
            kinds.get(label).get(fs).add(s.name)
          }
        }
        // The control count is printed, not just the heights: it is the only
        // thing on screen that shows whether a screen was actually measured or
        // merely visited, and a silently-empty screen is how this gate lied.
        report.push(
          `      ${s.name.padEnd(12)} ${String(s.m.controls.length).padStart(3)} controls   ` +
            `${[...perScreen].sort((a, b) => a - b).join(' ')}`,
        )
      }

      report.push(
        `      ${'= kinds'.padEnd(12)} ${byKind.size} kinds, ${otherCount} unclassified (\`other\`)`,
      )

      if (head.shell === 'mobile' && tooSmall.size) {
        for (const { c, screens: on } of [...tooSmall.values()].slice(0, 8)) {
          problems.push(`${size.name}: ${c.cls.slice(0, 34)} is ${c.w}x${c.h}, under the ${MIN_TAP}px floor (on ${[...on].join(', ')})`)
        }
      }
      // One kind of control, one height. `other` is exempt because it is a
      // grab-bag by definition — its size is printed above instead, so a
      // control cannot escape the rule by being unclassifiable without that
      // showing up in the output.
      for (const [kind, seen] of byKind) {
        if (kind === 'other' || seen.size < 2) continue
        const hs = [...seen.keys()].sort((a, b) => a - b)
        if (hs[hs.length - 1] - hs[0] <= HEIGHT_TOLERANCE) continue
        const where = hs.map((h) => `${h}px on ${[...seen.get(h)].join('/')}`).join('; ')
        problems.push(`${size.name}: .${kind} renders at ${hs.length} heights (${hs.join(' ')}) — one kind of control, one height [${where}]`)
      }
      for (const [label, bySize] of kinds) {
        if (bySize.size > 1) {
          const where = [...bySize].map(([fs, on]) => `${fs} on ${[...on].join('/')}`).join('; ')
          problems.push(`${size.name}: "${label}" renders at ${bySize.size} different sizes — one kind of text, one size [${where}]`)
        }
      }

      await page.close()
    }
  } finally {
    await browser.close()
  }

  console.log('')
  console.log(report.join('\n'))
  console.log('')

  if (problems.length) {
    console.error(`  ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n`)
    for (const p of problems) console.error(`    ${p}`)
    console.error('')
    return 1
  }

  console.log('  All clear — every control clears 44px on a touch shell, and each kind')
  console.log('  of text has one size.\n')
  return 0
}

let exitCode = 1

if (process.env.CHECK_URL) {
  // Someone else's server; measure it and leave it alone.
  try {
    exitCode = await measureAll(process.env.CHECK_URL)
  } catch (e) {
    console.error(`\n  ✗ ${e instanceof Error ? e.message : String(e)}\n`)
    exitCode = 1
  }
} else {
  const port = await freePort()
  // Windows needs `shell: true` to resolve `npx`'s `.cmd` shim, and passing an
  // argv array alongside `shell: true` is a deprecated no-op Node warns about —
  // so Windows gets one command string and everywhere else gets a real argv
  // array. Nothing here is user input, so string-vs-array is a warning to
  // silence, not an escaping concern.
  const args = ['vite', '--host', '127.0.0.1', '--port', String(port)]
  const vite =
    process.platform === 'win32'
      ? spawn(`npx ${args.join(' ')}`, { shell: true })
      : spawn('npx', args, { detached: true })
  // Node throws an uncaught exception — past the try/catch below, cleanup
  // skipped entirely — if a spawned process is unspawnable (bad path, no
  // permission) and nothing is listening for its 'error' event.
  vite.on('error', () => {})

  try {
    // `strictPort` is off in vite.config.ts, so the port asked for above is a
    // request, not a promise. Read back the one it actually bound.
    const bound = await waitForVitePort(vite, 30_000)
    const target = `http://127.0.0.1:${bound}/`
    const ready = await waitFor(target, 20_000)
    if (!ready) throw new Error(`Vite reported ${target} but it did not answer`)
    exitCode = await measureAll(target)
  } catch (e) {
    console.error(`\n  ✗ ${e instanceof Error ? e.message : String(e)}\n`)
    exitCode = 1
  } finally {
    killTree(vite)
  }
}

process.exit(exitCode)
