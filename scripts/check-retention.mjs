/**
 * The activity-log retention policy really deletes — `npm run check:retention`.
 *
 * This exists because the feature shipped once already without doing anything.
 * "Keep activity log for 30 days" was applied as a filter inside the Logs
 * screen: older entries stopped being *shown* and stayed in `state.json`, which
 * is the file that records who was mailed and when. Nothing looked broken. The
 * screen showed the right rows, the setting saved, and the data the setting
 * promised to remove was still on disk months later.
 *
 * That failure mode cannot be caught by looking at the UI, which is the whole
 * reason for a check here. Every case below is a way the policy can go quietly
 * wrong rather than loudly:
 *
 *   - not deleting at all (the original bug)
 *   - deleting *everything* because a setting was absent and `NaN` compared
 *     false against every timestamp
 *   - keeping the oldest instead of the newest when the count limit bites
 */

import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = await mkdtemp(join(tmpdir(), 'aevistle-retention-'))
const bundle = join(dir, 'retention.mjs')
await build({
  entryPoints: ['src/core/logRetention.ts'],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
})
const { pruneLogs, LOG_CAP_FALLBACK, LOG_CAP_MAX } = await import(pathToFileURL(bundle).href)
await rm(dir, { recursive: true, force: true })

const DAY = 86_400_000
const NOW = Date.UTC(2026, 7, 3, 12, 0, 0)

/** Newest first, which is the order the reducer builds the list in. */
const entriesAgedDays = (...ages) =>
  ages.map((days, i) => ({
    id: `e${i}`,
    at: NOW - days * DAY,
    level: 'info',
    kind: 'send',
    title: `${days}d old`,
  }))

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

console.log('\n  Activity-log retention\n')

// --- the day limit ---------------------------------------------------------

{
  const logs = entriesAgedDays(0, 5, 29, 31, 400)
  const kept = pruneLogs(logs, { logRetentionDays: 30, logMaxEntries: 500 }, NOW)
  check('entries past the day limit are removed', kept.length === 3, `kept ${kept.length}/5`)
  check(
    'entries inside the day limit survive',
    kept.every((e) => e.at >= NOW - 30 * DAY),
    kept.map((e) => e.title).join(', '),
  )
}

// --- the count limit -------------------------------------------------------

{
  const logs = entriesAgedDays(...Array.from({ length: 40 }, (_, i) => i * 0.01))
  const kept = pruneLogs(logs, { logRetentionDays: 365, logMaxEntries: 10 }, NOW)
  check('the count limit is enforced', kept.length === 10, `kept ${kept.length}/40`)
  check('the count limit keeps the newest', kept[0].id === 'e0' && kept[9].id === 'e9',
    `${kept[0].id} … ${kept[9].id}`)
}

// --- whichever bites first -------------------------------------------------

{
  const logs = entriesAgedDays(1, 2, 3, 90, 91)
  const kept = pruneLogs(logs, { logRetentionDays: 30, logMaxEntries: 2 }, NOW)
  check('both limits apply together', kept.length === 2, `kept ${kept.length}`)
  check('the stricter limit wins', kept.every((e) => e.at >= NOW - 30 * DAY))
}

// --- unusable settings must not wipe the log -------------------------------

{
  const logs = entriesAgedDays(0, 1, 2)
  const missing = pruneLogs(logs, {}, NOW)
  check('a settings object with no limits keeps everything', missing.length === 3,
    `kept ${missing.length}/3`)

  const zero = pruneLogs(logs, { logRetentionDays: 0, logMaxEntries: 0 }, NOW)
  check('zeroes fall back instead of deleting everything', zero.length === 3,
    `kept ${zero.length}/3`)

  const emptyInput = pruneLogs(logs, { logRetentionDays: '', logMaxEntries: '' }, NOW)
  check('an emptied number input does not delete the log', emptyInput.length === 3,
    `kept ${emptyInput.length}/3`)
}

// --- the ceiling on the ceiling --------------------------------------------

{
  const logs = entriesAgedDays(...Array.from({ length: 30 }, (_, i) => i * 0.01))
  const huge = pruneLogs(logs, { logRetentionDays: 3650, logMaxEntries: 9_999_999 }, NOW)
  check('an absurd count limit is clamped, not honoured', huge.length === 30)
  check('the clamp constant is the documented one', LOG_CAP_MAX === 10_000, String(LOG_CAP_MAX))
  check('the fallback constant is the documented one', LOG_CAP_FALLBACK === 500,
    String(LOG_CAP_FALLBACK))
}

// --- the property that was actually broken ---------------------------------

{
  // The regression, stated as its own case: a filter that only hides would
  // return the full list here, because nothing about `logs` changed.
  const logs = entriesAgedDays(1, 400)
  const kept = pruneLogs(logs, { logRetentionDays: 30, logMaxEntries: 500 }, NOW)
  check(
    'pruning returns a shorter list, not a filtered view of the same one',
    kept.length < logs.length && !kept.some((e) => e.at < NOW - 30 * DAY),
    `${logs.length} → ${kept.length}`,
  )
}

console.log(`\n  ${failed === 0 ? 'All clear.' : `${failed} failed.`}\n`)
process.exit(failed === 0 ? 0 : 1)
