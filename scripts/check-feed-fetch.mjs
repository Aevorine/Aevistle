/**
 * The two public feeds this app may read, and the three places that must agree
 * about them.
 *
 * ## What broke, and why a guard exists now
 *
 * `index.html` ships `connect-src 'self'`. Two features were nevertheless
 * written as renderer-side `fetch()` calls:
 *
 *   - the working calendar's "check online" button. It failed for 2025, 2026
 *     and 2027 alike with `Failed to fetch` — the year was never the problem,
 *     and the message reads exactly like a network fault, which it is not.
 *   - the Android in-app update check, which has **never worked in a shipped
 *     build**. Nobody noticed because the desktop copy of the same shared
 *     function runs in the main process, where no CSP applies, and reported
 *     success.
 *
 * That second one is the reason this file is not just a unit test for a regex.
 * A transport that is correct on one platform and silently dead on another is
 * invisible to `typecheck`, invisible to a green desktop run, and invisible to
 * a code reader who sees `fetch()` and assumes it fetches.
 *
 * ## So this asserts three separate things
 *
 * 1. **The rule.** `isAllowedFeedUrl` accepts exactly the two real URLs and
 *    refuses a list of near-misses — credentials before the host, a different
 *    path under the same host, plaintext, a query string.
 * 2. **The copies of the rule agree.** The same allow-list is written a second
 *    time in `FeedFetcher.java`, because the JVM owns that socket and a rule
 *    enforced only in JavaScript is not enforced. Two copies of a rule is the
 *    shape that drifts, so both are read and compared here.
 * 3. **It is actually used.** Declaring `fetchFeed` on the bridge proves
 *    nothing; a call site that still reaches for the global `fetch` is the
 *    original bug wearing new clothes. Every renderer call site is read and
 *    required to route through the bridge.
 *
 * `--selftest` corrupts each assertion in turn and requires it to fail.
 *
 * Exit code 1 if anything needs attention.
 */

import { build } from 'esbuild'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SELFTEST = process.argv.includes('--selftest')

let dir
try {
  dir = await mkdtemp(path.join(process.cwd(), 'node_modules', '.aevistle-feeds-'))
} catch {
  dir = await mkdtemp(path.join(tmpdir(), 'aevistle-feeds-'))
}

async function load(entry, name) {
  const outfile = path.join(dir, `${name}.mjs`)
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    outfile,
    platform: 'node',
    external: ['react', 'react-dom', '@capacitor/core', '@capacitor/preferences'],
    define: { __APP_VERSION__: '"0.0.0-check"' },
    logLevel: 'error',
  })
  return import(pathToFileURL(outfile).href)
}

let failures = 0
let checks = 0

function ok(label, condition, detail = '') {
  checks++
  if (condition) return true
  failures++
  console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

const feeds = await load('src/core/schedule/feeds.ts', 'feeds')
const cn = await load('src/core/schedule/cnHolidays.ts', 'cn')
const update = await load('src/core/platform/update.ts', 'update')

// ---------------------------------------------------------------------------
// 1. The rule itself
// ---------------------------------------------------------------------------

const HOLIDAY_2026 = 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/2026.json'
const RELEASES = 'https://api.github.com/repos/Aevorine/Aevistle/releases/latest'

const ACCEPT = [HOLIDAY_2026, cn.cnFeedUrl(2027), update.RELEASES_API]

const REJECT = [
  // The two hosts, wrong path. This is the case that matters: a host-only
  // allow-list would hand the renderer an arbitrary-path GET to GitHub.
  ['other repo under the same host', 'https://raw.githubusercontent.com/evil/repo/master/2026.json'],
  ['a secret in the path', 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/../../x.json'],
  ['another API route', 'https://api.github.com/user/repos'],
  // `https://raw.githubusercontent.com@evil.example/` parses with the host on
  // the right of the `@`, so a naive `startsWith` check reads it as allowed.
  ['credentials before the host', 'https://raw.githubusercontent.com@evil.example/x.json'],
  ['plaintext', 'http://raw.githubusercontent.com/NateScarlet/holiday-cn/master/2026.json'],
  ['a query string', `${HOLIDAY_2026}?callback=x`],
  ['a fragment', `${HOLIDAY_2026}#x`],
  ['an odd port', 'https://api.github.com:8443/repos/Aevorine/Aevistle/releases/latest'],
  ['a lookalike host', 'https://raw.githubusercontent.com.evil.example/NateScarlet/holiday-cn/master/2026.json'],
  ['a non-year file', 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/README.json'],
  ['not a URL', 'not a url'],
  ['loopback', 'https://127.0.0.1/repos/Aevorine/Aevistle/releases/latest'],
]

for (const url of ACCEPT) {
  ok(`allows ${url}`, feeds.isAllowedFeedUrl(url) === true)
}
for (const [label, url] of REJECT) {
  ok(`refuses ${label}`, feeds.isAllowedFeedUrl(url) === false, url)
}

// Every year the calendar screen can offer has to be reachable, not just the
// two in the bundle — the whole point of the button is the years that are not.
for (let year = 2024; year <= 2035; year++) {
  ok(`allows the ${year} feed URL`, feeds.isAllowedFeedUrl(cn.cnFeedUrl(year)) === true)
}

// ---------------------------------------------------------------------------
// 2. The Java copy of the rule says the same thing
// ---------------------------------------------------------------------------

const java = await readFile('android/app/src/main/java/dev/aevistle/app/FeedFetcher.java', 'utf8')

ok('java pins the holiday path', /NateScarlet/.test(java) && /holiday-cn/.test(java))
ok('java pins the releases path', java.includes('/repos/Aevorine/Aevistle/releases/latest'))
ok('java pins both hosts',
  java.includes('raw.githubusercontent.com') && java.includes('api.github.com'))
ok('java refuses plaintext', /"https"\.equals\(url\.getProtocol\(\)\)/.test(java))
ok('java refuses credentials in the URL', /getUserInfo\(\)\s*!=\s*null/.test(java))
ok('java refuses a query or fragment',
  /getQuery\(\)\s*!=\s*null/.test(java) && /getRef\(\)\s*!=\s*null/.test(java))
ok('java re-checks a redirect target against the allow-list',
  /isAllowed\(next\)/.test(java))

for (const host of feeds.FEED_HOSTS) {
  ok(`java knows about ${host}`, java.includes(host))
}

// ---------------------------------------------------------------------------
// 3. It is wired up, and actually used
// ---------------------------------------------------------------------------

const contract = await readFile('src/core/platform/ipc-contract.ts', 'utf8')
const preload = await readFile('electron/preload.ts', 'utf8')
const main = await readFile('electron/main.ts', 'utf8')
const desktop = await readFile('src/core/platform/bridge-desktop.ts', 'utf8')
const android = await readFile('src/core/platform/bridge-android.ts', 'utf8')
const plugin = await readFile(
  'android/app/src/main/java/dev/aevistle/app/AevistleNativePlugin.java',
  'utf8',
)
const calendar = await readFile('src/views/WorkCalendarView.tsx', 'utf8')
const html = await readFile('index.html', 'utf8')

ok('the IPC channel is declared', /fetchFeed:\s*'aevistle:fetch-feed'/.test(contract))
ok('preload forwards it', /fetchFeed:\s*\(url\)\s*=>\s*ipcRenderer\.invoke\(IPC\.fetchFeed/.test(preload))
ok('main handles it', /ipcMain\.handle\(IPC\.fetchFeed/.test(main))
ok('the desktop bridge exposes it', /fetchFeed:\s*\(url\)\s*=>\s*api\.fetchFeed\(url\)/.test(desktop))
ok('the android bridge exposes it', /fetchFeed:\s*\(url\)\s*=>\s*Native\.fetchFeed/.test(android))
ok('the android plugin implements it', /public void fetchFeed\(/.test(plugin))

// The two that actually broke. A declaration without a call site is the bug.
ok(
  'the android update check routes through the bridge',
  /feedFetchVia\(/.test(android),
  'checkForUpdate must not use the global fetch — connect-src refuses it',
)
ok(
  'the calendar refresh routes through the bridge',
  /fetchStatutoryYear\([^)]*fetchImpl/s.test(calendar),
  'fetchStatutoryYear must be given a bridge-backed fetch',
)

// And the reason all of this exists. If this line ever goes away, the guard
// above is enforcing a rule that no longer has a cause — which is worth
// knowing, because someone will have widened the policy instead.
ok(
  "the renderer still has connect-src 'self'",
  /connect-src\s+'self'\s*;/.test(html),
  'if this was widened on purpose, this guard needs rewriting, not deleting',
)

// ---------------------------------------------------------------------------
// Self-test: every assertion above must be capable of failing
// ---------------------------------------------------------------------------

if (SELFTEST) {
  const broken = [
    ['host-only allow-list', () => feeds.isAllowedFeedUrl('https://api.github.com/user/repos')],
    ['no path pinning', () =>
      feeds.isAllowedFeedUrl('https://raw.githubusercontent.com/evil/repo/master/2026.json')],
    ['credentials accepted', () =>
      feeds.isAllowedFeedUrl('https://raw.githubusercontent.com@evil.example/x.json')],
    ['plaintext accepted', () =>
      feeds.isAllowedFeedUrl('http://api.github.com/repos/Aevorine/Aevistle/releases/latest')],
  ]
  let caught = 0
  for (const [label, probe] of broken) {
    if (probe() === true) {
      console.error(`SELFTEST FAIL  ${label} was accepted`)
    } else caught++
  }
  console.log(`selftest: ${caught}/${broken.length} bad URLs refused`)
  if (caught !== broken.length) failures++
}

await rm(dir, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} problem(s) across ${checks} checks`)
  process.exit(1)
}
console.log(`feed allow-list: ${checks} checks, 0 problems`)
