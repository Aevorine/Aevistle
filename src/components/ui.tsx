/** Small, unopinionated UI primitives shared by every view. */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react'
import { IconAlert, IconCheckCircle, IconInfo, IconSearch, IconX } from './icons'
import { useI18n } from '../i18n'
import { pushBackHandler } from '../core/backStack'
import { newId } from '../core/types'

/**
 * How a `PageHead` opens the command palette, without every screen having to
 * be handed a callback it does not otherwise care about.
 *
 * `null` is the honest default and the one a test or a storybook gets: no
 * provider, no search button, no crash. `App` is the only provider.
 */
export const PaletteContext = createContext<(() => void) | null>(null)

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'md' | 'lg'
  block?: boolean
  icon?: ReactNode
  loading?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  block,
  icon,
  loading,
  children,
  className = '',
  disabled,
  ...rest
}: ButtonProps) {
  const classes = [
    'btn',
    `btn--${variant}`,
    size === 'lg' ? 'btn--lg' : '',
    block ? 'btn--block' : '',
    !children ? 'btn--icon' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button className={classes} disabled={disabled || loading} {...rest}>
      {loading ? <span className="spinner" /> : icon}
      {/* Wrapped so a narrow screen can drop the words and keep the icon.
          Four labelled buttons in the compose header need 444px of text and
          have 284px on a phone, which is how that row became two. */}
      {children ? <span className="btn__label">{children}</span> : null}
    </button>
  )
}

export function IconButton({
  label,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    // `className` is destructured and merged rather than left in `rest`: the
    // spread comes after the attribute, so a caller passing one used to
    // silently replace `icon-btn` and lose the size, shape and 48px touch
    // floor that go with it.
    <button
      className={className ? `icon-btn ${className}` : 'icon-btn'}
      title={label}
      aria-label={label}
      {...rest}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function Card({
  children,
  className = '',
  flush,
}: {
  children: ReactNode
  className?: string
  flush?: boolean
}) {
  return <div className={`card ${flush ? 'card--flush' : ''} ${className}`}>{children}</div>
}

export function CardHeader({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="card__header">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="card__title">{title}</div>
        {hint ? <div className="card__hint">{hint}</div> : null}
      </div>
      {action}
    </div>
  )
}

/**
 * The heading every screen opens with — and the only one.
 *
 * Uniform by construction: all six views render this, so the screen name is
 * always 小二 in the same place, and `action` is always the one thing that
 * screen is for, always at the trailing edge. Views used to be free to invent
 * their own arrangement, which is how four of them ended up printing the title
 * twice and two printed it not at all.
 */
export function PageHead({
  title,
  subtitle,
  action,
  hideTitle,
}: {
  title: string
  subtitle?: string
  action?: ReactNode
  /** Keeps the `action` row (and the accessible name via `aria-label`) while
   *  dropping the visible heading — for a screen whose name is already said
   *  elsewhere (a highlighted tab, a modal's own title bar) and does not
   *  need to say it a second time at the top of its own content. Only worth
   *  reaching for when `action` is set: without one, the head has nothing
   *  left to hold and the view is better off not rendering it at all. */
  hideTitle?: boolean
}) {
  const openPalette = useContext(PaletteContext)
  const { t } = useI18n()
  return (
    <div className="page-head" data-hide-title={hideTitle || undefined} aria-label={hideTitle ? title : undefined}>
      <div className="page-head__text">
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {action || openPalette ? (
        <div className="page-head__actions">
          {/*
            Search, on every screen, because on a phone it was on one.
            `Ctrl+K` opens the command palette and the only tappable way in was
            a tile on Home — so from Compose, Codes, Inbox or Settings, four of
            the five tabs a phone has, there was no way to reach it at all
            without a keyboard. Nothing was broken; there was simply no door.

            Rendered here rather than added to each screen's own `action` prop
            so that a screen added later gets it without anyone remembering,
            and hidden on a desktop window by `.page-head__search` in
            `20-short.css` — a pointer has Ctrl+K, and the button would be a
            tenth control on screens that already carry nine.
          */}
          {openPalette ? (
            <IconButton
              className="page-head__search"
              label={t('palette.title')}
              onClick={openPalette}
            >
              <IconSearch />
            </IconButton>
          ) : null}
          {action}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

export function Field({
  label,
  hint,
  labelHint,
  action,
  optional,
  children,
  htmlFor,
  className,
}: {
  label?: string
  /** Guidance below the control. Costs a row of vertical space. */
  hint?: ReactNode
  /**
   * Guidance on the label line instead of below the control.
   *
   * Exists because the compose form is required to fit one screen: a hint row
   * is ~32px, and the label line already has empty space to its right. Use
   * this for text that explains the field; use `hint` when it needs the width.
   */
  labelHint?: ReactNode
  /**
   * Controls that belong to this field, pushed to the end of the label line.
   *
   * On the label line rather than above the control for the same reason
   * `labelHint` is: that line already has empty space to its right, and a row
   * of its own would cost ~32px on a form that is required to fit one screen.
   */
  action?: ReactNode
  optional?: string
  children: ReactNode
  htmlFor?: string
  /**
   * Extra class on the `.field` wrapper, so a stylesheet can name this field
   * instead of inferring it from what is inside.
   *
   * The compose message box used to be selected as
   * `.field:has(.textarea--body)` — thirty rules across six partials, every one
   * of them load-bearing for the box's height. `:has()` is Chromium 105+ and
   * this app ships to `minSdkVersion 24`, so on a device whose System WebView
   * predates it all thirty fail at once: measured in a browser with those rules
   * removed, the box went from 475px to 128px (72.7% to 19.6% of the view) and
   * the sr-only "Body" label became visible again — both of the two symptoms
   * reported from a real phone, from one cause. A class costs nothing and
   * cannot fail.
   */
  className?: string
}) {
  const labelEl = label ? (
    <label className="field__label" htmlFor={htmlFor}>
      {label}
      {optional ? <span className="field__optional">{optional}</span> : null}
      {labelHint ? <span className="field__labelhint">{labelHint}</span> : null}
    </label>
  ) : null

  return (
    <div className={className ? `field ${className}` : 'field'}>
      {/*
        The wrapper appears only when there is something to put beside the
        label. Wrapping unconditionally looked tidier and cost 69px on the
        compose footer: `.form-rows .field > .field__label` places the label in
        the 5.5em gutter column, that selector stopped matching through the new
        div, and every label in the form went from beside its control to above
        it. Measured, not guessed — `scripts/layout-probe.mjs` showed the
        message box *shrinking* from 281px to 234px on a change meant to grow
        it.
      */}
      {action ? (
        <div className="field__labelrow">
          {labelEl ?? <span />}
          {action}
        </div>
      ) : (
        labelEl
      )}
      {children}
      {hint ? <div className="field__hint">{hint}</div> : null}
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  title,
  description,
  danger,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  title: string
  description?: string
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <label className={`switch ${danger ? 'switch--danger' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch__control" />
      <span className="switch__text">
        <span className="switch__title">{title}</span>
        {description ? <span className="switch__desc">{description}</span> : null}
      </span>
    </label>
  )
}

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T
  options: SegmentedOption<T>[]
  onChange: (v: T) => void
  ariaLabel?: string
}) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="segmented__item"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export type BannerTone = 'info' | 'warning' | 'danger' | 'success'

/**
 * How long an `info` or `success` banner stays before it starts leaving.
 *
 * Seven seconds, which is between the two figures `ToastProvider` below already
 * uses — 4.2s for a success, 9s for an error — and picked for the same reason
 * those two differ. A banner carries more than a toast does (a bold title and
 * a sentence, often a path or a server's own words), so 4.2s is not long
 * enough to finish reading one; but it also sits inline with the screen's own
 * content instead of floating over a corner of it, so it is not in anybody's
 * way while it waits and does not need the 9s an error message gets. Seven is
 * roughly thirty Chinese characters at an unhurried pace, which is longer than
 * any banner text in this application.
 */
const BANNER_TTL_MS = 7000

/**
 * The gap between "start leaving" and "gone", which has to match
 * `.banner--leaving`'s fade in the stylesheet.
 *
 * Same arrangement — and the same caveat — as `INK_BLOOM_MS` in
 * `ScheduleView`: a CSS animation's duration cannot be read back out into a
 * `setTimeout`, so this is a second copy of the same number rather than a
 * shared source. Drift and the element unmounts slightly before or after its
 * own fade finishes; nothing else depends on the two staying equal.
 */
const BANNER_LEAVE_MS = 220

export function Banner({
  tone = 'info',
  title,
  children,
  action,
  keep,
}: {
  tone?: BannerTone
  title?: string
  children?: ReactNode
  action?: ReactNode
  /**
   * Survive the phone's cull of `banner--info` — and the timer below.
   *
   * A phone hides every info banner (see the `@media (max-width: 760px)` block
   * in app.css) on the reasoning that they explain how a screen works and a
   * small screen has no room for explanations. That is right for "here is how
   * pairing works" and wrong for an info banner that is *reporting* something —
   * the account dialog's says which of your hand-edited fields auto-fill just
   * refused to overwrite, and hiding it is precisely how auto-fill comes to look
   * broken. The `:not(.banner--keep)` escape hatch already existed in the
   * stylesheet for exactly this; this is the prop that reaches it.
   *
   * It now means one more thing, which is the same thing: a caller who has said
   * this message must not be hidden has also said it must not time out. See
   * `transient`.
   */
  keep?: boolean
}) {
  const { t } = useI18n()
  const Icon = tone === 'success' ? IconCheckCircle : tone === 'info' ? IconInfo : IconAlert

  /**
   * Three states rather than a boolean, because "leaving" is a real one: the
   * element has to stay mounted for as long as its fade takes to play, and
   * `gone` has to be distinguishable from `shown` or the fade would restart on
   * the next render.
   */
  const [phase, setPhase] = useState<'shown' | 'leaving' | 'gone'>('shown')

  /**
   * Which banners go away on their own, and which are only ever dismissed by
   * the person reading them.
   *
   * `info` and `success` report something that *happened* — a backup was
   * written, three fields were filled in for you — and the fact stays true
   * whether the sentence is still on screen or not. `warning` and `danger`
   * report something that is *still the case*: "no receiving account is
   * configured" is not news, it is a condition, and a condition that quietly
   * vanished after seven seconds would be read as "so it fixed itself". Those
   * two keep their place and get the close button instead, which is the user
   * saying "seen it" — a claim only the user is in a position to make.
   */
  const transient = !keep && (tone === 'info' || tone === 'success')

  /**
   * Take it off screen, through the fade where there is one.
   *
   * `prefers-reduced-motion` is asked at the moment of dismissal rather than
   * assumed either way. theme.css's global block already cuts animation
   * durations to 0.01ms under that setting, so the leaving phase would be
   * `BANNER_LEAVE_MS` of nothing visibly happening followed by an unmount;
   * going straight to `gone` is the same result without the wait.
   */
  const dismiss = useCallback(() => {
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    setPhase(reduced ? 'gone' : 'leaving')
  }, [])

  /*
   * A new message is a new banner, even inside the same mounted element.
   * Several callers swap a banner's text in place rather than re-keying it —
   * the account dialog's test-connection strip is the same `<Banner>` saying
   * three different things over one dialog's life — and a replacement that
   * arrived after the timer had run would never be seen at all. Setting the
   * phase it already has is a no-op React bails out of, so the renders where
   * nothing changed pay nothing for this.
   */
  useEffect(() => setPhase('shown'), [title, tone])

  useEffect(() => {
    if (!transient || phase !== 'shown') return
    const timer = window.setTimeout(dismiss, BANNER_TTL_MS)
    return () => window.clearTimeout(timer)
  }, [transient, phase, dismiss])

  useEffect(() => {
    if (phase !== 'leaving') return
    const timer = window.setTimeout(() => setPhase('gone'), BANNER_LEAVE_MS)
    return () => window.clearTimeout(timer)
  }, [phase])

  if (phase === 'gone') return null

  return (
    <div
      className={`banner banner--${tone}${keep ? ' banner--keep' : ''}${
        // A button beside the text needs ~110px it will not give back, which on
        // a 360px screen leaves the sentence wrapping inside a column a few
        // characters wide. `--stack` is what app.css hangs the phone rule off;
        // it is emitted only where there is an action, so nothing else moves.
        action ? ' banner--stack' : ''
      }${phase === 'leaving' ? ' banner--leaving' : ''}`}
      role={tone === 'danger' ? 'alert' : undefined}
    >
      <Icon className="banner__icon" size={16} />
      <div className="banner__body">
        {title ? <div className="banner__title">{title}</div> : null}
        {children}
      </div>
      {action}
      {/*
        Every banner can be closed, including the ones that never close
        themselves — that is the whole of what `warning` and `danger` get in
        place of a timer, and a banner reporting a condition the user has
        already decided to live with should not be a permanent tax on the
        screen it sits in.

        An `IconButton` rather than a bespoke cross so it inherits the 48px
        touch floor `icon-btn` already carries (`check:tap`), and
        `t('common.close')` rather than a word of its own because this is the
        same act the dialog header's cross performs.
      */}
      <IconButton className="banner__close" label={t('common.close')} onClick={dismiss}>
        <IconX size={15} />
      </IconButton>
    </div>
  )
}

/**
 * The one way this application says what state something is in.
 *
 * Before this existed, "paused" was grey italic text on the schedule screen, a
 * `.chip` on the inbox, a coloured dot in the log and a bare word in settings —
 * four visual languages for one idea, so none of them could be learned. Every
 * status now uses this, and a new state means picking a tone rather than
 * inventing a look.
 *
 * `dot` is for states that describe something *live* (armed, sending, waiting).
 * A label alone reads as a property; a label with a dot reads as a condition.
 */
export type StatusTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'

export function StatusChip({
  tone = 'neutral',
  label,
  title,
  dot = false,
  icon,
}: {
  tone?: StatusTone
  label: string
  /** Hover text — the place for the detail that would make the chip too wide. */
  title?: string
  dot?: boolean
  icon?: ReactNode
}) {
  return (
    <span className={`statuschip statuschip--${tone}`} title={title}>
      {dot ? <span className="statuschip__dot" aria-hidden="true" /> : null}
      {icon ? (
        <span className="statuschip__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="statuschip__label">{label}</span>
    </span>
  )
}

/**
 * The "there is nothing here yet" state.
 *
 * One rule, applied on all seven screens: an empty state says what the screen
 * is *for* and offers the one action that fills it. A bare title is a dead
 * end — "No activity yet" tells someone nothing they did not already know from
 * looking at the blank space.
 *
 * `hint` is therefore not decorative, and `action` is omitted only where the
 * screen genuinely fills itself (the activity log) or where the action lives
 * one obvious click away in the page head.
 */
export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: ReactNode
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="empty">
      <div className="empty__icon">{icon}</div>
      <div className="empty__title">{title}</div>
      {hint ? <div className="empty__hint">{hint}</div> : null}
      {action}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
  fullscreen,
  onEscape,
  headerExtra,
  bodyClassName = '',
  variant,
  // No English default: every caller passes a translated label, and a
  // hard-coded fallback would silently ship 'Close' into five other locales.
  closeLabel,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  /** Near-viewport sizing for content that needs the room — a read message, say. */
  fullscreen?: boolean
  /**
   * What Escape means, when it means something other than "close".
   *
   * The message reader opens full-screen and Escape steps *out* of full screen
   * before it closes anything — one key, two stages, which is what people
   * already expect from every other full-screen surface. Without this hook the
   * dialog would have to choose between owning Escape and letting its content
   * own it, and either choice is wrong for one of its callers.
   */
  onEscape?: () => void
  /** Controls that belong beside the title rather than in the footer. */
  headerExtra?: ReactNode
  bodyClassName?: string
  /**
   * Which *kind* of dialog this is, stamped on the panel as `data-variant`.
   *
   * The stylesheet needed a way to say "the message reader's header, not every
   * dialog's header", and what it had was `.modal:has(> .modal__body--reader)`
   * — reaching down to the body class to identify the panel above it. That is a
   * Chromium 105 selector. This app ships against `minSdkVersion 24`, where a
   * WebView that has never been updated is Chromium 51 and treats the whole
   * rule as invalid, so on exactly the devices the rules were written for, the
   * reader's header rules did not exist: the subject and five icons stayed
   * crammed onto one row and nothing in the CSS looked wrong. It is the second
   * time this trap has been sprung here (see the compose screen, 0.3.5).
   *
   * An attribute selector is Selectors 2 and works in every engine this app can
   * run in, and naming the panel is what the stylesheet actually wanted to do:
   * the body class describes the body, and a rule about the header should not
   * have to ask the body what it is.
   */
  variant?: 'reader'
  closeLabel: string
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  /**
   * `onClose` is an inline arrow at nearly every call site, so its identity
   * changes on every parent render — and a dialog re-renders its parent on
   * every keystroke, because that is where the edited draft lives.
   *
   * Holding it in a ref is what lets the effect below depend on `open` alone.
   * With `onClose` in the dependency list the whole effect tore down and set
   * itself up again for each character typed, re-arming the autofocus timer
   * every time; any render in which the focused field was momentarily
   * detached (an IME commit, a re-keyed field) left `document.activeElement`
   * on `<body>`, the "already focused inside" guard stopped applying, and
   * focus landed on the first focusable in the panel — the header's close
   * button. That is the "type one character and it jumps to Close, and you
   * cannot type any more" report.
   */
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // `isComposing` is true for every key pressed while an IME candidate
      // window is up. Escape there means "cancel the candidate", not "throw
      // away the dialog I am typing into".
      if (e.key !== 'Escape' || e.isComposing) return
      /*
       * `repeat` is true for every synthetic keydown the OS fires while a key
       * stays physically down — Windows' default is one after ~500ms, then
       * roughly every 30ms after that. Without this guard, a single press of
       * Escape held a fraction of a second too long fired this handler five
       * or six times before the finger lifted, and on the reader — whose
       * Escape is a two-stage ladder (leave full screen, then close) — that
       * walked both stages in one motion: reported as "Escape closes the
       * reader instead of leaving full screen", on a build where the ladder
       * itself was correct and the *first* stage did fire, just followed
       * immediately by the second because the key was still down.
       */
      if (e.repeat) return
      const escape = onEscapeRef.current
      if (escape) escape()
      else onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    // Move focus into the dialog so keyboard users are not left behind it.
    // This runs once per opening, never again while the dialog stays open.
    const timer = window.setTimeout(() => {
      const panel = panelRef.current
      if (!panel) return
      // If the user has already clicked (or tabbed) into something inside the
      // dialog by the time this fires, leave it alone.
      if (panel.contains(document.activeElement)) return
      // The body is where the actual content lives; the header's close button
      // is a DOM sibling that happens to come *first*, so a plain
      // `panel.querySelector(...)` would always land on it instead of the
      // first real field. Prefer the body, and only fall back to the whole
      // panel (which is how a content-less confirm dialog still gets a
      // focused Cancel/OK) when the body has nothing focusable in it.
      //
      // `.banner__close` is excluded for the same reason the header's cross is
      // not searched for: several dialogs open with a `Banner` above their
      // first field (the account dialog's auto-fill report, the send-test
      // result), and now that a banner carries a dismiss button that button is
      // the first focusable in the body. Landing on it would put the keyboard
      // on "throw this message away" instead of on the thing the dialog was
      // opened to edit.
      const focusable = 'input, textarea, select, button:not(.banner__close), [tabindex]'
      const target =
        bodyRef.current?.querySelector<HTMLElement>(focusable) ??
        panel.querySelector<HTMLElement>(focusable)
      target?.focus()
    }, 30)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.clearTimeout(timer)
    }
  }, [open])

  /**
   * Android's back gesture closes this dialog rather than the application.
   *
   * The same two-stage rule Escape already follows directly above, and read off
   * the same two refs so the key and the gesture cannot come to disagree: the
   * message reader steps out of full screen first and closes second, and that
   * has to be true whichever way the user asked.
   *
   * Registered only while `open`, so the handler stack holds exactly the
   * surfaces that are actually on screen — see `core/backStack.ts` for why the
   * newest is asked first. Returning `true` is the dialog claiming the gesture;
   * with no dialog open the stack falls through to the shell, which returns to
   * Home, and from Home to the platform, which exits.
   *
   * A separate effect from the one above rather than another line inside it:
   * that one also owns the autofocus timer and is documented at length as
   * depending on `open` alone, and folding a second concern into it is how the
   * dependency list would eventually grow the entry that broke it before.
   */
  useEffect(() => {
    if (!open) return
    return pushBackHandler(() => {
      const escape = onEscapeRef.current
      if (escape) escape()
      else onCloseRef.current()
      return true
    })
  }, [open])

  if (!open) return null

  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`modal ${wide ? 'modal--wide' : ''} ${fullscreen ? 'modal--fullscreen' : ''}`}
        data-variant={variant}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panelRef}
      >
        <div className="modal__header">
          <div className="modal__title">{title}</div>
          {headerExtra}
          <IconButton label={closeLabel} onClick={onClose}>
            <IconX size={17} />
          </IconButton>
        </div>
        <div className={`modal__body ${bodyClassName}`} ref={bodyRef}>
          {children}
        </div>
        {footer ? <div className="modal__footer">{footer}</div> : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export interface Toast {
  id: string
  tone: 'success' | 'error' | 'info'
  title: string
  detail?: string
}

interface ToastApi {
  push: (toast: Omit<Toast, 'id'>) => void
}

const ToastContext = createContext<ToastApi>({ push: () => {} })

export function useToast(): ToastApi {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const [toasts, setToasts] = useState<Toast[]>([])

  const push = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = newId('toast')
    setToasts((prev) => [...prev, { ...toast, id }])
    // Errors stay long enough to read the server's message; successes do not.
    const ttl = toast.tone === 'error' ? 9000 : 4200
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, ttl)
  }, [])

  const api = useMemo(() => ({ push }), [push])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {/* `toast`, not `t` — the row used to be named for the one letter this
            component now needs for the translator. */}
        {toasts.map((toast) => {
          const Icon =
            toast.tone === 'success'
              ? IconCheckCircle
              : toast.tone === 'error'
                ? IconAlert
                : IconInfo
          return (
            <div className={`toast toast--${toast.tone}`} key={toast.id}>
              <Icon className="toast__icon" size={17} />
              <div className="toast__body">
                <div className="toast__title">{toast.title}</div>
                {toast.detail ? <div className="toast__detail">{toast.detail}</div> : null}
              </div>
              {/* `t('common.close')`, like every other close button in the
                  app. The literal 'Dismiss' that used to be here was the one
                  control whose accessible name a Chinese screen reader read
                  out in English. */}
              <IconButton
                label={t('common.close')}
                onClick={() => setToasts((prev) => prev.filter((x) => x.id !== toast.id))}
              >
                <IconX size={15} />
              </IconButton>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Confirm dialog — a promise-based replacement for window.confirm, which
// Electron renders as an OS box that ignores the app's theme entirely.
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  title: string
  body?: string
  confirmLabel: string
  cancelLabel: string
  danger?: boolean
  /**
   * When set, the confirm button stays disabled until the user types this
   * text exactly. For the handful of actions destructive enough that a plain
   * OK/Cancel is too easy to click through out of habit — deleting hundreds
   * of messages at once, say — after dozens of routine single-row deletes
   * trained the same click.
   */
  requireTypedConfirmation?: string
}

export function useConfirm() {
  const [state, setState] = useState<
    (ConfirmOptions & { resolve: (v: boolean) => void }) | null
  >(null)
  const [typed, setTyped] = useState('')

  const confirm = useCallback((options: ConfirmOptions) => {
    setTyped('')
    return new Promise<boolean>((resolve) => setState({ ...options, resolve }))
  }, [])

  const close = (value: boolean) => {
    state?.resolve(value)
    setState(null)
  }

  const locked = Boolean(state?.requireTypedConfirmation) && typed !== state?.requireTypedConfirmation

  const element = state ? (
    <Modal
      open
      title={state.title}
      onClose={() => close(false)}
      closeLabel={state.cancelLabel}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            {state.cancelLabel}
          </Button>
          <Button
            variant={state.danger ? 'danger' : 'primary'}
            disabled={locked}
            onClick={() => close(true)}
          >
            {state.confirmLabel}
          </Button>
        </>
      }
    >
      {state.body ? <p style={{ margin: 0, color: 'var(--text-2)' }}>{state.body}</p> : null}
      {state.requireTypedConfirmation ? (
        <input
          className="input"
          autoFocus
          spellCheck={false}
          autoComplete="off"
          placeholder={state.requireTypedConfirmation}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      ) : null}
    </Modal>
  ) : null

  return { confirm, confirmElement: element }
}

/** Stable DOM id helper for label/control pairs. */
export function useFieldId(prefix: string): string {
  const id = useId()
  return `${prefix}${id}`
}
