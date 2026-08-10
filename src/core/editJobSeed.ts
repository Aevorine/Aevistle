/**
 * "Edit this reminder" — the one thing the compose screen needs to know that
 * cannot travel through `state.draft` (the message) or the schedule state
 * inside `ComposeView` itself (which resets fresh on every mount): which
 * `ScheduledJob`, if any, this session of the compose screen is updating
 * rather than creating.
 *
 * Same one-screen-transition lifetime as `core/composeSeed.ts`'s date seed,
 * and the same reason for the next-tick clear — see that module's doc for
 * why clearing on read rather than on the next macrotask would let React
 * StrictMode's double-invoked `useState` initialiser see different answers
 * across the two calls.
 */

import type { ScheduledJob } from './types'

let pending: ScheduledJob | null = null
let clearScheduled = false

type Defer = (fn: () => void) => void
const deferToNextTick: Defer = (fn) => {
  setTimeout(fn, 0)
}

/** Remember which job the next compose-screen mount is editing. */
export function seedEditJob(job: ScheduledJob): void {
  pending = job
  clearScheduled = false
}

/** What is waiting, without spending it. */
export function peekEditJobSeed(): ScheduledJob | null {
  return pending
}

/** Drop the seed. Used when the navigation that would have consumed it did not happen. */
export function clearEditJobSeed(): void {
  pending = null
  clearScheduled = false
}

/**
 * The seed, spent. Returns the same job to every caller inside one render
 * pass, and null to everyone after that — see the module doc.
 */
export function takeEditJobSeed(defer: Defer = deferToNextTick): ScheduledJob | null {
  if (pending === null) return null
  const value = pending
  if (!clearScheduled) {
    clearScheduled = true
    defer(() => {
      pending = null
      clearScheduled = false
    })
  }
  return value
}
