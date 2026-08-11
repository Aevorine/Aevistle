/**
 * "Mail does not work on my phone and I cannot tell you why."
 *
 * That sentence is the entire reason this module exists. Sending a message on
 * Android crosses the WebView, the Capacitor bridge, a Java plugin, the Android
 * keystore, WorkManager, a TCP socket, a TLS handshake and an SMTP
 * conversation — and when it fails, what the user is shown is one line from
 * whichever layer noticed. The layers below it are invisible, so "it does not
 * work" is often the most precise thing anybody can honestly say.
 *
 * The self-check walks those layers from the bottom up and reports each one
 * separately. Its value is not the checks individually — most of them are
 * things the app already knows — but the *ordering*: the first failure going up
 * is the one worth acting on, and everything above it is noise. An account with
 * a perfect SMTP configuration and no native bridge underneath it is not an
 * account problem, and telling the user to check their password would send them
 * somewhere they cannot fix anything.
 *
 * ---------------------------------------------------------------------------
 * Why the judgement is separated from the gathering
 * ---------------------------------------------------------------------------
 *
 * Everything here is pure: facts in, verdicts out. Nothing in this file opens a
 * socket, touches a bridge or reads a clock. The component collects the facts
 * and hands them over.
 *
 * That split is not tidiness. A diagnostic that cannot itself be tested is a
 * diagnostic nobody should believe — it would be reporting on parts of the app
 * that only exist on a device, from code that has never been run anywhere. This
 * way the rules that decide "fail" from "warn" from "not applicable" are
 * exercised in ordinary tests, on every platform, and what remains device-shaped
 * is only the fact-collection, which is a handful of calls that either answer or
 * throw.
 */

import type { AuthMethod, MailAccount, Platform } from '../types'
import type { ExactAlarmPermission, NotificationPermission } from '../platform/bridge-android'
import type { OAuthConnectionState } from '../mail/oauth'
import type { TranslationKey } from '../../i18n'

/**
 * `skip` is a first-class outcome, not a hidden one.
 *
 * A check that did not run because it could not apply — IMAP on an account with
 * no inbox configured, notification permissions on a desktop — must not look
 * like a pass. A row of green ticks that includes things nobody tested is worse
 * than no self-check at all: it is a report that actively argues against the
 * user's own experience of the app being broken.
 */
export type SelfCheckStatus = 'pass' | 'warn' | 'fail' | 'skip'

export interface SelfCheckRow {
  /** Stable across runs and translations — used as a React key and a test hook. */
  id: string
  status: SelfCheckStatus
  labelKey: TranslationKey
  /** Which account this row is about, when it is about one. */
  accountLabel?: string
  /**
   * Whatever the failing layer actually said, verbatim and untranslated.
   *
   * A server's own words are worth more than any paraphrase this file could
   * write: `535 5.7.8 Username and Password not accepted` is searchable, and
   * "sign-in failed" is not. It is rendered in a monospace block precisely so it
   * reads as machine output rather than as advice.
   */
  detail?: string
  /** What to do about it. Absent when there is nothing to do. */
  hintKey?: TranslationKey
}

/** Everything the panel manages to find out before judgement is passed. */
export interface SelfCheckFacts {
  platform: Platform
  /**
   * Whether the native plugin answered at all.
   *
   * `missing` is the signature of the whole-app failure this module was written
   * for: the WebView is fine, the UI renders, every button works — and nothing
   * that needs Java does anything, because the plugin never registered. Every
   * check below it is meaningless in that state, which is why it is reported
   * first and why the rest are skipped rather than run and failed.
   */
  native: 'ok' | 'missing' | 'error'
  nativeError?: string
  /*
   * The permission unions are imported rather than restated. A local copy would
   * compile happily against a stale set of values and then mis-grade whichever
   * one was added later — `not-required` in particular, which must read as
   * "this Android version does not need it" and would default to a warning if
   * it fell through an `=== 'granted'` test written against a narrower type.
   */
  permissions?: {
    notifications: NotificationPermission
    exactAlarms: ExactAlarmPermission
  }
  accounts: AccountFacts[]
  /** Jobs the user has switched on. */
  enabledJobs: number
  /** …of those, how many have a next occurrence to fire. */
  armedJobs: number
  /** Messages sitting in the outbox that have already used up their retries. */
  deadOutbox: number
}

export interface AccountFacts {
  id: string
  label: string
  authMethod: AuthMethod
  /** Field names that are empty and must not be — `host`, `port`, `username`. */
  missingFields: string[]
  /** Whether the keystore holds a usable credential. Undefined when not asked. */
  hasSecret?: boolean
  oauthState?: OAuthConnectionState
  /** Result of the real SMTP round trip, when one was attempted. */
  smtp?: { ok: boolean; error?: string }
  imapConfigured: boolean
  imap?: { ok: boolean; error?: string }
}

/** The fields an account cannot send without. */
export function missingAccountFields(account: MailAccount): string[] {
  const missing: string[] = []
  if (!account.host?.trim()) missing.push('host')
  if (!account.port) missing.push('port')
  if (!account.fromAddress?.trim()) missing.push('fromAddress')
  // `username` is genuinely optional under `authMethod: 'none'` — an internal
  // relay that authenticates by IP is a real configuration, and demanding a
  // username there would report a fault the user cannot fix and does not have.
  if (account.authMethod !== 'none' && !account.username?.trim()) missing.push('username')
  return missing
}

/**
 * Turn the facts into rows, bottom layer first.
 *
 * The order is the contract. Read top to bottom, the first non-pass row is the
 * one to act on; anything below it may be reporting a consequence rather than a
 * cause. The UI does not re-sort.
 */
export function runSelfCheck(facts: SelfCheckFacts): SelfCheckRow[] {
  const rows: SelfCheckRow[] = []

  // --- layer 1: is there a native side at all? ------------------------------

  if (facts.platform !== 'android') {
    /*
     * Said out loud rather than hidden. Someone reading a self-check in the
     * browser preview and seeing every mail check skipped needs to know that is
     * the preview's doing and not a diagnosis — otherwise this panel becomes a
     * source of false alarms about a build that is fine.
     */
    rows.push({
      id: 'platform',
      status: facts.platform === 'desktop' ? 'pass' : 'warn',
      labelKey: 'selfcheck.platform',
      hintKey: facts.platform === 'desktop' ? undefined : 'selfcheck.platformWebHint',
    })
  }

  /*
   * "Is there a mail engine underneath this at all?"
   *
   * Two ways for there not to be, and they must be treated identically even
   * though they look nothing alike: an Android build whose plugin never
   * registered, and the browser preview, which has no mail code by design.
   *
   * Written as one flag after the panel was run for the first time in the
   * preview and produced a report that argued with itself — the platform row
   * said "mail checks are skipped here" and three SMTP rows underneath it said
   * "failed", each quoting the preview's own polite refusal as though it were a
   * server rejecting a password. Anyone reading that would go and check their
   * mail settings. The earlier version of this only knew about the Android
   * case, which is the mistake: the *reason* there is no engine does not change
   * what the layers above it can honestly report, which is nothing.
   */
  const engineDown = facts.platform === 'web' || (facts.platform === 'android' && facts.native !== 'ok')
  if (facts.platform === 'android') {
    rows.push({
      id: 'native',
      status: facts.native === 'ok' ? 'pass' : 'fail',
      labelKey: 'selfcheck.native',
      detail: facts.nativeError,
      hintKey: facts.native === 'ok' ? undefined : 'selfcheck.nativeHint',
    })
  }

  // --- layer 2: what the OS is letting the app do ---------------------------

  if (facts.permissions) {
    const n = facts.permissions.notifications
    rows.push({
      id: 'notifications',
      status: n === 'granted' ? 'pass' : 'warn',
      labelKey: 'selfcheck.notifications',
      hintKey: n === 'granted' ? undefined : 'selfcheck.notificationsHint',
    })

    const e = facts.permissions.exactAlarms
    /*
     * A warning, never a failure. Without exact alarms a scheduled send still
     * happens — Android simply batches it into a maintenance window, so it
     * arrives late rather than not at all. Calling that "failed" in a panel
     * whose whole purpose is to point at the real fault would be teaching the
     * user to distrust the panel.
     *
     * `not-required` is a pass and not a skip. Below Android 12 there is no
     * permission to hold, so the app has everything it needs — which is what
     * the row is asking. Reporting "not applicable" there would leave the user
     * looking for a setting their phone does not have.
     */
    rows.push({
      id: 'exactAlarms',
      status: e === 'granted' || e === 'not-required' ? 'pass' : 'warn',
      labelKey: 'selfcheck.exactAlarms',
      hintKey: e === 'denied' ? 'selfcheck.exactAlarmsHint' : undefined,
    })
  }

  // --- layer 3: the accounts themselves -------------------------------------

  if (facts.accounts.length === 0) {
    rows.push({ id: 'accounts', status: 'fail', labelKey: 'selfcheck.noAccounts', hintKey: 'selfcheck.noAccountsHint' })
  }

  for (const account of facts.accounts) {
    const scope = { accountLabel: account.label }

    rows.push({
      id: `fields:${account.id}`,
      status: account.missingFields.length === 0 ? 'pass' : 'fail',
      labelKey: 'selfcheck.fields',
      ...scope,
      detail: account.missingFields.length ? account.missingFields.join(', ') : undefined,
      hintKey: account.missingFields.length ? 'selfcheck.fieldsHint' : undefined,
    })

    rows.push(credentialRow(account, scope, engineDown))

    /*
     * The live round trips are skipped, not failed, when the layer beneath them
     * is down. An SMTP test with no native bridge to run it does not tell you
     * anything about SMTP.
     */
    rows.push({
      id: `smtp:${account.id}`,
      status: engineDown ? 'skip' : account.smtp ? (account.smtp.ok ? 'pass' : 'fail') : 'skip',
      labelKey: 'selfcheck.smtp',
      ...scope,
      detail: engineDown ? undefined : account.smtp?.error,
      hintKey: !engineDown && account.smtp && !account.smtp.ok ? 'selfcheck.smtpHint' : undefined,
    })

    rows.push({
      id: `imap:${account.id}`,
      status: !account.imapConfigured
        ? 'skip'
        : engineDown
          ? 'skip'
          : account.imap
            ? account.imap.ok
              ? 'pass'
              : 'fail'
            : 'skip',
      labelKey: 'selfcheck.imap',
      ...scope,
      detail: engineDown ? undefined : account.imap?.error,
      hintKey:
        !engineDown && account.imapConfigured && account.imap && !account.imap.ok
          ? 'selfcheck.imapHint'
          : undefined,
    })
  }

  // --- layer 4: is anything actually scheduled to happen? -------------------

  /*
   * The check that catches the failure nobody reports as a failure: every
   * account works, every test is green, and no mail is sent, because the jobs
   * are switched on but have no next occurrence — an end date that has passed, a
   * working calendar that excludes every remaining day, a recurrence that
   * produced nothing. Nothing errors. Nothing is logged. The app looks idle
   * because it *is* idle, and no other screen says so in one line.
   */
  rows.push({
    id: 'armed',
    status: facts.enabledJobs === 0 ? 'skip' : facts.armedJobs > 0 ? 'pass' : 'fail',
    labelKey: 'selfcheck.armed',
    detail: facts.enabledJobs ? `${facts.armedJobs}/${facts.enabledJobs}` : undefined,
    hintKey: facts.enabledJobs > 0 && facts.armedJobs === 0 ? 'selfcheck.armedHint' : undefined,
  })

  rows.push({
    id: 'outbox',
    status: facts.deadOutbox === 0 ? 'pass' : 'warn',
    labelKey: 'selfcheck.outbox',
    detail: facts.deadOutbox ? String(facts.deadOutbox) : undefined,
    hintKey: facts.deadOutbox ? 'selfcheck.outboxHint' : undefined,
  })

  return rows
}

function credentialRow(
  account: AccountFacts,
  scope: { accountLabel: string },
  engineDown: boolean,
): SelfCheckRow {
  // No keystore to consult means no answer to give — not a missing password.
  if (engineDown || account.authMethod === 'none') {
    return { id: `cred:${account.id}`, status: 'skip', labelKey: 'selfcheck.credential', ...scope }
  }

  if (account.authMethod === 'oauth2') {
    const state = account.oauthState
    /*
     * `unconfigured` is a fault in the *build*, not in the user's account, and
     * saying so is the difference between a user who waits for an update and a
     * user who spends an evening re-entering a password that was never going to
     * be asked for. It is a failure rather than a warning because nothing the
     * user can do on this screen will make the account send.
     */
    const status: SelfCheckStatus =
      state === 'connected' ? 'pass' : state === undefined ? 'skip' : 'fail'
    return {
      id: `cred:${account.id}`,
      status,
      labelKey: 'selfcheck.credential',
      ...scope,
      detail: state,
      hintKey:
        state === 'unconfigured'
          ? 'selfcheck.credentialUnconfiguredHint'
          : status === 'fail'
            ? 'selfcheck.credentialOauthHint'
            : undefined,
    }
  }

  return {
    id: `cred:${account.id}`,
    status: account.hasSecret === undefined ? 'skip' : account.hasSecret ? 'pass' : 'fail',
    labelKey: 'selfcheck.credential',
    ...scope,
    hintKey: account.hasSecret === false ? 'selfcheck.credentialHint' : undefined,
  }
}

/**
 * The one-line verdict.
 *
 * Counts rather than a mood, and `skip` is counted separately rather than
 * folded into either side — see `SelfCheckStatus` for why a skipped check must
 * never read as a passed one.
 */
export function summarise(rows: SelfCheckRow[]): {
  pass: number
  warn: number
  fail: number
  skip: number
  /** The first thing worth acting on, reading from the bottom layer up. */
  firstProblem?: SelfCheckRow
} {
  const count = (s: SelfCheckStatus) => rows.filter((r) => r.status === s).length
  return {
    pass: count('pass'),
    warn: count('warn'),
    fail: count('fail'),
    skip: count('skip'),
    firstProblem: rows.find((r) => r.status === 'fail') ?? rows.find((r) => r.status === 'warn'),
  }
}
