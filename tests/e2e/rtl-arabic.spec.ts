/**
 * Every other spec in this suite pins `locale: 'en'` deliberately (see
 * `baseState`'s doc) so layout measurements are not accidentally testing
 * `Intl` output instead of the app. That leaves a real gap: nothing here has
 * ever actually rendered the app in Arabic, the one shipped locale whose
 * `dir` is `rtl` (`src/i18n/index.ts`). `check-i18n.mjs` only diffs
 * translation *keys* across the six locale files — it has no browser and
 * cannot see a layout that mirrors wrong, a fixed-direction margin that
 * should have flipped, or a card that spills sideways once its labels run
 * right-to-left.
 *
 * This spec boots the app with `settings.locale: 'ar'`, which
 * `AppState.tsx`'s appearance effect turns into `document.documentElement`'s
 * `dir="rtl"` (see the call right after `localeMeta(locale)` there), on
 * compose and settings — the two screens `AGENTS`/the task both name — at
 * both a phone width and a desktop width, and fails if anything overflows
 * sideways.
 *
 * The overflow check mirrors `scripts/layout-probe.mjs`'s own approach
 * rather than inventing a new one: the document's own `scrollWidth` vs
 * `clientWidth` (nothing, anywhere on the page, pushes the whole viewport
 * wider), plus every layout container layout-probe.mjs already watches
 * (`.view`, `.list-pane`, `.modal__body`, `.codelist`, `.joblist`,
 * `.btn-row`, `.markup`) for horizontal scroll that is not `.markup`'s own
 * intentional `overflow-x: auto`.
 */

import { expect, test, type Page } from '@playwright/test'
import { account, baseState, boot, expectInteractive, goToView } from '../support/app'

const PHONE = { width: 390, height: 844 } as const
const DESKTOP = { width: 1440, height: 900 } as const

interface OverflowReport {
  docOverflowPx: number
  offenders: Array<{ sel: string; x: number }>
}

/** Same measurement `scripts/layout-probe.mjs` uses for "nothing overflows sideways". */
async function measureOverflow(page: Page): Promise<OverflowReport> {
  return page.evaluate(() => {
    const docOverflowPx = document.documentElement.scrollWidth - document.documentElement.clientWidth
    const offenders: Array<{ sel: string; x: number }> = []
    const selectors = ['.view', '.list-pane', '.modal__body', '.codelist', '.joblist', '.btn-row', '.markup']
    for (const el of document.querySelectorAll(selectors.join(', '))) {
      const x = el.scrollWidth - el.clientWidth
      if (x <= 0) continue
      const intended = getComputedStyle(el).overflowX === 'auto' || getComputedStyle(el).overflowX === 'scroll'
      if (intended) continue
      offenders.push({ sel: (el.className || el.tagName).toString().split(' ').slice(0, 2).join('.'), x })
    }
    return { docOverflowPx, offenders }
  })
}

function assertNoOverflow(report: OverflowReport, where: string) {
  expect(report.docOverflowPx, `${where}: the document itself scrolls sideways by ${report.docOverflowPx}px in Arabic (RTL)`).toBeLessThanOrEqual(0)
  expect(
    report.offenders,
    `${where}: ${report.offenders.length} container(s) overflow sideways in Arabic (RTL): ${report.offenders
      .map((o) => `${o.sel} (+${o.x}px)`)
      .join(', ')}`,
  ).toEqual([])
}

const arabicState = (over: Record<string, unknown> = {}) =>
  baseState({
    settings: { locale: 'ar', defaultAccountId: 'acct_test_primary', updateCheckOnStart: false },
    ...over,
  })

test.describe('Arabic (RTL) layout', () => {
  test('the document actually switches to dir="rtl"', async ({ page }) => {
    await boot(page, arabicState(), DESKTOP)
    await expectInteractive(page)
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar')
  })

  for (const viewport of [PHONE, DESKTOP]) {
    test(`compose has no horizontal overflow at ${viewport.width}px`, async ({ page }) => {
      await boot(page, arabicState(), viewport)
      await expectInteractive(page)
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
      // compose is the app's default view
      assertNoOverflow(await measureOverflow(page), `compose @ ${viewport.width}px`)
    })

    test(`settings has no horizontal overflow at ${viewport.width}px`, async ({ page }) => {
      await boot(page, arabicState({ accounts: [account()] }), viewport)
      await expectInteractive(page)
      await goToView(page, 'settings')
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
      assertNoOverflow(await measureOverflow(page), `settings @ ${viewport.width}px`)
    })
  }
})
