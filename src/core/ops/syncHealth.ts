/**
 * When a mailbox has been failing long enough to be worth saying out loud.
 *
 * A failed sync already writes a red line onto the Inbox screen, which is the
 * right amount of noise for the case it was designed for: you are looking at
 * the screen, a refresh failed, you can see that it failed. It is the wrong
 * amount for the case that actually costs the user something — an account
 * whose password changed three weeks ago, failing silently every five minutes,
 * on a screen nobody has opened since. The app looks healthy from every angle
 * except the one nobody checks, and the mail simply stops.
 *
 * So a *run* of failures gets promoted from a red line to a notification, once,
 * and the two halves of "once" are what this file is for: not on the first
 * blip, and not again every five minutes after that.
 */

/**
 * How many consecutive failures before anything is said.
 *
 * Three. One is a train tunnel; two is a mail server restarting. Three
 * consecutive failures at the default five-minute interval is fifteen minutes
 * of an account being unreachable, which is past every transient cause and
 * into the ones a person has to fix — a changed password, a revoked app
 * password, a provider that turned IMAP off.
 */
export const FAILURE_ALERT_THRESHOLD = 3

/**
 * The soonest the same account may raise this again.
 *
 * Six hours. The condition persists — that is the entire point of it — so the
 * naive "alert whenever the count is past the threshold" fires every sync
 * interval forever, which is how a warning becomes something people swipe away
 * without reading. Long enough not to nag, short enough that an account broken
 * on Monday morning has said so again by the afternoon.
 */
export const FAILURE_ALERT_COOLDOWN_MS = 6 * 60 * 60_000

/** What is remembered per account between syncs. */
export interface FailureRun {
  /** How many syncs in a row have failed. Reset to 0 by any success. */
  count: number
  /** When this account last raised a failure notification, if ever. */
  alertedAt?: number
}

/**
 * Fold one sync's outcome into the run.
 *
 * A success clears everything, including `alertedAt` — an account that
 * recovered and then broke again a week later is a new problem and deserves to
 * be told about immediately rather than sitting inside a stale cooldown.
 */
export function recordSync(previous: FailureRun | undefined, ok: boolean): FailureRun {
  if (ok) return { count: 0 }
  return { count: (previous?.count ?? 0) + 1, alertedAt: previous?.alertedAt }
}

/**
 * Should this account interrupt the user right now?
 *
 * Split from `recordSync` so the caller can fold the outcome in without
 * deciding anything, and so the decision is testable against a clock it is
 * given rather than one it reads.
 */
export function shouldAlert(
  run: FailureRun,
  now: number,
  threshold: number = FAILURE_ALERT_THRESHOLD,
  cooldownMs: number = FAILURE_ALERT_COOLDOWN_MS,
): boolean {
  if (run.count < threshold) return false
  if (run.alertedAt && now - run.alertedAt < cooldownMs) return false
  return true
}

/** The run with the alert recorded, for the caller to store back. */
export function markAlerted(run: FailureRun, now: number): FailureRun {
  return { ...run, alertedAt: now }
}
