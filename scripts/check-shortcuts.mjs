/**
 * Do the keyboard shortcuts still say what they do?
 *
 * They stopped, and nothing noticed. The matcher resolves `Ctrl+N` by reading
 * `NAV[n - 1]`, so it follows the tab list automatically; the help panel that
 * lists those shortcuts spelled its labels out by hand. Inserting the working
 * calendar in the middle of the list therefore made `Ctrl+7` open the calendar
 * while the panel said it opened Activity — and pushed Settings to ninth place,
 * where the matcher's `[1-8]` could not reach it at all.
 *
 * Neither failure could raise an error. The keys worked, the panel rendered,
 * and only someone who pressed one and read the other would find out.
 *
 * Checked here:
 *   - every numbered tab has a shortcut, and its label is the tab's own label;
 *   - no two shortcuts claim the same chord in the same context;
 *   - the matcher answers for every chord the panel advertises, and answers
 *     with the action the panel names — the panel is documentation, and
 *     documentation that is not executed is documentation that drifts.
 *
 * Exit code 1 if anything needs attention.
 */

import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const failures = []
let checked = 0
const check = (what, ok) => {
  checked++
  if (!ok) failures.push(what)
}

/*
 * `Shortcuts.tsx` imports `./ui`, which is React. Rather than bundle the whole
 * component tree just to read a table, the two pure exports are re-exported
 * through a shim and the JSX is left out of the graph entirely.
 */
const dir = await mkdtemp(path.join(tmpdir(), 'aevistle-shortcuts-'))
const entry = path.join(dir, 'entry.ts')
await writeFile(
  entry,
  `export { SHORTCUTS, findConflicts, matchShortcut, inTextField } from ${JSON.stringify(
    path.resolve('src/components/Shortcuts.tsx'),
  )}
export { NAV, MAX_NAV_SHORTCUT } from ${JSON.stringify(path.resolve('src/core/nav.ts'))}`,
  'utf8',
)
const bundle = path.join(dir, 'shortcuts.mjs')
await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
  // React comes along rather than being marked external: the bundle is written
  // to a temp directory, and an external import would be resolved from *there*,
  // where node_modules does not exist. Nothing in the component tree is
  // executed — only the two pure exports are read — so the cost is a moment of
  // bundling and no behaviour.
  loader: { '.tsx': 'tsx' },
})
const { SHORTCUTS, findConflicts, matchShortcut, NAV, MAX_NAV_SHORTCUT } = await import(
  pathToFileURL(bundle).href
)
await rm(dir, { recursive: true, force: true })

// --- every tab is reachable, and labelled as itself --------------------------

const navSpecs = SHORTCUTS.filter((s) => s.action.startsWith('nav'))
const reachable = Math.min(NAV.length, MAX_NAV_SHORTCUT)

check('every numbered tab must have a shortcut', navSpecs.length === reachable)
check(
  `all ${NAV.length} tabs must be reachable by number (raise MAX_NAV_SHORTCUT or rethink the scheme)`,
  NAV.length <= MAX_NAV_SHORTCUT,
)

for (let i = 0; i < reachable; i++) {
  const spec = navSpecs[i]
  check(
    `Ctrl+${i + 1} must be labelled with the tab it opens (${NAV[i].id})`,
    spec && spec.labelKey === NAV[i].labelKey && spec.keys === `Ctrl+${i + 1}`,
  )
}

// --- no two shortcuts fight over one chord ----------------------------------

const conflicts = findConflicts()
check(
  `no two shortcuts may share a chord (${conflicts
    .map(([a, b]) => `${a.action}/${b.action} on ${a.keys}`)
    .join(', ')})`,
  conflicts.length === 0,
)

// A deliberately conflicting table must be reported, or the check above is
// vacuous — it would pass just as happily on a function that returns [].
const planted = findConflicts([
  { action: 'send', keys: 'Ctrl+P', labelKey: 'a', worksInFields: true, group: 'general' },
  { action: 'preview', keys: 'Ctrl+P', labelKey: 'b', worksInFields: true, group: 'general' },
])
check('the conflict detector must actually detect a conflict', planted.length === 1)
const reordered = findConflicts([
  { action: 'send', keys: 'Ctrl+Shift+P', labelKey: 'a', worksInFields: true, group: 'general' },
  { action: 'preview', keys: 'Shift+Ctrl+P', labelKey: 'b', worksInFields: true, group: 'general' },
])
check('a chord written in another order is the same chord', reordered.length === 1)

// --- the panel and the matcher agree ----------------------------------------

/** Turn "Ctrl+Shift+P" into the event the browser would deliver. */
function eventFor(keys, target = null) {
  const parts = keys.split('+').map((p) => p.trim())
  const key = parts[parts.length - 1]
  return {
    ctrlKey: parts.includes('Ctrl'),
    metaKey: false,
    shiftKey: parts.includes('Shift'),
    key: key === 'Enter' ? 'Enter' : key.length === 1 ? key.toLowerCase() : key,
    target,
  }
}

for (const spec of SHORTCUTS) {
  const got = matchShortcut(eventFor(spec.keys))
  check(`${spec.keys} must resolve to ${spec.action} (matcher said ${got})`, got === spec.action)
}

// The field rule is the one place where the panel's badge is a promise about
// behaviour, so it is executed rather than trusted.
const field = { tagName: 'TEXTAREA', isContentEditable: false }
for (const spec of SHORTCUTS.filter((s) => !s.worksInFields)) {
  const got = matchShortcut(eventFor(spec.keys, field))
  check(`${spec.keys} is marked "not in fields" and must stand down in one`, got !== spec.action)
}
for (const spec of SHORTCUTS.filter((s) => s.worksInFields)) {
  const got = matchShortcut(eventFor(spec.keys, field))
  check(`${spec.keys} is marked as working in fields and must still fire in one`, got === spec.action)
}

// ---------------------------------------------------------------------------

const label = 'the shortcuts do what the panel says'
if (failures.length === 0) {
  console.log(`\n  ${label}\n  ${checked} checks, ${SHORTCUTS.length} shortcuts\n\n  All clear.\n`)
  process.exit(0)
}
console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log('')
process.exit(1)
