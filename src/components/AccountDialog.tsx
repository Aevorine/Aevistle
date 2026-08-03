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
import { PROVIDERS, providerById, providerForAddress } from '../core/providers'
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
    if (p.imapHost && !inbox.imapHost) {
      inboxPatch({
        imapHost: p.imapHost,
        imapPort: p.imapPort,
        imapSecurity: p.imapSecurity,
        imapUsername: inbox.imapUsername || account.username || account.fromAddress,
      })
    }
  }

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

  /** Filling in the address auto-selects a provider, once, when none is set. */
  const onAddressChange = (value: string) => {
    const next: Partial<MailAccount> = { fromAddress: value }
    if (!account.username || account.username === account.fromAddress) {
      next.username = value
    }
    if (!account.providerId) {
      const guess = providerForAddress(value)
      if (guess) {
        next.providerId = guess.id
        next.host = guess.host
        next.port = guess.port
        next.security = guess.security
      }
    }
    if (!account.label) {
      const guess = providerForAddress(value)
      if (guess) next.label = guess.name
    }
    patch(next)

    if (!inbox.imapHost) {
      const guess = providerForAddress(value)
      if (guess?.imapHost) {
        inboxPatch({
          imapHost: guess.imapHost,
          imapPort: guess.imapPort,
          imapSecurity: guess.imapSecurity,
          imapUsername: inbox.imapUsername || value,
        })
      }
    }
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
    const guess = providerForAddress(account.fromAddress)
    if (!guess) {
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
    patch({
      providerId: guess.id,
      host: guess.host,
      port: guess.port,
      security: guess.security,
      label: account.label || guess.name,
      username: account.username || account.fromAddress,
    })
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

      <div className="field__row">
        <Field label={t('account.label')}>
          <input
            className="input"
            placeholder={t('account.labelPlaceholder')}
            value={account.label}
            onChange={(e) => patch({ label: e.target.value })}
          />
        </Field>
        {/* Free text with suggestions rather than a managed list of groups.
            Groups here are a filing device, and a filing device that makes you
            create the folder first is one people stop using. */}
        <Field label={t('account.group')} optional={t('common.optional')}>
          <datalist id="aevistle-account-groups">
            {knownGroups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
          <input
            className="input"
            list="aevistle-account-groups"
            placeholder={t('account.groupPlaceholder')}
            value={account.group ?? ''}
            onChange={(e) => patch({ group: e.target.value.trim() || undefined })}
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
            onChange={(e) => patch({ host: e.target.value.trim() })}
          />
        </Field>
        <Field label={t('account.port')}>
          <input
            className="input"
            type="number"
            min={1}
            max={65535}
            value={account.port}
            onChange={(e) => patch({ port: Number(e.target.value) })}
          />
        </Field>
        <Field label={t('account.security')}>
          <select
            className="select"
            value={account.security}
            onChange={(e) => patch({ security: e.target.value as TransportSecurity })}
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
            onChange={(e) => patch({ username: e.target.value })}
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
                onChange={(e) => inboxPatch({ imapHost: e.target.value.trim() })}
              />
            </Field>
            <Field label={t('account.port')}>
              <input
                className="input"
                type="number"
                min={1}
                max={65535}
                value={inbox.imapPort}
                onChange={(e) => inboxPatch({ imapPort: Number(e.target.value) })}
              />
            </Field>
            <Field label={t('account.security')}>
              <select
                className="select"
                value={inbox.imapSecurity}
                onChange={(e) => inboxPatch({ imapSecurity: e.target.value as TransportSecurity })}
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
                onChange={(e) => inboxPatch({ imapUsername: e.target.value })}
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
