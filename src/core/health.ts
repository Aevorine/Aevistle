/**
 * What is quietly wrong right now.
 *
 * This app's characteristic failure is silence. A schedule whose account was
 * deleted, an attachment whose source file was moved, a job that has been
 * failing every night for a week — none of them announce themselves, because
 * the app looks exactly the same either way. You find out when someone asks
 * why they never got the email.
 *
 * So the conditions are computed here, in one place, and shown on the screen
 * the user opens most. Each one names the thing that is wrong, how many are
 * affected, and where to go and fix it — a warning that cannot be acted on is
 * just anxiety.
 */

import { needsStoredPassword } from './accounts'
import type { AppState } from './types'

export type HealthLevel = 'danger' | 'warning' | 'info'

export interface HealthIssue {
  id: string
  level: HealthLevel
  /** i18n key for the headline. */
  key: string
  /** Substitutions for that key. */
  values?: Record<string, string | number>
  /** Where the fix is, so the card can offer a button rather than a shrug. */
  goTo?: 'schedule' | 'settings' | 'compose' | 'logs'
  /**
   * A fix that is an action rather than a place — the Android permission
   * screens, which live outside this app entirely. Named rather than supplied
   * as a callback so this module stays pure and platform-free; the strip maps
   * the name onto the bridge call.
   */
  fix?: 'requestNotifications' | 'openNotificationSettings' | 'openExactAlarmSettings'
  /** Label for the `fix` button. "Turn on" and "Open settings" are not the same offer. */
  fixKey?: string
}

/**
 * What Android knows about its own permissions.
 *
 * Passed in for the same reason `schedulerUnreachable` is: it cannot be derived
 * from `state`. Nothing in the store changes when someone revokes notification
 * access in the system settings, and the app looks identical either way — which
 * is exactly how this shipped for four versions with notifications silently
 * dead on every phone from 2022 onward.
 *
 * Undefined on desktop and web, where neither question applies.
 */
export interface PermissionSnapshot {
  notifications: 'granted' | 'prompt' | 'blocked'
  exactAlarms: 'granted' | 'denied' | 'not-required'
  /** `'granted'` means *exempt* from battery optimization — see `bridge-android.ts`. */
  batteryOptimized: 'granted' | 'denied' | 'not-required'
  canAskNotifications: boolean
}

/** How far ahead "coming up" looks. A week is one planning horizon. */
const HORIZON_MS = 7 * 86_400_000

export function collectHealth(
  state: AppState,
  now = Date.now(),
  /**
   * Set when the schedule could not be handed to the platform scheduler. It is
   * not derivable from `state` — the jobs look identical whether or not an
   * alarm exists behind them — so it has to be passed in.
   */
  schedulerUnreachable = false,
  /** Android only; see `PermissionSnapshot`. */
  permissions?: PermissionSnapshot,
  /**
   * Set when the last attempt to write the document to disk failed, and the
   * retry after it failed too.
   *
   * Not derivable from `state` for the worst possible reason: `state` is
   * exactly what could not be written. Everything the user did is still on
   * screen and none of it is on disk, which is the single most expensive kind
   * of silence this app can produce — an unwritable data folder used to log to
   * a console nobody opens and change nothing else at all.
   */
  saveFailing = false,
): HealthIssue[] {
  const issues: HealthIssue[] = []

  if (saveFailing) {
    issues.push({
      id: 'save-failing',
      level: 'danger',
      key: 'health.saveFailing',
      goTo: 'settings',
    })
  }
  const accountIds = new Set(state.accounts.map((a) => a.id))

  // --- things that will definitely fail ----------------------------------

  // First, because it invalidates every other reassurance on this strip: if the
  // scheduler never received the jobs, nothing below is going to happen either.
  if (schedulerUnreachable && state.jobs.some((j) => j.enabled)) {
    issues.push({
      id: 'scheduler-unreachable',
      level: 'danger',
      key: 'health.schedulerUnreachable',
      goTo: 'schedule',
    })
  }

  const orphaned = state.jobs.filter((j) => j.enabled && !accountIds.has(j.draft.accountId))
  if (orphaned.length > 0) {
    issues.push({
      id: 'orphaned-account',
      level: 'danger',
      key: 'health.orphanedAccount',
      values: { n: orphaned.length },
      goTo: 'schedule',
    })
  }

  // An account with no stored password will fail at connect time, every time.
  // `needsStoredPassword` rather than `!hasSecret`: an OAuth2 account holds a
  // grant instead of a password and an IP-authenticated relay holds neither, so
  // the bare test raised a permanent danger banner on two kinds of account that
  // were working perfectly.
  const unauthenticated = state.accounts.filter(needsStoredPassword)
  if (unauthenticated.length > 0) {
    issues.push({
      id: 'no-secret',
      level: 'danger',
      key: 'health.noSecret',
      values: { n: unauthenticated.length },
      goTo: 'settings',
    })
  }

  const failing = state.jobs.filter((j) => j.enabled && j.lastResult === 'failed')
  if (failing.length > 0) {
    issues.push({
      id: 'failing',
      level: 'danger',
      key: 'health.failing',
      values: { n: failing.length },
      goTo: 'logs',
    })
  }

  // A working calendar so full that an occurrence has nowhere to move to. The
  // job still looks armed and the schedule screen still lists it; the send just
  // never happens. That is the one failure this product exists to not have, so
  // it sits with the definite failures rather than the warnings.
  const dropped = state.jobs
    .filter((j) => j.enabled)
    .reduce((n, j) => n + (j.calendarWarning?.dropped.length ?? 0), 0)
  if (dropped > 0) {
    issues.push({
      id: 'calendar-dropped',
      level: 'danger',
      key: 'health.calendarDropped',
      values: { n: dropped },
      goTo: 'schedule',
    })
  }

  // --- things that are probably not what was meant ------------------------

  /**
   * The same shape of orphan as `orphaned` above, for the inbox rather than
   * the schedule — a row in `state.inboxAccounts` naming an id `state.accounts`
   * no longer holds.
   *
   * A warning rather than a danger, unlike its schedule counterpart: an
   * orphaned job silently fails to send, but an orphaned inbox row does not
   * fail at anything — it just sits there, briefly, as the one place a race
   * this app used to have left a trace. `AppState.tsx` now closes that race
   * at its source (the dispatch in `syncInboxAccount`) and again in the
   * `upsertInboxAccount` reducer case, and sweeps any row that already
   * reached disk before those guards existed on the very next boot — so by
   * the time this runs, the row is normally already gone. This check is what
   * is left for the paths those three do not cover: a document edited by
   * hand, one restored from a backup older than the fix, or a future writer
   * that reaches the reducer some way this file never anticipated. Without
   * it, the only place a leftover row ever surfaced was `InboxView`, as a
   * filter tab labelled with its own raw `acct_...` id — which is the
   * phantom account this whole chain of guards exists to stop.
   *
   * Secrets and the on-disk remote-image cache can suffer the same kind of
   * orphaning — a credential or a cached picture left behind for an id
   * nothing points to any more — but neither is *cheaply* checked here: both
   * live outside `state`, behind an async platform-bridge call, and this
   * function is a synchronous read of the document that `HealthBoard`
   * re-runs on every keystroke in the compose form. Reaching into the
   * keystore or the filesystem on that schedule would trade a rare orphaned
   * file for a real, constant cost.
   */
  const orphanedInbox = state.inboxAccounts.filter((i) => !accountIds.has(i.accountId))
  if (orphanedInbox.length > 0) {
    issues.push({
      id: 'orphaned-inbox-account',
      level: 'warning',
      key: 'health.orphanedInboxAccount',
      values: { n: orphanedInbox.length },
      goTo: 'settings',
    })
  }

  // Notifications the user will never see. Not "probably not what was meant" —
  // the send happens and its result is announced to nobody, which is the same
  // as not announcing it. Only worth saying once there is something to announce.
  if (permissions && state.jobs.some((j) => j.enabled)) {
    if (permissions.notifications === 'blocked') {
      issues.push({
        id: 'notifications-blocked',
        level: 'warning',
        key: 'health.notificationsBlocked',
        fix: 'openNotificationSettings',
        fixKey: 'health.notificationsBlockedFix',
      })
    } else if (permissions.notifications === 'prompt') {
      issues.push({
        id: 'notifications-off',
        level: 'warning',
        key: 'health.notificationsOff',
        // Once Android has stopped allowing the dialog, offering "Turn on" is a
        // button that does nothing. Send them where it can still be turned on.
        fix: permissions.canAskNotifications ? 'requestNotifications' : 'openNotificationSettings',
        fixKey: permissions.canAskNotifications
          ? 'health.notificationsOffFix'
          : 'health.notificationsBlockedFix',
      })
    }
    // Sends still happen without this — they just drift, because the alarm
    // gets batched into whatever window the system feels like. "On time" is
    // the whole promise, so a silent hour of drift deserves a line.
    if (permissions.exactAlarms === 'denied') {
      issues.push({
        id: 'exact-alarms-denied',
        level: 'warning',
        key: 'health.exactAlarmsDenied',
        fix: 'openExactAlarmSettings',
        fixKey: 'health.exactAlarmsFix',
      })
    }
  }

  // Everything landed on one day and had to be fanned out minute by minute.
  // Nothing is lost, but a burst of near-identical mail is rarely what was
  // meant, and without this the only clue is the send times themselves.
  const crowdedJobs = state.jobs.filter(
    (j) => j.enabled && ((j.calendarWarning?.crowded ?? 0) > 0 || (j.calendarWarning?.spreadMs ?? 0) >= 300_000),
  )
  if (crowdedJobs.length > 0) {
    const spreadMs = Math.max(...crowdedJobs.map((j) => j.calendarWarning?.spreadMs ?? 0))
    issues.push({
      id: 'calendar-crowded',
      level: 'warning',
      key: 'health.calendarCrowded',
      values: {
        n: crowdedJobs.reduce((n, j) => n + (j.calendarWarning?.crowded ?? 0), 0),
        minutes: Math.max(1, Math.round(spreadMs / 60_000)),
      },
      goTo: 'schedule',
    })
  }

  // Enabled, but with nothing left to fire: a one-off that has already run, or
  // a rule whose end condition has passed. It sits in the list looking armed.
  const spent = state.jobs.filter((j) => j.enabled && j.occurrences.length === 0)
  if (spent.length > 0) {
    issues.push({
      id: 'spent',
      level: 'warning',
      key: 'health.spent',
      values: { n: spent.length },
      goTo: 'schedule',
    })
  }

  const paused = state.jobs.filter((j) => !j.enabled)
  if (paused.length > 0) {
    issues.push({
      id: 'paused',
      level: 'info',
      key: 'health.paused',
      values: { n: paused.length },
      goTo: 'schedule',
    })
  }

  if (state.accounts.length === 0) {
    issues.push({ id: 'no-account', level: 'warning', key: 'health.noAccount', goTo: 'settings' })
  }

  // --- what is actually coming ------------------------------------------

  const upcoming = state.jobs
    .filter((j) => j.enabled)
    .flatMap((j) => j.occurrences.filter((at) => at >= now && at <= now + HORIZON_MS))
  if (upcoming.length > 0) {
    issues.push({
      id: 'upcoming',
      level: 'info',
      key: 'health.upcoming',
      values: { n: upcoming.length },
      goTo: 'schedule',
    })
  }

  // Ordered by how much it matters, so the card can show the top few and mean
  // it. Within a level, insertion order — which is roughly "will break" before
  // "looks odd" — is already right.
  const rank: Record<HealthLevel, number> = { danger: 0, warning: 1, info: 2 }
  return issues.sort((a, b) => rank[a.level] - rank[b.level])
}
