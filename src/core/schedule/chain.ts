/**
 * Multi-stage reminders.
 *
 * Real reminders are rarely one message. "The contract expires on the 30th"
 * means a nudge a week out, another the day before, and one on the morning
 * itself — and setting that up today means creating three separate jobs, three
 * times, and remembering to delete all three if the thing gets done early.
 *
 * A chain is those jobs created together and tagged with a shared id, so the
 * schedule screen can show them as one thing and cancelling one offers to
 * cancel the rest.
 *
 * Modelled as ordinary jobs rather than a new kind of object on purpose: the
 * scheduler, the retry logic, quiet hours, the control API and the activity
 * log all already work on jobs, and none of them need to learn what a chain
 * is. The id is the only new thing, and anything that ignores it still
 * behaves correctly.
 */

import { newId, type Recurrence, type ScheduledJob } from '../types'

export interface ChainStage {
  /** Milliseconds before the event. 0 is the event itself. */
  leadMs: number
  /** i18n key for the label shown in the picker and prefixed to the subject. */
  labelKey: string
}

const DAY = 86_400_000

/**
 * The offsets offered by default.
 *
 * Seven / one / zero rather than a free-form list because the point is to make
 * the common case one click. Anything else is still two reminders made the
 * ordinary way.
 */
export const CHAIN_STAGES: ChainStage[] = [
  { leadMs: 7 * DAY, labelKey: 'chain.week' },
  { leadMs: 3 * DAY, labelKey: 'chain.threeDays' },
  { leadMs: DAY, labelKey: 'chain.day' },
  { leadMs: 2 * 3_600_000, labelKey: 'chain.twoHours' },
  { leadMs: 0, labelKey: 'chain.onTheDay' },
]

/**
 * Build the jobs for one chain.
 *
 * Stages whose fire time has already passed are dropped rather than fired
 * immediately: an event three days out selected with a "one week before" stage
 * should quietly skip that stage, not send a "one week to go" message right
 * now, which is both wrong and alarming.
 *
 * Only the `once` kind gets stages. "Every Monday, and also three days before
 * every Monday" is a sentence nobody means, and offering it would produce
 * schedules that are impossible to reason about.
 */
export function buildChain(
  base: Omit<ScheduledJob, 'id' | 'chainId'>,
  leadTimes: number[],
  now = Date.now(),
): ScheduledJob[] {
  const target = base.recurrence.startAt
  const chainId = newId('chain')

  const stages = base.recurrence.kind === 'once' ? [...new Set(leadTimes)].sort((a, b) => b - a) : [0]

  /*
   * Survivors first, then the tag — `stages.length` counted the stages asked
   * for, including the ones already in the past.
   *
   * Measured: an event two days out with lead times of a week and a day leaves
   * exactly one job, and it still carried `chainId` and `chainLeadMs`. The
   * comment below states the rule it was breaking: the schedule screen drew
   * grouping affordances around that single row, and deleting it opened the
   * "cancel this one, or the whole chain of 1?" dialog.
   */
  const surviving = stages
    .map((leadMs) => ({ leadMs, at: target - leadMs }))
    .filter((stage) => stage.at > now)
  const isChain = surviving.length > 1

  const jobs = surviving.map(({ leadMs, at }): ScheduledJob => {
    const recurrence: Recurrence = { ...base.recurrence, startAt: at }
    return {
      ...base,
      id: newId('job'),
      // A single-stage chain is just a job. Tagging it would make the
      // schedule screen draw grouping affordances around one row.
      chainId: isChain ? chainId : undefined,
      chainLeadMs: isChain ? leadMs : undefined,
      recurrence,
      occurrences: [],
    }
  })

  // Everything was in the past — including the event itself. Give back the
  // event stage anyway so the caller reports "that time has gone" rather than
  // silently creating nothing.
  if (jobs.length === 0) {
    return [{ ...base, id: newId('job'), recurrence: { ...base.recurrence }, occurrences: [] }]
  }
  return jobs
}

/** Human-readable lead time, for a row that is part of a chain. */
export function leadLabelKey(leadMs: number): string {
  return CHAIN_STAGES.find((stage) => stage.leadMs === leadMs)?.labelKey ?? 'chain.custom'
}
