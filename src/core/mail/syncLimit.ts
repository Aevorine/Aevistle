/**
 * How many mailboxes may be talked to at once.
 *
 * Every place that syncs more than one account fires them all off together —
 * `runAll` over the timer's account list, the verification-code screen's
 * `Promise.all`, the pull-to-refresh on the inbox. With one or two accounts
 * that is correct and this file changes nothing. With five it is the reason a
 * "check now" takes as long as the worst mailbox and the UI stutters while it
 * does: five TLS handshakes, five IMAP logins and five mailbox scans start in
 * the same tick, on a phone, on mobile data.
 *
 * The measured case that prompted it is already written down — one account
 * whose connect took 36.7 seconds against a 10-second budget. While that one
 * hangs, four healthy accounts are queued behind it inside the runtime's own
 * socket and DNS limits, so the *fast* accounts finish late for no reason
 * other than having been started at the same time as the slow one.
 *
 * A limiter fixes the wrong half of that on its own, so it does two things:
 * it caps how many run at once, and it lets a caller give a known-slow account
 * a lane of its own rather than a place in the queue.
 *
 * Pure, with no timers and no platform calls, so `check-sync-limit.mjs` can
 * run it to completion against resolved promises.
 */

/**
 * How many at once, by default.
 *
 * Three. Two is measurably slower than three on a four-account mailbox with
 * one slow member, and past three the added parallelism buys nothing on any
 * connection a phone has: the work is almost entirely waiting on a server, but
 * the *start* of each sync is a TLS handshake, which is not free on a low-end
 * device. Three keeps a healthy account's answer inside a couple of seconds
 * while leaving the CPU to the interface.
 */
export const DEFAULT_SYNC_CONCURRENCY = 3

/** A unit of work the limiter owns. */
export type SyncTask<T> = () => Promise<T>

/**
 * Run `tasks` with at most `limit` in flight, preserving result order.
 *
 * Never rejects. A task that throws resolves to `{ ok: false, error }` in its
 * own slot, because the alternative — `Promise.all`'s reject-on-first-failure —
 * is precisely the bug this replaces at three other call sites: one unreachable
 * mailbox and the four that were fine are reported as a failed refresh.
 */
export async function runLimited<T>(
  tasks: readonly SyncTask<T>[],
  limit: number = DEFAULT_SYNC_CONCURRENCY,
): Promise<Array<{ ok: true; value: T } | { ok: false; error: unknown }>> {
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, tasks.length || 1))
  const results = new Array<{ ok: true; value: T } | { ok: false; error: unknown }>(tasks.length)
  let next = 0

  /**
   * One worker, pulling from the shared cursor until there is nothing left.
   *
   * A cursor rather than pre-slicing the list into `width` chunks: chunks
   * assume every task costs the same, which is the assumption this file exists
   * because of. With a cursor, the worker that drew the 36-second mailbox
   * simply takes one task while the others take four.
   */
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= tasks.length) return
      try {
        results[index] = { ok: true, value: await tasks[index]() }
      } catch (error) {
        results[index] = { ok: false, error }
      }
    }
  }

  await Promise.all(Array.from({ length: width }, worker))
  return results
}

/**
 * Reorder so the accounts most likely to answer quickly go first.
 *
 * The limiter alone still lets a slow mailbox occupy a lane for half a minute
 * at the front of the queue. Sorting by how long each account's last sync took
 * means the four fast ones are done and on screen before the slow one has
 * finished its handshake — the same total time, and a list that fills in
 * seconds instead of after everything.
 *
 * Ties and unknowns keep the caller's order (`Array.prototype.sort` is
 * required to be stable), so an account that has never synced is neither
 * punished nor promoted; it simply queues where the caller put it.
 */
export function fastestFirst<T>(items: readonly T[], lastDurationMs: (item: T) => number | undefined): T[] {
  return [...items].sort((a, b) => {
    const da = lastDurationMs(a)
    const db = lastDurationMs(b)
    if (da === undefined && db === undefined) return 0
    // An unmeasured account is assumed ordinary rather than slow: assuming the
    // worst would send every newly added account to the back of the queue on
    // the one sync where the user is standing there watching it.
    if (da === undefined) return 0
    if (db === undefined) return 0
    return da - db
  })
}
