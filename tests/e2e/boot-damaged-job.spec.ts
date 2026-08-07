/**
 * Guards: the boot effect in `src/state/AppState.tsx` (the per-record `try`
 * around `migrateSkipWeekends` / `rearm` / `shapeOccurrences`, and the
 * structurally-complete placeholder it returns) plus
 * `src/core/schedule.ts:migrateSkipWeekends`.
 *
 * The bug: one stored job whose `recurrence` was missing entirely — a record
 * merged in from a paired device on a different build, or restored from an old
 * backup — threw inside `migrateSkipWeekends`. The throw escaped the boot
 * effect, `setReady(true)` never ran, and `App.tsx`'s `if (!ready)` branch left
 * every screen in the application on its grey loading skeleton indefinitely.
 * Nothing said anything: no error, no console dialog, and the sidebar still
 * looked and behaved like a sidebar. The user's accounts, jobs and mail all
 * appeared to be gone while sitting intact on disk.
 *
 * What breaking this test would mean: a single malformed field anywhere in
 * anyone's stored document takes the whole application down to a placeholder,
 * silently, and the only recovery is deleting their data.
 */

import { expect, test } from '@playwright/test'
import { baseState, boot, expectInteractive, goToView, job } from '../support/app'

test('a job with no recurrence does not strand the app on the loading skeleton', async ({ page }) => {
  // The exact shape that was reproduced: `recurrence` absent, everything else
  // present and plausible. `delete` rather than `recurrence: undefined`, because
  // `JSON.stringify` drops undefined anyway and the point is a key that is not
  // there at all.
  const damaged = job({ id: 'job_damaged', name: 'Damaged reminder' })
  delete damaged.recurrence

  await boot(
    page,
    baseState({ jobs: [damaged, job({ id: 'job_healthy', name: 'Healthy reminder' })] }),
  )

  // The whole fix, in one assertion: boot finished. Before it, this timed out
  // because `button.nav__item[data-view]` never replaced the disabled `<span>`
  // placeholders.
  await expectInteractive(page)

  await goToView(page, 'schedule')

  const rows = page.locator('.joblist .job')
  // Two rows: the blast radius of a bad record has to *be* that record. A single
  // `.map` that threw would have lost the healthy job too, which is why boot
  // rebuilds them one at a time.
  await expect(rows).toHaveCount(2)

  const damagedRow = rows.filter({ hasText: 'Damaged reminder' })

  // Disabled, not deleted. Deleting someone's reminder because this build could
  // not parse it destroys the one thing they are here to keep; disabling it
  // means it survives to be looked at and cannot fire on a schedule nobody can
  // compute. `data-disabled` is the attribute `ScheduleView` already renders for
  // exactly this state, so no translated status text is involved.
  await expect(damagedRow).toHaveCount(1)
  await expect(damagedRow).toHaveAttribute('data-disabled', 'true')

  // The healthy job beside it is untouched and still armed.
  await expect(rows.filter({ hasText: 'Healthy reminder' })).toHaveAttribute(
    'data-disabled',
    'false',
  )
})

test('the quarantined job is structurally complete, so no downstream screen throws on it', async ({
  page,
}) => {
  // The second half of the same fix, and the reason the placeholder is built
  // from `defaultRecurrence()` rather than left as `{...job}`: handing the rest
  // of the app a job whose `recurrence` is still missing only moves the throw
  // downstream — the schedule list reads `.timeOfDay` off it, the working
  // calendar reads `.workdayPolicy`. One damaged record became three broken
  // screens.
  const damaged = job({ id: 'job_damaged', name: 'Damaged reminder' })
  delete damaged.recurrence

  await boot(page, baseState({ jobs: [damaged] }))
  await expectInteractive(page)

  for (const view of ['schedule', 'workcal', 'logs', 'contacts']) {
    await goToView(page, view)
    // `.uifail` is what `ErrorBoundary` renders when a screen throws. None of
    // these should ever reach it on account of a quarantined job.
    await expect(page.locator('.uifail')).toHaveCount(0)
    await expect(page.locator('.main [aria-busy="true"]')).toHaveCount(0)
  }

  // And it is still on disk after all that — quarantine is not a slow delete.
  const stored = await page.evaluate(() => {
    const raw = window.localStorage.getItem('aevistle.state.v1')
    return raw ? JSON.parse(raw) : null
  })
  expect(stored.jobs.map((j: { id: string }) => j.id)).toContain('job_damaged')
  expect(stored.jobs.find((j: { id: string }) => j.id === 'job_damaged').enabled).toBe(false)
})
