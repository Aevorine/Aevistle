/**
 * Does the body-cache search actually read what the cache holds? —
 * `npm run check:body-search`.
 *
 * `electron/bodySearch.ts` is the engine both platforms mirror (the Java
 * half lives in `InboxBodyStore.search`, held to the same haystack by the
 * source assertions at the bottom). Driven against a real temp directory of
 * body files, because the failure modes worth money here are file-shaped:
 * a non-json neighbour, a corrupt entry, a match hiding inside markup.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

const failures = []
let checked = 0
const check = (what, ok) => {
  checked++
  if (!ok) {
    failures.push(what)
    console.log(`  FAIL  ${what}`)
  } else {
    console.log(`  ok    ${what}`)
  }
}

const out = mkdtempSync(join(tmpdir(), 'aevistle-bodysearch-'))
try {
  execFileSync(
    'npx',
    [
      'esbuild',
      `"${join(root, 'electron/bodySearch.ts')}"`,
      '--bundle',
      '--format=esm',
      '--platform=node',
      `--outfile="${join(out, 'bs.mjs')}"`,
      '--log-level=warning',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], shell: true },
  )
  const { searchBodiesIn, bodyHaystack } = await import(pathToFileURL(join(out, 'bs.mjs')).href)

  const dir = join(out, 'bodies')
  mkdirSync(dir)
  writeFileSync(join(dir, '101.json'), JSON.stringify({ text: '您的账单已经生成，应还金额为 3847.56 元' }))
  writeFileSync(
    join(dir, '102.json'),
    JSON.stringify({ sanitizedHtml: '<table><tr><td>12</td><td>March</td></tr></table><style>td{color:red}</style>' }),
  )
  writeFileSync(join(dir, '103.json'), JSON.stringify({ text: 'nothing of note' }))
  writeFileSync(join(dir, '104.json'), '{ this is not json')
  writeFileSync(join(dir, 'notes.txt'), '账单 12 March — a neighbour that is not a body')

  check('a plain-text match answers with its uid', JSON.stringify(await searchBodiesIn(dir, '账单')) === '[101]')
  check(
    'markup between the words does not hide a match',
    JSON.stringify(await searchBodiesIn(dir, '12 march')) === '[102]',
  )
  check('css inside <style> is not searchable text', (await searchBodiesIn(dir, 'color:red')).length === 0)
  check('the search is case-folded on both sides', JSON.stringify(await searchBodiesIn(dir, 'MARCH')) === '[102]')
  check('a corrupt body file is not a match and not a crash', (await searchBodiesIn(dir, 'this is not json')).length === 0)
  check('a non-json neighbour is never read as a body', (await searchBodiesIn(dir, 'neighbour')).length === 0)
  check('an empty query answers nothing rather than everything', (await searchBodiesIn(dir, '  ')).length === 0)
  check('a folder that does not exist is an empty answer', (await searchBodiesIn(join(dir, 'no-such'), 'x')).length === 0)
  check(
    'the haystack folds text and de-tagged html together',
    bodyHaystack({ text: 'A', sanitizedHtml: '<b>B</b>' }).includes('a') &&
      bodyHaystack({ text: 'A', sanitizedHtml: '<b>B</b>' }).includes('b'),
  )

  // The Java mirror is held to the same shape by source, since no JVM runs
  // here: same tag-stripping, same case fold, same .json-only discipline.
  const java = readFileSync(join(root, 'android/app/src/main/java/dev/aevistle/app/InboxBodyStore.java'), 'utf8')
  check('the Java mirror strips script/style before tags', /replaceAll\("\(\?is\)<\(script\|style\)/.test(java))
  check('the Java mirror case-folds with a fixed locale', /toLowerCase\(java\.util\.Locale\.ROOT\)/.test(java))
  check('the Java mirror reads only .json bodies', /endsWith\("\.json"\)/.test(java))
  check('the Java mirror folds whitespace like the engine', /replaceAll\("\\\\s\+", " "\)/.test(java))
  // …and the desktop pipeline actually reaches the engine.
  const store = readFileSync(join(root, 'electron/inboxStore.ts'), 'utf8')
  check('inboxStore routes search through the shared engine', /searchBodiesIn\(bodyDir\(accountId, folderPath\), query\)/.test(store))
  const main = readFileSync(join(root, 'electron/main.ts'), 'utf8')
  check('main answers the IPC with the store search', /ipcMain\.handle\(IPC\.searchInboxBodies/.test(main))
} finally {
  rmSync(out, { recursive: true, force: true })
}

const label = 'full-text search reads the body cache, on both platforms, the same way'
if (failures.length === 0) {
  console.log(`\n  ${label}\n  ${checked} checks\n\n  All clear.\n`)
  process.exit(0)
}
console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
process.exit(1)
