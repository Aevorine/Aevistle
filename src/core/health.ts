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
}

/** How far ahead "coming up" looks. A week is one planning horizon. */
const HORIZON_MS = 7 * 86_400_000

export function collectHealth(state: AppState, now = Date.now()): HealthIssue[] {
  const issues: HealthIssue[] = []
  const accountIds = new Set(state.accounts.map((a) => a.id))

  // --- things that will definitely fail ----------------------------------

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
  const unauthenticated = state.accounts.filter((a) => !a.hasSecret)
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

  // --- things that are probably not what was meant ------------------------

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
