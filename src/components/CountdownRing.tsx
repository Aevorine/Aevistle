/**
 * The ring a scheduled send is drawn as — "how much of the wait is done",
 * as one closed shape instead of two timestamps.
 *
 * The schedule row already says `Next: 12 Aug 2026, 07:00 (in 5 h)`. That is
 * complete and it is precise, and it is also two numbers you have to subtract
 * from each other before you know anything. A ring is read in the time it
 * takes to see it, the same way a clock face is: the eye answers "nearly" or
 * "not yet" before it has read a single digit. So the ring is added *beside*
 * that text, never instead of it — see the accessibility note below, which is
 * the same decision stated in the way a screen reader cares about.
 *
 * ## The denominator: the arc is the last 24 hours, never the whole wait
 *
 * A ring needs a start as well as an end, and the obvious start — the moment
 * the job was armed — falls apart the moment a job is scheduled more than a
 * day out. A reminder set three weeks ahead is 99.7% of the way through its
 * wait for the last six days of it; the arc is visually closed and stays
 * visually closed, so for six days the ring says "any moment now" about
 * something six days away. That is not a rounding error, it is the opposite of
 * the information.
 *
 * So the window is capped:
 *
 *     windowMs = min(fireAt - armedAt, 24 h)
 *
 * and the arc represents the last `windowMs` before the fire time. A job armed
 * ten minutes before it fires uses its true ten-minute window and the arc
 * sweeps the whole way. A job armed three weeks out sits at zero until T-24h
 * and then fills over the final day.
 *
 * Why 24 hours, and not an hour or a week:
 *
 *   - 7 days. One hour of progress moves the arc 71.5px / 168 = 0.43px. An
 *     hour of waiting that does not move the ring by a whole pixel is an hour
 *     the ring did not report, so a week-long denominator is a still picture
 *     with extra steps.
 *   - 1 hour. Sharp — a minute is 1.2px — but empty for everything that is not
 *     already imminent, and "tomorrow morning" versus "next month" is exactly
 *     the distinction someone scanning this list wants.
 *   - 24 hours. One hour moves the arc ~3px, which is visible; and the
 *     boundary the ring is now drawing is "today / not today", which is the
 *     boundary this app's users actually schedule against.
 *
 * A non-linear mapping — log time, so that weeks and minutes both fit — was
 * considered and rejected. A ring whose angle is not proportional to time is a
 * dial that lies at a glance, and "readable at a glance" is the entire reason
 * this component exists.
 *
 * Outside the window the ring is not merely empty, it is *dashed* (`data-far`).
 * An empty solid ring and a stalled ring look identical; a dashed track reads
 * as "not started", which is the true statement, and it distinguishes "25 hours
 * away" from "3 weeks away" no better than a number would — but it does stop
 * either of them being mistaken for "stuck".
 *
 * ## One ticker, not forty
 *
 * The naive version is a `setInterval(…, 1000)` inside each ring. At forty
 * visible rows that is forty timers, forty wakeups a second, and forty React
 * renders a second, for an arc that on a 24-hour window advances 0.0008px in
 * that second. This app has a hard no-stutter requirement and ships on a
 * phone; that design is a battery bill for a picture nobody can see change.
 *
 * Instead: one module-level ticker, shared by every mounted ring, whose
 * interval is chosen from the *soonest* ring on screen —
 *
 *     soonest remaining        tick every      worst-case staleness
 *     ---------------------------------------------------------------
 *     under 1 min              1 s             1 s
 *     1 min – 10 min           5 s             5 s
 *     10 min – 1 h             20 s            20 s
 *     1 h – 6 h                60 s            1 min
 *     over 6 h                 5 min           5 min
 *     nothing still pending    (stopped)       —
 *
 * The staleness column is what the table is really choosing, because the arc
 * itself moves far too slowly to need any of these rates on a long window.
 * What needs to be timely is the two state boundaries: T-10min, where the ring
 * turns to `--warning`, is approached inside the 20-second bucket, so the
 * warning appears at most 20 s late; T-0, where it turns to `--danger`, is
 * approached inside the 1-second bucket. Twenty seconds of lateness on a
 * ten-minute warning is invisible; one second on "it should have gone by now"
 * is the accuracy that state deserves.
 *
 * Rings that are already overdue are excluded from the choice — an overdue
 * ring is a closed circle that will never change again, and letting one pin
 * the whole list to 1 Hz forever is the exact bug this table exists to avoid.
 * With nothing pending at all the timer stops outright.
 *
 * The second half of the saving is that a tick is not a render. Each ring
 * quantises its own arc to a whole degree and returns the previous state
 * object when neither the degree nor the state has changed, so React bails out
 * without reconciling. One degree is 0.2px of arc and, on a 24-hour window,
 * four minutes of wall clock — so a ring four minutes from its next visible
 * change absorbs 239 of every 240 ticks for the cost of a comparison. At the
 * fastest cadence, forty rows one day out plus one row 45 seconds out come to
 * ~1.2 React renders a second between them, not 40.
 *
 * The visual gap that quantising leaves is closed by CSS rather than by more
 * ticks: `.sendring__arc` carries a linear `stroke-dashoffset` transition, the
 * same trick `.pairqr__ringValue` already uses, so the final minute's 1 Hz
 * steps are ridden across instead of snapped through. Under
 * `prefers-reduced-motion` theme.css strips that transition and the steps show
 * honestly, which is the correct behaviour and not a degradation.
 *
 * Rings that are off screen do not subscribe at all (see the observer below),
 * and the ticker stops entirely while the document is hidden — a backgrounded
 * phone has no rings to draw.
 *
 * ## Accessibility: the arc is never the carrier
 *
 * The *arc* is `aria-hidden`, always. The schedule row announces
 * `t('schedule.nextRun') + formatDateTime(next) + formatRelative(next)` from
 * its own `.job__meta` line (`ScheduleView.tsx`), which is a real localized
 * timestamp and a real relative phrase, and that is what a screen reader
 * should read — not "72 percent". A ring that also announced itself would make
 * every row say the same thing twice, in two vocabularies, one of them worse.
 *
 * The `title` on the wrapper is for a pointer, not for assistive technology:
 * hovering tells a sighted user what the colour means the first time they meet
 * it. `aria-hidden` keeps it out of the accessibility tree, so it adds a
 * tooltip and no announcement.
 *
 * ## When it has actions, it is a real button — and the arc is still hidden
 *
 * With `onOpenActions` the wrapper becomes a `<button>` carrying an
 * `aria-label`, and the `<svg>` keeps `aria-hidden="true"`. So the tree gains
 * one control with a name like "Send options — waiting to send" and gains no
 * second reading of the time: `.job__meta`'s real timestamp is still the only
 * thing that says *when*.
 *
 * The other two arrangements were rejected, and the first of them is not
 * merely worse, it is invalid:
 *
 *   - **Keep `aria-hidden` on the wrapper and make it focusable.** ARIA
 *     forbids it — `aria-hidden` on an element containing focus is a
 *     conformance error, and real screen readers land on a control they then
 *     refuse to describe. There is no version of "focusable but hidden".
 *   - **Put the actions on a sibling control instead.** `.job__actions`
 *     already carries five icon buttons; at 360px they and the row's text are
 *     already tight, and a sixth for "postpone" is the change that tips it.
 *     More to the point the ring is *what the actions are about* — the thing
 *     you are looking at when you want to defer a send is the ring saying it
 *     is nearly due — and moving them elsewhere is how a row ends up with two
 *     places to do one thing.
 *
 * Without `onOpenActions` — a paused job, or a finished one on the Done tab —
 * nothing has changed: it is the same inert `<span aria-hidden>` it always
 * was, and the Done tab does not grow forty focus stops leading to two actions
 * that would not apply.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n, type TranslationKey } from '../i18n'

/* -------------------------------------------------------------------------- */
/*  Geometry                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A 32-unit box rather than the 24-unit grid `icons.tsx` draws on. The ring
 * carries strokes up to 5 units wide and a glyph inside the hole they leave;
 * on a 24 grid the hole is 10 units across and the exclamation mark inside it
 * stops being a mark and becomes a smudge.
 */
const VIEW = 32
const CENTRE = VIEW / 2
const RADIUS = 13
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** Whole degrees. See the render-bailout note in the file header. */
const STEPS = 360

/* -------------------------------------------------------------------------- */
/*  The window and the states                                                  */
/* -------------------------------------------------------------------------- */

/** The most wait the arc will ever represent. See the header for why 24 h. */
const WINDOW_CAP_MS = 24 * 60 * 60_000

/** Under this much left, the ring is `--warning`. */
const SOON_MS = 10 * 60_000

export type RingState = 'waiting' | 'soon' | 'overdue' | 'done'

export interface CountdownRingProps {
  /**
   * When the send is due — `job.occurrences[0]` on the schedule screen.
   */
  fireAt: number
  /**
   * When *this* wait started, which is not always when the job was created.
   *
   * For a one-off that is `job.createdAt`. For anything repeating it is
   * `job.lastRunAt ?? job.createdAt`: a daily reminder created three months
   * ago is not three months into a wait, it is however far it is since
   * yesterday's send. Passing `createdAt` for a repeating job is not wrong so
   * much as irrelevant — the 24-hour cap swallows it either way — but
   * `lastRunAt` makes the arc mean something for a job that repeats faster
   * than daily, which the cap alone cannot.
   */
  armedAt: number
  /**
   * The send actually happened. Draws the tick, and — only if the row is on
   * screen and motion is allowed — plays the collapse into it.
   *
   * Deliberately a caller's fact and not something this component infers from
   * the clock. "The ring closed" and "the mail went" are different events, and
   * conflating them would draw a success tick on every job that reached its
   * fire time and failed, which is the single state this app most needs to not
   * lie about. A ring that reaches zero unsent goes to `overdue` instead.
   */
  done?: boolean
  /**
   * Off the control ladder — 28 / 36 / 48. `xs` is the list-row size and the
   * default; the numbers live in `27-ring.css` so this file names a rung
   * rather than a pixel count.
   */
  size?: 'xs' | 'sm' | 'md'
  className?: string
  /**
   * Open this send's action menu — "send now / postpone ten minutes / cancel".
   *
   * Supplying it is what turns the ring from a picture into a `<button>`; see
   * the accessibility section of the file header for why that is the shape,
   * and what the caller is expected to render in response (a surface *outside*
   * the virtualised list, because a popover inside a row is clipped — see
   * `ScheduleView.tsx`).
   *
   * Optional, and absent is the honest answer for a paused or finished job:
   * two of the three actions would not apply, so the ring stays the inert
   * decoration it is everywhere else.
   */
  onOpenActions?: () => void
}

/**
 * What the ring shows right now. Quantised on purpose: two frames that round
 * to the same values are the same picture, and this is the object the render
 * bailout compares.
 */
interface Frame {
  /** 0…STEPS of the arc filled. */
  step: number
  state: RingState
  /** Outside the capped window entirely — the wait has not started drawing yet. */
  far: boolean
}

function frameAt(now: number, fireAt: number, armedAt: number, done: boolean): Frame {
  const span = fireAt - armedAt
  /*
   * `span <= 0` is not hypothetical: an occurrence that has passed without
   * firing can be re-armed behind a job whose `lastRunAt` is already later
   * than it. Falling back to the cap keeps the arithmetic finite; the state
   * below is `overdue` in that case anyway, which is a full ring, so the
   * fallback never actually shows.
   */
  const windowMs = span > 0 ? Math.min(span, WINDOW_CAP_MS) : WINDOW_CAP_MS
  const startAt = fireAt - windowMs
  const raw = (now - startAt) / windowMs
  const progress = raw < 0 ? 0 : raw > 1 ? 1 : raw
  const remaining = fireAt - now

  const state: RingState = done
    ? 'done'
    : remaining <= 0
      ? 'overdue'
      : remaining <= SOON_MS
        ? 'soon'
        : 'waiting'

  return {
    step: Math.round(progress * STEPS),
    state,
    // `!done` because "Send now" on a job scheduled for tomorrow finishes a
    // wait the arc had not started drawing yet — a dashed track behind a
    // success tick would be the ring saying "not started" about something
    // already sent.
    far: !done && progress <= 0 && remaining > 0,
  }
}

/* -------------------------------------------------------------------------- */
/*  The shared ticker                                                          */
/* -------------------------------------------------------------------------- */

type Listener = (now: number) => void

/**
 * Every mounted, on-screen ring, mapped to the instant it is waiting for. The
 * value is what lets {@link cadenceFor} pick an interval from the soonest one
 * rather than from a fixed guess.
 */
const listeners = new Map<Listener, number>()

/** [remaining is under this, tick this often]. The table in the header. */
const CADENCE: ReadonlyArray<readonly [number, number]> = [
  [60_000, 1_000],
  [10 * 60_000, 5_000],
  [60 * 60_000, 20_000],
  [6 * 60 * 60_000, 60_000],
  [Number.POSITIVE_INFINITY, 300_000],
]

let timer: number | null = null
let timerInterval = 0

/**
 * The interval the whole list should run at, or 0 for "stop".
 *
 * Overdue rings are skipped rather than treated as maximally urgent: they are
 * finished pictures, and one of them left in the list would otherwise hold
 * every other ring at 1 Hz for the rest of the session.
 */
function cadenceFor(now: number): number {
  let soonest = Number.POSITIVE_INFINITY
  for (const fireAt of listeners.values()) {
    const remaining = fireAt - now
    if (remaining > 0 && remaining < soonest) soonest = remaining
  }
  if (soonest === Number.POSITIVE_INFINITY) return 0
  for (const [under, interval] of CADENCE) {
    if (soonest < under) return interval
  }
  return 0
}

/**
 * Start, restart or stop the timer to match what is currently subscribed.
 *
 * Re-run after *every* tick, not only on subscribe, because the bucket the
 * list belongs in changes with the clock — and because a device that slept
 * through an hour wakes up with a 5-minute timer arming a send that is now 40
 * seconds away.
 */
function retime(now: number) {
  const wanted =
    typeof document !== 'undefined' && document.visibilityState === 'hidden' ? 0 : cadenceFor(now)
  if (wanted === timerInterval) return
  if (timer !== null) {
    window.clearInterval(timer)
    timer = null
  }
  timerInterval = wanted
  if (wanted === 0) return
  timer = window.setInterval(() => {
    const at = Date.now()
    for (const listener of listeners.keys()) listener(at)
    retime(at)
  }, wanted)
}

/**
 * A ring joins the ticker. Returns its own unsubscribe.
 *
 * The listener is called once immediately: a row scrolled back into view after
 * ten minutes off screen must be right on its first painted frame, not on the
 * next tick — which, in the slowest bucket, is five minutes away.
 */
function subscribe(fireAt: number, listener: Listener): () => void {
  listeners.set(listener, fireAt)
  const now = Date.now()
  listener(now)
  retime(now)
  return () => {
    listeners.delete(listener)
    retime(Date.now())
  }
}

if (typeof document !== 'undefined') {
  /*
   * A backgrounded app draws nothing, so it should wake for nothing. Browsers
   * already throttle background intervals, but "already throttled" is not
   * "stopped", and on Android this process can sit in the background for
   * hours. Coming back re-ticks every ring before re-timing, so the first
   * visible frame is current rather than however stale the last tick left it.
   */
  document.addEventListener('visibilitychange', () => {
    const now = Date.now()
    if (document.visibilityState !== 'hidden') {
      for (const listener of listeners.keys()) listener(now)
    }
    retime(now)
  })
}

/* -------------------------------------------------------------------------- */
/*  The shared observer                                                        */
/* -------------------------------------------------------------------------- */

const visibility = new Map<Element, (onScreen: boolean) => void>()
let observer: IntersectionObserver | null = null

/**
 * One `IntersectionObserver` for every ring in the app, for the same reason
 * there is one ticker: forty observers watching forty rows in one scroller is
 * forty times the bookkeeping for one answer.
 *
 * `rootMargin` pads the viewport so a row just under the fold is already
 * ticking when it arrives, rather than arriving stale and correcting itself in
 * front of the user. `root: null` is correct even though the rows live inside
 * `.list-pane`: intersection against the viewport is clipped by every
 * scrolling ancestor on the way up, so a row scrolled out of the pane is
 * reported out of view.
 */
function observe(element: Element, onChange: (onScreen: boolean) => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    // Old WebView, or a test environment. Treat everything as visible: a ring
    // that ticks when it did not have to is a waste, a ring that never ticks
    // is a bug.
    onChange(true)
    return () => {}
  }
  if (observer === null) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          visibility.get(entry.target)?.(entry.isIntersecting)
        }
      },
      { rootMargin: '64px' },
    )
  }
  visibility.set(element, onChange)
  observer.observe(element)
  return () => {
    visibility.delete(element)
    observer?.unobserve(element)
  }
}

/* -------------------------------------------------------------------------- */
/*  The component                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Chosen at runtime out of a map, so the cast is the same one `ScheduleView`
 * already makes for `summarizeRecurrence`'s key — a `string` narrowed to the
 * key union, not a key invented at the call site.
 */
const TITLE_KEY: Record<RingState, string> = {
  waiting: 'ring.waiting',
  soon: 'ring.soon',
  overdue: 'ring.overdue',
  done: 'ring.done',
}

/** Belt and braces for {@link CountdownRing}'s collapse — see its use. */
const COLLAPSE_GUARD_MS = 600

/**
 * Long-press timings, copied from `InboxView`'s `SwipeableRow` rather than
 * re-chosen — 450ms and 10px are what the rest of this app already means by
 * "held", and a second set of numbers would make one gesture feel like two.
 */
const LONG_PRESS_MS = 450
const LONG_PRESS_SLOP = 10

export function CountdownRing({
  fireAt,
  armedAt,
  done = false,
  size = 'xs',
  className,
  onOpenActions,
}: CountdownRingProps) {
  const { t } = useI18n()
  /*
   * A callback ref, and stable, because the element this points at is a
   * `<span>` or a `<button>` depending on `onOpenActions` — one `useRef`
   * typed to the common `HTMLElement` is the only thing both branches can
   * share. Memoised so React does not detach and re-attach it (null, then the
   * node) on every one of forty rows' every render.
   */
  const host = useRef<HTMLElement | null>(null)
  const setHost = useCallback((element: HTMLElement | null) => {
    host.current = element
  }, [])
  const [onScreen, setOnScreen] = useState(true)
  const [frame, setFrame] = useState<Frame>(() => frameAt(Date.now(), fireAt, armedAt, done))

  useEffect(() => {
    const element = host.current
    if (!element) return
    return observe(element, setOnScreen)
  }, [])

  useEffect(() => {
    if (!onScreen) return
    return subscribe(fireAt, (now) => {
      const next = frameAt(now, fireAt, armedAt, done)
      // The bailout. Returning `prev` unchanged is what stops a tick from
      // becoming a render — see the header.
      setFrame((prev) =>
        prev.step === next.step && prev.state === next.state && prev.far === next.far ? prev : next,
      )
    })
  }, [onScreen, fireAt, armedAt, done])

  /*
   * The collapse into the tick, and the two things it is gated on.
   *
   * `wasDone` makes it a *transition* rather than a state: a row that mounts
   * already sent — every row in the "finished" tab — draws its tick without
   * ceremony, because animating something that happened last Tuesday is
   * theatre. And the transition is only honoured while the row is on screen,
   * so scrolling past forty finished jobs does not queue forty animations
   * nobody watched.
   *
   * `prefers-reduced-motion` needs nothing here: theme.css's global block cuts
   * every animation to 0.01ms, so `animationend` arrives on the next frame and
   * the tick is simply *there*. That is the correct outcome, and it is one
   * fewer media query to keep in step with the rest of the app.
   */
  const wasDone = useRef(done)
  const [collapsing, setCollapsing] = useState(false)
  useEffect(() => {
    const justFinished = done && !wasDone.current
    wasDone.current = done
    if (justFinished && onScreen) setCollapsing(true)
  }, [done, onScreen])

  /*
   * The floor under the animation, and it hangs off `collapsing` rather than
   * off the effect above on purpose. If the animation never runs at all — an
   * ancestor went `display: none` mid-flight — `animationend` never fires and
   * the departing arc would sit on top of the tick for the rest of the
   * session. Tied to the flag it clears, this cannot be cancelled early by an
   * unrelated re-run, which is exactly what happened when it lived beside the
   * `onScreen` dependency: scrolling the row away inside the 180ms tore down
   * the guard and left the flag set.
   */
  useEffect(() => {
    if (!collapsing) return
    const guard = window.setTimeout(() => setCollapsing(false), COLLAPSE_GUARD_MS)
    return () => window.clearTimeout(guard)
  }, [collapsing])

  const progress = frame.step / STEPS
  /*
   * The bead rides the head of the arc in the `soon` state — see `27-ring.css`
   * for why it is there rather than being one more colour.
   *
   * Computed in the unrotated frame; the `<g>` below carries the -90° that
   * puts zero at twelve o'clock, so the same rotation takes the bead with it.
   * That rotation is an SVG attribute rather than a CSS transform on purpose:
   * it must not apply to the glyph in the middle, which stays upright, and it
   * must not mirror under `ar.ts`'s RTL layout, because a clock runs clockwise
   * in every language.
   */
  const beadAngle = 2 * Math.PI * progress
  const beadX = CENTRE + RADIUS * Math.cos(beadAngle)
  const beadY = CENTRE + RADIUS * Math.sin(beadAngle)

  /*
   * Long press, and the three other ways in.
   *
   * The gesture is the *fourth* route, never the only one — this codebase's
   * standing rule, and the 0.3.3 notes say it out loud about pull-to-refresh.
   * A plain click opens the same menu; Enter and Space open it because this is
   * a real `<button>` and the browser turns both into a click; and
   * `onContextMenu` covers the keyboard's own context-menu key as well as a
   * right-click. Long press only exists so a finger gets an answer before it
   * lifts.
   *
   * `fired` is read in `onClick` rather than swallowed with `onClickCapture`
   * the way `SwipeableRow` does it. There the capture handler sits on a
   * *wrapper* and has to stop a handler on a child; here both live on the same
   * button, so a flag says what is happening without leaning on React's
   * dispatch order.
   *
   * Mouse is excluded from the timer for the same reason `useSwipe` excludes
   * it: on a desktop a held click becoming a menu is a surprise, and the click
   * itself already opens it.
   */
  const pressTimer = useRef<number | null>(null)
  const pressFrom = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)

  const cancelPress = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
    pressFrom.current = null
  }

  useEffect(() => cancelPress, [])

  const shared = {
    className: className ? `sendring ${className}` : 'sendring',
    'data-state': frame.state,
    'data-far': frame.far || undefined,
    'data-collapsing': collapsing || undefined,
    'data-size': size,
    title: t(TITLE_KEY[frame.state] as TranslationKey),
    onAnimationEnd: () => setCollapsing(false),
  }

  const art = (
    <svg viewBox={`0 0 ${VIEW} ${VIEW}`} focusable="false" aria-hidden="true">
      <g transform={`rotate(-90 ${CENTRE} ${CENTRE})`}>
        <circle className="sendring__track" cx={CENTRE} cy={CENTRE} r={RADIUS} />
        {/*
          A sent ring has no arc — the tick is the whole message. The exception
          is the 180ms it is collapsing, which needs something to collapse;
          during that frame the arc is drawn *closed* rather than wherever the
          clock had got to, because "Send now" can finish a wait at 40% and the
          animation being described is a ring closing, not a ring giving up.
        */}
        {frame.state !== 'done' || collapsing ? (
          <circle
            className="sendring__arc"
            cx={CENTRE}
            cy={CENTRE}
            r={RADIUS}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={collapsing ? 0 : CIRCUMFERENCE * (1 - progress)}
          />
        ) : null}
        {frame.state === 'soon' ? (
          <circle className="sendring__bead" cx={beadX} cy={beadY} r={3.2} />
        ) : null}
      </g>

      {/* One shape in the hole, and never more than one. Each is a different
          silhouette, not a different colour — see `27-ring.css`. */}
      {frame.state === 'overdue' ? (
        <path className="sendring__glyph" d="M16 10.4v7.2M16 21.4v0.1" />
      ) : null}
      {frame.state === 'done' ? (
        <path className="sendring__glyph sendring__glyph--tick" d="m11.4 16.2 3.3 3.4 6.1-6.9" />
      ) : null}
    </svg>
  )

  if (!onOpenActions) {
    return (
      <span ref={setHost} {...shared} aria-hidden="true">
        {art}
      </span>
    )
  }

  return (
    <button
      ref={setHost}
      type="button"
      {...shared}
      /* The name is the menu plus the state, and never the arc's percentage —
         "72 percent" is not something anyone can act on, and the row's own
         `.job__meta` line is already announcing the real time. */
      aria-label={t('ring.menuLabel' as TranslationKey, {
        state: t(TITLE_KEY[frame.state] as TranslationKey),
      })}
      aria-haspopup="dialog"
      onPointerDown={(e) => {
        cancelPress()
        fired.current = false
        if (e.pointerType === 'mouse') return
        pressFrom.current = { x: e.clientX, y: e.clientY }
        pressTimer.current = window.setTimeout(() => {
          pressTimer.current = null
          fired.current = true
          onOpenActions()
        }, LONG_PRESS_MS)
      }}
      onPointerMove={(e) => {
        const start = pressFrom.current
        if (!start) return
        // A press that travels is the list being scrolled, not a hold. The
        // ring sits in a scroller, so without this every flick that started on
        // one would open a menu.
        if (
          Math.abs(e.clientX - start.x) > LONG_PRESS_SLOP ||
          Math.abs(e.clientY - start.y) > LONG_PRESS_SLOP
        ) {
          cancelPress()
        }
      }}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onClick={() => {
        // The click a long press produces on lift. The menu is already open.
        if (fired.current) {
          fired.current = false
          return
        }
        onOpenActions()
      }}
      onContextMenu={(e) => {
        // Two jobs. On a keyboard this *is* the route — the context-menu key
        // raises it with no pointer involved. On Android it also suppresses
        // the native text callout, which fires at roughly the same moment the
        // timer does and would otherwise open over the menu that just opened.
        e.preventDefault()
        if (!fired.current) onOpenActions()
      }}
    >
      {art}
    </button>
  )
}
