/**
 * The Android string resources, and the small set of them that has to exist.
 *
 * Almost nothing user-facing lives in `res/values`: this app's interface is
 * translated in `src/i18n/*.ts` and reaches Android already worded, through the
 * `notify` bridge call. The exception is `InboxSyncWorker`, which runs on
 * WorkManager's schedule with no WebView in the process — it has no way to
 * reach the app's own translations, so the four strings it writes come from
 * Android's resource system instead.
 *
 * That split is fine and it is also a trap. A missing key in `values/` is a
 * compile error and announces itself; a missing key in `values-ru/` is not —
 * Android falls back to the default, so a Russian phone quietly gets an English
 * notification and nothing anywhere reports it. Which is the same failure shape
 * `check-i18n.mjs` exists for on the other side of the bridge, so it gets the
 * same treatment here.
 *
 * The format specifiers are checked too. `%1$s` versus `%1$d` is not a
 * cosmetic difference: `getString` throws `IllegalFormatConversionException` at
 * runtime when a translation disagrees with the argument it is handed, which
 * turns a wrong word into a crashed notification — inside a background worker,
 * where nobody sees the stack trace.
 *
 * `--selftest` drops a key from one locale and requires this to go red.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const RES = join(root, 'android/app/src/main/res')
const selftest = process.argv.includes('--selftest')

/**
 * The keys the native side words for itself. Listed rather than inferred from
 * `values/`: the point is that these specific strings must be translated
 * everywhere, and a list derived from the default locale would happily agree
 * with itself if one were deleted there.
 */
const REQUIRED = [
  'notify_new_mail_one',
  'notify_new_mail_many',
  'notify_new_mail_summary',
  'notify_no_subject',
]

const failures = []
let checked = 0
const check = (what, ok) => {
  checked++
  if (!ok) failures.push(what)
}

/** `name` → raw text, for one `values*` directory. */
function stringsIn(dir) {
  const file = join(RES, dir, 'strings.xml')
  let xml
  try {
    xml = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const found = new Map()
  for (const m of xml.matchAll(/<string\s+name="([^"]+)"\s*>([\s\S]*?)<\/string>/g)) {
    found.set(m[1], m[2])
  }
  return found
}

/** The `%n$x` specifiers a string uses, in order — `['1$s', '2$s']`. */
const specifiersOf = (text) => [...text.matchAll(/%(\d+\$[a-zA-Z])/g)].map((m) => m[1])

const locales = readdirSync(RES, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^values(-|$)/.test(e.name))
  .map((e) => e.name)
  .sort()

const base = stringsIn('values')
check('android/app/src/main/res/values/strings.xml must be readable', base !== null)
if (!base) {
  console.log('\n  the Android notification strings are translated everywhere\n')
  for (const f of failures) console.log(`  FAIL  ${f}`)
  process.exit(1)
}

for (const key of REQUIRED) {
  check(`values/strings.xml must define ${key}`, base.has(key))
}

let translated = 0
for (const dir of locales) {
  if (dir === 'values') continue
  const found = stringsIn(dir)
  // A `values-*` directory holding no strings.xml at all is not a fault: the
  // Android Gradle plugin creates qualifier folders for other resource types
  // (`values-night`, `values-v31`), and none of those owes us a translation.
  if (!found) continue
  translated++

  for (const key of REQUIRED) {
    const has = selftest && dir !== 'values' && key === REQUIRED[0] ? false : found.has(key)
    check(`${dir}/strings.xml must translate ${key}`, has)
    if (!has || !found.has(key)) continue

    const wanted = specifiersOf(base.get(key) ?? '')
    const actual = specifiersOf(found.get(key) ?? '')
    check(
      `${dir}/strings.xml — ${key} must use the same arguments as the default ` +
        `(${wanted.join(', ') || 'none'}), not ${actual.join(', ') || 'none'}`,
      wanted.length === actual.length && wanted.every((s) => actual.includes(s)),
    )
  }
}

// A parser that finds nothing must not report "all clear".
check('at least one translated locale must exist', translated > 0)

const label = 'the Android notification strings are translated everywhere'

if (selftest) {
  console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
  for (const f of failures) console.log(`  FAIL  ${f}`)
  const caught = failures.some((f) => f.includes(`must translate ${REQUIRED[0]}`))
  if (!caught) {
    console.log('\n  SELFTEST FAILED: a missing translation was not caught.\n')
    process.exit(1)
  }
  console.log('\n  Selftest OK — the injected fault was caught.\n')
  process.exit(0)
}

if (failures.length === 0) {
  console.log(
    `\n  ${label}\n  ${checked} checks across ${translated + 1} locales, ${REQUIRED.length} keys\n\n  All clear.\n`,
  )
  process.exit(0)
}

console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log('')
process.exit(1)
