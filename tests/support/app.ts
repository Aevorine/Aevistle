/**
 * Fixture builders and the handful of app-shaped helpers every spec needs.
 *
 * ## The one rule these helpers exist to enforce
 *
 * Aevistle ships in six languages, and a test that clicks "添加账号" is a test
 * that breaks the next time somebody edits a translation table — which is a
 * false alarm about a real language file, in a suite whose whole job is to be
 * believed. So nothing here, and nothing in the specs, matches on app copy.
 * Everything is reached through `data-view`, a class the stylesheet already
 * owns, a role, or a literal the app hard-codes in English on purpose
 * (`aria-label="Primary"`, `placeholder="smtp.example.com"`). Where only the
 * DOM *shape* identifies an element, the spec says so and says why.
 *
 * The one string these tests do assert on is data the test itself seeded — a
 * job called "Damaged reminder" is not app copy, it is the fixture.
 */

import { expect, type Page } from '@playwright/test'

/** `src/core/bridge-web.ts`'s `STATE_KEY`. This is the whole seeding mechanism. */
export const STATE_KEY = 'aevistle.state.v1'

/** `src/core/types.ts`'s `SCHEMA_VERSION`. */
export const SCHEMA_VERSION = 2

/** Wide enough for the nine-tab sidebar — `useNarrow`'s threshold is 760px. */
export const DESKTOP = { width: 1440, height: 900 } as const

/**
 * The phone shell. Under 760px `main.tsx`/`useMobileShell` set
 * `document.documentElement.dataset.shell = 'mobile'` and the
 * `@media (max-width: 760px)` block in `app.css` takes effect — which is the
 * thing two of these specs are actually testing.
 */
export const PHONE = { width: 390, height: 844 } as const

const NOW = Date.UTC(2026, 7, 6, 9, 0, 0)

// ---------------------------------------------------------------------------
// Record builders
// ---------------------------------------------------------------------------

export function account(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'acct_test_primary',
    label: 'Primary',
    fromName: 'Test Sender',
    fromAddress: 'sender@example.com',
    host: 'smtp.example.com',
    port: 465,
    security: 'ssl',
    username: 'sender@example.com',
    authMethod: 'password',
    hasSecret: true,
    timeoutMs: 20_000,
    autoNegotiate: true,
    allowInvalidCert: false,
    poolMaxMessages: 50,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

export function draft(accountId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    to: ['someone@example.com'],
    cc: [],
    bcc: [],
    subject: 'Test subject',
    body: 'Test body',
    bodyFormat: 'plain',
    attachments: [],
    accountId,
    priority: 'normal',
    requestReadReceipt: false,
    individualDelivery: false,
    ...over,
  }
}

export function recurrence(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'daily',
    startAt: NOW,
    timeOfDay: '09:00',
    monthDayFallback: 'last',
    endMode: 'never',
    jitterSeconds: 0,
    skipWeekends: false,
    catchUp: 'fireOnce',
    ...over,
  }
}

export function job(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'job_healthy',
    name: 'Healthy reminder',
    enabled: true,
    draft: draft('acct_test_primary'),
    recurrence: recurrence(),
    occurrences: [NOW + 86_400_000],
    runCount: 0,
    retry: { maxAttempts: 3, backoffSeconds: 60, backoffFactor: 3 },
    status: 'armed',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

export function inboxAccount(accountId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId,
    enabled: true,
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapSecurity: 'ssl',
    imapUsername: 'sender@example.com',
    imapAllowInvalidCert: false,
    folders: [],
    messages: [],
    removed: [],
    showRemoteImages: 'always',
    imageAllowlist: [],
    ...over,
  }
}

/**
 * A complete, healthy stored document, ready to be spoilt in exactly one way
 * per spec.
 *
 * `locale: 'en'` is pinned rather than left to `detectLocale()`. Not because
 * anything below reads English — none of it does — but because a locale that
 * changed with the CI runner's `Accept-Language` would change `Intl.ListFormat`
 * output, text direction (Arabic is RTL) and layout widths, and a suite that
 * measures `offsetHeight` should not have that as a hidden input.
 */
export function baseState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accounts: [account()],
    jobs: [],
    contacts: [],
    templates: [],
    logs: [],
    settings: {
      locale: 'en',
      defaultAccountId: 'acct_test_primary',
      // Otherwise the first render fires a real network request at GitHub's
      // release API, which is neither this suite's business nor reliable.
      updateCheckOnStart: false,
    },
    draft: draft('acct_test_primary', { to: [], subject: '', body: '' }),
    inboxAccounts: [],
    draftSnapshots: [],
    outbox: [],
    codeHits: [],
    recentRecipients: [],
    pairedDevices: [],
    syncConflicts: [],
    schemaVersion: SCHEMA_VERSION,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// Driving the app
// ---------------------------------------------------------------------------

/**
 * Put a document on disk (as the browser understands "disk") and open the app
 * on it.
 *
 * `addInitScript` rather than `evaluate`-then-reload: the boot effect reads
 * `localStorage` in the first tick after mount, so anything written after
 * navigation races it. This runs before a single line of app code does.
 *
 * `localStorage.clear()` first because the app also stores an unrelated
 * sidebar-collapsed flag, and a spec that inherited a collapsed sidebar from
 * another spec would be exactly the cross-test coupling this suite promises
 * not to have.
 */
export async function boot(
  page: Page,
  state: Record<string, unknown>,
  viewport: { width: number; height: number } = DESKTOP,
  options: { seedOnce?: boolean } = {},
): Promise<void> {
  await page.setViewportSize(viewport)
  await page.addInitScript(
    ([key, json, once]) => {
      /*
       * An init script runs before *every* navigation, not once per test — and
       * there is no API to take one back. So a spec that reloads to prove
       * something was persisted gets the fixture written over the top of the
       * thing it was about to check, and reads back the state it started with.
       * That failure is indistinguishable from "persistence is broken", which
       * is the worst possible shape for a regression suite: a green app and a
       * red test that agree on nothing.
       *
       * `seedOnce` leaves a marker in `sessionStorage`, which survives a reload
       * in the same tab and dies with it — so the first navigation seeds and
       * every later one leaves the app's own writes alone. It is opt-in because
       * clearing on each navigation is the right default for the specs that
       * never reload, and silently changing that under them would be worse.
       */
      const MARKER = 'aevistle.e2e.seeded'
      if (once && window.sessionStorage.getItem(MARKER)) return
      window.localStorage.clear()
      window.localStorage.setItem(key as string, json as string)
      if (once) window.sessionStorage.setItem(MARKER, '1')
    },
    [STATE_KEY, JSON.stringify(state), options.seedOnce ? '1' : ''] as const,
  )
  await page.goto('/')
}

/**
 * Wait for the app to become *interactive*, distinguished structurally from
 * "still loading" rather than by a timeout.
 *
 * This is the assertion the boot-guard spec is built on, so it is worth being
 * precise about what makes it true. While `ready` is false, `App.tsx` renders
 * the nav as `<span class="nav__item" aria-disabled="true">` — deliberately the
 * same shape and length, so the bar does not flicker — and the main area as a
 * `<Skeleton>`. Only the ready branch renders `<button class="nav__item"
 * data-view="…">`. So a live `button.nav__item[data-view]` is precisely the
 * signal "boot finished", and it cannot be faked by the skeleton.
 */
export async function expectInteractive(page: Page): Promise<void> {
  await expect(page.locator('button.nav__item[data-view="compose"]')).toBeVisible()
  // The loading skeleton carries `aria-busy`; the real screens do not. If this
  // is still on screen the app is on the placeholder, whatever else rendered.
  await expect(page.locator('.main [aria-busy="true"]')).toHaveCount(0)
}

/** Click a primary tab by its stable `data-view`, never by its label. */
export async function goToView(page: Page, view: string): Promise<void> {
  await page.locator(`button.nav__item[data-view="${view}"]`).click()
}

/** The document as it currently stands on "disk", or null if nothing is stored. */
export async function readStoredState(page: Page): Promise<Record<string, any> | null> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null
  }, STATE_KEY)
}
