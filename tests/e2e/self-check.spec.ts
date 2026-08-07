/**
 * The mail self-check, end to end.
 *
 * `scripts/check-selfcheck.mjs` already exercises every verdict rule against
 * hand-built facts, so this file deliberately does not re-test the judgement.
 * What it covers is the part that file cannot reach: that the tile exists on
 * both shells, that pressing the button collects real facts from a real bridge,
 * and — the one that matters — that what lands on screen does not contradict
 * itself.
 *
 * That last one is not hypothetical. The first working version of this panel
 * reported "mail checks are skipped in the browser preview" and then, three
 * rows below, three red SMTP failures quoting the preview's own refusal as
 * though a mail server had rejected a password. Every unit test passed. It was
 * only visible by running it, which is why it is pinned here rather than there.
 */

import { expect, test } from '@playwright/test'
import { PHONE, account, baseState, boot, expectInteractive, goToView } from '../support/app'

/** Open Home, open the self-check tile, run it, and wait for a verdict. */
async function runSelfCheck(page: import('@playwright/test').Page) {
  await page.locator('.hometile[data-view="selfcheck"]').click()
  await page.locator('[data-testid="selfcheck-run"]').click()
  await expect(page.locator('.selfcheck__summary')).toBeVisible()
  // The button re-labels itself when the run finishes; waiting on the summary
  // alone would race a render that has the heading but no rows yet.
  await expect(page.locator('.selfcheck__row').first()).toBeVisible()
}

const rowStatuses = async (page: import('@playwright/test').Page) =>
  page.locator('.selfcheck__row').evaluateAll((rows) =>
    rows.map((r) => `${(r as HTMLElement).dataset.status}:${(r as HTMLElement).dataset.check}`),
  )

test.describe('mail self-check', () => {
  test('the report does not contradict itself in the browser preview', async ({ page }) => {
    await boot(
      page,
      baseState({
        accounts: [
          account({ id: 'acct_a', label: 'Alpha', fromAddress: 'a@example.com' }),
          account({ id: 'acct_b', label: 'Bravo', fromAddress: 'b@example.com' }),
        ],
      }),
    )
    await expectInteractive(page)
    // Desktop reaches Home from the sidebar footer, not a numbered tab.
    await page.locator('button.icon-btn[aria-label="Home"]').click()
    await runSelfCheck(page)

    const statuses = await rowStatuses(page)

    // The preview has no mail engine, so every layer that needs one must be
    // "not applicable" — never "failed".
    expect(statuses).toContain('warn:platform')
    for (const id of ['smtp:acct_a', 'imap:acct_a', 'cred:acct_a', 'smtp:acct_b']) {
      expect(statuses, `${id} must be skipped, not failed`).toContain(`skip:${id}`)
    }
    await expect(page.locator('.selfcheck__row[data-status="fail"]')).toHaveCount(0)

    // And the preview's own refusal must never be dressed up as a server reply.
    const details = await page.locator('.selfcheck__detail').allTextContents()
    expect(details.join(' ')).not.toContain('Browser preview')
  })

  test('the account name is on every row that is about an account', async ({ page }) => {
    // Two accounts produce two sets of otherwise identical rows; without the
    // name attached, a failure would be unattributable — which on a screen whose
    // entire job is "tell me which thing is broken" is the whole value gone.
    await boot(
      page,
      baseState({
        accounts: [
          account({ id: 'acct_a', label: 'Alpha', fromAddress: 'a@example.com' }),
          account({ id: 'acct_b', label: 'Bravo', fromAddress: 'b@example.com' }),
        ],
      }),
    )
    await expectInteractive(page)
    await page.locator('button.icon-btn[aria-label="Home"]').click()
    await runSelfCheck(page)

    await expect(page.locator('.selfcheck__row[data-check="smtp:acct_a"]')).toContainText('Alpha')
    await expect(page.locator('.selfcheck__row[data-check="smtp:acct_b"]')).toContainText('Bravo')
  })

  test('a missing account field is reported, and names the field', async ({ page }) => {
    await boot(page, baseState({ accounts: [account({ id: 'acct_a', label: 'Alpha', host: '' })] }))
    await expectInteractive(page)
    await page.locator('button.icon-btn[aria-label="Home"]').click()
    await runSelfCheck(page)

    const fields = page.locator('.selfcheck__row[data-check="fields:acct_a"]')
    await expect(fields).toHaveAttribute('data-status', 'fail')
    // The field name is data the test seeded, not app copy — safe to assert on.
    await expect(fields.locator('.selfcheck__detail')).toHaveText('host')
  })

  test('phone: the tile is reachable and the status word survives the narrow layout', async ({ page }) => {
    await boot(page, baseState(), PHONE)
    await expectInteractive(page)
    await goToView(page, 'home')
    await runSelfCheck(page)

    // Under 760px the badge stacks above the label instead of sitting beside
    // it. It must still be *there*: on this one screen the status word is the
    // content, and colour alone cannot carry it for a red-green colourblind
    // reader.
    const badge = page.locator('.selfcheck__badge').first()
    await expect(badge).toBeVisible()
    await expect(badge).not.toHaveText('')
  })
})
