/**
 * Guards: the `.test-action` wrappers and their `field__hint field__hint--keep`
 * reasons in `src/components/AccountDialog.tsx`, together with the
 * `.field__hint:not(.field__hint--keep)` escape hatch in the
 * `@media (max-width: 760px)` block of `src/styles/app.css`.
 *
 * The bug: `validateAccount` marks the from address, server and username as
 * errors from the moment a blank add-account form opens, so the "test
 * connection" button is disabled before anyone has typed a character — on every
 * platform. A desktop reader has the per-field hints sitting in the empty column
 * beside each input and can see why. The phone stylesheet culls `.field__hint`
 * wholesale, on the sound general reasoning that a hint restates what an input
 * already shows. Applied here it removed the *only* thing on a 360px screen that
 * ever said which boxes were still empty, leaving a permanently grey button and
 * no clue anywhere on the device. "The tests do not work on Android" is a fair
 * description of that.
 *
 * Two things have to hold, and only both together are a fix:
 *   - the reason renders, and
 *   - the phone stylesheet does not hide it — which is why every assertion below
 *     goes through `offsetHeight`, not `toBeVisible()`. A `display: none`
 *     element fails both, but so does one the media query merely collapsed, and
 *     `offsetHeight` is the measurement that made the original bug report
 *     concrete ("0x0, link included").
 */

import { expect, test, type Locator, type Page } from '@playwright/test'
import { PHONE, baseState, boot, expectInteractive, goToView } from '../support/app'

/** Rendered height as the browser computes it. 0 means the user cannot read it. */
function heightOf(locator: Locator): Promise<number> {
  return locator.evaluate((el) => (el as HTMLElement).offsetHeight)
}

/**
 * Settings → 邮箱账号 → 添加账号, without touching a word of app copy.
 *
 * On a phone `SettingsSection` renders an empty anchor `<div id="set-accounts">`
 * immediately followed by the `.settingsrow` button that opens it — see that
 * component's comment on why the anchor is emitted even where nothing scrolls
 * to it. The adjacent-sibling selector is therefore the section's identity, and
 * it survives every translation.
 */
async function openAddAccountDialog(page: Page): Promise<void> {
  await goToView(page, 'settings')

  // The phone shell is the entire premise of this file. Assert it rather than
  // assume it: at 761px every assertion below would pass for the wrong reason.
  expect(await page.evaluate(() => document.documentElement.dataset.shell)).toBe('mobile')
  expect(await page.evaluate(() => window.matchMedia('(max-width: 760px)').matches)).toBe(true)

  await page.locator('#set-accounts + button.settingsrow').click()

  // The accounts section holds exactly one Card, and its header's action is the
  // add button. The fixture seeds an account, so the `EmptyState`'s second copy
  // of that button is not rendered and this cannot be ambiguous.
  await page.locator('.modal .card__header .btn--primary').click()

  // `wide` is what tells the account dialog apart from the section dialog it
  // opened on top of.
  await expect(page.locator('.modal--wide[role="dialog"]')).toBeVisible()
}

test('the send-test button says why it is disabled, on a phone', async ({ page }) => {
  await boot(page, baseState(), PHONE)
  await expectInteractive(page)
  await openAddAccountDialog(page)

  const testButton = page.locator('.modal--wide .modal__footer .test-action > .btn')
  const reason = page.locator('.modal--wide .modal__footer .test-action .field__hint--keep')

  // Disabled, because a blank form is missing the from address, the server and
  // the username — `validateAccount`'s three errors.
  await expect(testButton).toBeDisabled()

  // And it says so, at a height greater than zero. This is the assertion the
  // bug was: before the fix the element either did not exist or was
  // `display: none`, and the button was grey forever with nothing to read.
  await expect(reason).toHaveCount(1)
  expect(await heightOf(reason)).toBeGreaterThan(0)
  // Not empty text, either — a rendered-but-blank box is the same dead end.
  expect((await reason.innerText()).trim().length).toBeGreaterThan(0)

  // Fill the three fields the reason is about. The literal placeholders are
  // hard-coded English in `AccountDialog.tsx` (they are example hostnames, not
  // translated copy), which makes them the most stable handles in the form.
  await page.locator('.modal--wide input[placeholder="you@example.com"]').fill('me@example.net')
  await page.locator('.modal--wide input[placeholder="smtp.example.com"]').fill('smtp.example.net')

  // The username box carries no placeholder and its label is translated. It is
  // identified structurally instead: the first `.input` in the one `.field__row`
  // that also contains the send password box. The receive half of the form has a
  // row of the same shape, but it is not rendered until receiving is switched
  // on, so this is unambiguous here.
  const usernameRow = page.locator('.modal--wide .field__row', {
    has: page.locator('input[autocomplete="new-password"]'),
  })
  await usernameRow.locator('input.input').first().fill('me@example.net')

  // Now it is usable, and the explanation has gone with the reason for it.
  await expect(testButton).toBeEnabled()
  await expect(reason).toHaveCount(0)
})

test('the receive-test button explains itself too, while ordinary hints stay culled', async ({
  page,
}) => {
  await boot(page, baseState(), PHONE)
  await expectInteractive(page)
  await openAddAccountDialog(page)

  // Turn receiving on. The switch is identified by position *within the form's
  // structure* rather than by label: it is the first `.switch` after the
  // `.section-label` that begins the receiving half of the dialog.
  await page.locator('.modal--wide .modal__body > .section-label ~ .switch').first().click()

  const inboxTest = page.locator('.modal--wide .inline-actions .test-action > .btn')
  const inboxReason = page.locator('.modal--wide .inline-actions .test-action .field__hint--keep')

  // An account created before receiving existed has no IMAP host, so switching
  // this on reveals empty boxes — which is precisely the state that used to
  // present a grey button with no explanation.
  await expect(inboxTest).toBeDisabled()
  await expect(inboxReason).toHaveCount(1)
  expect(await heightOf(inboxReason)).toBeGreaterThan(0)

  // The negative half of the same rule, and the reason `--keep` is an *exception*
  // rather than a blanket revert: the receive password's ordinary hint is still
  // hidden by the phone media query. If this ever reports a height, the mobile
  // cull has been removed wholesale and Settings has gone back to being an
  // article about its own controls — see the long comment above the rule in
  // `app.css`.
  const plainHint = page.locator('.modal--wide .field__hint:not(.field__hint--keep)')
  expect(await plainHint.count()).toBeGreaterThan(0)
  expect(await heightOf(plainHint.first())).toBe(0)

  // Fill the two fields the receive test needs and watch it come alive.
  await page.locator('.modal--wide input[placeholder="imap.example.com"]').fill('imap.example.net')
  const inboxUserRow = page.locator('.modal--wide .field__row', {
    has: page.locator('input[autocomplete="new-password"]'),
  })
  // Two such rows exist now (send and receive); the receive one is the second.
  await inboxUserRow.nth(1).locator('input.input').first().fill('me@example.net')

  await expect(inboxTest).toBeEnabled()
  await expect(inboxReason).toHaveCount(0)
})
