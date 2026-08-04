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
import { useI18n, type TranslationKey } from '../i18n'
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
import {
  defaultInboxAccountState,
  newId,
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
  const { t } = useI18n()
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

  const patch = (p: Partial<MailAccount>) => {
    setAccount((a) => ({ ...a, ...p }))
    setTestResult(null)
  }

  const preset = providerById(account.providerId)
  const issues = useMemo(() => validateAccount(account), [account])
  const blocked = hasErrors(issues)

  const inboxPatch = (p: Partial<InboxAccountState>) => {
    setInbox((i) => ({ ...i, ...p }))
    setInboxTestResult(null)
  }

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
      if (may('providerId')) next.providerId = cfg.guessed ? undefined : p.id
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
        inboxSecret || undefined,
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

  /** Fill server, port and encryption from the address, in one click. */
  const autoFill = () => {
    if (!autoConfigForAddress(account.fromAddress)) {
      setTestResult({
        ok: false,
        accepted: [],
        rejected: [],
        durationMs: 0,
        error: t('account.autoFillUnknown'),
        errorKind: 'config',
      })
      return
    }
    restoreAuto()
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
            <Button variant="ghost" onClick={runTest} disabled={blocked}>
              {t('account.testConnection')}
            </Button>
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
        <Banner tone="info">
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
        <Field
          label={t('account.fromAddress')}
          hint={
            <button type="button" className="link" onClick={autoFill}>
              {t('account.autoFill')}
            </button>
          }
        >
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
      </div>

      <Banner tone="success">
        <IconShield size={13} style={{ verticalAlign: -2, marginInlineEnd: 4 }} />
        {t('account.storedSafely')}
      </Banner>

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

      <div className="section-label">{t('inbox.sectionTitle')}</div>

      <Switch
        checked={inbox.enabled}
        onChange={toggleInbox}
        title={t('inbox.enable')}
        description={t('inbox.enableHint')}
      />

      {inbox.enabled ? (
        <>
          <div className="field__row">
            <Field
              label={t('inbox.imapHost')}
              hint={
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    const next = inboxDefaults(true)
                    if (next) inboxPatch(next)
                    else
                      setInboxTestResult({
                        ok: false,
                        accepted: [],
                        rejected: [],
                        durationMs: 0,
                        error: t('account.autoFillUnknown'),
                        errorKind: 'config',
                      })
                  }}
                >
                  {t('account.autoFill')}
                </button>
              }
            >
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
              <Button
                variant="secondary"
                onClick={runInboxTest}
                disabled={!inbox.imapHost || !inbox.imapUsername}
              >
                {t('inbox.testConnection')}
              </Button>
            )}
          </div>

          {inboxTestResult ? (
            <TestReport result={inboxTestResult} onApply={applyInboxAdjusted} />
          ) : null}
        </>
      ) : null}

      {testResult ? <TestReport result={testResult} onApply={applyAdjusted} /> : null}

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
  const advisory = d
    ? advisoryKey(result.errorKind, d.port, d.securityUsed)
    : advisoryKey(result.errorKind, 0, 'ssl')

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
