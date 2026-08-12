/**
 * Do the desktop and Android halves of the privacy image proxy still agree?
 *
 * The pipeline exists twice — `src/core/mail/imageProxy.ts` plus
 * `electron/imageProxy.ts`, and `android/.../ImageProxy.java` — because the
 * fetching, decoding and re-encoding have to be native on both platforms.
 * Everything *policy* about it is supposed to be one set of rules implemented
 * twice, and "implemented twice" is a phrase with a well-known ending.
 *
 * The failure mode is quiet and nasty: the phone blocks a picture the desktop
 * shows, or counts a tracker the desktop does not, and both look like correct
 * programs. Nothing errors. The user reports "the picture is missing on my
 * phone" and the cause is a word in a list that only got edited on one side.
 *
 * So this compares the parts that must match, by name:
 *
 *   1. the block-reason vocabulary — every reason the TypeScript union defines
 *      must be produced somewhere in Java, and Java must not invent one the
 *      renderer has no string for (which would render as a raw key);
 *   2. the tracking-rule names, same both ways;
 *   3. the tracking-path word list, byte for byte and in the same order;
 *   4. the numeric thresholds that decide what is a tracking pixel and what is
 *      too large to process.
 *
 * It also checks that every block reason has a translation in all six locales,
 * because `blockReasonKey` maps a reason to an i18n key and a missing one is
 * only visible to a user in that language, at the moment something has already
 * gone wrong.
 *
 * Exit code 1 if anything needs attention.
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TS = readFileSync(path.join(ROOT, 'src', 'core', 'mail', 'imageProxy.ts'), 'utf8')
const JAVA = readFileSync(
  path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'dev', 'aevistle', 'app', 'ImageProxy.java'),
  'utf8',
)

const failures = []
let checked = 0
const check = (what, ok) => {
  checked++
  if (!ok) failures.push(what)
}

/** Comments stripped, so prose *about* a rule is never mistaken for the rule. */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const tsCode = strip(TS)
const javaCode = strip(JAVA)

/* -------------------------------------------------------------------------- */
/*  1. Block reasons                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Read off the union declaration rather than off `blockReasonKey`'s switch:
 * the union is the definition, and a reason present in the switch but absent
 * from the union would be dead code rather than a contract.
 */
const unionBlock = /export type ImageBlockReason =([\s\S]*?)\n\n/.exec(TS)
check('ImageBlockReason union not found in imageProxy.ts', unionBlock !== null)
const tsReasons = unionBlock
  ? [...unionBlock[1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1])
  : []
check('ImageBlockReason union parsed as empty', tsReasons.length > 0)

/** Every string Java hands to `blocked(...)` as its reason. */
const javaReasons = [...javaCode.matchAll(/blocked\(\s*"([a-zA-Z]+)"/g)].map((m) => m[1])
// `refusedTarget` and `fetchFailed` are produced by the plugin, not by
// ImageProxy itself — they mean the bytes never arrived, so the scanner never
// saw them. Read from there so the check covers the whole Android surface.
const PLUGIN = readFileSync(
  path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'dev', 'aevistle', 'app', 'AevistleNativePlugin.java'),
  'utf8',
)
for (const m of strip(PLUGIN).matchAll(/ImageProxy\.blocked\(\s*"([a-zA-Z]+)"/g)) javaReasons.push(m[1])

const javaReasonSet = new Set(javaReasons)
for (const reason of javaReasonSet) {
  check(
    `Java emits block reason "${reason}", which is not in the ImageBlockReason union — ` +
      `the renderer has no string for it and would show a raw key`,
    tsReasons.includes(reason),
  )
}

/*
 * The reverse is deliberately *not* an error.
 *
 * `trailingData` is defined in the union and is currently only reachable on the
 * desktop, where the structural walk reports it; Android's re-encode drops
 * trailing bytes without needing to name them. A union entry no platform emits
 * yet is a vocabulary the other half can grow into, not a defect — what would
 * be a defect is Java emitting one nobody can translate, which is checked
 * above.
 */

/* -------------------------------------------------------------------------- */
/*  2. Tracking rule names                                                    */
/* -------------------------------------------------------------------------- */

const ruleUnion = /export type TrackerRule =([\s\S]*?)\n\n/.exec(TS)
check('TrackerRule union not found', ruleUnion !== null)
const tsRules = ruleUnion ? [...ruleUnion[1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]) : []
check('TrackerRule union parsed as empty', tsRules.length > 0)

const javaRules = [...javaCode.matchAll(/rules\.add\("([a-zA-Z]+)"\)/g)].map((m) => m[1])
check('Java adds no tracker rules at all — the classifier is not wired up', javaRules.length > 0)

for (const rule of new Set(javaRules)) {
  check(`Java emits tracker rule "${rule}" which TrackerRule does not define`, tsRules.includes(rule))
}
for (const rule of tsRules) {
  check(
    `TrackerRule defines "${rule}" but Java never emits it — the phone would ` +
      `under-report trackers the desktop finds`,
    javaRules.includes(rule),
  )
}

/* -------------------------------------------------------------------------- */
/*  3. The word list, in order                                                */
/* -------------------------------------------------------------------------- */

const tsWordsBlock = /const TRACKING_PATH_WORDS = \[([\s\S]*?)\]/.exec(tsCode)
const javaWordsBlock = /String\[\] TRACKING_PATH_WORDS = \{([\s\S]*?)\}/.exec(javaCode)
check('TRACKING_PATH_WORDS not found in imageProxy.ts', tsWordsBlock !== null)
check('TRACKING_PATH_WORDS not found in ImageProxy.java', javaWordsBlock !== null)

if (tsWordsBlock && javaWordsBlock) {
  const tsWords = [...tsWordsBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  const javaWords = [...javaWordsBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  check('TRACKING_PATH_WORDS is empty on the TypeScript side', tsWords.length > 0)
  check(
    `TRACKING_PATH_WORDS differs between platforms.\n` +
      `      only in TS:   ${tsWords.filter((w) => !javaWords.includes(w)).join(', ') || '(none)'}\n` +
      `      only in Java: ${javaWords.filter((w) => !tsWords.includes(w)).join(', ') || '(none)'}`,
    tsWords.length === javaWords.length && tsWords.every((w, i) => w === javaWords[i]),
  )
}

/* -------------------------------------------------------------------------- */
/*  4. Thresholds                                                             */
/* -------------------------------------------------------------------------- */

const numberFrom = (src, re) => {
  const m = re.exec(src)
  return m ? Number(m[1].replace(/_/g, '')) : null
}

const pairs = [
  {
    what: 'PIXEL_MAX_EDGE (what counts as a tracking pixel)',
    ts: numberFrom(tsCode, /PIXEL_MAX_EDGE = (\d+)/),
    java: numberFrom(javaCode, /PIXEL_MAX_EDGE = (\d+)/),
  },
  {
    what: 'OPAQUE_TOKEN minimum length (what counts as a recipient serial number)',
    ts: numberFrom(tsCode, /\[A-Za-z0-9\+\/_-\]\{(\d+),\}/),
    java: numberFrom(javaCode, /\[A-Za-z0-9\+\/_-\]\{(\d+),\}/),
  },
]

const ELECTRON = strip(readFileSync(path.join(ROOT, 'electron', 'imageProxy.ts'), 'utf8'))
pairs.push(
  {
    what: 'MAX_PIXELS (refuse-to-decode ceiling)',
    ts: numberFrom(ELECTRON, /MAX_PIXELS = ([\d_]+)/),
    java: numberFrom(javaCode, /MAX_PIXELS = ([\d_]+)L/),
  },
  {
    what: 'MAX_OUTPUT_BYTES',
    ts: numberFrom(ELECTRON, /MAX_OUTPUT_BYTES = (\d+)/),
    java: numberFrom(javaCode, /MAX_OUTPUT_BYTES = (\d+)/),
  },
  {
    what: 'JPEG_QUALITY',
    ts: numberFrom(ELECTRON, /JPEG_QUALITY = (\d+)/),
    java: numberFrom(javaCode, /JPEG_QUALITY = (\d+)/),
  },
)

for (const pair of pairs) {
  check(`${pair.what}: could not read it on one side (ts=${pair.ts}, java=${pair.java})`,
    pair.ts !== null && pair.java !== null)
  if (pair.ts !== null && pair.java !== null) {
    check(
      `${pair.what} differs: TypeScript ${pair.ts}, Java ${pair.java}. ` +
        `The two platforms would make different decisions about the same picture.`,
      pair.ts === pair.java,
    )
  }
}

/* -------------------------------------------------------------------------- */
/*  5. Every reason has a string, in every language                           */
/* -------------------------------------------------------------------------- */

const I18N_DIR = path.join(ROOT, 'src', 'i18n')
const locales = readdirSync(I18N_DIR).filter((f) => f.endsWith('.ts') && f !== 'index.ts')
for (const file of locales) {
  const src = readFileSync(path.join(I18N_DIR, file), 'utf8')
  for (const reason of tsReasons) {
    check(
      `${file} has no string for block reason "${reason}" — a user in that ` +
        `language sees a raw key at the moment something has already gone wrong`,
      src.includes(`inbox.imageBlock.${reason}`),
    )
  }
}

/* -------------------------------------------------------------------------- */
/*  6. The prefetch is actually wired in                                      */
/* -------------------------------------------------------------------------- */

/*
 * The single most important line on each platform, and the easiest to lose in
 * a refactor of the file around it. Without it every other part of this feature
 * still works and the privacy claim is simply false — pictures would be fetched
 * at open time, which is the behaviour the whole design exists to replace, and
 * nothing would look broken.
 */
const IMAP = readFileSync(path.join(ROOT, 'electron', 'imap.ts'), 'utf8')
check(
  'electron/imap.ts no longer calls prefetchImages — pictures would be fetched at ' +
    'open time again, which is the exact behaviour this feature replaces',
  /prefetchImages\(/.test(strip(IMAP)),
)
const MAIL_FETCHER = readFileSync(
  path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'dev', 'aevistle', 'app', 'MailFetcher.java'),
  'utf8',
)
check(
  'MailFetcher.java no longer calls ImagePrefetch.offer — same defect, on the phone',
  /ImagePrefetch\.offer\(/.test(strip(MAIL_FETCHER)),
)

/* -------------------------------------------------------------------------- */
/*  7. SVG stays refused                                                      */
/* -------------------------------------------------------------------------- */

/*
 * SVG is the one format that must never render here: it is XML that can carry
 * `<script>` and can fetch its own subresources, which would reopen the exact
 * channel the proxy closes. Checked as a rule of its own because "allow SVG,
 * it is only an image" is a change somebody will propose, reasonably, and this
 * is where the answer is written down.
 */
check(
  'the desktop scanner no longer refuses SVG',
  /scriptableFormat/.test(strip(readFileSync(path.join(ROOT, 'electron', 'imageProxy.ts'), 'utf8'))),
)
check('the Android scanner no longer refuses SVG', /scriptableFormat/.test(javaCode))

/* -------------------------------------------------------------------------- */

if (failures.length > 0) {
  console.error(`\n  check-image-proxy: ${failures.length} problem(s)\n`)
  for (const f of failures) console.error(`  - ${f}`)
  console.error('')
  process.exit(1)
}
console.log(`\n  Privacy image proxy: desktop and Android agree`)
console.log(`  ${checked} checks · ${tsReasons.length} block reasons · ${tsRules.length} tracker rules\n`)
console.log('  All clear.\n')
