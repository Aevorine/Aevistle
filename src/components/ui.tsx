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
import { IconAlert, IconCheckCircle, IconInfo, IconX } from './icons'
import { newId } from '../core/types'

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
      {children}
    </button>
  )
}

export function IconButton({
  label,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button className="icon-btn" title={label} aria-label={label} {...rest}>
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
}: {
  title: string
  subtitle?: string
  action?: ReactNode
}) {
  return (
    <div className="page-head">
      <div className="page-head__text">
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {action ? <div className="page-head__actions">{action}</div> : null}
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
}) {
  const labelEl = label ? (
    <label className="field__label" htmlFor={htmlFor}>
      {label}
      {optional ? <span className="field__optional">{optional}</span> : null}
      {labelHint ? <span className="field__labelhint">{labelHint}</span> : null}
    </label>
  ) : null

  return (
    <div className="field">
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

export function Banner({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: BannerTone
  title?: string
  children?: ReactNode
  action?: ReactNode
}) {
  const Icon = tone === 'success' ? IconCheckCircle : tone === 'info' ? IconInfo : IconAlert
  return (
    <div className={`banner banner--${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon className="banner__icon" size={16} />
      <div className="banner__body">
        {title ? <div className="banner__title">{title}</div> : null}
        {children}
      </div>
      {action}
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
      const target =
        bodyRef.current?.querySelector<HTMLElement>(
          'input, textarea, select, button, [tabindex]',
        ) ?? panel.querySelector<HTMLElement>('input, textarea, select, button, [tabindex]')
      target?.focus()
    }, 30)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.clearTimeout(timer)
    }
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
        {toasts.map((t) => {
          const Icon =
            t.tone === 'success' ? IconCheckCircle : t.tone === 'error' ? IconAlert : IconInfo
          return (
            <div className={`toast toast--${t.tone}`} key={t.id}>
              <Icon className="toast__icon" size={17} />
              <div className="toast__body">
                <div className="toast__title">{t.title}</div>
                {t.detail ? <div className="toast__detail">{t.detail}</div> : null}
              </div>
              <IconButton
                label="Dismiss"
                onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
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
