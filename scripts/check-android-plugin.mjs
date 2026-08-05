/**
 * Does the Java plugin actually implement what the TypeScript says it does?
 *
 * `registerPlugin<AevistleNativePlugin>('AevistleNative')` hands back a proxy
 * typed as that interface. TypeScript then checks every call site against the
 * interface and stops — it has no way to look at Java, and Java has no way to
 * look at it. So a method declared in `bridge-android.ts` with no
 * `@PluginMethod` behind it typechecks, builds, installs, and fails only when a
 * user taps the thing: Capacitor's bridge cannot find a handler for the name
 * and rejects the call. On a screen that already has a "could not reach the
 * other device" path, that reads as a network problem.
 *
 * `pairingRequest` shipped exactly that way. It is the single relay both
 * `pairingJoinRequest` and `syncRequest` go through — the WebView is
 * CSP-blocked from a direct `fetch()` to a LAN address, so it is the *only*
 * route Android has to the other device — and it was declared on the interface,
 * called from two places, and never written on the native side. Every code path
 * of cross-device pairing on Android was dead, and nothing in `npm run check`
 * had an opinion about it.
 *
 * The reverse direction is only a warning. A `@PluginMethod` nothing calls is
 * dead weight, not a broken feature, and one may legitimately be landing ahead
 * of the TypeScript that will use it.
 *
 * `--selftest` declares a method that cannot exist in Java and requires this to
 * go red.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TS_FILE = 'src/core/bridge-android.ts'
const JAVA_FILE = 'android/app/src/main/java/dev/aevistle/app/AevistleNativePlugin.java'
const ROOT_INTERFACE = 'AevistleNativePlugin'

/**
 * Declared on the interface, implemented by Capacitor's own `Plugin`
 * superclass. Requiring these of our subclass would fail on methods that are
 * not ours to write.
 */
const BASE_METHODS = new Set([
  'addListener',
  'removeAllListeners',
  'checkPermissions',
  'requestPermissions',
])

const selftest = process.argv.includes('--selftest')

const failures = []
const warnings = []
let checked = 0
const check = (what, ok) => {
  checked++
  if (!ok) failures.push(what)
}

/**
 * Blank out comments, keeping newlines — a method named in prose is not a
 * method declared, and both files talk about each other constantly.
 *
 * Character by character rather than by regex because string literals have to
 * be walked past, not scanned. The file picker passes the wildcard MIME type,
 * and those three characters contain a block-comment opener; a regex read it as
 * one, ran to the next closer a hundred lines further down, and reported a
 * `@PluginMethod` that was plainly there as missing.
 */
function stripComments(text, backtick = false) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? text.length : end + 2
      out += text.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '"' || c === "'" || (backtick && c === '`')) {
      out += c
      i++
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') {
          out += text[i]
          i++
        }
        if (i < text.length) {
          out += text[i]
          i++
        }
      }
      if (i < text.length) {
        out += text[i]
        i++
      }
    } else {
      out += c
      i++
    }
  }
  return out
}

let tsSource = stripComments(readFileSync(path.join(ROOT, TS_FILE), 'utf8'), true)
const javaSource = stripComments(readFileSync(path.join(ROOT, JAVA_FILE), 'utf8'))

if (selftest) {
  tsSource = tsSource.replace(
    new RegExp(`(interface\\s+${ROOT_INTERFACE}\\b[^{]*\\{)`),
    '$1\n  selftestNeverImplemented(opts: { x: string }): Promise<void>\n',
  )
}

// --- the TypeScript side ----------------------------------------------------

/** An interface body plus the names it extends, found by brace matching so a
 *  nested option-object type cannot end the search early. */
function interfaceOf(source, name) {
  const head = new RegExp(`\\binterface\\s+${name}\\b([^{]*)\\{`).exec(source)
  if (!head) return null
  const extendsClause = /\bextends\s+([^{]+)/.exec(head[1])
  const start = head.index + head[0].length
  let depth = 1
  let i = start
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    i++
  }
  return {
    body: source.slice(start, i - 1),
    extends: extendsClause
      ? extendsClause[1].split(',').map((n) => n.trim().replace(/<[\s\S]*$/, '')).filter(Boolean)
      : [],
  }
}

/** Method names declared directly on the interface — depth 0 of its body, so
 *  the fields of an inline `opts: { … }` are not mistaken for methods. */
function methodsIn(body) {
  const names = []
  let depth = 0
  for (const line of body.split('\n')) {
    if (depth === 0) {
      const m = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*\(/.exec(line)
      if (m) names.push(m[1])
    }
    depth += (line.match(/[{([]/g) ?? []).length - (line.match(/[})\]]/g) ?? []).length
    if (depth < 0) depth = 0
  }
  return names
}

function declaredMethods(source, name, seen = new Set()) {
  if (seen.has(name)) return []
  seen.add(name)
  const found = interfaceOf(source, name)
  if (!found) return []
  return [...methodsIn(found.body), ...found.extends.flatMap((p) => declaredMethods(source, p, seen))]
}

const tsMethods = [...new Set(declaredMethods(tsSource, ROOT_INTERFACE))].filter(
  (m) => !BASE_METHODS.has(m),
)

// --- the Java side ----------------------------------------------------------

const javaMethods = new Set()
for (const m of javaSource.matchAll(
  /@PluginMethod\b[^\n]*\s+public\s+void\s+([A-Za-z_$][\w$]*)\s*\(/g,
)) {
  javaMethods.add(m[1])
}

// --- sanity: a parser that finds nothing must not report "all clear" --------

check(`${TS_FILE} must declare the ${ROOT_INTERFACE} interface`, tsMethods.length > 0)
check(`${JAVA_FILE} must declare @PluginMethod handlers`, javaMethods.size > 0)

// --- the two must agree on the plugin's name too ----------------------------
//
// Registering under a name no `@CapacitorPlugin` claims fails the same silent
// way, only for every method at once.

const tsName = /registerPlugin<[^>]*>\(\s*(['"])([^'"]+)\1/.exec(tsSource)?.[2]
const javaName = /@CapacitorPlugin\s*\([\s\S]*?name\s*=\s*"([^"]+)"/.exec(javaSource)?.[1]
check(
  `registerPlugin('${tsName ?? '?'}') must match @CapacitorPlugin(name = "${javaName ?? '?'}")`,
  Boolean(tsName) && tsName === javaName,
)

// --- every declared method must have a handler ------------------------------

for (const name of tsMethods) {
  check(
    `${name}() is declared in ${TS_FILE} but has no @PluginMethod in ${path.basename(JAVA_FILE)}`,
    javaMethods.has(name),
  )
}

// --- handlers nothing on the TypeScript side ever asks for ------------------

const pluginConst = /const\s+([A-Za-z_$][\w$]*)\s*=\s*registerPlugin</.exec(tsSource)?.[1]
const called = new Set(
  pluginConst
    ? [...tsSource.matchAll(new RegExp(`\\b${pluginConst}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, 'g'))].map(
        (m) => m[1],
      )
    : [],
)
const declared = new Set(tsMethods)
for (const name of [...javaMethods].sort()) {
  if (BASE_METHODS.has(name)) continue
  if (declared.has(name) || called.has(name)) continue
  warnings.push(`${name}() has a @PluginMethod but nothing in ${TS_FILE} reaches it`)
}

// ---------------------------------------------------------------------------

const label = 'the Android plugin interface matches its Java implementation'

if (selftest) {
  console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
  for (const f of failures) console.log(`  FAIL  ${f}`)
  const caught = failures.some((f) => f.startsWith('selftestNeverImplemented()'))
  if (!caught) {
    console.log('\n  SELFTEST FAILED: an unimplemented method was not caught.\n')
    process.exit(1)
  }
  console.log('\n  Selftest OK — the injected fault was caught.\n')
  process.exit(0)
}

if (failures.length === 0) {
  console.log(
    `\n  ${label}\n  ${checked} checks across ${tsMethods.length} declared methods, ${javaMethods.size} @PluginMethod handlers\n`,
  )
  for (const w of warnings) console.log(`  WARN  ${w}`)
  console.log(`${warnings.length > 0 ? '\n' : ''}  All clear.\n`)
  process.exit(0)
}

console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
for (const f of failures) console.log(`  FAIL  ${f}`)
for (const w of warnings) console.log(`  WARN  ${w}`)
console.log('')
process.exit(1)
