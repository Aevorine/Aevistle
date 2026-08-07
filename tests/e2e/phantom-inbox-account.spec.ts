/**
 * Guards: the hydrate-time `inboxAccounts` filter in `src/state/AppState.tsx`'s
 * boot effect, the `upsertInboxAccount` reducer's refusal to write a row for an
 * unknown account, and `src/views/InboxView.tsx`'s `accountLabel` fallback.
 *
 * The bug: `syncInboxAccount` captures its config in a closure and then awaits
 * an IMAP round trip of up to twenty seconds. `deleteAccount` does not wait for
 * that, because nothing should have to. A reply landing after the account was
 * gone resurrected an `inboxAccounts` row pointing at an id `state.accounts` no
 * longer held, and the debounced whole-document save wrote it to disk. The only
 * place it ever surfaced was the inbox screen's account label and filter tabs,
 * as a raw internal identifier — the reported one being
 * `acct_ceb9d641-94ba-4fc0-981d-973c96e6fb47`, which is not a thing any user
 * chose, recognises, or can act on.
 *
 * Three separate guards were needed and all three are checked here: the call
 * site, the reducer (because a call site is what the next caller forgets to
 * copy), and the sweep on the way in (because neither of those helps anyone who
 * already has one of these sitting in a file from before the fix).
 */

import { expect, test } from '@playwright/test'
import {
  account,
  baseState,
  boot,
  expectInteractive,
  goToView,
  inboxAccount,
  readStoredState,
} from '../support/app'

/** The id from the report, kept verbatim so the test says what it is about. */
const PHANTOM_ID = 'acct_ceb9d641-94ba-4fc0-981d-973c96e6fb47'

test('an inbox row for a deleted account is swept at boot and never shown', async ({ page }) => {
  await boot(
    page,
    baseState({
      accounts: [account()],
      inboxAccounts: [
        // The real one, so the screen has something to draw and the assertions
        // below cannot pass merely because the inbox is empty.
        inboxAccount('acct_test_primary'),
        // The phantom: an `accountId` with no matching entry in `accounts`.
        inboxAccount(PHANTOM_ID, {
          imapUsername: 'ghost@example.com',
          messages: [
            {
              id: 'msg_ghost',
              accountId: PHANTOM_ID,
              uid: 1,
              folder: 'INBOX',
              from: 'someone@example.com',
              subject: 'Message from a mailbox that no longer has an account',
              date: Date.UTC(2026, 7, 5),
              seen: false,
              hasAttachments: false,
              bodyCached: false,
            },
          ],
        }),
      ],
    }),
  )

  await expectInteractive(page)

  // Nowhere on the compose screen, which is where the app opens.
  await expect(page.locator('body')).not.toContainText(PHANTOM_ID)

  await goToView(page, 'inbox')
  await expect(page.locator('.uifail')).toHaveCount(0)

  // The inbox is the one screen that ever rendered the raw id — in the account
  // label and in the per-account filter tabs. Asserting on the whole rendered
  // text rather than on those two elements specifically, because the point is
  // that the identifier reaches *no* part of the UI, not that two known places
  // were patched.
  await expect(page.locator('#root')).not.toContainText(PHANTOM_ID)

  // And it is gone from the document, not merely hidden. The app persists on a
  // 350 ms debounce, so this polls rather than sleeping a fixed amount.
  await expect
    .poll(
      async () => {
        const stored = await readStoredState(page)
        return (stored?.inboxAccounts ?? []).map((i: { accountId: string }) => i.accountId)
      },
      { message: 'the phantom inbox row should be swept out of the persisted state' },
    )
    .toEqual(['acct_test_primary'])

  // The whole serialised document, belt and braces: a sweep that left the id in
  // some other array would still be leaking it into the next sync.
  const raw = await page.evaluate(() => window.localStorage.getItem('aevistle.state.v1'))
  expect(raw).not.toContain(PHANTOM_ID)
})

test('the surviving account keeps its own inbox — the sweep is not a purge', async ({ page }) => {
  // The failure mode on the other side of the same fix. A filter written as
  // "drop rows whose account is missing" is one typo away from "drop rows",
  // and the symptom would be a mailbox quietly emptying at every launch.
  await boot(
    page,
    baseState({
      accounts: [account(), account({ id: 'acct_second', label: 'Second', fromAddress: 'two@example.com' })],
      inboxAccounts: [
        inboxAccount('acct_test_primary'),
        inboxAccount(PHANTOM_ID),
        inboxAccount('acct_second', { imapUsername: 'two@example.com' }),
      ],
    }),
  )

  await expectInteractive(page)

  await expect
    .poll(async () => {
      const stored = await readStoredState(page)
      return (stored?.inboxAccounts ?? []).map((i: { accountId: string }) => i.accountId).sort()
    })
    .toEqual(['acct_second', 'acct_test_primary'])
})
