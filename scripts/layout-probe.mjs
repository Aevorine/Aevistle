/**
 * Measure the four screens the interface is judged on — `node scripts/layout-probe.mjs`.
 *
 * Written because rounds of layout work were argued from screenshots, and a
 * screenshot cannot tell "the rule did not apply" from "the build is older than
 * the edit". This reads `getBoundingClientRect()` and `getComputedStyle()` off a
 * real window, so every number below is what a browser actually laid out.
 *
 * It checks four properties the layout is *required* to have and that are all
 * invisible in a picture:
 *
 *   1. **The message box gets 85% of the compose view, on first paint.**
 *
 *      Not "after the body is focused". The previous version of this file
 *      documented the 85% requirement at length and then never asserted it: the
 *      only thing that could fail was `overflowPx > 2`, the share was computed
 *      against `window.innerHeight` rather than against the compose view, and the
 *      script never emulated a narrow viewport at all — so it was measuring a
 *      desktop window against a number written for a phone and passing.
 *
 *      All three are fixed here. The denominator is `.view--compose`'s own
 *      client height, the viewport is emulated at 360x800 and at a tablet width,
 *      and the state measured is the one the screen opens in, because that is
 *      the state someone has to find the recipient field in. A layout that only
 *      reaches 85% once you have already started typing has not solved the
 *      complaint that started this.
 *
 *      The wide window keeps its own, different promise: the form fits one
 *      screen with the options disclosure closed. A compose form that scrolls
 *      before a character is typed is the complaint that layout was built to
 *      answer. The two are not the same requirement stated twice, and the narrow
 *      one deliberately replaces "must not scroll" rather than joining it — 85%
 *      of the view leaves ~100px for everything else, the attachment picker and
 *      the send-time bar do not fit in 100px and are not meant to, and requiring
 *      no scroll anywhere would forbid the arrangement that makes 85% reachable.
 *
 *      A one-line title band for the narrow screen (`.composetop--compact`)
 *      was tried and pulled back out the same day (2026-08-11): its own
 *      smallest measurement only left 82.4%, and lowering this number to fit
 *      it would have traded the requirement away instead of meeting it. See
 *      `ComposeView.tsx`'s comment on the narrow `.composetop` branch before
 *      trying that again.
 *
 *   2. **Nothing is below the floor for its rank.**
 *
 *      This used to be one flat floor: every one of ~20 prose selectors had to be
 *      16px or larger. That single number is why three attempts at bringing the
 *      type down either failed this check or were reverted by it — and it was
 *      enforcing something nobody wanted, because a scale whose "secondary" step
 *      is the same size as its body step has no secondary step. The interface
 *      read as one wall of 16px, which is the reported 字体太大，显示的范围太小.
 *
 *      So the floor is graded, and each selector is filed under the rank it is
 *      *supposed* to be, by hand, in `TIERS` below:
 *
 *        body       ≥ 15.9px  prose, and every input — under 16px a focused
 *                            field makes mobile browsers zoom the page, so this
 *                            floor is an interaction requirement too
 *        secondary  ≥ 13.9px  metadata, hints, notes, descriptions
 *        auxiliary  ≥ 12.4px  timestamps, chips, counts, badges
 *
 *      A violation names the rank it broke, so "this is 12.5px" is reported as
 *      either fine or a two-rank fall, rather than as a bare number.
 *
 *   3. **Nothing overflows sideways.** Zero, not "a bit". The Codes screen's
 *      action row had no `flex-wrap` and needed ~460px inside a 286px card,
 *      which does not clip and does not scroll inside the card — it makes the
 *      whole list scroll sideways.
 *
 *   4. **The inbox row spends its width on text, and at least 9 fit a phone screen.**
 *      The row count used to be reported rather than asserted, because it moved
 *      with subject length (6-8 rows depending on how many wrapped to a second
 *      line). The subject clamp is one line now, specifically so this is no
 *      longer a trend to watch but a number to hold: `fits < 9` at the 360x800
 *      band is a failure, not a note.
 *
 * ---------------------------------------------------------------------------
 * Running it
 *
 * It talks CDP to an already-running window on `CDP_PORT` (default 9445), and it
 * only reads — apart from the viewport override it sets and clears, and one
 * `display: none` it applies and puts back. Either of these works:
 *
 *   the packaged app     launch it with `--remote-debugging-port=9445` and a
 *                        scratch `--user-data-dir`
 *   the dev server       `npx vite --host 127.0.0.1` (this repo's Vite binds
 *                        IPv6 only without the flag), then a Chrome started with
 *                        `--remote-debugging-port=9445 --user-data-dir=<scratch>`
 *                        pointed at it
 *
 * Both are the real stylesheet in a real engine. The dev server has no mail
 * account, so the two list screens have no rows to measure; where that is the
 * case this says so and measures the stylesheet against synthetic markup instead
 * of quietly reporting a pass it did not observe. See `SYNTHETIC_CODECARD`.
 */

const PORT = Number(process.env.CDP_PORT ?? 9445)

if (typeof WebSocket !== 'function') {
  console.error('This needs Node 22+ for a global WebSocket.')
  process.exit(1)
}

const guard = setTimeout(() => {
  console.error('\nTimed out waiting for the app to answer.')
  process.exit(1)
}, 180_000)
guard.unref?.()

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
/* Extension pages and dev-tools windows are also targets, and a browser started
   with a profile carries several. The app is the one whose document actually has
   the shell in it, which `title` is the cheap proxy for; the `type === 'page'`
   fallback is what a packaged Electron window matches. */
const page =
  targets.find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('devtools://')) ??
  targets.find((t) => t.type === 'page')
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
    throw new Error(
      res.result.exceptionDetails.exception?.description ??
        JSON.stringify(res.result.exceptionDetails),
    )
  }
  return res.result?.result?.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/*
 * Reload before measuring, and wait for the shell.
 *
 * Two things this buys, both learned the hard way in one session. A dev server
 * with HMR does not always have the edit you just made applied to the window
 * that has been open for twenty minutes, so a run can report the *previous*
 * stylesheet and be believed. And this script suppresses a few first-run bands
 * with inline `display: none`; an interrupted run leaves them suppressed, and the
 * next run then measures a screen with 79px missing from it and calls it a pass.
 * A reload throws both away.
 */
await send('Page.enable')
await send('Page.reload', { ignoreCache: false })
for (let i = 0; i < 40; i += 1) {
  await sleep(250)
  if (await evaluate(`Boolean(document.querySelector('.shell .view'))`)) break
}
await sleep(400)

// ---------------------------------------------------------------------------
// The graded type floor
// ---------------------------------------------------------------------------

/**
 * Every selector this checks, filed under the rank it is meant to be.
 *
 * Classified by hand and deliberately so: the whole failure this replaces was a
 * machine applying one number to twenty different roles. If a selector moves
 * rank, it moves here, in the same commit as the stylesheet, and the reason is
 * readable in the diff.
 *
 * `body` includes the controls (`.input`, `.select`, `.textarea`) for a reason
 * that is not typographic: a focused field under 16px makes iOS and Android zoom
 * the whole page. That floor may not be traded for height.
 */
const TIERS = {
  body: {
    floor: 15.9,
    label: 'body 16px',
    selectors: [
      '.page-title',
      '.field__label',
      '.switch__title',
      '.dropzone__title',
      '.moreoptions__summary',
      '.quickpicks__label',
      '.quickpick__name',
      '.actionbar__line',
      '.btn',
      '.input',
      '.select',
      '.textarea',
      '.composesummary',
      '.job__name',
      '.log__title',
      '.empty__title',
      '.bin-row__subject',
      '.lightbox__title',
      '.option__title',
    ],
  },
  secondary: {
    floor: 13.9,
    label: 'secondary 14px',
    selectors: [
      '.page-subtitle',
      '.field__hint',
      '.field__labelhint',
      '.field__optional',
      '.field__count',
      '.switch__desc',
      '.dropzone__hint',
      '.whenbar__rule',
      '.actionbar__meta',
      '.empty__hint',
      '.banner',
      '.markup__btn',
      '.reader__meta',
      '.checkbar',
      '.codewhy',
      '.datecard__title',
      '.swipe__behind',
    ],
  },
  auxiliary: {
    floor: 12.4,
    label: 'auxiliary 12.5px',
    selectors: [
      '.chip',
      '.nav__badge',
      '.job__meta',
      '.bin-row__meta',
      '.log__time',
      '.codecard__meta',
      '.codecard__sender',
      '.codecard__url',
      '.composeacts__badge',
      '.lightbox__counter',
    ],
  },
}

/**
 * The measurement, as one expression evaluated in the page.
 *
 * `scope` is the screen's root selector. Everything is measured inside it,
 * except the action bar and the send-result banner, which are siblings of the
 * view rather than children of it — they sit outside the scrolling area on
 * purpose — and so are named separately.
 */
const probeSource = (scope) => `(() => {
  const TIERS = ${JSON.stringify(TIERS)}
  const roots = [document.querySelector(${JSON.stringify(scope)})]
  for (const extra of ['.actionbar', '.sendresult', '.modal']) {
    const el = document.querySelector(extra)
    if (el) roots.push(el)
  }
  const alive = roots.filter(Boolean)

  const tooSmall = []
  const seen = {}
  for (const [tier, { floor }] of Object.entries(TIERS)) {
    for (const sel of TIERS[tier].selectors) {
      for (const root of alive) {
        // The root itself can be the match — \`.actionbar\` is passed as a root
        // and \`.banner\` can be one too — so test it as well as its descendants.
        const els = [...root.querySelectorAll(sel)]
        if (root.matches(sel)) els.push(root)
        for (const el of els) {
          if (!el.textContent.trim()) continue
          if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue
          const px = parseFloat(getComputedStyle(el).fontSize)
          seen[tier] = Math.min(seen[tier] ?? Infinity, px)
          if (px < floor) {
            tooSmall.push({
              tier,
              floor,
              sel,
              px: Number(px.toFixed(2)),
              text: el.textContent.trim().slice(0, 28),
            })
          }
        }
      }
    }
  }

  const rect = (sel, from) => {
    const el = (from ?? document).querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }
  }

  // Every scroller on the screen, so "does anything move sideways" is answered
  // by measurement rather than by picking the one element someone remembered.
  const overflow = []
  for (const el of document.querySelectorAll('.view, .list-pane, .modal__body, .codelist, .joblist, .btn-row, .markup')) {
    const x = el.scrollWidth - el.clientWidth
    const y = el.scrollHeight - el.clientHeight
    if (x > 0 || y > 0) {
      overflow.push({
        sel: (el.className || el.tagName).toString().split(' ').slice(0, 2).join('.'),
        x,
        y,
        // A strip that is *meant* to scroll sideways is not a defect. Only
        // \`.markup\` is, and it says so with \`overflow-x: auto\`.
        intended: getComputedStyle(el).overflowX === 'auto' || getComputedStyle(el).overflowX === 'scroll',
      })
    }
  }
  const unintendedX = overflow.filter((o) => o.x > 0 && !o.intended)
  // The document itself. A card that overflows a \`flex: none\` parent shows up
  // here and nowhere else, because no ancestor of it is a scroller.
  const docX = document.documentElement.scrollWidth - document.documentElement.clientWidth

  const view = document.querySelector(${JSON.stringify(scope)})
  const body = document.querySelector('.textarea--body')

  return JSON.stringify({
    viewport: { w: innerWidth, h: innerHeight },
    screen: document.querySelector('.view')?.dataset.screen
      ?? (document.querySelector('.view--compose') ? 'compose' : 'unknown'),
    view: view ? { w: Math.round(view.clientWidth), h: Math.round(view.clientHeight) } : null,
    scrollHeight: view?.scrollHeight ?? 0,
    overflowPx: view ? view.scrollHeight - view.clientHeight : 0,
    docX,
    overflow,
    unintendedX,
    tooSmall,
    smallestSeen: seen,

    // --- compose ---------------------------------------------------------
    body: rect('.textarea--body'),
    bodyShare:
      view && body
        ? Math.round((body.getBoundingClientRect().height / view.clientHeight) * 1000) / 10
        : null,
    // Absent on a narrow first paint, and that absence is the whole
    // multi-account argument: the account \`<select>\` lives inside
    // \`.compose-head\`, so if the head is not rendered the number of accounts
    // cannot change the height of anything.
    composeHead: rect('.compose-head'),
    composeSummary: rect('.composesummary'),
    actionbar: rect('.actionbar'),
    sendresultBottom: (() => {
      const el = document.querySelector('.sendresult')
      return el ? parseFloat(getComputedStyle(el).bottom) : null
    })(),
    // Every direct child of the column and of the card, so the height budget is
    // itemised rather than reasoned about. Three rounds of this work were argued
    // from estimates; the estimates were wrong every time.
    innerKids: [...(document.querySelector('.view--compose .view__inner')?.children ?? [])]
      .map((el) => (el.className || el.tagName).toString().split(' ')[0] + ' = ' +
        Math.round(el.getBoundingClientRect().height * 10) / 10),
    cardKids: [...(document.querySelector('.compose-layout')?.children ?? [])]
      .map((el) => (el.className || el.tagName).toString().split(' ')[0] + ' = ' +
        Math.round(el.getBoundingClientRect().height * 10) / 10),
    bodyFieldKids: [...(document.querySelector('.compose-layout > .field:has(.textarea--body)')?.children ?? [])]
      .map((el) => (el.className || el.tagName).toString().split(' ')[0] + ' = ' +
        Math.round(el.getBoundingClientRect().height * 10) / 10),
    markupButtons: document.querySelectorAll('.markup__btn').length,
    markupVisible: (() => {
      const strip = document.querySelector('.markup')
      if (!strip) return null
      const box = strip.getBoundingClientRect()
      let inside = 0
      for (const b of strip.querySelectorAll('.markup__btn')) {
        const r = b.getBoundingClientRect()
        if (r.left >= box.left - 0.5 && r.right <= box.right + 0.5) inside += 1
      }
      return { inside, scrollable: strip.scrollWidth - strip.clientWidth }
    })(),

    // --- inbox -----------------------------------------------------------
    inbox: (() => {
      const row = document.querySelector('.swipe .job')
      if (!row) return { rows: 0 }
      const rowBox = row.getBoundingClientRect()
      let furniture = 0
      for (const kid of row.children) {
        if (kid.classList.contains('job__body')) continue
        const r = kid.getBoundingClientRect()
        if (r.width > 0) furniture += r.width
      }
      // The gaps are furniture too — they were 48px of the 150.
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0
      const gapCount = [...row.children].filter((k) => k.getBoundingClientRect().width > 0).length - 1
      const pane = document.querySelector('.list-pane')
      const subject = row.querySelector('.job__name')
      return {
        rows: document.querySelectorAll('.swipe .job').length,
        rowH: Math.round(rowBox.height * 10) / 10,
        furniture: Math.round((furniture + gap * Math.max(0, gapCount)) * 10) / 10,
        subjectW: subject ? Math.round(subject.getBoundingClientRect().width * 10) / 10 : null,
        subjectLines: subject
          ? Math.round(
              subject.getBoundingClientRect().height /
                parseFloat(getComputedStyle(subject).lineHeight),
            )
          : null,
        subjectClipped: subject ? subject.scrollHeight > subject.clientHeight + 1 : null,
        paneH: pane ? Math.round(pane.clientHeight) : null,
        // What the pane can show, from the measured row pitch rather than from
        // the \`estimate\` VirtualList was given.
        fits:
          pane && rowBox.height > 0
            ? Math.floor(
                pane.clientHeight /
                  (rowBox.height +
                    (parseFloat(getComputedStyle(document.querySelector('.joblist') ?? row).rowGap) || 0)),
              )
            : null,
      }
    })(),

    // --- codes -----------------------------------------------------------
    codes: (() => {
      const cards = [...document.querySelectorAll('.codecard')]
      if (cards.length === 0) return { cards: 0 }
      let worst = 0
      let worstSel = null
      for (const card of cards) {
        for (const el of card.querySelectorAll('.codecard__actions, .codecard__body, .codecard__main')) {
          const over = el.scrollWidth - el.clientWidth
          if (over > worst) {
            worst = over
            worstSel = el.className.split(' ')[0]
          }
        }
      }
      const value = cards[0].querySelector('.codecard__value')
      const url = cards[0].querySelector('.codecard__url')
      return {
        cards: cards.length,
        worstOverflow: worst,
        worstSel,
        valuePx: value ? parseFloat(getComputedStyle(value).fontSize) : null,
        urlRendered: Boolean(url),
        urlLines: url
          ? Math.round(url.getBoundingClientRect().height / parseFloat(getComputedStyle(url).lineHeight))
          : null,
      }
    })(),

    // --- the tap-target floor --------------------------------------------
    // Cheap to carry and it is the one rule that quietly breaks whenever
    // something is made denser.
    underTap: (() => {
      const out = []
      for (const el of document.querySelectorAll(
        'button, [role="button"], input[type="checkbox"], select, .chip--toggle',
      )) {
        if (el.offsetParent === null) continue
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        if (r.height < 43.5)
          out.push(
            (el.className || el.tagName).toString().split(' ')[0] +
              ' ' +
              Math.round(r.width) +
              'x' +
              Math.round(r.height),
          )
      }
      return [...new Set(out)].slice(0, 12)
    })(),

    fontFamily: getComputedStyle(document.body).fontFamily.slice(0, 60),
  })
})()`

/**
 * A link card with four actions and an absurd URL, built from the real classes
 * and measured, for the case where there is no mail account and therefore no
 * real card on the screen.
 *
 * Appended to `document.body`, never into the React tree. Deleting or inserting
 * a node React believes it owns makes the next render that touches that subtree
 * throw inside `removeChild`, the whole app unmounts to a blank window, and
 * because it happens *later* it looks like whatever anyone did next caused it.
 * That happened once. `document.body`'s own extra children are outside every
 * root React reconciles, so this is safe — and it is measuring the stylesheet,
 * which is what the wrapping rules are, so it is the right thing to measure.
 */
const SYNTHETIC_CODECARD = `(() => {
  const host = document.createElement('div')
  host.id = 'probe-synthetic'
  host.style.cssText = 'position:fixed;left:-9999px;top:0;width:360px'
  host.innerHTML = \`
    <div class="view view--list"><div class="view__inner"><div class="list-pane"><div class="codelist">
      <div class="codecard" data-kind="code">
        <div class="codecard__body">
          <div class="codecard__mark"></div>
          <div class="codecard__main">
            <div class="codecard__value" data-kind="code">482 913</div>
            <div class="codecard__sender"><strong>Example</strong><span class="codecard__address">no-reply@accounts.example.com</span></div>
            <div class="codecard__meta"><span class="codecard__subject">Your verification code</span><span>2 min</span><span class="chip"><span class="chip__text">work@example.com</span></span></div>
          </div>
          <div class="codecard__actions">
            <button class="btn btn--secondary"><span class="btn__label">Copy</span></button>
            <button class="btn btn--ghost"><span class="btn__label">Why this one?</span></button>
          </div>
        </div>
      </div>
      <div class="codecard" data-kind="link">
        <div class="codecard__body">
          <div class="codecard__mark"></div>
          <div class="codecard__main">
            <div class="codecard__value" data-kind="link">Sign in to your account</div>
            <div class="codecard__purpose"><span class="chip chip--strong"><span class="chip__text">Sign in at accounts.example.com</span></span></div>
            <div class="codecard__url">https://accounts.example.com/auth/verify/callback?token=synthetic-sign-in-token-for-the-layout-probe-not-a-real-one&amp;source=email&amp;utm_campaign=login</div>
            <div class="codecard__sender"><strong>Example</strong><span class="codecard__address">no-reply@accounts.example.com</span></div>
            <div class="codecard__meta"><span class="codecard__subject">Your sign-in link</span><span>2 min</span><span class="chip"><span class="chip__text">work@example.com</span></span></div>
          </div>
          <div class="codecard__actions">
            <button class="btn btn--primary"><span class="btn__label">Open</span></button>
            <button class="btn btn--secondary"><span class="btn__label">Copy link</span></button>
            <button class="btn btn--ghost"><span class="btn__label">Show QR code</span></button>
            <button class="btn btn--ghost"><span class="btn__label">Why this one?</span></button>
          </div>
        </div>
      </div>
    </div></div></div></div>\`
  document.body.appendChild(host)
  const card = host.querySelector('.codecard[data-kind="link"]')
  const actions = card.querySelector('.codecard__actions')
  const url = host.querySelector('.codecard__url')
  // The code card's value, not the link card's — a link's "value" is its purpose
  // line and is deliberately body rank, so measuring that one would report 16px
  // and say nothing about the code size this screen exists for.
  const value = host.querySelector('.codecard[data-kind="code"] .codecard__value')
  const btns = [...actions.querySelectorAll('.btn')]
  const box = actions.getBoundingClientRect()
  const need = btns.reduce((n, b) => n + b.getBoundingClientRect().width, 0) +
    (btns.length - 1) * (parseFloat(getComputedStyle(actions).columnGap) || 0)
  const out = {
    cardW: Math.round(card.getBoundingClientRect().width * 10) / 10,
    actionsW: Math.round(box.width * 10) / 10,
    buttonsNeed: Math.round(need * 10) / 10,
    actionRows: new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top))).size,
    overflowX: Math.max(
      ...[...host.querySelectorAll('.codecard, .codecard__actions, .codecard__body, .codecard__main, .codelist')]
        .map((el) => el.scrollWidth - el.clientWidth),
    ),
    valuePx: parseFloat(getComputedStyle(value).fontSize),
    urlPx: parseFloat(getComputedStyle(url).fontSize),
    urlLines: Math.round(url.getBoundingClientRect().height / parseFloat(getComputedStyle(url).lineHeight)),
    urlClipped: url.scrollHeight > url.clientHeight + 1,
    cardH: Math.round(card.getBoundingClientRect().height * 10) / 10,
  }
  host.remove()
  return JSON.stringify(out)
})()`

/**
 * A mail row, built from the real classes and measured, for the case where there
 * is no mail account and therefore no real row on the screen.
 *
 * Same contract as `SYNTHETIC_CODECARD`: appended to `document.body`, never into
 * the React tree, and it measures the stylesheet — which is what the row rules
 * are. The subject is 22 Chinese characters, which is an ordinary length and long
 * enough to still need the ellipsis on a one-line clamp. Because the clamp no
 * longer varies by content, `row(false)` (long subject) and `row('short')`
 * exist to prove the row height does *not* move with subject length any more —
 * both should measure the same `rowH`, which is what makes a fixed 9-row floor
 * assertable instead of a range.
 *
 * `.swipe` is not decoration here: every narrow mail-row rule is scoped through
 * it, because that is what tells an inbox row apart from a Scheduled row, and a
 * probe that left it out would measure the rules for the wrong screen.
 */
const SYNTHETIC_MAILROW = `(() => {
  const host = document.createElement('div')
  host.id = 'probe-synthetic-row'
  // The width of the real list column at this viewport, not a fixed 360. A 360px
  // box inside an 820px document gets the *desktop* rules applied to a phone's
  // width, which is a combination no user is ever in and whose numbers mean
  // nothing.
  const realPane = document.querySelector('.view--list .list-pane')
  const colW = realPane ? Math.round(realPane.clientWidth) : 360
  host.style.cssText = 'position:fixed;left:-9999px;top:0;width:' + colW + 'px'
  const row = (selecting) => \`
    <div class="swipe">
      <div class="swipe__behind"><span class="swipe__action swipe__action--lead">Mark read</span><span class="swipe__action swipe__action--trail">Remove</span></div>
      <div class="swipe__front">
        <div class="job"\${selecting === true ? ' data-selecting="true"' : ''}>
          <input type="checkbox" class="job__select">
          <span class="job__pulse" data-unread="true"></span>
          <span class="avatar job__avatar" aria-hidden="true">Z</span>
          <div class="job__body">
            <div class="job__name">\${selecting === 'short' ? '会议通知' : '下周三上午十点的项目进度评审会议安排通知'}</div>
            <div class="job__meta">
              <span class="chip"><span class="chip__text">work@example.com</span></span>
              <span class="job__from">Zhang Wei &lt;zhang.wei@example.com&gt;</span>
              <span>2 min</span>
            </div>
          </div>
          <div class="job__actions">
            <button class="icon-btn"></button>
            <button class="icon-btn"></button>
          </div>
        </div>
      </div>
    </div>\`
  // Just the row list at the real column width — no .view--list / .list-pane
  // wrapper. Nesting one inside a box already sized to the real pane's *client*
  // width subtracts the pane's border and padding a second time, which showed up
  // as a subject 34px narrower than the one on screen.
  host.innerHTML = \`<div class="joblist">\${row(false)}\${row(true)}\${row('short')}</div>\`
  document.body.appendChild(host)

  const measure = (el) => {
    const job = el.querySelector('.job')
    const box = job.getBoundingClientRect()
    let furniture = 0
    let visibleKids = 0
    for (const kid of job.children) {
      const r = kid.getBoundingClientRect()
      if (r.width === 0) continue
      visibleKids += 1
      if (!kid.classList.contains('job__body')) furniture += r.width
    }
    const gap = parseFloat(getComputedStyle(job).columnGap) || 0
    const subject = job.querySelector('.job__name')
    const sr = subject.getBoundingClientRect()
    const lh = parseFloat(getComputedStyle(subject).lineHeight)
    return {
      rowH: Math.round(box.height * 10) / 10,
      furniture: Math.round((furniture + gap * Math.max(0, visibleKids - 1)) * 10) / 10,
      subjectW: Math.round(sr.width * 10) / 10,
      subjectLines: Math.round(sr.height / lh),
      subjectPx: Math.round(parseFloat(getComputedStyle(subject).fontSize) * 10) / 10,
      metaPx: Math.round(parseFloat(getComputedStyle(job.querySelector('.job__meta')).fontSize) * 10) / 10,
      metaH: Math.round(job.querySelector('.job__meta').getBoundingClientRect().height * 10) / 10,
      metaLines: Math.round(
        job.querySelector('.job__meta').getBoundingClientRect().height /
          parseFloat(getComputedStyle(job.querySelector('.job__meta')).lineHeight),
      ),
      subjectClipped: subject.scrollHeight > subject.clientHeight + 1,
      actionsShown: job.querySelector('.job__actions').getBoundingClientRect().width > 0,
      checkboxShown: job.querySelector('.job__select').getBoundingClientRect().width > 0,
    }
  }

  const rows = [...host.querySelectorAll('.swipe')]
  // The real pane, on the real screen, whose height is what decides how many rows
  // anybody sees. Only the row *pitch* comes from the synthetic markup.
  const pane = document.querySelector('.view--list .list-pane')
  const paneH = pane ? Math.round(pane.clientHeight) : null

  /*
   * Both list densities, because the row count is the one number here that the
   * user has a control for. --row-pad-y is what data-list-density moves and .job
   * reads it, so "how many rows fit" has two honest answers, and reporting one of
   * them would be picking the flattering half.
   */
  const root = document.documentElement
  const had = root.getAttribute('data-list-density')
  const atDensity = (value) => {
    if (value === null) root.removeAttribute('data-list-density')
    else root.setAttribute('data-list-density', value)
    const listGap = parseFloat(getComputedStyle(host.querySelector('.joblist')).rowGap) || 0
    const long = measure(rows[0])
    const short = measure(rows[2])
    const fits = (m) => (paneH && m.rowH > 0 ? Math.floor(paneH / (m.rowH + listGap)) : null)
    return {
      listGap,
      longRowH: long.rowH,
      shortRowH: short.rowH,
      fitsLong: fits(long),
      fitsShort: fits(short),
    }
  }
  const dflt = atDensity(null)
  const compact = atDensity('compact')
  if (had === null) root.removeAttribute('data-list-density')
  else root.setAttribute('data-list-density', had)

  const idle = measure(rows[0])
  const out = {
    idle,
    selecting: measure(rows[1]),
    short: measure(rows[2]),
    colW,
    paneH,
    density: { default: dflt, compact },
    listGap: dflt.listGap,
    fits: dflt.fitsLong,
    overflowX: Math.max(
      ...[...host.querySelectorAll('.job, .job__body, .job__meta, .joblist, .swipe')]
        .map((el) => el.scrollWidth - el.clientWidth),
    ),
  }
  host.remove()
  return JSON.stringify(out)
})()`

// ---------------------------------------------------------------------------
// Driving the window
// ---------------------------------------------------------------------------

/** Emulate a device viewport. Media queries and `matchMedia` both follow it. */
async function viewport(w, h, mobile) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: h,
    deviceScaleFactor: 1,
    mobile,
  })
  await sleep(400)
}

async function clearViewport() {
  await send('Emulation.clearDeviceMetricsOverride')
  await sleep(300)
}

/**
 * Go to a screen by clicking its nav item, and confirm arrival.
 *
 * Always leaves and comes back, even when already there, so the view remounts
 * and every piece of first-paint state — `headerOpen` above all — is re-derived
 * for the viewport now in force. Measuring the compose screen without this after
 * a resize measures a component that decided its layout at the old width.
 */
/**
 * Wait until the app has actually mounted, rather than until a stopwatch says
 * it probably has.
 *
 * `check-layout.mjs` sleeps 5s after Chrome's CDP port answers, with a comment
 * explaining that the port is up long before React has hydrated a cold,
 * unbundled dev-server load. That number was fitted to the app as it was; round
 * 8 added a component and two stylesheets, and 5s stopped being enough — the
 * probe failed *deterministically* on `phone 360x800` with `landed on
 * "unknown"`, which is the string it prints when `document.querySelector('.view')`
 * returns null, i.e. when nothing has rendered at all.
 *
 * A fixed sleep cannot be the right shape for this: it is either longer than
 * every machine needs or shorter than some machine needs, and the failure it
 * produces looks exactly like a real layout bug. Polling for the nav to exist
 * costs nothing on a fast machine and cannot go stale as the app grows.
 *
 * Deliberately NOT a longer sleep in `check-layout.mjs`: that would have made
 * this pass today and broken again at whatever size the app reaches next.
 */
async function waitForApp(ms = 30_000) {
  const until = Date.now() + ms
  for (;;) {
    const ready = await evaluate(
      `!!document.querySelector('.nav__item[data-view]') && !!document.querySelector('.view')`,
    )
    if (ready === 'true' || ready === true) return true
    if (Date.now() > until) return false
    await sleep(250)
  }
}

async function goto(view) {
  const other = view === 'compose' ? 'schedule' : 'compose'
  await waitForApp()
  const click = async () => {
    await evaluate(`document.querySelector('.nav__item[data-view="${other}"]')?.click(), true`)
    await sleep(200)
    await evaluate(`document.querySelector('.nav__item[data-view="${view}"]')?.click(), true`)
    await sleep(500)
    return evaluate(
      `document.querySelector('.view--compose') ? 'compose' : (document.querySelector('.view')?.dataset.screen ?? 'unknown')`,
    )
  }
  let at = await click()
  // "unknown" — neither `.view--compose` nor a `.view[data-screen]` found at
  // all — means the nav click landed before React had finished registering
  // handlers, not that the app went somewhere unexpected. That race is worst
  // on the very first interaction of a freshly reloaded, unbundled dev-server
  // session; every later `goto()` call in the same run has already proven the
  // nav works. Retried here rather than by widening the waits above for
  // every call: a screen that genuinely opened somewhere else (`at` is a real
  // name, just the wrong one) is not this problem, and retrying it would only
  // hide an actual navigation bug behind a second identical click.
  for (let i = 0; at === 'unknown' && i < 2; i += 1) {
    await sleep(500)
    at = await click()
  }
  return at
}

async function measure(scope) {
  return JSON.parse(await evaluate(probeSource(scope)))
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const failures = []
const notes = []
const fail = (msg) => {
  failures.push(msg)
  console.log(`  FAIL  ${msg}`)
}
const ok = (msg) => console.log(`  ok    ${msg}`)

function reportType(m, where) {
  if (m.tooSmall.length === 0) {
    const seen = Object.entries(m.smallestSeen)
      .map(([tier, px]) => `${tier} ${Number.isFinite(px) ? px.toFixed(2) : '—'}`)
      .join(' · ')
    ok(`type ranks hold on ${where} — smallest seen per rank: ${seen}`)
    return
  }
  for (const v of m.tooSmall) {
    fail(
      `${where}: ${v.sel} is ${v.px}px, under the ${TIERS[v.tier].label} floor of ${v.floor}px` +
        ` :: "${v.text}"`,
    )
  }
}

/* Not a failure, a note: the 44px floor is enforced by `app.css` inside a media
   query, so a 32px control on a 1400px desktop is deliberate and a 32px control
   on a phone is a defect. Printing it at every width is what makes the second
   one visible without the first one crying wolf. */
function reportTaps(m, where) {
  if (m.underTap.length === 0) return
  const line = `${where}: under the 44px tap floor — ${m.underTap.join(', ')}`
  notes.push(line)
  console.log(`  note  ${line}`)
}

function reportOverflow(m, where) {
  if (m.docX > 0) {
    fail(`${where}: the document scrolls sideways by ${m.docX}px`)
  }
  for (const o of m.unintendedX) {
    fail(`${where}: ${o.sel} overflows horizontally by ${o.x}px with no scroller to reach it`)
  }
  if (m.docX === 0 && m.unintendedX.length === 0) ok(`${where}: horizontal overflow 0px`)
}

/*
 * The scratch profile has no mail account, so the compose screen carries three
 * bands a configured install does not: the first-run warning banner, the health
 * strip reporting that there is no account to send from, and the outbox strip.
 * Measured at 360x800, the health strip alone is 78.8px — 12% of the compose
 * view, which is most of the difference between 71.5% and 85% and none of it the
 * form's own chrome.
 *
 * Taking all three out of the layout measures the state every user after the
 * first minute is in. Reported as the simulation it is, with the cost printed,
 * rather than quietly folded into a general-case number: `HealthBoard` renders
 * `null` when there is nothing wrong, so on a working install this is what the
 * screen is, but on an install with a real problem the strip is back and the
 * message box is smaller by its height.
 *
 * `display: none`, never `.remove()`. See the note on `SYNTHETIC_CODECARD`.
 */
const FIRST_RUN = ['.view--compose .banner--warning', '.view--compose .health', '.view--compose .outbox']
const hideFirstRun = async (hide) =>
  evaluate(
    `(() => { let n = 0; for (const sel of ${JSON.stringify(FIRST_RUN)}) {
       const el = document.querySelector(sel)
       if (!el) continue
       if (${hide}) { n += el.getBoundingClientRect().height; el.style.display = 'none' }
       else el.style.display = ''
     } return Math.round(n * 10) / 10 })()`,
  )

const NARROW = { w: 360, h: 800, mobile: true, label: 'phone 360x800' }
const TABLET = { w: 820, h: 1180, mobile: true, label: 'tablet 820x1180' }

for (const band of [NARROW, TABLET]) {
  console.log(`\n=========================================================`)
  console.log(`  ${band.label}`)
  console.log(`=========================================================`)

  await viewport(band.w, band.h, band.mobile)

  // --- compose -----------------------------------------------------------
  const at = await goto('compose')
  if (at !== 'compose') {
    fail(`could not reach the compose screen (landed on "${at}")`)
    break
  }
  const suppressed = await hideFirstRun(true)
  await sleep(300)
  const c = await measure('.view--compose')
  console.log(`\n--- compose, first paint, account configured ---`)
  console.log(`  compose view   ${c.view?.w}x${c.view?.h}   (window ${c.viewport.w}x${c.viewport.h})`)
  console.log(`  message box    ${c.body?.w}x${c.body?.h}  →  ${c.bodyShare}% of the compose view`)
  console.log(`  summary bar    ${c.composeSummary ? `${c.composeSummary.w}x${c.composeSummary.h}` : 'absent'}`)
  console.log(`  addressing     ${c.composeHead ? `${c.composeHead.w}x${c.composeHead.h} — OPEN` : 'not rendered (folded)'}`)
  console.log(`  action bar     ${c.actionbar?.h}   send-result sticks at ${c.sendresultBottom ?? 'n/a'}px`)
  console.log(`  markup strip   ${c.markupVisible?.inside}/${c.markupButtons} buttons fully inside, ` +
    `${c.markupVisible?.scrollable}px scrollable`)
  console.log(`  vertical       scroll ${c.scrollHeight} / client ${c.view?.h} → overflow ${c.overflowPx}px`)
  console.log(`  page column:   ${c.innerKids.join('  |  ')}`)
  console.log(`  card column:   ${c.cardKids.join('  |  ')}`)
  console.log(`  message field: ${c.bodyFieldKids.join('  |  ')}`)
  console.log(`  suppressed:    ${suppressed}px of first-run bands (warning banner, health strip,`)
  console.log(`                 outbox strip) — none of them the form's own chrome; see hideFirstRun`)

  reportType(c, `compose @ ${band.w}px`)
  reportOverflow(c, `compose @ ${band.w}px`)
  reportTaps(c, `compose @ ${band.w}px`)

  // 1 — the 85%, on the state the screen opens in.
  if (c.bodyShare === null) {
    fail(`compose @ ${band.w}px: no .textarea--body to measure`)
  } else if (c.bodyShare < 85) {
    fail(
      `compose @ ${band.w}px: the message box is ${c.bodyShare}% of the compose view on first ` +
        `paint, under the 85% this screen is held to`,
    )
  } else {
    ok(`compose @ ${band.w}px: message box ${c.bodyShare}% of the compose view on first paint`)
  }

  /*
   * 1b — and the same box on the screen that is actually in front of someone.
   *
   * The measurement above hides three bands before taking it (`hideFirstRun`),
   * on the argument that a configured install does not carry them. Half of
   * that is true and the wrong half was load-bearing: `HealthBoard` renders
   * for notifications being off, exact alarms being denied and saves failing,
   * none of which is a first-run condition, and the strip has no height cap.
   * Measured in a browser at 360x800 before this round: 79px at the standard
   * text size, 131px at `larger`, and 341px at `larger` with a 1.3x Android
   * system font scale — 42.8% of the view left for the message box, against an
   * 85% floor the gate was reporting as met.
   *
   * So the simulation keeps its number and this asserts the real one. 55, not
   * 85: with the strip up the box cannot reach 85 and pretending otherwise is
   * how the floor gets quietly lowered. It is the number `22-compose.css`'s
   * `min-height` is set to hold, and it fails if either the clamp on the strip
   * or that floor is removed.
   */
  await hideFirstRun(false)
  await sleep(250)
  const real = await measure('.view--compose')
  if (real.bodyShare === null) {
    fail(`compose @ ${band.w}px: no .textarea--body to measure with the first-run bands shown`)
  } else if (real.bodyShare < 55) {
    fail(
      `compose @ ${band.w}px: with the health strip and first-run banners on screen the message ` +
        `box is ${real.bodyShare}% of the compose view, under the 55% floor it is held to in ` +
        `that state`,
    )
  } else {
    ok(
      `compose @ ${band.w}px: ${real.bodyShare}% with the first-run bands SHOWN ` +
        `(the state the 85% above simulates away)`,
    )
  }
  await hideFirstRun(true)
  await sleep(200)

  // The multi-account case, argued structurally rather than by configuring two
  // accounts in a scratch profile: the account `<select>` is inside
  // `.compose-head`, so a head that is not rendered cannot cost the message box
  // anything, whatever the account count is.
  if (c.composeHead === null) {
    ok(
      `compose @ ${band.w}px: .compose-head is not rendered on first paint, so the account ` +
        `<select> contributes 0px — the share above is the multi-account share too`,
    )
  } else {
    notes.push(
      `compose @ ${band.w}px: .compose-head IS rendered on first paint (${c.composeHead.h}px). ` +
        `A second account adds a ~79px <select> to it, so the share above is the ` +
        `single-account best case and the multi-account number is lower.`,
    )
    console.log(`  note  ${notes[notes.length - 1]}`)
  }

  if (c.markupVisible && c.markupVisible.inside < c.markupButtons) {
    if (c.markupVisible.scrollable > 0) {
      ok(
        `compose @ ${band.w}px: ${c.markupVisible.inside}/${c.markupButtons} markup buttons fit and ` +
          `the strip scrolls ${c.markupVisible.scrollable}px, with the shadow affordance on the ` +
          `edge that has more`,
      )
    } else {
      fail(
        `compose @ ${band.w}px: only ${c.markupVisible.inside}/${c.markupButtons} markup buttons ` +
          `are reachable and the strip does not scroll`,
      )
    }
  } else if (c.markupVisible) {
    ok(`compose @ ${band.w}px: all ${c.markupButtons} markup buttons visible without scrolling`)
  }

  await hideFirstRun(false)

  // --- inbox -------------------------------------------------------------
  const atInbox = await goto('inbox')
  const i = atInbox === 'inbox' ? await measure('.view--list') : null
  if (!i) {
    notes.push(`could not reach the inbox screen at ${band.w}px (landed on "${atInbox}")`)
  } else {
    console.log(`\n--- inbox ---`)
    if (i.inbox.rows === 0) {
      console.log(`  no mail rows on screen — measuring the stylesheet against synthetic markup instead`)
      const r = JSON.parse(await evaluate(SYNTHETIC_MAILROW))
      console.log(`  synthetic row, 22-character Chinese subject, in the real ${r.colW}px column:`)
      console.log(`    row height     ${r.idle.rowH}px  + ${r.listGap}px list gap`)
      console.log(`    furniture      ${r.idle.furniture}px  (checkbox shown: ${r.idle.checkboxShown}, ` +
        `row actions shown: ${r.idle.actionsShown})`)
      console.log(`    subject        ${r.idle.subjectW}px, ${r.idle.subjectLines} line(s) at ` +
        `${r.idle.subjectPx}px, clamp cutting text: ${r.idle.subjectClipped}`)
      console.log(`    meta line      ${r.idle.metaPx}px, ${r.idle.metaH}px tall (${r.idle.metaLines} line(s))`)
      console.log(`    while selecting: furniture ${r.selecting.furniture}px, ` +
        `checkbox shown: ${r.selecting.checkboxShown}`)
      console.log(`    real list pane ${r.paneH}px, and what fits it:`)
      for (const [name, d] of Object.entries(r.density)) {
        console.log(
          `      ${name.padEnd(8)} gap ${d.listGap}px · row ${d.shortRowH}px -> ${d.fitsShort} rows ` +
            `(long-subject row ${d.longRowH}px -> ${d.fitsLong} rows)`,
        )
      }
      console.log(`    horizontal overflow ${r.overflowX}px`)
      notes.push(
        `inbox @ ${band.w}px: row geometry measured against synthetic markup — the real list had ` +
          `0 rows (no mail account). The list-pane height is the real one; the row pitch is not.`,
      )
      if (band === NARROW) {
        if (r.idle.furniture > 40)
          fail(`inbox @ 360px: ${r.idle.furniture}px of non-text furniture on a row, over the 40px target`)
        else ok(`inbox @ 360px: ${r.idle.furniture}px of non-text furniture on a row (target <=40)`)
        if (r.idle.subjectW < 256)
          fail(`inbox @ 360px: the subject gets ${r.idle.subjectW}px, under the 256px target`)
        else ok(`inbox @ 360px: the subject gets ${r.idle.subjectW}px (target >=256)`)
        if (r.idle.subjectLines !== 1)
          fail(`inbox @ 360px: the one-line subject clamp renders on ${r.idle.subjectLines} line(s), not 1`)
        else ok(`inbox @ 360px: the subject clamps to 1 line`)
        if (!r.idle.subjectClipped)
          fail(`inbox @ 360px: a 22-character subject does not overflow — the ellipsis rule has nothing to prove`)
        else ok(`inbox @ 360px: a 22-character subject is clipped with an ellipsis`)
        if (!r.selecting.checkboxShown)
          fail(`inbox @ 360px: the checkbox does not come back while a selection is live`)
        else ok(`inbox @ 360px: the checkbox is hidden when idle and shown while selecting`)
        if (r.overflowX !== 0)
          fail(`inbox @ 360px: a row overflows horizontally by ${r.overflowX}px`)
        else ok(`inbox @ 360px: 0px horizontal overflow inside a row`)
        if (r.density.default.fitsShort < 9)
          fail(`inbox @ 360px: only ${r.density.default.fitsShort} rows fit the pane at default density, under the 9-row floor`)
        else ok(`inbox @ 360px: ${r.density.default.fitsShort} rows fit the pane at default density (floor 9)`)
      }
    } else {
      console.log(`  rows rendered  ${i.inbox.rows}   list pane ${i.inbox.paneH}px`)
      console.log(`  row height     ${i.inbox.rowH}px  → ${i.inbox.fits} fit the pane`)
      console.log(`  furniture      ${i.inbox.furniture}px (everything on the row that is not text)`)
      console.log(`  subject        ${i.inbox.subjectW}px wide, ${i.inbox.subjectLines} line(s), ` +
        `clipped: ${i.inbox.subjectClipped}`)
      if (band === NARROW) {
        if (i.inbox.furniture > 40)
          fail(`inbox @ 360px: ${i.inbox.furniture}px of non-text furniture on a row, over the 40px target`)
        else ok(`inbox @ 360px: ${i.inbox.furniture}px of non-text furniture on a row (target ≤40)`)
        if (i.inbox.subjectW !== null && i.inbox.subjectW < 256)
          fail(`inbox @ 360px: the subject gets ${i.inbox.subjectW}px, under the 256px target`)
        else ok(`inbox @ 360px: the subject gets ${i.inbox.subjectW}px (target ≥256)`)
        if (i.inbox.fits !== null && i.inbox.fits < 9)
          fail(`inbox @ 360px: only ${i.inbox.fits} real rows fit the pane, under the 9-row floor`)
        else if (i.inbox.fits !== null) ok(`inbox @ 360px: ${i.inbox.fits} real rows fit the pane (floor 9)`)
      }
    }
    reportType(i, `inbox @ ${band.w}px`)
    reportOverflow(i, `inbox @ ${band.w}px`)
    reportTaps(i, `inbox @ ${band.w}px`)
  }

  // --- the tap floor on a touch tablet -----------------------------------
  //
  // At 820px in a browser the shell is *not* the mobile one — `useMobileShell`
  // wants narrow OR a native mobile platform, and a desktop browser at 820px is
  // neither — so the 38px row actions measured above are the desktop's and are
  // not a defect. On an 820px Android tablet the attribute is set and a different
  // set of rules applies. Forcing it is the only way to test those rules here,
  // and it is put back immediately.
  if (band === TABLET) {
    const before = (await measure('.view--list')).underTap
    await evaluate(`document.documentElement.setAttribute('data-shell', 'mobile'), true`)
    await sleep(300)
    const after = (await measure('.view--list')).underTap
    await evaluate(`document.documentElement.removeAttribute('data-shell'), true`)
    await sleep(200)
    console.log(`\n--- the 44px floor with data-shell="mobile" forced on, at ${band.w}px ---`)
    console.log(`  as a desktop shell:  ${before.length === 0 ? 'nothing under 44px' : before.join(', ')}`)
    console.log(`  as a mobile shell:   ${after.length === 0 ? 'nothing under 44px' : after.join(', ')}`)
    if (after.length > 0)
      fail(`tablet @ ${band.w}px as a mobile shell: still under the 44px floor — ${after.join(', ')}`)
    else ok(`tablet @ ${band.w}px as a mobile shell: everything tappable clears 44px`)
  }

  // --- codes -------------------------------------------------------------
  const atCodes = await goto('codes')
  const k = atCodes === 'codes' ? await measure('.view--list') : null
  if (!k) {
    notes.push(`could not reach the codes screen at ${band.w}px (landed on "${atCodes}")`)
  } else {
    console.log(`\n--- verification codes ---`)
    if (k.codes.cards === 0) {
      console.log(`  no cards on screen — measuring the stylesheet against synthetic markup instead`)
      const s = JSON.parse(await evaluate(SYNTHETIC_CODECARD))
      console.log(`  synthetic link card, four actions, 189-char URL:`)
      console.log(`    card           ${s.cardW}x${s.cardH}px`)
      console.log(`    action row     ${s.actionsW}px holding ${s.buttonsNeed}px of buttons ` +
        `on ${s.actionRows} row(s)`)
      console.log(`    horizontal overflow ${s.overflowX}px`)
      console.log(`    code value     ${s.valuePx}px`)
      console.log(`    URL line       ${s.urlPx}px, ${s.urlLines} line(s), clipped past the clamp: ${s.urlClipped}`)
      if (s.overflowX !== 0)
        fail(`codes @ ${band.w}px: a link card overflows horizontally by ${s.overflowX}px (target 0)`)
      else ok(`codes @ ${band.w}px: a four-action link card has 0px horizontal overflow`)
      if (!s.urlLines) fail(`codes @ ${band.w}px: the full URL is not rendered on the card`)
      else ok(`codes @ ${band.w}px: the full URL renders on the card, clamped to ${s.urlLines} line(s)`)
      // The code is the one thing on this screen that has to stay the most
      // prominent, and the one thing the user asked to be smaller. 20px is the
      // agreed number; the assertion is a window, not a floor, because both
      // directions are regressions.
      if (s.valuePx < 19 || s.valuePx > 21)
        fail(`codes @ ${band.w}px: the code is ${s.valuePx}px, outside the agreed 20px (±1)`)
      else ok(`codes @ ${band.w}px: the code is ${s.valuePx}px`)
      notes.push(
        `codes @ ${band.w}px: measured against synthetic markup, not real mail — the numbers are ` +
          `the stylesheet's, which is what the wrapping rules are, but no real card was on screen`,
      )
    } else {
      console.log(`  cards          ${k.codes.cards}`)
      console.log(`  code value     ${k.codes.valuePx}px`)
      console.log(`  URL line       rendered: ${k.codes.urlRendered}, ${k.codes.urlLines} line(s)`)
      console.log(`  worst in-card overflow  ${k.codes.worstOverflow}px (${k.codes.worstSel ?? '—'})`)
      if (k.codes.worstOverflow !== 0)
        fail(`codes @ ${band.w}px: ${k.codes.worstSel} overflows by ${k.codes.worstOverflow}px (target 0)`)
      else ok(`codes @ ${band.w}px: 0px overflow inside every card`)
    }
    reportType(k, `codes @ ${band.w}px`)
    reportOverflow(k, `codes @ ${band.w}px`)
    reportTaps(k, `codes @ ${band.w}px`)
  }
}

// ---------------------------------------------------------------------------
// The wide window keeps its own promise
// ---------------------------------------------------------------------------

console.log(`\n=========================================================`)
console.log(`  the window as it actually is (no emulation)`)
console.log(`=========================================================`)
await clearViewport()
const atWide = await goto('compose')
if (atWide !== 'compose') {
  fail(`could not reach the compose screen at the native size (landed on "${atWide}")`)
} else {
  const suppressedWide = await hideFirstRun(true)
  await sleep(300)
  const w = await measure('.view--compose')
  console.log(`\n--- compose, disclosure closed, account configured ---`)
  console.log(`  compose view   ${w.view?.w}x${w.view?.h}   (window ${w.viewport.w}x${w.viewport.h})`)
  console.log(`  message box    ${w.body?.w}x${w.body?.h}  →  ${w.bodyShare}% of the compose view`)
  console.log(`  addressing     ${w.composeHead ? `${w.composeHead.w}x${w.composeHead.h}` : 'not rendered'}`)
  console.log(`  vertical       scroll ${w.scrollHeight} / client ${w.view?.h} → overflow ${w.overflowPx}px`)
  console.log(`  font stack     ${w.fontFamily}`)
  reportType(w, `compose @ ${w.viewport.w}px`)
  reportOverflow(w, `compose @ ${w.viewport.w}px`)

  // Above 900px the narrow arrangement is not in force, so the promise is the
  // other one: no scroll before a character is typed.
  if (w.viewport.w > 900) {
    if (w.overflowPx > 2) fail(`compose @ ${w.viewport.w}px: the form scrolls (${w.overflowPx}px) before anything is typed`)
    else ok(`compose @ ${w.viewport.w}px: fits one screen with the disclosure closed`)
  } else if (w.view && w.body) {
    /*
     * A px budget here, not the 85%.
     *
     * The 85% is asserted where the requirement lives — the emulated phone and
     * tablet above, at sizes this script chooses. This block runs against
     * whatever window the app happens to be open in, and the share is a
     * function of *height* while the branch above it tests *width*: at 360x800
     * the chrome is 96px of 662 and the box gets 85.5%, and the identical
     * layout in a 762x484 window is 78px of 425 and gets 81.7%. Failing on that
     * would be failing on the tester's window size. Worse, the only way to pass
     * it in a short window is to drop the action bar, which is the Send button.
     *
     * What genuinely regresses is the chrome growing — a band coming back, the
     * addressing block unfolding on first paint, a second toolbar row. That is
     * a px cost and it is the same px at every window size, so that is what is
     * held. Measured at three sizes with this layout: 96px at 360 wide, 78px at
     * 820, 78px at 762. 110px leaves room for a font the metrics differ on and
     * still catches the 44px addressing block or a 124px first-run band.
     */
    const chrome = Math.round((w.view.h - w.body.h) * 10) / 10
    if (chrome > 110) {
      fail(
        `compose @ ${w.viewport.w}x${w.viewport.h}: ${chrome}px of chrome above and below the ` +
          `message box (budget 110px) — something has been added to the form's own furniture`,
      )
    } else {
      ok(
        `compose @ ${w.viewport.w}x${w.viewport.h}: ${chrome}px of chrome (budget 110px), ` +
          `message box ${w.bodyShare}% of a ${w.view.h}px view`,
      )
    }
  }
  await hideFirstRun(false)
  if (suppressedWide > 0)
    console.log(`  note  ${suppressedWide}px of first-run bands suppressed to measure a configured install`)
}

console.log(`\n---------------------------------------------------------`)
if (notes.length > 0) {
  console.log(`  ${notes.length} thing(s) this run could not establish:`)
  for (const n of notes) console.log(`    · ${n}`)
}
console.log(`\n  ${failures.length === 0 ? 'PASS' : `FAIL — ${failures.length} problem(s)`}`)

ws.close()
process.exit(failures.length > 0 ? 1 : 0)
