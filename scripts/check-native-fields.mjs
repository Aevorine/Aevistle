/**
 * Does the Android side read JSON fields the TypeScript side actually writes?
 *
 * `check-android-plugin.mjs` already holds the two halves of every *plugin
 * call* to the same payload shape. This covers the other direction, which had
 * no gate at all: the objects the background workers read out of their own
 * store — a job, an account, a draft, a cached message — after the web layer
 * put them there.
 *
 * It exists because of a bug with no symptom. `SendWorker` decided whether to
 * announce a completed send with:
 *
 *     boolean announceSuccess = job.optBoolean("notifyOnSuccess", false);
 *
 * `ScheduledJob` in `src/core/types.ts` has never had a `notifyOnSuccess`
 * field. Nothing has ever written one. So that expression was a constant
 * `false`, and a scheduled send that worked had never once raised a
 * notification on Android — while the settings screen showed the switch on,
 * the switch saved, and every gate in the repository stayed green. Nothing
 * threw, nothing logged, and the only way to notice was to wait for a
 * notification that was never coming.
 *
 * The check is deliberately generous about what counts as "declared": a name
 * used as a TypeScript property, quoted anywhere in `src/`, or written by the
 * Java side itself (the stores round-trip their own bookkeeping). A false
 * positive here would be a gate that cries wolf, and the failure it guards
 * against only needs one honest signal to be caught.
 *
 * `--selftest` injects a read of a field nothing declares and requires this to
 * go red.
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const JAVA_DIR = path.join(ROOT, 'android/app/src/main/java/dev/aevistle/app')
const selftest = process.argv.includes('--selftest')

/**
 * Fields that legitimately come from somewhere other than this project's own
 * TypeScript, with the reason. Anything not on this list has to be declared.
 */
const FOREIGN = new Map([
  [
    'id_token',
    'part of an OAuth2 token response, defined by the provider (RFC 7519), not by us',
  ],
])

const failures = []
let checked = 0
const check = (what, ok) => {
  checked++
  if (!ok) failures.push(what)
}

const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

function walk(dir, filter, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (/node_modules|dist|build/.test(p)) continue
      walk(p, filter, out)
    } else if (filter.test(entry.name)) out.push(p)
  }
  return out
}

const javaFiles = walk(JAVA_DIR, /\.java$/)
let javaRaw = ''
const reads = new Map()
for (const file of javaFiles) {
  const raw = readFileSync(file, 'utf8')
  javaRaw += raw + '\n'
  let text = strip(raw)
  if (selftest && file.endsWith('SendWorker.java')) {
    text += '\njob.optBoolean("selftestNeverDeclared", false);\n'
  }
  for (const m of text.matchAll(
    /\.opt(?:String|Boolean|Int|Long|Double|JSONObject|JSONArray)\s*\(\s*"([^"]+)"/g,
  )) {
    if (!reads.has(m[1])) reads.set(m[1], new Set())
    reads.get(m[1]).add(path.basename(file))
  }
}

let tsText = ''
for (const f of walk(path.join(ROOT, 'src'), /\.(ts|tsx)$/)) tsText += readFileSync(f, 'utf8') + '\n'

// A parser that finds nothing must not report "all clear".
check('the Android sources must contain JSON field reads', reads.size > 0)
check('the TypeScript sources must be readable', tsText.length > 0)

for (const [field, files] of [...reads].sort()) {
  if (FOREIGN.has(field)) continue
  const declared =
    // `field: T` or `field?: T` in an interface, or `field:` in a literal.
    new RegExp(`(^|[^\\w$])${field}\\??\\s*:`, 'm').test(tsText) ||
    // `'field'` / `"field"` — a key written through an index or a map.
    new RegExp(`["']${field}["']`).test(tsText) ||
    // The Java side wrote it itself: the stores round-trip their own
    // bookkeeping (`pendingRuns`, `lastSyncError`) and owe TypeScript nothing.
    new RegExp(`\\.put\\s*\\(\\s*"${field}"`).test(javaRaw)
  check(
    `${[...files].join(', ')} reads "${field}" out of JSON, but nothing in src/ ever writes it ` +
      `— the read will always return its default`,
    declared,
  )
}

const label = 'the Android side only reads JSON fields something writes'

if (selftest) {
  console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
  for (const f of failures) console.log(`  FAIL  ${f}`)
  const caught = failures.some((f) => f.includes('selftestNeverDeclared'))
  if (!caught) {
    console.log('\n  SELFTEST FAILED: an undeclared field read was not caught.\n')
    process.exit(1)
  }
  console.log('\n  Selftest OK — the injected fault was caught.\n')
  process.exit(0)
}

if (failures.length === 0) {
  console.log(
    `\n  ${label}\n  ${checked} checks across ${reads.size} field names in ${javaFiles.length} files` +
      `${FOREIGN.size > 0 ? `, ${FOREIGN.size} allowed as foreign` : ''}\n\n  All clear.\n`,
  )
  process.exit(0)
}

console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log('')
process.exit(1)
