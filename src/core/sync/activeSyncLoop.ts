/**
 * A way to reach the one `SyncLoop` this process is running, for a screen
 * that has to start a cycle on purpose.
 *
 * `SyncLoop` is constructed inside `state/AppState.tsx`'s effect and torn
 * down with it — it needs the live state ref, the keystore bridge and the
 * dispatching `onSynced` callback, none of which a view has or should have.
 * That was fine while a cycle only ever started from the 90-second timer.
 * `views/DevicesCard.tsx`'s "sync now" button is the first caller that is not
 * the timer, and it needs the loop itself rather than a copy: a second loop
 * built in the view would allocate its own replay counters against the same
 * `PairedDevice` rows (see `syncLoop.ts`'s module doc on two exchanges racing
 * for one device) and would silently skip mailbox passwords, since the
 * `SyncSecretTransport` factory lives in the provider too.
 *
 * So the loop is registered rather than rebuilt. One slot, not a set: this
 * app has exactly one `AppProvider`, and a second registration overwriting
 * the first is the correct outcome of a remount rather than a case worth
 * modelling.
 *
 * Deliberately not on the React context. The context value is rebuilt on
 * every state change that touches it, and the loop is the one thing in the
 * app that must survive those rebuilds untouched — the reason `AppState.tsx`
 * builds it in an effect with a near-empty dependency list in the first
 * place. Putting it on the context would put a live socket-driving object
 * into a value React is free to recreate.
 *
 * Nothing registers this in a build with no sync bridge (the web sandbox, or
 * a desktop launch before the state has loaded), and `syncNow` answering
 * `null` is the honest report of that — see how the button words it.
 */

import type { SyncCycleReport, SyncLoop } from './syncLoop'

let active: SyncLoop | null = null

/**
 * Hand over the running loop, or `null` while tearing it down.
 *
 * The `null` call is not optional bookkeeping: without it a torn-down
 * provider leaves a loop here whose hooks close over a state ref nobody
 * updates any more, and the button would keep "succeeding" against a snapshot
 * frozen at unmount.
 */
export function registerSyncLoop(loop: SyncLoop | null): void {
  active = loop
}

/**
 * Run one cycle now, or answer `null` when there is no loop to run it.
 *
 * The report is the point — see `SyncCycleReport`. A caller that only wanted
 * "go and try" would be served by the timer it is already sitting inside.
 */
export function syncNow(): Promise<SyncCycleReport> | null {
  return active ? active.runCycle() : null
}
