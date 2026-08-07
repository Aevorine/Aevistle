/**
 * Guards: `src/views/HomeView.tsx` and `HOME_FEATURES` in `src/core/nav.ts`,
 * plus the two doors that reach them — the sidebar footer button in
 * `src/App.tsx` on a desktop, and Home's slot in `MOBILE_NAV` on a phone.
 *
 * The bug behind the feature: the daily digest, holiday greetings, publishing
 * the working calendar for subscription and device pairing were four of sixteen
 * sections on the Settings screen and nothing else. Reaching any of them meant
 * knowing that a *preferences* screen was where "have I sent today's summary"
 * lived. Home is the door they got; the tiles are only a fix if each one
 * actually opens the feature and gives it back when closed.
 *
 * Two ways this silently regresses, and both are asserted below:
 *   - a tile opens a dialog that never resolves its lazy chunk, so the user
 *     stares at a skeleton — the tile "works" and shows nothing;
 *   - a dialog that Escape does not close, which on a fullscreen modal is a
 *     trap rather than an inconvenience.
 */

import { expect, test, type Page } from '@playwright/test'
import {
  DESKTOP,
  PHONE,
  account,
  baseState,
  boot,
  expectInteractive,
  goToView,
  job,
} from '../support/app'

/**
 * The four ids, spelled out rather than imported from `core/nav.ts`.
 *
 * Importing them would make this test agree with the product by construction —
 * and then a fifth tile added, or one quietly dropped, would still pass. The
 * list is the specification here, so it is written down here.
 */
const FEATURES = ['digest', 'greetings', 'calendarsub', 'pairing', 'selfcheck'] as const

/** A fixture with enough in it that the feature cards have something to draw. */
const seed = () =>
  baseState({
    accounts: [account()],
    jobs: [job()],
    contacts: [{ id: 'ct_1', name: 'Wei Chen', address: 'wei@example.com', tags: [], createdAt: 0 }],
  })

async function openAndCloseEveryFeature(page: Page): Promise<void> {
  for (const id of FEATURES) {
    const tile = page.locator(`button.hometile[data-view="${id}"]`)
    await expect(tile, `the ${id} tile should exist on Home`).toHaveCount(1)
    await tile.click()

    // `modal--fullscreen` is what `HomeView` asks for; `modal__body--settings`
    // is the treatment the five feature cards get (as opposed to the five real
    // screens, which get `--screen`). Both together identify a feature dialog
    // without reading its title, which is translated.
    const dialog = page.locator('.modal--fullscreen[role="dialog"]')
    await expect(dialog).toBeVisible()

    const body = dialog.locator('.modal__body--settings')
    await expect(body).toBeVisible()

    // Real content, not the `Suspense` placeholder. `Skeleton` renders
    // `aria-busy="true"`; a lazy chunk that never arrives would leave it there
    // and the tile would look like it worked.
    await expect(body.locator('[aria-busy="true"]')).toHaveCount(0)
    // Each of the five is a `Card` with controls in it. Requiring the card
    // *and* an operable control rules out "the chunk loaded and rendered
    // nothing", which is what a broken lazy export looks like from outside.
    await expect(body.locator('.card').first(), `the ${id} dialog should render its card`).toBeVisible()
    // Deliberately not a bare `input`: `Switch` renders a visually-hidden
    // checkbox as its first child, so "the first input" is always hidden and
    // asserting on it would fail for every feature regardless of the product.
    //
    // `.banner` is in the list on purpose and is not a loophole. Pairing over
    // Wi-Fi needs a host or join role that the browser bridge does not have, so
    // `DevicesCard` correctly draws no buttons there and explains why in a
    // warning banner instead — that *is* the feature working. What this
    // assertion rules out is the failure worth catching: a tile that opens onto
    // a frame with nothing in it.
    //
    // Filtered to what is actually *visible*, not to whatever comes first in
    // document order. On a phone the media query culls `.banner--info`, so the
    // first match inside the calendar-subscribe card is a `display: none`
    // element — correct behaviour that a `.first()` assertion would report as a
    // broken feature.
    await expect(
      body
        .locator('.switch, .btn, input.input, select.select, textarea, a[href], .banner')
        .filter({ visible: true }),
      `the ${id} dialog should offer a control or say why it cannot`,
    ).not.toHaveCount(0)
    // A card with a control and no words in it is a card that failed to load
    // its own copy — worth catching, and cheap.
    expect((await body.innerText()).trim().length).toBeGreaterThan(20)
    // And the boundary is not showing instead of the feature.
    await expect(page.locator('.uifail')).toHaveCount(0)

    // Escape closes it. Pressed on `body` rather than on a focused control, so
    // this exercises the document-level listener in `Modal` — the one an
    // over-eager `stopPropagation` inside a child has broken before.
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // Back on Home, with the tiles still there to open the next one.
    await expect(page.locator('.view--home')).toBeVisible()
  }
}

test('desktop: the sidebar footer opens Home, and all five feature tiles work', async ({ page }) => {
  await boot(page, seed(), DESKTOP)
  await expectInteractive(page)

  // Home is deliberately *not* in `NAV` — it is a doorway, not a tenth numbered
  // tab (see `core/nav.ts`'s `ViewId` comment). On a desktop its only entry is
  // the first icon button in the sidebar footer; the second is the collapse
  // toggle. Reached by position rather than by `aria-label`, because that label
  // is `t('nav.home')` and this suite does not key off translated copy — and
  // the assertion immediately after is self-checking: press the wrong one and
  // the sidebar merely collapses, so `.view--home` never appears.
  await page.locator('.sidebar__footer .icon-btn').first().click()
  await expect(page.locator('.view--home')).toBeVisible()

  // Five tiles and no more. `HOME_SECTIONS`' five are drawn only when `narrow`,
  // because on a desktop each of them already owns a sidebar tab and a second
  // door one click from the first is a door bought for nothing.
  await expect(page.locator('button.hometile')).toHaveCount(5)

  await openAndCloseEveryFeature(page)
})

test('phone: Home is a tab, and all five feature tiles work there too', async ({ page }) => {
  await boot(page, seed(), PHONE)
  await expectInteractive(page)

  // On a phone Home takes the middle slot of `MOBILE_NAV`, under the thumb.
  await goToView(page, 'home')
  await expect(page.locator('.view--home')).toBeVisible()

  // Ten tiles: the five features plus the five `HOME_SECTIONS` screens that
  // have nowhere else to be reached from at this width. This is the assertion
  // that fails if the phone silently loses its only door to the schedule, the
  // contacts, the templates, the working calendar or the log.
  await expect(page.locator('button.hometile')).toHaveCount(10)
  for (const id of ['schedule', 'contacts', 'templates', 'workcal', 'logs']) {
    await expect(page.locator(`button.hometile[data-view="${id}"]`)).toHaveCount(1)
  }

  await openAndCloseEveryFeature(page)
})
