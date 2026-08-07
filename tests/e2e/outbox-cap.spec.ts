/**
 * The outbox strip stays a strip, however long the queue gets.
 *
 * Measured before this cap existed: a queue of 150 — an ordinary result of an
 * offline afternoon with recurring jobs — rendered all 150 rows above the
 * compose editor, pushing it off the screen, and re-rendered every one of them
 * on every keystroke because the component reads the whole app state and the
 * draft lives in it. Typing a subject line blocked the main thread for 65 ms on
 * average and 244 ms at the 95th percentile, against a 16.7 ms frame. With the
 * cap: 32 ms and 56 ms.
 *
 * What is pinned here is the behaviour, not the timing. A latency assertion in
 * a suite that runs on whatever machine CI allocates is a flake generator; the
 * row count and the ordering are exact, and they are what the fix actually
 * changed.
 */

import { expect, test } from '@playwright/test'
import { DESKTOP, account, baseState, boot, draft, expectInteractive } from '../support/app'

const NOW = Date.UTC(2026, 7, 6, 9, 0, 0)

/** `n` queued messages, `failedIds` of them having given up. */
function outbox(n: number, failedIds: number[] = []): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    id: `o_${i}`,
    draft: draft('acct_test_primary', { subject: `Queued ${i}` }),
    accountId: 'acct_test_primary',
    status: failedIds.includes(i) ? 'failed' : 'waiting',
    attempts: 1,
    queuedAt: NOW,
    // Descending, so "soonest first" is a different order from array order and
    // the sort is actually being tested rather than coincidentally agreed with.
    nextAttemptAt: NOW + (n - i) * 60_000,
  }))
}

test.describe('the outbox strip', () => {
  test('a long queue is capped, and says how many it is not showing', async ({ page }) => {
    await boot(page, baseState({ accounts: [account()], outbox: outbox(150) }), DESKTOP)
    await expectInteractive(page)

    await expect(page.locator('.outbox__item')).toHaveCount(6)
    // The remainder must be stated. A list that silently stops at six would
    // have the user believe six is the whole queue.
    await expect(page.locator('.outbox__more')).toHaveText(/144/)
  })

  test('failures come first, so the cap never hides the ones needing a decision', async ({ page }) => {
    // Three failures buried deep in the array. Without the sort they would fall
    // outside the first six and the user would see only messages that are
    // waiting patiently — while three have given up.
    await boot(
      page,
      baseState({ accounts: [account()], outbox: outbox(60, [40, 50, 59]) }),
      DESKTOP,
    )
    await expectInteractive(page)

    const statuses = await page
      .locator('.outbox__item')
      .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.status))
    expect(statuses.slice(0, 3)).toEqual(['failed', 'failed', 'failed'])

    const subjects = await page.locator('.outbox__item .outbox__subject').allTextContents()
    expect(subjects.slice(0, 3).sort()).toEqual(['Queued 40', 'Queued 50', 'Queued 59'])
  })

  test('a short queue is shown whole, with no remainder line', async ({ page }) => {
    await boot(page, baseState({ accounts: [account()], outbox: outbox(3) }), DESKTOP)
    await expectInteractive(page)

    await expect(page.locator('.outbox__item')).toHaveCount(3)
    await expect(page.locator('.outbox__more')).toHaveCount(0)
  })

  test('drawing the queue does not reorder it', async ({ page }) => {
    /*
     * The strip sorts to decide what to show. `state.outbox` belongs to the
     * reducer, and sorting it in place would rewrite the stored queue as a side
     * effect of rendering — reordering the send order, and persisting that
     * reorder on the next save. Sorting a copy is the fix; this is the test
     * that fails if somebody removes the `.slice()` for looking redundant.
     */
    await boot(page, baseState({ accounts: [account()], outbox: outbox(20, [15]) }), DESKTOP)
    await expectInteractive(page)
    await expect(page.locator('.outbox__item').first()).toBeVisible()

    const storedOrder = await page.evaluate(() => {
      const raw = window.localStorage.getItem('aevistle.state.v1')
      return raw ? (JSON.parse(raw).outbox as Array<{ id: string }>).map((o) => o.id) : []
    })
    expect(storedOrder.slice(0, 4)).toEqual(['o_0', 'o_1', 'o_2', 'o_3'])
  })
})
