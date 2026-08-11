/**
 * Guards: `src/components/ErrorBoundary.tsx` (both levels of it, and the
 * `key={view}` on the per-view one in `src/App.tsx`) and
 * `src/core/mail/recipients.ts:buildPool`'s tolerance of a contact with no `tags`.
 *
 * The bug, as reported: one contact record written by an older build had no
 * `tags` field. `buildPool` read `.filter` off it, threw inside `TagField`,
 * and — with no error boundary anywhere in the tree at the time — React
 * unmounted the entire application. A white window, with the scheduled sends
 * still armed on disk and nothing on screen to say so.
 *
 * ## Why this is two tests and not the one the report describes
 *
 * *Both* halves of that failure were fixed, and they are independent. Seeding
 * a tag-less contact today therefore does **not** produce an error panel — it
 * produces a working compose screen, because `buildPool` no longer throws. A
 * test that asserted `.uifail` appears for that contact would be asserting the
 * product is still half-broken, and would start failing the moment anyone
 * hardened it further.
 *
 * So the two guards are exercised separately:
 *
 *   1. the malformed contact renders, proving `buildPool`'s guard is there;
 *   2. a view is made to fail by a fault the *test* injects, proving the
 *      boundary catches it and costs the user exactly one screen.
 *
 * The injected fault is a blocked network request for one lazily-imported view
 * chunk. That is deliberately not a data shape: a poison record is a race
 * against the product being hardened against it, and this suite should still
 * be testing the boundary in a year's time.
 */

import { expect, test } from '@playwright/test'
import { baseState, boot, expectInteractive, goToView } from '../support/app'

test('a contact with no tags renders instead of taking the app down', async ({ page }) => {
  await boot(
    page,
    baseState({
      contacts: [
        // Exactly the record from the report: no `tags` key at all. `tags` is
        // non-optional in the current `Contact` type, which is the whole
        // problem — the field arrived after the type did, so every store that
        // has ever written a contact can hold one without it.
        { id: 'ct_legacy', name: 'Wei Chen', address: 'wei@example.com', createdAt: 0 },
        // A second one missing an address entirely, which `buildPool` skips
        // rather than defaults — a blank chip is worse than one absent name.
        { id: 'ct_nameless', name: 'No Address', createdAt: 0 },
      ],
      recentRecipients: [{ address: 'old@example.com', count: 4, lastAt: 0 }],
    }),
  )

  await expectInteractive(page)

  // Compose is the screen `TagField` lives on, and `buildPool` runs in a
  // `useMemo` during its render — so simply getting here exercises it.
  await expect(page.locator('.uifail')).toHaveCount(0)
  await expect(page.locator('.tagfield').first()).toBeVisible()

  // The contacts screen reads the same records from the other end.
  await goToView(page, 'contacts')
  await expect(page.locator('.uifail')).toHaveCount(0)

  // And the picker, which is the other consumer of the same pool.
  await goToView(page, 'compose')
  await page.locator('.tagfield').first().click()
  await expect(page.locator('.uifail')).toHaveCount(0)
})

test('a view that fails to render costs one screen, not the window', async ({ page }) => {
  // The injected fault. `App.tsx` loads every screen but Compose through
  // `React.lazy(() => import('./views/…'))`; blocking the dev server's response
  // for one of those modules makes that import reject, which React re-throws
  // during render — the same path a component throwing in `useMemo` takes, and
  // the exact thing `ErrorBoundary` exists to catch.
  await page.route('**/src/views/LogsView.tsx*', (route) => route.abort())

  await boot(page, baseState())
  await expectInteractive(page)

  await goToView(page, 'logs')

  // One screen replaced by an explanation. `.uifail[role=alert]` is what
  // `ErrorBoundary`'s default panel renders; the copy inside it is not asserted
  // on because it is prose that may well be translated later.
  await expect(page.locator('.uifail[role="alert"]')).toBeVisible()

  // ...and the rest of the application is still standing. This is the assertion
  // that fails if the boundary is removed: without it React unmounts the whole
  // tree, `#root` empties, and every locator below finds nothing.
  await expect(page.locator('#root .shell')).toBeVisible()
  await expect(page.locator('nav[aria-label="Primary"]')).toBeVisible()
  // Nine primary tabs on a desktop — `NAV` in `core/nav.ts`. Counted rather
  // than named, so adding a tenth screen is a deliberate edit here and not a
  // silent pass.
  await expect(page.locator('button.nav__item[data-view]')).toHaveCount(9)

  // Other screens still render, which is the difference between "a screen
  // failed" and "the app failed".
  for (const view of ['contacts', 'templates', 'schedule']) {
    await goToView(page, view)
    await expect(page.locator('.uifail')).toHaveCount(0)
    await expect(page.locator('.view')).toBeVisible()
  }

  // Going back to the broken screen shows the panel again rather than a stale
  // rendered view — the boundary is keyed on `view`, so it remounts per screen.
  await goToView(page, 'logs')
  await expect(page.locator('.uifail[role="alert"]')).toBeVisible()

  // The retry button exists and is reachable. Most of these failures are
  // data-shaped and clear themselves once the offending row is edited
  // elsewhere; without a button the only way to find that out is a restart.
  await expect(page.locator('.uifail__retry')).toBeVisible()
})
