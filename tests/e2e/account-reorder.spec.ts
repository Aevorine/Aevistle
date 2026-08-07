/**
 * Arranging mail accounts by hand, and the four ways that can go wrong.
 *
 * The feature spans `useReorder` (the gesture), `reorderAccounts` (the
 * reducer), `byManualOrder` (the sort) and two screens that must agree. Each
 * test below fails for a *different* reason if one of those four is removed,
 * which is the only property that makes a regression suite worth running:
 *
 *   - "keyboard" fails if the gesture or the reducer goes.
 *   - "persisted densely" fails if the reducer stops stamping `order`.
 *   - "an untouched store is not shuffled" fails if `byManualOrder` is
 *     replaced with the naive `a.order - b.order` comparator — the mistake
 *     that would silently rearrange every existing user's accounts on upgrade,
 *     and the one no amount of clicking would ever surface.
 *   - "groups are walls" fails if `scopeOf` is dropped.
 *   - "the inbox strip agrees" fails if either screen stops reading the shared
 *     `orderedAccounts` sequence.
 *
 * The keyboard path is used rather than a simulated drag on purpose. It is not
 * a weaker proxy: it runs through the *same* `commit` → `withMoved` → reducer
 * chain the pointer does, and it is the only one of the three input methods
 * that is deterministic in a headless browser. A `dragTo` here would be
 * measuring Chromium's drag heuristics as much as the app's, which is how a
 * suite acquires the flake it exists to detect.
 */

import { expect, test, type Page } from '@playwright/test'
import {
  DESKTOP,
  account,
  baseState,
  boot,
  expectInteractive,
  goToView,
  inboxAccount,
  readStoredState,
} from '../support/app'

/** Three accounts, distinguishable by label alone, in a known starting order. */
function threeAccounts(over: Array<Record<string, unknown>> = [{}, {}, {}]) {
  return [
    account({ id: 'acct_a', label: 'Alpha', fromAddress: 'a@example.com', ...over[0] }),
    account({ id: 'acct_b', label: 'Bravo', fromAddress: 'b@example.com', ...over[1] }),
    account({ id: 'acct_c', label: 'Charlie', fromAddress: 'c@example.com', ...over[2] }),
  ]
}

/**
 * The account rows in the order the Settings screen draws them.
 *
 * `[data-reorder-id]` and not a label match: the ids are the app's own stable
 * handles — `useReorder` puts them there for its hit-testing — so reading them
 * back tests the same thing the gesture sees, and survives translation.
 *
 * The `waitFor` is load-bearing. `evaluateAll` is a plain read with none of
 * Playwright's auto-waiting behind it, so calling it the instant after a nav
 * click returns `[]` — not "the list is empty", but "React has not committed
 * yet", which is a different fact wearing the same clothes. Waiting on
 * `.reorder-row` (the class the row carries whether or not reordering is
 * enabled) settles that before anything is read.
 */
async function settingsOrder(page: Page): Promise<string[]> {
  await page.locator('.log.reorder-row').first().waitFor()
  return page.locator('.log[data-reorder-id]').evaluateAll((rows) =>
    rows.map((row) => (row as HTMLElement).dataset.reorderId ?? ''),
  )
}

/** The same sequence as the inbox's tab strip understands it. */
async function inboxOrder(page: Page): Promise<string[]> {
  await page.locator('.segmented__slot').first().waitFor()
  return page.locator('.segmented__slot[data-reorder-id]').evaluateAll((slots) =>
    slots.map((slot) => (slot as HTMLElement).dataset.reorderId ?? ''),
  )
}

/** The grip inside a given account's row. */
function grip(page: Page, id: string) {
  return page.locator(`[data-reorder-id="${id}"] .reorder-handle`)
}

/**
 * Wait for the 350 ms save debounce to have fired *and* for the write to carry
 * the expected shape. Polling on the assertion rather than sleeping a fixed
 * number keeps this from being the test that fails on a loaded CI box.
 */
async function expectStoredOrder(page: Page, ids: string[]): Promise<void> {
  await expect
    .poll(async () => {
      const stored = await readStoredState(page)
      if (!stored) return null
      return [...(stored.accounts as Array<Record<string, unknown>>)]
        .sort((a, b) => (a.order as number) - (b.order as number))
        .map((a) => a.id as string)
    })
    .toEqual(ids)
}

test.describe('arranging accounts', () => {
  test('the keyboard moves a row, and the move survives a reload', async ({ page }) => {
    // `seedOnce` because this is the one spec here that reloads — see `boot`.
    await boot(
      page,
      baseState({ accounts: threeAccounts(), settings: { locale: 'en', defaultAccountId: 'acct_a', updateCheckOnStart: false } }),
      DESKTOP,
      { seedOnce: true },
    )
    await expectInteractive(page)
    await goToView(page, 'settings')

    expect(await settingsOrder(page)).toEqual(['acct_a', 'acct_b', 'acct_c'])

    // Alt rather than Ctrl: all three modifiers are accepted, and Alt is the
    // one that collides with nothing the browser claims on any platform.
    await grip(page, 'acct_a').focus()
    await grip(page, 'acct_a').press('Alt+ArrowDown')
    await expect
      .poll(() => settingsOrder(page))
      .toEqual(['acct_b', 'acct_a', 'acct_c'])

    // The announcement is the whole reason the keyboard path exists — a move
    // nobody is told about is not an accessible move. One-based, and counted
    // within the scope.
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: 'Alpha is now 2 of 3' })).toHaveCount(1)

    await expectStoredOrder(page, ['acct_b', 'acct_a', 'acct_c'])

    await page.reload()
    await expectInteractive(page)
    await goToView(page, 'settings')
    expect(await settingsOrder(page)).toEqual(['acct_b', 'acct_a', 'acct_c'])
  })

  test('one move stamps a dense order on every account, not just the moved one', async ({ page }) => {
    await boot(page, baseState({ accounts: threeAccounts(), settings: { locale: 'en', defaultAccountId: 'acct_a', updateCheckOnStart: false } }))
    await expectInteractive(page)
    await goToView(page, 'settings')

    await grip(page, 'acct_c').focus()
    await grip(page, 'acct_c').press('Alt+ArrowUp')
    await expect.poll(() => settingsOrder(page)).toEqual(['acct_a', 'acct_c', 'acct_b'])

    // Dense and complete. A sparse stamping — only the row that moved getting a
    // number — is the shape that works on the screen it was tested on and then
    // sorts wrongly the first time a *second* drag happens, because two rows
    // now compare as equal.
    await expect
      .poll(async () => {
        const stored = await readStoredState(page)
        return (stored?.accounts as Array<Record<string, unknown>>).map((a) => a.order)
      })
      .toEqual([0, 1, 2])
  })

  test('a store nobody has arranged is drawn in the order it was written', async ({ page }) => {
    /*
     * The upgrade case, and the reason `byManualOrder` is a function rather
     * than a comparator. Every account here predates the feature and carries no
     * `order` at all; `undefined - undefined` is `NaN`, which `Array.sort`
     * reads as "equal", so the naive implementation would have reordered a
     * store the user never touched. The labels are deliberately in reverse
     * alphabetical order so that an accidental `localeCompare` fallback would
     * fail this too.
     */
    await boot(
      page,
      baseState({
        accounts: [
          account({ id: 'acct_z', label: 'Zulu', fromAddress: 'z@example.com' }),
          account({ id: 'acct_m', label: 'Mike', fromAddress: 'm@example.com' }),
          account({ id: 'acct_a', label: 'Alpha', fromAddress: 'a@example.com' }),
        ],
        settings: { locale: 'en', defaultAccountId: 'acct_z', updateCheckOnStart: false },
      }),
    )
    await expectInteractive(page)
    await goToView(page, 'settings')

    expect(await settingsOrder(page)).toEqual(['acct_z', 'acct_m', 'acct_a'])
  })

  test('a group is a wall — a row cannot be stepped out of its own block', async ({ page }) => {
    /*
     * Groups render as contiguous alphabetical blocks, so "Work" comes before
     * "Zebra" no matter what any `order` says. A move across that boundary
     * would be accepted by the reducer, drawn back inside the original block on
     * the next render, and look to the user like the app undid their drag — so
     * `scopeOf` refuses it at the gesture instead.
     */
    await boot(
      page,
      baseState({
        accounts: [
          account({ id: 'acct_w1', label: 'Work one', fromAddress: 'w1@example.com', group: 'Work' }),
          account({ id: 'acct_w2', label: 'Work two', fromAddress: 'w2@example.com', group: 'Work' }),
          account({ id: 'acct_z1', label: 'Zebra one', fromAddress: 'z1@example.com', group: 'Zebra' }),
        ],
        settings: { locale: 'en', defaultAccountId: 'acct_w1', updateCheckOnStart: false },
      }),
    )
    await expectInteractive(page)
    await goToView(page, 'settings')

    expect(await settingsOrder(page)).toEqual(['acct_w1', 'acct_w2', 'acct_z1'])

    // Last of its group: down does nothing at all, rather than jumping groups.
    await grip(page, 'acct_w2').focus()
    await grip(page, 'acct_w2').press('Alt+ArrowDown')
    await page.waitForTimeout(200)
    expect(await settingsOrder(page)).toEqual(['acct_w1', 'acct_w2', 'acct_z1'])

    // And within the group it still moves, so the refusal above is the scope
    // rule and not a dead handler.
    await grip(page, 'acct_w2').press('Alt+ArrowUp')
    await expect.poll(() => settingsOrder(page)).toEqual(['acct_w2', 'acct_w1', 'acct_z1'])
  })

  test('the inbox strip is the same arrangement, not a second one', async ({ page }) => {
    /*
     * `state.accounts` and `state.inboxAccounts` are separate arrays whose
     * orders were never guaranteed to agree, which is precisely why `order`
     * lives on the account and both screens read `orderedAccounts`. If either
     * screen ever grows its own sequence, this is the test that says so.
     */
    await boot(
      page,
      baseState({
        accounts: threeAccounts(),
        inboxAccounts: [
          inboxAccount('acct_c', { imapUsername: 'c@example.com' }),
          inboxAccount('acct_a', { imapUsername: 'a@example.com' }),
          inboxAccount('acct_b', { imapUsername: 'b@example.com' }),
        ],
        settings: { locale: 'en', defaultAccountId: 'acct_a', updateCheckOnStart: false },
      }),
    )
    await expectInteractive(page)
    await goToView(page, 'settings')

    await grip(page, 'acct_c').focus()
    await grip(page, 'acct_c').press('Alt+ArrowUp')
    await grip(page, 'acct_c').press('Alt+ArrowUp')
    await expect.poll(() => settingsOrder(page)).toEqual(['acct_c', 'acct_a', 'acct_b'])

    await goToView(page, 'inbox')
    // The strip's own stored order (c, a, b) happens to match here; what makes
    // this meaningful is the *next* assertion, after a move that contradicts it.
    expect(await inboxOrder(page)).toEqual(['acct_c', 'acct_a', 'acct_b'])

    // Move from the inbox side this time, and check Settings followed.
    await grip(page, 'acct_b').focus()
    await grip(page, 'acct_b').press('Alt+ArrowLeft')
    await expect.poll(() => inboxOrder(page)).toEqual(['acct_c', 'acct_b', 'acct_a'])

    await goToView(page, 'settings')
    expect(await settingsOrder(page)).toEqual(['acct_c', 'acct_b', 'acct_a'])
  })

  test('the mouse drags a row onto another, and the pointercancel does not eat it', async ({ page }) => {
    /*
     * The one pointer test, and it is here for one specific defect.
     *
     * Starting an HTML5 drag makes Chromium fire `pointercancel` at whatever
     * held the pointer — which is the grip, because that is where the button
     * went down. An unguarded `pointercancel` handler tears down the drag it
     * has just started: `activeId` goes back to null, every subsequent
     * `dragover` declines to `preventDefault`, Chromium refuses the drop and
     * plays the snap-back. What made that worth a test rather than a fix is
     * that it was *intermittent* — whether the cancel arrived before or after
     * the first `dragover` decided whether that particular drag worked.
     *
     * `useReorder` answers only for a pointer it is actually holding, by id,
     * and a mouse never gets one. The event order asserted below is the proof:
     * the cancel must arrive *and* the drop must still land.
     *
     * Both rows are scrolled into view first, deliberately. Playwright scrolls
     * a target into view as part of moving to it, and a scroll that happens
     * while the button is down cancels a nascent drag in Chromium — which
     * would make this the flakiest test in the suite for a reason that has
     * nothing to do with the app.
     */
    await boot(page, baseState({ accounts: threeAccounts(), settings: { locale: 'en', defaultAccountId: 'acct_a', updateCheckOnStart: false } }))
    await expectInteractive(page)
    await goToView(page, 'settings')
    expect(await settingsOrder(page)).toEqual(['acct_a', 'acct_b', 'acct_c'])

    const visible = await page.evaluate(() => {
      document.querySelector('[data-reorder-id="acct_b"]')?.scrollIntoView({ block: 'center' })
      ;(window as unknown as { __dnd: string[] }).__dnd = []
      for (const type of ['dragstart', 'pointercancel', 'dragover', 'drop', 'dragend']) {
        document.addEventListener(
          type,
          (event) => (window as unknown as { __dnd: string[] }).__dnd.push(event.type),
          true,
        )
      }
      const box = (id: string) => document.querySelector(`[data-reorder-id="${id}"]`)?.getBoundingClientRect()
      const a = box('acct_a')
      const c = box('acct_c')
      return Boolean(a && c && a.top >= 0 && c.bottom <= window.innerHeight)
    })
    expect(visible, 'all three rows must be on screen before the drag').toBe(true)

    await page
      .locator('[data-reorder-id="acct_a"] .reorder-handle')
      .dragTo(page.locator('[data-reorder-id="acct_c"]'))

    await expect.poll(() => settingsOrder(page)).toEqual(['acct_b', 'acct_a', 'acct_c'])

    // The cancel fired, and the drop landed anyway. Asserting only the final
    // order would pass just as well against an implementation that had no
    // pointer handlers at all, which is not the thing being protected.
    const events = await page.evaluate(() => (window as unknown as { __dnd: string[] }).__dnd)
    expect(events).toContain('pointercancel')
    expect(events.indexOf('dragstart')).toBeLessThan(events.indexOf('pointercancel'))
    expect(events.indexOf('pointercancel')).toBeLessThan(events.indexOf('drop'))

    await expectStoredOrder(page, ['acct_b', 'acct_a', 'acct_c'])
  })

  test('a single account has no grip, and is not even a drop target', async ({ page }) => {
    /*
     * A control that cannot do anything is worse than an absent one: it invites
     * a gesture, does nothing, and gives no reason. `disabled` in `useReorder`
     * withholds both halves — the grip *and* `data-reorder-id` — so there is
     * also nothing for a stray drag from elsewhere in the app to land on. The
     * row itself still renders, which is what separates "reordering is off"
     * from "the account list broke".
     */
    await boot(page, baseState())
    await expectInteractive(page)
    await goToView(page, 'settings')

    await expect(page.locator('.log.reorder-row')).toHaveCount(1)
    await expect(page.locator('.reorder-handle')).toHaveCount(0)
    await expect(page.locator('[data-reorder-id]')).toHaveCount(0)
  })
})
