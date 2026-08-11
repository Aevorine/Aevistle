/**
 * Automated accessibility sweep, via `@axe-core/playwright`, over the three
 * screens most people spend the most time on: compose (the whole point of
 * the app), settings (where every account and mail server credential is
 * entered), and inbox (a live reply thread, embedded remote HTML included).
 *
 * `@axe-core/playwright` is not declared in `tests/package.json` — this
 * suite lives in its own dependency island (see `playwright.config.ts`'s
 * module doc) — but Node's module resolution walks up from
 * `tests/e2e/node_modules` through `tests/node_modules` to the repository
 * root's, where it is installed as a root devDependency, so no second
 * install is needed here.
 *
 * Only `serious` and `critical` impact violations fail the run. `moderate`
 * and `minor` findings are real but noisy enough (contrast ratios a design
 * review already signed off on, landmark nitpicks) that gating on them would
 * train people to ignore red rather than fix it; `serious`/`critical` is
 * axe's own bar for "a screen reader or keyboard user is actually blocked",
 * which is the bar this suite exists to hold.
 */

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { account, baseState, boot, expectInteractive, goToView, inboxAccount } from '../support/app'

const FAILING_IMPACTS = new Set(['serious', 'critical'])

/** Run axe against whatever is on screen right now and fail on serious/critical findings only. */
async function assertNoSeriousViolations(page: Page, screenLabel: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => FAILING_IMPACTS.has(v.impact ?? ''))
  if (blocking.length === 0) return

  const detail = blocking
    .map((v) => {
      const targets = v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')
      return `  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s): ${targets})`
    })
    .join('\n')
  expect(blocking, `${screenLabel} has serious/critical accessibility violations:\n${detail}`).toEqual([])
}

test.describe('accessibility (axe, serious/critical only)', () => {
  test('compose', async ({ page }) => {
    await boot(page, baseState())
    await expectInteractive(page)
    // Compose is the app's default view — no navigation needed, but asserted
    // rather than assumed, so a future default-view change fails loudly here
    // instead of silently auditing the wrong screen.
    await expect(page.locator('button.nav__item[data-view="compose"][aria-current="page"]')).toBeVisible()
    await assertNoSeriousViolations(page, 'compose')
  })

  test('settings', async ({ page }) => {
    await boot(page, baseState())
    await expectInteractive(page)
    await goToView(page, 'settings')
    await expect(page.locator('button.nav__item[data-view="settings"][aria-current="page"]')).toBeVisible()
    await assertNoSeriousViolations(page, 'settings')
  })

  test('inbox', async ({ page }) => {
    // A populated inbox, not an empty one — an empty state and a screen with
    // a real message thread can fail axe for different reasons (the former
    // for its placeholder, the latter for the rendered mail body), and only
    // testing the empty one would miss the one people actually read mail in.
    await boot(
      page,
      baseState({
        inboxAccounts: [
          inboxAccount('acct_test_primary', {
            messages: [
              {
                id: 'msg_1',
                accountId: 'acct_test_primary',
                uid: 1,
                folder: 'INBOX',
                from: 'sender@example.com',
                subject: 'A reply worth reading',
                date: Date.UTC(2026, 7, 6, 8, 0, 0),
                seen: true,
                hasAttachments: false,
                bodyCached: false,
              },
            ],
          }),
        ],
      }),
    )
    await expectInteractive(page)
    await goToView(page, 'inbox')
    await expect(page.locator('button.nav__item[data-view="inbox"][aria-current="page"]')).toBeVisible()
    await assertNoSeriousViolations(page, 'inbox')
  })
})
