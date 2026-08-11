/**
 * The Reliability Center — "will my scheduled reminders actually go out?"
 * answered in one screen, instead of the schedule, the log, Settings and the
 * devices card each holding one piece of the answer.
 *
 * Everything shown here is either already in `state` or a cheap, read-only
 * fact: the dispatch ledger (a JSON file read fresh on open, see
 * `PlatformBridge.getDispatchLedgerStatus`) and each OAuth2 account's grant
 * state (`PlatformBridge.oauthStatus`, documented as "reads the store, does
 * not call the provider"). Nothing here opens an SMTP or IMAP connection —
 * that live probe already exists, on demand, as `components/SelfCheckPanel`,
 * and duplicating it would turn a screen meant to be safe to open constantly
 * into one that costs a round trip every time.
 *
 * The judgement itself lives in `core/reliability.ts`, which is pure and
 * platform-free; this file only collects the handful of async facts that
 * module cannot reach on its own and lays out what it returns.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Banner,
  Button,
  Card,
  CardHeader,
  EmptyState,
  StatusChip,
  useToast,
  type StatusTone,
} from '../components/ui'
import {
  IconClock,
  IconMonitor,
  IconRefresh,
  IconSend,
  IconShield,
  IconSmartphone,
} from '../components/icons'
import {
  collectAccountIssues,
  collectDeviceSyncIssues,
  collectStuckSends,
  collectUnhealthyJobs,
  type AccountIssueKind,
  type JobIssueKind,
} from '../core/ops/reliability'
import type { DispatchLedgerEntry } from '../core/ops/dispatchLedger'
import type { OAuthConnectionState } from '../core/mail/oauth'
import type { PairedDevicePlatform } from '../core/sync/pairedDevices'
import { useApp } from '../state/AppState'
import { useI18n, type TranslationKey } from '../i18n'

const JOB_KIND_LABEL: Record<JobIssueKind, TranslationKey> = {
  paused: 'reliability.job.paused',
  failing: 'reliability.job.failing',
  retrying: 'reliability.job.retrying',
  stuckSend: 'reliability.job.stuckSend',
  executorUnsynced: 'reliability.job.executorUnsynced',
}

const JOB_KIND_TONE: Record<JobIssueKind, StatusTone> = {
  paused: 'neutral',
  failing: 'danger',
  retrying: 'warning',
  stuckSend: 'danger',
  executorUnsynced: 'warning',
}

/** Which color a job's row dot takes — the worst of its kinds, same idea as `core/reliability.ts`'s own rank table. */
function jobRowLevel(kinds: JobIssueKind[]): 'info' | 'warn' | 'error' {
  if (kinds.some((k) => k === 'failing' || k === 'stuckSend')) return 'error'
  if (kinds.some((k) => k === 'executorUnsynced' || k === 'retrying')) return 'warn'
  return 'info'
}

const ACCOUNT_KIND_LABEL: Record<AccountIssueKind, TranslationKey> = {
  noSecret: 'reliability.account.noSecret',
  oauthDisconnected: 'reliability.account.oauthDisconnected',
  oauthNeedsConsent: 'reliability.account.oauthNeedsConsent',
  oauthUnconfigured: 'reliability.account.oauthUnconfigured',
  authFailure: 'reliability.account.authFailure',
}

/** Only these two have a self-contained fix — a consent flow this screen can start on its own without leaving it. */
const ACCOUNT_KIND_RECONNECTABLE: ReadonlySet<AccountIssueKind> = new Set([
  'oauthDisconnected',
  'oauthNeedsConsent',
])

function platformIcon(platform: PairedDevicePlatform) {
  return platform === 'android' ? <IconSmartphone size={16} /> : <IconMonitor size={16} />
}

export function ReliabilityView() {
  const { state, bridge, permissions, fixPermission, toggleJob, runJobNow } = useApp()
  const { t, formatAgo } = useI18n()
  const toast = useToast()

  const [ledgerEntries, setLedgerEntries] = useState<DispatchLedgerEntry[]>([])
  const [oauthStatuses, setOauthStatuses] = useState<Record<string, OAuthConnectionState>>({})
  const [loading, setLoading] = useState(true)
  const [busyJobId, setBusyJobId] = useState<string | null>(null)
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null)

  const ledgerAvailable = Boolean(bridge?.getDispatchLedgerStatus)

  /**
   * Every fact this screen cannot read straight off `state`, gathered once on
   * open and again on demand. Both calls are read-only and cheap — see the
   * module doc — which is what makes "just open the screen" a safe default
   * instead of something that has to be triggered on purpose, unlike the live
   * probes in `SelfCheckPanel`.
   */
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const ledgerPromise = bridge?.getDispatchLedgerStatus
        ? bridge.getDispatchLedgerStatus().catch(() => [])
        : Promise.resolve([])
      const oauthAccounts = state.accounts.filter((a) => a.authMethod === 'oauth2')
      const oauthPromise = Promise.all(
        oauthAccounts.map(async (a): Promise<[string, OAuthConnectionState]> => {
          if (!bridge?.oauthStatus) return [a.id, 'unsupported']
          try {
            const status = await bridge.oauthStatus(a.id, a.providerId ?? '')
            return [a.id, status.state]
          } catch {
            return [a.id, 'unsupported']
          }
        }),
      )
      const [ledger, oauthPairs] = await Promise.all([ledgerPromise, oauthPromise])
      setLedgerEntries(ledger)
      setOauthStatuses(Object.fromEntries(oauthPairs))
    } finally {
      setLoading(false)
    }
    // `state.accounts` only changes identity when an account is actually
    // added, removed or edited — see the reducer split this state comes
    // from — so this does not refetch on every unrelated keystroke.
  }, [bridge, state.accounts])

  useEffect(() => {
    void load()
  }, [load])

  const localDeviceId = state.settings.localDeviceId

  const unhealthyJobs = useMemo(
    () => collectUnhealthyJobs(state.jobs, state.pairedDevices, localDeviceId, ledgerEntries, Date.now()),
    [state.jobs, state.pairedDevices, localDeviceId, ledgerEntries],
  )
  const stuckSends = useMemo(
    () => collectStuckSends(ledgerEntries, state.jobs, Date.now()),
    [ledgerEntries, state.jobs],
  )
  const accountIssues = useMemo(
    () => collectAccountIssues(state.accounts, state.jobs, oauthStatuses),
    [state.accounts, state.jobs, oauthStatuses],
  )
  const deviceIssues = useMemo(
    () => collectDeviceSyncIssues(state.pairedDevices, Date.now()),
    [state.pairedDevices],
  )
  const exactAlarmsDenied = permissions?.exactAlarms === 'denied'

  const totalIssues =
    unhealthyJobs.length + stuckSends.length + accountIssues.length + deviceIssues.length + (exactAlarmsDenied ? 1 : 0)

  const retry = async (jobId: string, jobName: string) => {
    setBusyJobId(jobId)
    try {
      const result = await runJobNow(jobId)
      if (result && !result.ok && result.skipped) {
        toast.push({
          tone: 'info',
          title: t('toast.skipped'),
          detail: result.skipReasonKey
            ? t(result.skipReasonKey as TranslationKey, result.skipReasonValues)
            : undefined,
        })
      } else if (result?.ok) {
        toast.push({
          tone: 'success',
          title: t('toast.sent'),
          detail: t('toast.sentDetail', { n: result.accepted.length, ms: result.durationMs }),
        })
      } else {
        toast.push({ tone: 'error', title: t('toast.sendFailed'), detail: result?.error ?? jobName })
      }
    } finally {
      setBusyJobId(null)
      void load()
    }
  }

  const resume = async (jobId: string) => {
    setBusyJobId(jobId)
    try {
      await toggleJob(jobId, true)
      toast.push({ tone: 'info', title: t('toast.jobResumed') })
    } finally {
      setBusyJobId(null)
    }
  }

  const reconnect = async (accountId: string, accountLabel: string, providerId: string | undefined) => {
    if (!bridge?.oauthConsent) return
    setBusyAccountId(accountId)
    try {
      const account = state.accounts.find((a) => a.id === accountId)
      const result = await bridge.oauthConsent(accountId, providerId ?? '', account?.fromAddress ?? '')
      if (result.ok) {
        toast.push({
          tone: 'success',
          title: t('reliability.reconnected'),
          detail: result.address ?? accountLabel,
        })
      } else if (!result.cancelled) {
        toast.push({ tone: 'error', title: t('reliability.reconnectFailed'), detail: result.error })
      }
    } finally {
      setBusyAccountId(null)
      void load()
    }
  }

  return (
    <Card className="reliability">
      <CardHeader
        title={t('reliability.title')}
        hint={t('reliability.intro')}
        action={
          <Button
            variant="ghost"
            icon={<IconRefresh size={15} />}
            onClick={() => void load()}
            disabled={loading}
          >
            {t('reliability.refresh')}
          </Button>
        }
      />
      <div data-view="reliability" className="form-rows">
        {!ledgerAvailable ? <Banner tone="info">{t('reliability.ledgerUnavailable')}</Banner> : null}

        {/* Collapsed summary first — see the module doc's framing. A number
            next to each category is the whole triage: which one is nonzero
            says where to look, without reading every row to find out. */}
        <div className="stats">
          <div className={`stat ${unhealthyJobs.length > 0 ? 'stat--bad' : 'stat--good'}`}>
            <div className="stat__value">{unhealthyJobs.length}</div>
            <div className="stat__label">{t('reliability.statJobs')}</div>
          </div>
          <div className={`stat ${stuckSends.length > 0 ? 'stat--bad' : ''}`}>
            <div className="stat__value">{ledgerAvailable ? stuckSends.length : '—'}</div>
            <div className="stat__label">{t('reliability.statLedger')}</div>
          </div>
          <div className={`stat ${accountIssues.length > 0 ? 'stat--bad' : 'stat--good'}`}>
            <div className="stat__value">{accountIssues.length}</div>
            <div className="stat__label">{t('reliability.statAccounts')}</div>
          </div>
          <div className={`stat ${deviceIssues.length > 0 ? 'stat--bad' : ''}`}>
            <div className="stat__value">{deviceIssues.length}</div>
            <div className="stat__label">{t('reliability.statDevices')}</div>
          </div>
        </div>

        {totalIssues === 0 && !loading ? (
          state.jobs.length === 0 ? (
            <EmptyState icon={<IconShield size={24} />} title={t('reliability.emptyNoJobs')} />
          ) : (
            <Banner tone="success">{t('reliability.allClear')}</Banner>
          )
        ) : null}

        {/* --- jobs -------------------------------------------------------- */}
        {unhealthyJobs.length > 0 ? (
          <section>
            <div className="section-label">{t('reliability.sectionJobs')}</div>
            {unhealthyJobs.map((job) => (
              <div className="log" data-level={jobRowLevel(job.kinds)} key={job.jobId}>
                <span className="log__dot" />
                <div className="log__body">
                  <div className="log__title">
                    {job.jobName}
                    {job.kinds.map((kind) => (
                      <StatusChip key={kind} tone={JOB_KIND_TONE[kind]} label={t(JOB_KIND_LABEL[kind])} />
                    ))}
                  </div>
                  {job.lastError ? <div className="log__detail mono">{job.lastError}</div> : null}
                  {job.kinds.includes('executorUnsynced') ? (
                    <div className="log__detail">
                      {job.executorLastSyncedAt
                        ? t('reliability.executorLastSynced', {
                            device: job.executorLabel ?? t('reliability.unknownDevice'),
                            when: formatAgo(job.executorLastSyncedAt),
                          })
                        : t('reliability.executorNeverSynced', {
                            device: job.executorLabel ?? t('reliability.unknownDevice'),
                          })}
                    </div>
                  ) : null}
                </div>
                <div className="log__actions">
                  {job.kinds.includes('paused') ? (
                    <Button
                      variant="ghost"
                      loading={busyJobId === job.jobId}
                      onClick={() => void resume(job.jobId)}
                    >
                      {t('schedule.resume')}
                    </Button>
                  ) : null}
                  {job.kinds.includes('failing') || job.kinds.includes('stuckSend') ? (
                    <Button
                      variant="ghost"
                      icon={<IconSend size={15} />}
                      loading={busyJobId === job.jobId}
                      onClick={() => void retry(job.jobId, job.jobName)}
                    >
                      {t('reliability.retryNow')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </section>
        ) : null}

        {/* --- dispatch ledger ---------------------------------------------- */}
        {stuckSends.length > 0 ? (
          <section>
            <div className="section-label">{t('reliability.sectionLedger')}</div>
            {stuckSends.map((send) => (
              <div className="log" data-level="error" key={send.claimKey}>
                <span className="log__dot" />
                <div className="log__body">
                  <div className="log__title">{send.jobName}</div>
                  <div className="log__detail">
                    {t('reliability.ledgerDetail', {
                      state: t(`reliability.ledgerState.${send.state}` as TranslationKey),
                      minutes: Math.max(1, Math.round(send.ageMs / 60_000)),
                      attempts: send.attempts,
                    })}
                  </div>
                </div>
              </div>
            ))}
          </section>
        ) : null}

        {/* --- accounts / credentials ---------------------------------------- */}
        {accountIssues.length > 0 ? (
          <section>
            <div className="section-label">{t('reliability.sectionAccounts')}</div>
            {accountIssues.map((issue, i) => (
              <div className="log" data-level="error" key={`${issue.accountId}:${issue.kind}:${i}`}>
                <span className="log__dot" />
                <div className="log__body">
                  <div className="log__title">
                    {issue.accountLabel}
                    <StatusChip tone="danger" label={t(ACCOUNT_KIND_LABEL[issue.kind])} />
                  </div>
                  {issue.detail ? <div className="log__detail mono">{issue.detail}</div> : null}
                </div>
                {ACCOUNT_KIND_RECONNECTABLE.has(issue.kind) && bridge?.oauthConsent ? (
                  <div className="log__actions">
                    <Button
                      variant="ghost"
                      loading={busyAccountId === issue.accountId}
                      onClick={() =>
                        void reconnect(
                          issue.accountId,
                          issue.accountLabel,
                          state.accounts.find((a) => a.id === issue.accountId)?.providerId,
                        )
                      }
                    >
                      {t('reliability.reconnect')}
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </section>
        ) : null}

        {/* --- paired device sync freshness ----------------------------------- */}
        {deviceIssues.length > 0 ? (
          <section>
            <div className="section-label">{t('reliability.sectionDevices')}</div>
            {deviceIssues.map((issue) => {
              const device = state.pairedDevices.find((d) => d.id === issue.deviceId)
              return (
                <div className="log" data-level="warn" key={issue.deviceId}>
                  {device ? platformIcon(device.platform) : <IconClock size={16} />}
                  <div className="log__body">
                    <div className="log__title">{issue.deviceLabel}</div>
                    <div className="log__detail">
                      {issue.lastSyncedAt
                        ? t('reliability.deviceStale', { when: formatAgo(issue.lastSyncedAt) })
                        : t('reliability.deviceNeverSynced')}
                    </div>
                  </div>
                </div>
              )
            })}
          </section>
        ) : null}

        {/* --- Android exact-alarm permission ----------------------------------
            Desktop has no equivalent, and `permissions` is `null` there — see
            `state/AppState.tsx`'s doc on the field — so this section simply
            does not render rather than showing a status that is not real. */}
        {exactAlarmsDenied ? (
          <section>
            <div className="section-label">{t('reliability.sectionAndroid')}</div>
            <div className="log" data-level="warn">
              <span className="log__dot" />
              <div className="log__body">
                <div className="log__title">{t('health.exactAlarmsDenied')}</div>
              </div>
              <div className="log__actions">
                <Button variant="ghost" onClick={() => void fixPermission('openExactAlarmSettings')}>
                  {t('health.exactAlarmsFix')}
                </Button>
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </Card>
  )
}
