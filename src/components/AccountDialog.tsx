/**
 * Add / edit a mail account.
 *
 * Picking a provider fills host, port and encryption, so the common path is
 * "choose Gmail, type your address, paste an app password". The manual fields
 * stay visible rather than hidden behind an "advanced" toggle, because a
 * wrong port is the single most common reason a send fails and people need to
 * see it to fix it.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Banner, Button, Field, Modal, Switch } from './ui'
import { IconExternal, IconShield } from './icons'
import { localeMeta, useI18n, type TranslationKey } from '../i18n'
import { useNarrow } from './useNarrow'
import {
  PROVIDERS,
  autoConfigForAddress,
  carryAutoFlags,
  providerById,
  providerForAddress,
  type AutoConfig,
  type AutoField,
} from '../core/providers'
import { advisoryKey } from '../core/transport'
import { hasErrors, validateAccount } from '../core/validate'
import { getBridge } from '../core/bridge'
import { requiresOAuth, supportsOAuth, type OAuthAccountStatus } from '../core/oauth'
import {
  defaultInboxAccountState,
  newId,
  type AuthMethod,
  type InboxAccountState,
  type MailAccount,
  type SendResult,
  type TransportSecurity,
} from '../core/types'

const SECURITY_LABEL: Record<TransportSecurity, TranslationKey> = {
  ssl: 'account.securitySsl',
  starttls: 'account.securityStarttls',
  none: 'account.securityNone',
}

/**
 * `validateAccount`'s `Issue.field`, worded the same as the label already
 * printed above each input.
 *
 * This exists for the "why is the test button grey" text below. Reusing the
 * field's own label rather than writing a second name for the same box means
 * the reason and the input agree, and it means a field validation ever grows
 * a new required check, its name shows up here for free instead of silently
 * falling out of the sentence.
 */
const BLOCKED_FIELD_LABEL: Partial<Record<string, TranslationKey>> = {
  fromAddress: 'account.fromAddress',
  fromName: 'account.fromName',
  replyTo: 'account.replyTo',
  host: 'account.host',
  port: 'account.port',
  username: 'account.username',
  authMethod: 'account.authMethod',
}

/** What the connection line says, per state. `connected` is formatted separately — it names the mailbox. */
const OAUTH_STATE_LABEL: Record<string, TranslationKey> = {
  unsupported: 'account.oauthUnsupported',
  unconfigured: 'account.oauthUnconfigured',
  disconnected: 'account.oauthNotConnected',
  needsConsent: 'account.oauthNeedsConsent',
}

/**
 * The fields the address can fill in on its own.
 *
 * Every one of them is also a field the user is allowed to type in, which is
 * the entire difficulty: re-deriving them on each keystroke of the address is
 * what makes "type your address and you are done" work, and it is also what
 * would silently throw away a port someone corrected by hand. So each one
 * carries a flag, and auto-fill only ever writes the ones still unflagged.
 */

/** The subset worth telling the user about — label and provider are cosmetic. */
const REPORTED_FIELDS: AutoField[] = [
  'host',
  'port',
  'security',
  'username',
  'imapHost',
  'imapPort',
  'imapSecurity',
  'imapUsername',
]

const ALL_AUTO_FIELDS: AutoField[] = ['providerId', 'label', ...REPORTED_FIELDS]


/**
 * A group-name box whose suggestion list we actually control the look of.
 *
 * This was a `<datalist>`, which is the right semantics and the wrong
 * rendering. Chromium draws that popup as browser chrome — outside the
 * document, at the platform's own type size — and no page CSS can reach it.
 * So while every other piece of text in the app is 16px 宋体 / Times New Roman,
 * the one list you use to *pick an existing group* was whatever the OS felt
 * like, which is what "the group display text is too small" meant.
 *
 * It also explains why a DOM sweep found nothing below 16px: a datalist popup
 * is not in the DOM to be measured. The list is rendered in the page now, so
 * it inherits the same scale as everything around it.
 *
 * Behaviour is unchanged: free text, typing filters, suggestions optional.
 */
function GroupInput({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string
  options: string[]
  placeholder: string
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const wrap = useRef<HTMLDivElement>(null)

  const matches = useMemo(() => {
    const query = value.trim().toLowerCase()
    const unique = [...new Set(options.filter(Boolean))]
    /*
     * A value that already *is* one of the groups means browsing, not typing.
     *
     * Filtering on it would leave one entry at best and, when the match is
     * exact, nothing at all — so opening the box on an account already filed
     * under "个人邮箱" showed an empty list, which is precisely the moment
     * someone is trying to move it to a different group. Show the whole set
     * then, and only narrow once what is typed is not a group yet.
     */
    if (!query || unique.some((o) => o.toLowerCase() === query)) return unique
    return unique.filter((o) => o.toLowerCase().includes(query))
  }, [options, value])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const commit = (v: string) => {
    onChange(v)
    setOpen(false)
    setActive(-1)
  }

  return (
    <div className="suggest" ref={wrap}>
      <input
        className="input"
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-autocomplete="list"
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
          setActive(-1)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            /*
             * Close the list, not the dialog behind it.
             *
             * The modal listens for Escape on `document` in the bubble phase,
             * and React's `stopPropagation` only stops React's own synthetic
             * propagation — the native event would still reach it and throw
             * away the whole form. Stopping the native event is the part that
             * actually works. (Same shape as the full-screen image viewer,
             * which lost a dialog to exactly this.)
             */
            e.nativeEvent.stopImmediatePropagation()
            e.preventDefault()
            setOpen(false)
            setActive(-1)
            return
          }
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            setOpen(true)
            return
          }
          if (!open || matches.length === 0) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((i) => (i + 1) % matches.length)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => (i <= 0 ? matches.length : i) - 1)
          } else if (e.key === 'Enter' && active >= 0) {
            // Only swallows Enter when something is highlighted, so Enter with
            // the list merely open still submits the form.
            e.preventDefault()
            commit(matches[active])
          }
        }}
      />
      {open && matches.length > 0 ? (
        <ul className="suggest__list" role="listbox">
          {matches.map((m, i) => (
            <li
              key={m}
              role="option"
              aria-selected={i === active}
              className={`suggest__item${i === active ? ' is-active' : ''}`}
              // `mousedown` rather than `click`: the input's blur would close
              // the list before a click ever landed.
              onMouseDown={(e) => {
                e.preventDefault()
                commit(m)
              }}
              onMouseEnter={() => setActive(i)}
            >
              {m}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function blankAccount(): MailAccount {
  const now = Date.now()
  return {
    id: newId('acct'),
    label: '',
    fromName: '',
    fromAddress: '',
    host: '',
    port: 465,
    security: 'ssl',
    username: '',
    authMethod: 'password',
    hasSecret: false,
    timeoutMs: 20_000,
    autoNegotiate: true,
    allowInvalidCert: false,
    poolMaxMessages: 50,
    createdAt: now,
    updatedAt: now,
  }
}

export function AccountDialog({
  open,
  initial,
  inboxConfig,
  onClose,
  onSave,
  onSaveInbox,
  onTest,
  onTestInbox,
  onOpenExternal,
  knownGroups = [],
}: {
  open: boolean
  initial?: MailAccount
  /** This account's current IMAP configuration, if it has one. */
  inboxConfig?: InboxAccountState
  onClose: () => void
  onSave: (account: MailAccount, secret?: string) => Promise<void>
  onSaveInbox: (config: InboxAccountState, secret?: string) => Promise<void>
  onTest: (account: MailAccount, secret?: string) => Promise<SendResult>
  onTestInbox: (config: InboxAccountState, secret?: string) => Promise<SendResult>
  onOpenExternal: (url: string) => void
  /** Existing group names, offered as completions. Purely a convenience. */
  knownGroups?: string[]
}) {
  const { t, locale } = useI18n()
  const narrow = useNarrow()
  const [account, setAccount] = useState<MailAccount>(initial ?? blankAccount())
  const [secret, setSecret] = useState('')
  const [testing, setTesting] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [testResult, setTestResult] = useState<SendResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [inbox, setInbox] = useState<InboxAccountState>(
    inboxConfig ?? defaultInboxAccountState(account.id),
  )
  const [inboxSecret, setInboxSecret] = useState('')
  const [inboxTesting, setInboxTesting] = useState(false)
  const [inboxElapsed, setInboxElapsed] = useState(0)
  const [inboxTestResult, setInboxTestResult] = useState<SendResult | null>(null)

  /**
   * What the trusted layer says about this account's OAuth2 grant.
   *
   * `null` means "not asked yet", which is different from `disconnected` and has
   * to stay different: showing "not connected" while the answer is still in
   * flight would send someone to re-run a consent they already completed.
   */
  const [oauthStatus, setOauthStatus] = useState<OAuthAccountStatus | null>(null)
  const [oauthBusy, setOauthBusy] = useState(false)
  /** The last consent failure, in the provider's own words. Cleared on the next attempt. */
  const [oauthError, setOauthError] = useState<string | null>(null)

  /**
   * Which of the auto-fillable fields the user has taken over.
   *
   * An account being *edited* starts with all of them flagged: whatever is
   * stored was configured on purpose, possibly years ago against a server that
   * no preset knows about, and re-typing the address to fix a typo must not
   * rewrite it. A new account starts with none flagged, so the address drives
   * everything until the user disagrees with it.
   */
  const [touched, setTouched] = useState<ReadonlySet<AutoField>>(
    () => new Set(initial ? ALL_AUTO_FIELDS : []),
  )
  const [auto, setAuto] = useState<AutoConfig | null>(() =>
    initial ? autoConfigForAddress(initial.fromAddress) : null,
  )

  /**
   * Whether "More settings" is expanded.
   *
   * Desktop starts open and stays that way — `!narrow` — because the section
   * was never collapsed there and nothing about it should look different. A
   * phone starts collapsed: everything inside (label, group, reply-to, the two
   * switches) is optional or warning-only per `validateAccount`, so hiding it
   * costs nothing a user cannot recover with one tap.
   */
  const [moreOpen, setMoreOpen] = useState(!narrow)

  const markTouched = (...fields: AutoField[]) =>
    setTouched((prev) => {
      const next = new Set(prev)
      for (const f of fields) next.add(f)
      return next
    })

  /**
   * Bumped every time a test starts, and checked when one finishes.
   *
   * Cancelling cannot abort the socket the main process is already holding, so
   * "cancel" means "stop showing me this one" — the late reply is dropped
   * rather than overwriting a result the user has moved on from.
   */
  const runId = useRef(0)
  const inboxRunId = useRef(0)

  /**
   * The two boxes a finished test writes its answer into.
   *
   * They exist only to be scrolled to — see the effects below, and the comment
   * there for the measurement that made them necessary.
   */
  const testReport = useRef<HTMLDivElement>(null)
  const inboxReport = useRef<HTMLDivElement>(null)

  /**
   * `<details>`'s `open` is not a normal React-controlled attribute: React
   * happily *sets* it (`open={true}` on a closed node works every time) but
   * does not reliably *remove* it — a node the user has natively toggled
   * open once stays open on every subsequent render with `open={false}`,
   * because React's reconciler does not call `removeAttribute('open')` on
   * this particular boolean attribute. `setMoreOpen`/`onToggle` below still
   * exist because the summary's own click needs `moreOpen` to read from for
   * the render (and the reply-to-error effect needs to *open* it, which
   * React can do), but *closing* it back down — the reset effect returning a
   * reused dialog instance to its default state — has to bypass React and
   * set the DOM node's own `.open` IDL property directly. Kept as a plain
   * ref assignment, not a second render, because a second render would hit
   * the exact same diffing gap.
   */
  const moreDetailsRef = useRef<HTMLDetailsElement>(null)

  useEffect(() => {
    if (open) {
      const a = initial ?? blankAccount()
      setAccount(a)
      setSecret('')
      setTestResult(null)
      setTesting(false)
      setElapsed(0)
      setInbox(inboxConfig ?? defaultInboxAccountState(a.id))
      setInboxSecret('')
      setInboxTestResult(null)
      setInboxTesting(false)
      setInboxElapsed(0)
      setTouched(new Set(initial ? ALL_AUTO_FIELDS : []))
      setAuto(autoConfigForAddress(a.fromAddress))
      setOauthStatus(null)
      setOauthError(null)
      setOauthBusy(false)
      // `moreOpen`'s own `useState(!narrow)` initialiser only runs on the
      // component's first-ever mount. The dialog is one long-lived instance
      // reused for every Add and every Edit — SettingsView renders a single
      // `<AccountDialog>` with no `key` — so without this line, expanding
      // "More settings" while adding one account left it expanded (or a
      // dismissed expand left it collapsed) the next time any account's
      // dialog opened, including a different account's. Belongs in this
      // reset block for the same reason `setTouched`/`setAuto` do: it is
      // per-open-session state, not state that should survive past `open`
      // going false.
      setMoreOpen(!narrow)
      // See `moreDetailsRef`'s own comment: this is not redundant with the
      // `setMoreOpen` call above. That updates the value the summary's
      // click handler and the reply-to-error effect read; this is what
      // actually closes the DOM node when the dialog was left open, which
      // the `open={moreOpen}` prop alone does not reliably do.
      if (moreDetailsRef.current) moreDetailsRef.current.open = !narrow
      runId.current++
      inboxRunId.current++
    }
    // Only the open transition matters — inboxConfig/initial identity churns
    // on every parent render and must not reset the form the user is editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // A spinner with no numbers on it is indistinguishable from a hung app —
  // which is exactly what the old "Testing…" looked like while it sat on a
  // two-minute DNS timeout. A counter makes waiting legible.
  useEffect(() => {
    if (!testing) return
    const started = Date.now()
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000))
    }, 250)
    return () => window.clearInterval(timer)
  }, [testing])

  useEffect(() => {
    if (!inboxTesting) return
    const started = Date.now()
    const timer = window.setInterval(() => {
      setInboxElapsed(Math.floor((Date.now() - started) / 1000))
    }, 250)
    return () => window.clearInterval(timer)
  }, [inboxTesting])

  /**
   * Take the user to the answer. This is what "the test button does nothing"
   * actually was.
   *
   * Both reports render at the far end of a form that is one long scroller, and
   * the send test's button is in the footer, which never moves. Measured on the
   * built bundle at 360x800 with receiving switched on: the report lands at
   * y=2426 inside a body whose visible band ends at y=721, and `scrollTop` stays
   * at 0 — so 1705px of form sit between the button and its own result, and
   * pressing it changes precisely nothing on screen. A phone has no scrollbar to
   * hint that anything appeared, which is why this reads as a dead button there
   * and merely as a flaky one on a desktop (551px out at 1280x900).
   *
   * `block: 'nearest'` rather than `'center'`: a result already on screen must
   * not be yanked around, and a report taller than the viewport should show its
   * top — which is where the verdict is.
   */
  useEffect(() => {
    if (!testResult) return
    testReport.current?.scrollIntoView({ block: 'nearest' })
  }, [testResult])

  useEffect(() => {
    if (!inboxTestResult) return
    inboxReport.current?.scrollIntoView({ block: 'nearest' })
  }, [inboxTestResult])

  const patch = (p: Partial<MailAccount>) => {
    setAccount((a) => ({ ...a, ...p }))
    setTestResult(null)
  }

  // -------------------------------------------------------------------------
  // OAuth2
  //
  // The bridge is fetched here rather than passed in as a prop. `getBridge`
  // caches and is the documented way to reach the platform layer from outside
  // the state tree (`core/download.ts` does the same), and the alternative —
  // threading three more callbacks through `SettingsView` — would put the
  // consent flow's plumbing in a file that has nothing to do with it.
  // -------------------------------------------------------------------------

  const oauthAvailable = supportsOAuth(account.providerId)
  const isOauth = account.authMethod === 'oauth2'

  const refreshOauthStatus = useMemo(
    () => async (accountId: string, providerId: string | undefined) => {
      try {
        const bridge = await getBridge()
        if (!bridge.oauthStatus) {
          // A platform with no consent flow at all — the browser preview. Said
          // as `unsupported` rather than left null, so the panel stops waiting.
          setOauthStatus({ state: 'unsupported' })
          return
        }
        setOauthStatus(await bridge.oauthStatus(accountId, providerId ?? ''))
      } catch {
        setOauthStatus({ state: 'unsupported' })
      }
    },
    [],
  )

  useEffect(() => {
    if (!open || !isOauth) return
    void refreshOauthStatus(account.id, account.providerId)
  }, [open, isOauth, account.id, account.providerId, refreshOauthStatus])

  /**
   * Hand the user to their browser and wait.
   *
   * This resolves when they are finished, which can be minutes — the button
   * stays in its waiting state for the whole of it rather than timing out
   * optimistically, because an app that gave up while the consent page was
   * still open would leave a stored grant nothing in the UI knew about.
   */
  const runConsent = async () => {
    setOauthBusy(true)
    setOauthError(null)
    try {
      const bridge = await getBridge()
      if (!bridge.oauthConsent) {
        setOauthStatus({ state: 'unsupported' })
        return
      }
      const result = await bridge.oauthConsent(
        account.id,
        account.providerId ?? '',
        account.fromAddress,
      )
      if (result.ok) {
        // The address the provider signed in as, which is not always the one
        // that was typed — someone with three Google accounts picks from a list.
        // It is also the exact string XOAUTH2 authenticates as, so it belongs in
        // the username box, flagged as hand-edited so a later address edit does
        // not quietly overwrite the mailbox the grant is actually for.
        if (result.address && result.address !== account.username) {
          markTouched('username')
          patch({ username: result.address })
        }
      } else if (!result.cancelled && result.error) {
        // Cancelling is not a failure and gets no red text — the state line
        // below still says "not connected", which is the whole truth of it.
        setOauthError(result.error)
      }
      await refreshOauthStatus(account.id, account.providerId)
    } catch (e) {
      setOauthError(e instanceof Error ? e.message : String(e))
    } finally {
      setOauthBusy(false)
    }
  }

  /**
   * Forget the grant on this device.
   *
   * Deliberately not called "revoke": the mailbox keeps the authorization until
   * the user removes Aevistle from their provider's connected-apps page, and a
   * button that implied otherwise would leave people believing they had
   * withdrawn access they had not.
   */
  const disconnectOauth = async () => {
    setOauthBusy(true)
    setOauthError(null)
    try {
      const bridge = await getBridge()
      await bridge.oauthDisconnect?.(account.id)
      await refreshOauthStatus(account.id, account.providerId)
    } catch (e) {
      setOauthError(e instanceof Error ? e.message : String(e))
    } finally {
      setOauthBusy(false)
    }
  }

  /**
   * Switching mechanism resets what the panel is showing, never what is stored.
   *
   * Flipping to a password and back must not silently drop a working grant —
   * that is `Disconnect`'s job, and it is one press away. What it does clear is
   * the *displayed* status, which would otherwise describe the mechanism the
   * user just switched away from.
   */
  const setAuthMethod = (method: AuthMethod) => {
    patch({ authMethod: method })
    setOauthStatus(null)
    setOauthError(null)
  }

  const preset = providerById(account.providerId)
  const issues = useMemo(() => validateAccount(account), [account])
  const blocked = hasErrors(issues)

  /**
   * A blocking reply-to error must never be hidden behind a closed
   * disclosure. Desktop is already open (`moreOpen` starts `!narrow`, i.e.
   * `true`), so this is a no-op there; on a phone it forces the section open
   * the moment `validateAccount` reports the one error that lives inside it.
   */
  useEffect(() => {
    const replyToBlocked = issues.some(
      (issue) => issue.field === 'replyTo' && issue.severity === 'error',
    )
    if (replyToBlocked) setMoreOpen(true)
  }, [issues])

  /**
   * Joins field names the way the reader's own language does — "A, B and C",
   * "A、B和C" — rather than a fixed ", " that would read as broken grammar in
   * a third of the app's locales the moment a third field is missing.
   */
  const fieldListFormat = useMemo(
    () => new Intl.ListFormat(localeMeta(locale).intlTag, { style: 'long', type: 'conjunction' }),
    [locale],
  )

  /**
   * Why the send test button below is grey, in words, on every platform.
   *
   * `blocked` is true from the instant a new-account dialog opens — every
   * required field starts empty — and desktop has always explained that for
   * free: the per-field hints sit in the empty column beside each input. A
   * phone has no such column, and the mobile media query below hides
   * `.field__hint` altogether, on the reasoning that a hint restates what an
   * input already shows. This one does not — it is the only place on a 360px
   * screen that ever says *which* boxes are still empty — so it renders with
   * `field__hint--keep` and is named in the media query's own comment as the
   * reason that escape hatch exists.
   */
  const blockedFields = useMemo(() => {
    const seen = new Set<string>()
    const labels: string[] = []
    for (const issue of issues) {
      if (issue.severity !== 'error' || !issue.field) continue
      const key = BLOCKED_FIELD_LABEL[issue.field]
      if (!key || seen.has(issue.field)) continue
      seen.add(issue.field)
      labels.push(t(key))
    }
    return labels
  }, [issues, t])

  const inboxPatch = (p: Partial<InboxAccountState>) => {
    setInbox((i) => ({ ...i, ...p }))
    setInboxTestResult(null)
  }

  /**
   * The receive test's own version of `blockedFields` above.
   *
   * Its button is disabled on a plain condition rather than `validateAccount`
   * — receiving has no validator of its own — so the two required fields are
   * named directly instead of read back out of an issue list.
   */
  const inboxBlockedFields = useMemo(() => {
    const labels: string[] = []
    if (!inbox.imapHost) labels.push(t('inbox.imapHost'))
    if (!inbox.imapUsername) labels.push(t('account.username'))
    return labels
  }, [inbox.imapHost, inbox.imapUsername, t])
  const inboxBlocked = inboxBlockedFields.length > 0

  /**
   * Everything we can work out about the receive side from what is already on
   * screen: the chosen provider first, the address domain second.
   *
   * `force` overwrites what is there; without it existing values win, so
   * re-picking a provider never clobbers a server someone typed by hand.
   */
  const inboxDefaults = (force: boolean): Partial<InboxAccountState> | null => {
    const p = providerById(account.providerId) ?? providerForAddress(account.fromAddress)
    const username = account.username || account.fromAddress
    if (!p?.imapHost) {
      // No preset match, but the username is still worth filling in — it is
      // the same address in every case we have ever seen.
      return username && (force || !inbox.imapUsername) ? { imapUsername: username } : null
    }
    return {
      ...(force || !inbox.imapHost
        ? { imapHost: p.imapHost, imapPort: p.imapPort, imapSecurity: p.imapSecurity }
        : {}),
      ...(force || !inbox.imapUsername ? { imapUsername: username } : {}),
    }
  }

  const applyProvider = (id: string) => {
    const p = providerById(id)
    if (!p) return
    patch({
      providerId: id,
      host: p.host || account.host,
      port: p.port,
      security: p.security,
      /*
       * Some providers no longer have a password path to leave the user on.
       *
       * Picking "Outlook / Hotmail" and being shown a password box is the exact
       * shape of the bug this feature exists to close: the account saves, the
       * form looks complete, and every send fails at sign-in because Microsoft
       * stopped accepting passwords for personal mailboxes on 30 April 2026.
       * Selecting the only mechanism that works is not overriding a decision —
       * nobody has made one yet, and the dropdown below is right there for
       * anyone who disagrees.
       */
      ...(requiresOAuth(id) && account.authMethod !== 'none'
        ? { authMethod: 'oauth2' as const }
        : {}),
    })
    // Picking from the dropdown is a deliberate choice about the servers, so
    // it overwrites and it counts as hand-editing them — a later address
    // change must not quietly undo it.
    markTouched('providerId', 'host', 'port', 'security')
    if (p.imapHost) {
      inboxPatch({
        imapHost: p.imapHost,
        imapPort: p.imapPort,
        imapSecurity: p.imapSecurity,
        imapUsername: inbox.imapUsername || account.username || account.fromAddress,
      })
      markTouched('imapHost', 'imapPort', 'imapSecurity')
    }
  }

  /**
   * Re-derive everything the address implies.
   *
   * `force` is the "go back to automatic" path: it ignores the hand-edit flags
   * and rewrites the lot. Without it, a flagged field is left exactly as it is,
   * which is what makes this safe to run on every keystroke.
   */
  const applyAuto = (address: string, force: boolean) => {
    const cfg = autoConfigForAddress(address)
    setAuto(cfg)
    setTestResult(null)
    setInboxTestResult(null)

    if (!cfg) {
      setAccount((a) => ({ ...a, fromAddress: address }))
      return
    }
    const p = cfg.preset

    /*
     * Changing the domain is not a typo fix — it is a different mailbox.
     *
     * Editing an existing account starts with every field flagged as
     * hand-edited, on the reasoning that a stored config was chosen on
     * purpose. That is right for `a@qq.com` → `ab@qq.com`, and wrong for
     * `me@outlook.com` → `me@gmail.com`, where it left Microsoft's servers
     * sitting under a Gmail address and nothing at all appeared to happen.
     *
     * So on a domain change the flags are recomputed rather than trusted:
     * only fields that genuinely differ from what the *old* address implied
     * were ever a customisation, and only those survive. Computed into a
     * local because `setTouched` will not have landed by the time `may` runs.
     */
    const effective = force
      ? touched
      : carryAutoFlags(account.fromAddress, address, { ...account, ...inbox }, touched)
    if (effective !== touched) setTouched(effective)

    const may = (f: AutoField) => force || !effective.has(f)

    setAccount((a) => {
      const next: MailAccount = { ...a, fromAddress: address }
      // A guessed host is not a provider, so the dropdown goes back to "—"
      // rather than claiming a preset that does not exist.
      if (may('providerId')) {
        next.providerId = cfg.guessed ? undefined : p.id
        // Same reasoning as `applyProvider`'s: typing an @outlook.com address
        // has to land on the mechanism that still works, not on a password box
        // whose contents can never be accepted.
        if (requiresOAuth(next.providerId) && next.authMethod !== 'none') {
          next.authMethod = 'oauth2'
        }
      }
      if (may('label')) next.label = cfg.guessed ? cfg.domain : p.name
      if (may('host')) next.host = p.host
      if (may('port')) next.port = p.port
      if (may('security')) next.security = p.security
      if (may('username')) next.username = address
      return next
    })

    setInbox((i) => {
      const next: InboxAccountState = { ...i }
      if (p.imapHost) {
        if (may('imapHost')) next.imapHost = p.imapHost
        if (may('imapPort') && p.imapPort) next.imapPort = p.imapPort
        if (may('imapSecurity') && p.imapSecurity) next.imapSecurity = p.imapSecurity
      }
      if (may('imapUsername')) next.imapUsername = address
      return next
    })
  }

  /**
   * The fields the user has taken over *and* changed away from what the
   * address would give them.
   *
   * Flagged-but-identical does not count: typing `993` into a box that already
   * said 993 is not a disagreement, and offering to "restore" it would be
   * offering to do nothing.
   */
  const autoOverrides = useMemo(() => {
    if (!auto) return [] as AutoField[]
    const p = auto.preset
    const out: AutoField[] = []
    const cmp = (f: AutoField, actual: unknown, wanted: unknown) => {
      if (touched.has(f) && actual !== wanted) out.push(f)
    }
    cmp('host', account.host, p.host)
    cmp('port', account.port, p.port)
    cmp('security', account.security, p.security)
    cmp('username', account.username, account.fromAddress)
    if (p.imapHost) {
      cmp('imapHost', inbox.imapHost, p.imapHost)
      cmp('imapPort', inbox.imapPort, p.imapPort)
      cmp('imapSecurity', inbox.imapSecurity, p.imapSecurity)
    }
    cmp('imapUsername', inbox.imapUsername, account.fromAddress)
    return out
  }, [auto, touched, account, inbox])

  /**
   * Turning receiving on fills the server in, rather than presenting four
   * empty boxes.
   *
   * This is the path that made the feature look broken: an account created
   * before receiving existed has no IMAP host, so flipping the switch used to
   * reveal a blank form. Anyone who then saved without filling it in got a
   * config that could never connect — and, before the `saveInboxAccount` fix,
   * one that silently reverted to off as well.
   */
  const toggleInbox = (enabled: boolean) => {
    if (!enabled) {
      inboxPatch({ enabled: false })
      return
    }
    inboxPatch({ enabled: true, ...(inboxDefaults(false) ?? {}) })
  }

  /**
   * Every edit of the address re-configures the account, not just the first.
   *
   * The old rule was "fill in the blanks, once": it keyed off `!providerId` and
   * `!inbox.imapHost`, so correcting `gmali.com` to `gmail.com` left the form
   * pointing at whatever the typo had produced — and since the typo produced
   * nothing, at nothing. Deriving it every time is the behaviour people expect
   * from an address box; the hand-edit flags are what keeps that from being
   * destructive.
   */
  const onAddressChange = (value: string) => {
    applyAuto(value, false)
  }

  /** Throw away every hand edit and go back to what the address implies. */
  const restoreAuto = () => {
    setTouched(new Set())
    applyAuto(account.fromAddress, true)
  }

  const runTest = async () => {
    const id = ++runId.current
    setTesting(true)
    setElapsed(0)
    setTestResult(null)
    try {
      const result = await onTest(account, secret || undefined)
      if (runId.current !== id) return
      setTestResult(result)
    } catch (e) {
      if (runId.current !== id) return
      setTestResult({
        ok: false,
        accepted: [],
        rejected: [],
        durationMs: 0,
        error: e instanceof Error ? e.message : String(e),
        errorKind: 'unknown',
      })
    } finally {
      if (runId.current === id) setTesting(false)
    }
  }

  const cancelTest = () => {
    runId.current++
    setTesting(false)
    setElapsed(0)
  }

  const runInboxTest = async () => {
    const id = ++inboxRunId.current
    setInboxTesting(true)
    setInboxElapsed(0)
    setInboxTestResult(null)
    try {
      const result = await onTestInbox(
        { ...inbox, accountId: account.id, enabled: true },
        /*
         * The send password, when the receive box is empty.
         *
         * Leaving it empty is the documented normal case — `inbox.passwordHint`
         * says it is usually the same app password — and both back ends fall
         * back to the *stored* SMTP secret for exactly that reason. Neither can
         * on an account that has not been saved yet: nothing is in the keystore
         * until Save, so the receive test refused with "No password stored for
         * receiving" before opening a socket, on the one screen whose whole
         * purpose is testing before you commit. The password the user is looking
         * at is the one they meant.
         */
        inboxSecret || secret || undefined,
      )
      if (inboxRunId.current !== id) return
      setInboxTestResult(result)
    } catch (e) {
      if (inboxRunId.current !== id) return
      setInboxTestResult({
        ok: false,
        accepted: [],
        rejected: [],
        durationMs: 0,
        error: e instanceof Error ? e.message : String(e),
        errorKind: 'unknown',
      })
    } finally {
      if (inboxRunId.current === id) setInboxTesting(false)
    }
  }

  const cancelInboxTest = () => {
    inboxRunId.current++
    setInboxTesting(false)
    setInboxElapsed(0)
  }

  /** Adopt the receive port and encryption the ladder actually got through on. */
  const applyInboxAdjusted = () => {
    const d = inboxTestResult?.diagnostics
    if (!d) return
    setInbox((i) => ({ ...i, imapPort: d.port, imapSecurity: d.securityUsed }))
  }

  /** Adopt the port and encryption that auto-negotiation actually got through on. */
  const applyAdjusted = () => {
    const d = testResult?.diagnostics
    if (!d) return
    setAccount((a) => ({ ...a, port: d.port, security: d.securityUsed }))
  }

  const save = async () => {
    setSaving(true)
    try {
      await onSave(account, secret || undefined)
      // Saved unconditionally, including when receiving was just switched
      // *off*: gating this on `inbox.enabled` meant turning it off never
      // persisted, so it came back on at the next launch.
      if (inbox.enabled || inboxConfig) {
        await onSaveInbox({ ...inbox, accountId: account.id }, inboxSecret || undefined)
      }
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      wide
      title={initial ? t('account.edit') : t('account.add')}
      onClose={onClose}
      closeLabel={t('common.close')}
      footer={
        <>
          {testing ? (
            <>
              <Button variant="ghost" loading disabled>
                {t('account.testing', { s: elapsed })}
              </Button>
              <Button variant="ghost" onClick={cancelTest}>
                {t('account.testCancel')}
              </Button>
            </>
          ) : (
            <div className="test-action">
              <Button variant="ghost" onClick={runTest} disabled={blocked}>
                {t('account.testConnection')}
              </Button>
              {blocked ? (
                <div className="field__hint field__hint--keep">
                  {t('account.testBlockedReason', { fields: fieldListFormat.format(blockedFields) })}
                </div>
              ) : null}
            </div>
          )}
          <div className="modal__footer-spacer" />
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={save} disabled={blocked} loading={saving}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {/*
        Section 1 of 4: the address. First on screen and self-explanatory —
        no title of its own — so it gets only the vertical rhythm the other
        sections share, plus (mobile only, see `.account-hero` in app.css) a
        bigger box for the one field a phone user reaches for first.
      */}
      <div className="account-section account-hero">
        <div className="field__row">
          <Field label={t('account.fromAddress')}>
            <input
              className="input"
              type="email"
              autoComplete="off"
              spellCheck={false}
              placeholder="you@example.com"
              value={account.fromAddress}
              onChange={(e) => onAddressChange(e.target.value)}
            />
          </Field>
          <Field label={t('account.fromName')}>
            <input
              className="input"
              value={account.fromName}
              onChange={(e) => patch({ fromName: e.target.value })}
            />
          </Field>
        </div>

        {/*
          Says what the address just did, and offers the way back.

          Auto-fill that silently refuses to touch a field the user once edited is
          indistinguishable from auto-fill that is broken — the address changes,
          the server does not, and there is nothing on screen to explain why. This
          banner is that explanation, and the button beside it is the one-click
          undo for the hand edits it is respecting.
        */}
        {auto ? (
          <Banner
            tone={auto.guessed ? 'warning' : 'info'}
            /*
             * Kept on a phone only while it has something to report.
             *
             * "Filled in from Gmail" under a form that visibly filled itself in is
             * the sort of note a phone is right to drop. "3 fields you edited by
             * hand were left alone" is not — it is the only thing on screen that
             * explains why changing the address moved some boxes and not others,
             * and it comes with the button that undoes them. Dropping *that* is
             * the failure the banner was written to prevent, reintroduced by a
             * width. The guessed variant is a warning and was never culled.
             */
            keep={autoOverrides.length > 0}
            action={
              autoOverrides.length > 0 ? (
                <Button variant="ghost" onClick={restoreAuto}>
                  {t('account.autoRestore')}
                </Button>
              ) : undefined
            }
          >
            <div>
              {auto.guessed
                ? t('account.autoGuessed', { domain: auto.domain })
                : t('account.autoApplied', { provider: auto.preset.name })}
            </div>
            {autoOverrides.length > 0 ? (
              <div className="banner__note">
                {t('account.autoKept', { n: autoOverrides.length })}
              </div>
            ) : null}
          </Banner>
        ) : null}
      </div>

      {/*
        Section 2 of 4: the send server. Every field here stays visible and
        fillable on every screen size — `tests/e2e/account-test-buttons-phone.spec.ts`
        fills the address, this host and the username without expanding
        anything, and this section must never fold any of them away.
      */}
      <div className="account-section">
        <div className="account-section__title">{t('account.sectionServer')}</div>

        <Field label={t('account.provider')}>
          <select
            className="select"
            value={account.providerId ?? ''}
            onChange={(e) => applyProvider(e.target.value)}
          >
            <option value="">—</option>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>

        {preset ? (
          /*
           * Kept on a phone, for the same reason the auto-fill banner below is
           * and with more at stake.
           *
           * This is the one that says the password box does not want the
           * password they log in with, and carries the link to the page that
           * mints the one it does want. The phone's blanket cull of
           * `banner--info` took it, and the shape of the resulting bug is why
           * "the tests do not work on Android" is a fair description of it:
           * nothing on a 360px screen ever mentioned an app password, so the
           * account was saved with a Google account password and both tests came
           * back as authentication failures. Measured at 360x800 before this:
           * `display: none`, 0x0, link included.
           */
          <Banner tone="info" keep>
            {t(preset.hintKey as 'provider.hint.appPassword')}
            {preset.appPasswordUrl ? (
              <>
                {' '}
                <button
                  type="button"
                  className="link"
                  onClick={() => onOpenExternal(preset.appPasswordUrl!)}
                >
                  {t('provider.openGuide')} <IconExternal size={12} />
                </button>
              </>
            ) : null}
          </Banner>
        ) : null}

        <div className="field__row">
          <Field label={t('account.host')}>
            <input
              className="input"
              spellCheck={false}
              placeholder="smtp.example.com"
              value={account.host}
              onChange={(e) => {
                markTouched('host')
                patch({ host: e.target.value.trim() })
              }}
            />
          </Field>
          <Field label={t('account.port')}>
            <input
              className="input"
              type="number"
              min={1}
              max={65535}
              value={account.port}
              onChange={(e) => {
                markTouched('port')
                patch({ port: Number(e.target.value) })
              }}
            />
          </Field>
          <Field label={t('account.security')}>
            <select
              className="select"
              value={account.security}
              onChange={(e) => {
                markTouched('security')
                patch({ security: e.target.value as TransportSecurity })
              }}
            >
              <option value="ssl">{t('account.securitySsl')}</option>
              <option value="starttls">{t('account.securityStarttls')}</option>
              <option value="none">{t('account.securityNone')}</option>
            </select>
          </Field>
        </div>

        {/*
          The mechanism picker, shown only where there is a genuine choice.

          Absent for the fifteen providers that still issue a working app
          password, because a dropdown with one real option is a question the user
          has to answer for no reason. Absent too for an `authMethod: 'none'`
          account — an open relay on a LAN, the one case where neither mechanism
          applies — rather than silently rewriting it to something it is not.
        */}
        {oauthAvailable && account.authMethod !== 'none' ? (
          <div className="field__row">
            <Field label={t('account.authMethod')}>
              <select
                className="select"
                value={account.authMethod}
                onChange={(e) => setAuthMethod(e.target.value as AuthMethod)}
              >
                <option value="password">{t('account.authPassword')}</option>
                <option value="oauth2">{t('account.authOauth2')}</option>
              </select>
            </Field>
          </div>
        ) : null}

        <div className="field__row">
          <Field label={t('account.username')}>
            <input
              className="input"
              autoComplete="off"
              spellCheck={false}
              value={account.username}
              onChange={(e) => {
                markTouched('username')
                patch({ username: e.target.value })
              }}
            />
          </Field>
          {/*
            The password box goes away entirely under OAuth2 rather than being
            disabled. A greyed-out field still reads as "something you were
            supposed to fill in", and there is no password for this account to
            have — the credential is the grant below.
          */}
          {isOauth ? null : (
            <Field
              label={t('account.password')}
              hint={account.hasSecret && !secret ? t('account.passwordSet') : undefined}
            >
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                placeholder={account.hasSecret ? '••••••••••' : ''}
                value={secret}
                onChange={(e) => {
                  setSecret(e.target.value)
                  setTestResult(null)
                }}
              />
            </Field>
          )}
        </div>

        {isOauth ? (
          <OAuthPanel
            status={oauthStatus}
            busy={oauthBusy}
            error={oauthError}
            fallbackAddress={account.username || account.fromAddress}
            onConnect={runConsent}
            onDisconnect={disconnectOauth}
          />
        ) : null}

        <Banner tone="success">
          <IconShield size={13} style={{ verticalAlign: -2, marginInlineEnd: 4 }} />
          {t('account.storedSafely')}
        </Banner>
      </div>

      {/*
        Section 3 of 4: more settings — label, group, reply-to, and the two
        switches. Collapsed by default on a phone (`moreOpen`, wide open on
        desktop); everything inside is optional or warning-only per
        `validateAccount`, except a malformed reply-to, which the effect above
        forces this open for. Controlled `<details>` so a manual click and the
        automatic open-on-error never fight each other.
      */}
      <details
        ref={moreDetailsRef}
        className="account-more"
        open={moreOpen}
        onToggle={(e) => setMoreOpen(e.currentTarget.open)}
      >
        <summary>{t('account.moreOptions')}</summary>
        <div className="account-more__body">
          <div className="field__row">
            <Field label={t('account.label')}>
              <input
                className="input"
                placeholder={t('account.labelPlaceholder')}
                value={account.label}
                onChange={(e) => {
                  markTouched('label')
                  patch({ label: e.target.value })
                }}
              />
            </Field>
            {/* Free text with suggestions rather than a managed list of groups.
                Groups here are a filing device, and a filing device that makes you
                create the folder first is one people stop using. */}
            <Field label={t('account.group')} optional={t('common.optional')}>
              <GroupInput
                value={account.group ?? ''}
                options={knownGroups}
                placeholder={t('account.groupPlaceholder')}
                onChange={(v) => patch({ group: v.trim() || undefined })}
              />
            </Field>
          </div>

          <div className="field__row">
            <Field label={t('account.replyTo')} optional={t('common.optional')}>
              <input
                className="input"
                type="email"
                spellCheck={false}
                value={account.replyTo ?? ''}
                onChange={(e) => patch({ replyTo: e.target.value })}
              />
            </Field>
          </div>

          <Switch
            checked={account.autoNegotiate !== false}
            onChange={(v) => patch({ autoNegotiate: v })}
            title={t('account.autoNegotiate')}
            description={t('account.autoNegotiateHint')}
          />

          <Switch
            danger
            checked={account.allowInvalidCert}
            onChange={(v) => patch({ allowInvalidCert: v })}
            title={t('account.allowInvalidCert')}
            description={t('account.allowInvalidCertWarn')}
          />
        </div>
      </details>

      {/*
        Section 4 of 4: receive mail. Structure unchanged — `inbox.enabled`
        still gates the fields below the switch.

        The title and the switch stay direct children of `.modal__body`,
        unwrapped, rather than moving inside an `.account-section` the way the
        other three sections did:
        `tests/e2e/account-test-buttons-phone.spec.ts` finds the switch with
        `.modal__body > .section-label ~ .switch`, a selector that only
        matches when both are the *same* element's direct children. Nesting
        either one a level deeper — even for a titled-card wrapper — breaks
        that adjacency and fails the test the same way hiding a field would.
        The fields the switch reveals still get the same titled-card chrome
        as the sections above, just applied to that block once it renders.
      */}
      <div className="section-label">{t('inbox.sectionTitle')}</div>

      <Switch
        checked={inbox.enabled}
        onChange={toggleInbox}
        title={t('inbox.enable')}
        description={t('inbox.enableHint')}
      />

      {inbox.enabled ? (
        <div className="account-section">
          <div className="field__row">
            <Field label={t('inbox.imapHost')}>
              <input
                className="input"
                spellCheck={false}
                placeholder="imap.example.com"
                value={inbox.imapHost}
                onChange={(e) => {
                  markTouched('imapHost')
                  inboxPatch({ imapHost: e.target.value.trim() })
                }}
              />
            </Field>
            <Field label={t('account.port')}>
              <input
                className="input"
                type="number"
                min={1}
                max={65535}
                value={inbox.imapPort}
                onChange={(e) => {
                  markTouched('imapPort')
                  inboxPatch({ imapPort: Number(e.target.value) })
                }}
              />
            </Field>
            <Field label={t('account.security')}>
              <select
                className="select"
                value={inbox.imapSecurity}
                onChange={(e) => {
                  markTouched('imapSecurity')
                  inboxPatch({ imapSecurity: e.target.value as TransportSecurity })
                }}
              >
                <option value="ssl">{t('account.securitySsl')}</option>
                <option value="starttls">{t('account.securityStarttls')}</option>
                <option value="none">{t('account.securityNone')}</option>
              </select>
            </Field>
          </div>

            <div className="field__row">
              <Field label={t('account.username')}>
                <input
                  className="input"
                  autoComplete="off"
                  spellCheck={false}
                  value={inbox.imapUsername}
                  onChange={(e) => {
                    markTouched('imapUsername')
                    inboxPatch({ imapUsername: e.target.value })
                  }}
                />
              </Field>
              {/*
                One grant covers both protocols, so receiving has no second
                credential to ask for under OAuth2.

                Both Microsoft and Google issue IMAP and SMTP access from the same
                consent — `core/oauth.ts` names both scopes in one request for
                exactly this reason — so a second password box here would be
                asking for something that does not exist, which is how the
                receiving side ends up looking broken on an account that works.
              */}
              {isOauth ? null : (
                <Field
                  label={t('account.password')}
                  hint={t('inbox.passwordHint')}
                >
                  <input
                    className="input"
                    type="password"
                    autoComplete="new-password"
                    placeholder={
                      inboxConfig && !inboxSecret ? t('account.passwordSet') : ''
                    }
                    value={inboxSecret}
                    onChange={(e) => setInboxSecret(e.target.value)}
                  />
                </Field>
              )}
            </div>

            <Switch
              danger
              checked={inbox.imapAllowInvalidCert}
              onChange={(v) => inboxPatch({ imapAllowInvalidCert: v })}
              title={t('account.allowInvalidCert')}
              description={t('account.allowInvalidCertWarn')}
            />

            {/* Receiving gets its own test, next to the fields it tests. Sharing
                the footer's button would have made "test" mean two things
                depending on which half of the form you were looking at. */}
            <div className="inline-actions">
              {inboxTesting ? (
                <>
                  <Button variant="ghost" loading disabled>
                    {t('account.testing', { s: inboxElapsed })}
                  </Button>
                  <Button variant="ghost" onClick={cancelInboxTest}>
                    {t('account.testCancel')}
                  </Button>
                </>
              ) : (
                <div className="test-action">
                  <Button variant="secondary" onClick={runInboxTest} disabled={inboxBlocked}>
                    {t('inbox.testConnection')}
                  </Button>
                  {inboxBlocked ? (
                    <div className="field__hint field__hint--keep">
                      {t('inbox.testBlockedReason', {
                        fields: fieldListFormat.format(inboxBlockedFields),
                      })}
                    </div>
                  ) : null}
                </div>
              )}
            </div>

            {inboxTestResult ? (
              <div ref={inboxReport}>
                <TestReport result={inboxTestResult} onApply={applyInboxAdjusted} />
              </div>
            ) : null}
          </div>
        ) : null}

      {testResult ? (
        <div ref={testReport}>
          <TestReport result={testResult} onApply={applyAdjusted} />
        </div>
      ) : null}

      {issues.length > 0 ? (
        <div className="issues">
          {issues.map((issue, i) => (
            <div
              key={`${issue.key}-${i}`}
              className={`banner banner--${issue.severity === 'error' ? 'danger' : 'warning'}`}
            >
              <span className="banner__body">
                {t(issue.key as 'validate.accountNoHost', issue.values)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </Modal>
  )
}

/**
 * The connection state of an OAuth2 account, and the one button that changes it.
 *
 * Written as a panel rather than a bare button because "connected" is not a
 * boolean the user can be left to infer. Four of the five states have different
 * fixes and only one of them is the user's own doing:
 *
 *   - `unconfigured` is a missing client id in this *build*. Nothing the person
 *     reading it can do, so it says so plainly instead of offering a button
 *     that would open a provider error page.
 *   - `needsConsent` is the state this whole feature exists to make visible. A
 *     revoked refresh token is a stored secret that no longer works, and every
 *     other check in the app — `hasSecret`, the account list, the health panel —
 *     reports it as fine. Without a line of text here, the first symptom is a
 *     scheduled send failing at three in the morning.
 *   - `disconnected` is the ordinary "you have not signed in yet".
 *   - `connected` names the mailbox, because a grant against the wrong one of
 *     somebody's three Google accounts is otherwise invisible until mail goes
 *     out from an address they did not expect.
 *
 * `status === null` is the fifth case and is deliberately not one of the four:
 * it means the answer has not come back yet, and showing "not connected" while
 * it is in flight would send someone to redo a consent they already completed.
 */
function OAuthPanel({
  status,
  busy,
  error,
  fallbackAddress,
  onConnect,
  onDisconnect,
}: {
  status: OAuthAccountStatus | null
  busy: boolean
  error: string | null
  /** Shown as the connected mailbox when the provider did not name one. */
  fallbackAddress: string
  onConnect: () => void
  onDisconnect: () => void
}) {
  const { t } = useI18n()
  const state = status?.state
  const connected = state === 'connected'
  // No button for a build with no client id, and none while the answer is
  // still on its way — both would be a control that cannot do anything.
  const canConnect = state === 'disconnected' || state === 'needsConsent'

  const tone = connected ? 'success' : state === 'needsConsent' ? 'danger' : 'info'

  return (
    <Banner
      tone={tone}
      keep
      action={
        busy ? (
          <Button variant="ghost" loading disabled>
            {t('account.oauthConnecting')}
          </Button>
        ) : connected ? (
          <Button variant="ghost" onClick={onDisconnect}>
            {t('account.oauthDisconnect')}
          </Button>
        ) : canConnect ? (
          <Button variant="primary" onClick={onConnect}>
            {t(state === 'needsConsent' ? 'account.oauthReconnect' : 'account.oauthConnect')}
          </Button>
        ) : undefined
      }
    >
      <div>
        {connected
          ? t('account.oauthConnected', { address: status?.address || fallbackAddress })
          : state
            ? t(OAUTH_STATE_LABEL[state])
            : t('account.oauthChecking')}
      </div>
      {/* The consent page is opened in the real browser, never in a window of
          this app's — saying so is the only way a user can tell this apart from
          the phishing pattern it superficially resembles. */}
      {canConnect ? <div className="banner__note">{t('account.oauthHint')}</div> : null}
      {error ? (
        <div className="banner__note mono">{t('account.oauthFailed', { error })}</div>
      ) : null}
    </Banner>
  )
}

/**
 * What the test actually found.
 *
 * Both halves matter. On success it prints the endpoint, the TLS version and
 * the round trip, because "it worked" with no evidence is the same screen a
 * broken build would show. On failure it prints the server's own words *and* a
 * sentence about what to change — the raw text ("Unexpected socket close") is
 * the one thing a user cannot act on by themselves.
 */
function TestReport({ result, onApply }: { result: SendResult; onApply: () => void }) {
  const { t } = useI18n()
  const d = result.diagnostics
  /*
   * The host and the raw error text are what tell `advisoryKey` it is looking
   * at a Microsoft account. Both call sites used to omit them, so the two
   * advisories written specifically for Microsoft — the ones explaining that a
   * password is no longer accepted at all — could never be reached.
   */
  const context = { host: d?.host, message: result.error }
  const advisory = d
    ? advisoryKey(result.errorKind, d.port, d.securityUsed, context)
    : advisoryKey(result.errorKind, 0, 'ssl', context)

  if (result.ok && d) {
    return (
      <Banner
        tone="success"
        title={
          d.adjusted
            ? t('account.adjusted', { port: d.port, security: t(SECURITY_LABEL[d.securityUsed]) })
            : t('account.testOk')
        }
        action={
          d.adjusted ? (
            <Button variant="primary" onClick={onApply}>
              {t('account.applyAdjusted')}
            </Button>
          ) : undefined
        }
      >
        {d.adjusted ? <div>{t('account.adjustedHint')}</div> : null}
        <dl className="diag">
          <dt>{t('account.diagServer')}</dt>
          <dd className="mono">
            {d.host}:{d.port}
          </dd>
          <dt>{t('account.diagEncryption')}</dt>
          <dd>{t(SECURITY_LABEL[d.securityUsed])}</dd>
          <dt>{t('account.diagTime')}</dt>
          <dd className="mono">{t('logs.duration', { ms: result.durationMs })}</dd>
          {/* Inbox tests only. "Connected" without these numbers cannot tell
              a working mailbox apart from the wrong account. */}
          {result.mailbox ? (
            <>
              <dt>{t('inbox.diagMailbox')}</dt>
              <dd className="mono">
                {t('inbox.diagCounts', {
                  total: result.mailbox.total,
                  unseen: result.mailbox.unseen,
                })}
              </dd>
            </>
          ) : null}
        </dl>

        {/* An empty INBOX on its own says nothing about where the mail went.
            Listing the other mailboxes turns "it's gone" into "it's in
            Archive", which is a completely different conversation. */}
        {result.mailbox?.folders && result.mailbox.folders.length > 1 ? (
          <details className="diag-folders">
            <summary>{t('inbox.diagFolders')}</summary>
            <dl className="diag">
              {result.mailbox.folders.map((f) => (
                <Fragment key={f.path}>
                  <dt className="mono">{f.path}</dt>
                  <dd className="mono">
                    {t('inbox.diagCounts', { total: f.total, unseen: f.unseen })}
                  </dd>
                </Fragment>
              ))}
            </dl>
          </details>
        ) : null}
      </Banner>
    )
  }

  return (
    <Banner tone="danger" title={t('account.testFail')}>
      {result.error ? <div className="mono">{result.error}</div> : null}
      {advisory ? (
        <div style={{ marginTop: 6 }}>{t(advisory as 'error.tlsHint')}</div>
      ) : null}
      {d && d.attempts > 1 ? (
        <div style={{ marginTop: 6, opacity: 0.85 }}>
          {t('account.diagAttempts')}: {d.attempts}
        </div>
      ) : null}
    </Banner>
  )
}
