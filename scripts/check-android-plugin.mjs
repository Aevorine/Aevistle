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
const TS_FILE = 'src/core/platform/bridge-android.ts'
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

/* ---------------------------------------------------------------------------
   The other JS/Java seam: the back gesture

   Everything above this line is about the plugin bridge, where a name that does
   not match produces a rejected call. The back gesture does not go through the
   plugin at all — `MainActivity` reaches the page with a raw
   `evaluateJavascript` on `window.__aevistleBack`, the same way it already
   publishes the keyboard inset — so it is a second contract between the same
   two languages, with no type checker and no bridge in between.

   Its failure mode is worse than the plugin's, and silent. If either side is
   renamed, the expression evaluates to `undefined`, the `!!` makes that
   `false`, and `MainActivity` concludes the page did not want the press — so it
   closes the application. That is precisely the bug the gesture work was done
   to fix, restored, with no error anywhere and nothing on screen to suggest a
   name had drifted.

   Checked as a pair of literals rather than by parsing: `backStack.ts` exports
   the name as a constant for exactly this, and the Java quotes it inside a
   JavaScript string that no Java tooling will ever look inside.
   --------------------------------------------------------------------------- */
const BACK_TS_FILE = 'src/core/backStack.ts'
/* `MainActivity`, not `AevistleNativePlugin` — the gesture is handled by the
   activity's `OnBackPressedCallback` and never touches the plugin, which is the
   whole reason it needs its own assertion here. */
const BACK_JAVA_FILE = 'android/app/src/main/java/dev/aevistle/app/MainActivity.java'
const backTs = readFileSync(path.join(ROOT, BACK_TS_FILE), 'utf8')
const backJava = readFileSync(path.join(ROOT, BACK_JAVA_FILE), 'utf8')
const backName = /BACK_BRIDGE_NAME\s*=\s*'([^']+)'/.exec(backTs)
checked++
if (!backName) {
  failures.push(
    `${BACK_TS_FILE} no longer exports BACK_BRIDGE_NAME — the back gesture's ` +
      'JS/Java contract cannot be checked, and a mismatch closes the app silently',
  )
} else {
  const name = backName[1]
  checked++
  // The web side must actually publish it, not merely name it.
  if (!new RegExp(`window\\[BACK_BRIDGE_NAME\\]|window\\.${name}\\s*=`).test(backTs)) {
    failures.push(`${BACK_TS_FILE} declares '${name}' but never assigns it onto window`)
  }
  checked++
  /* `\b`, not `includes`. A substring test passes for any *extension* of the
     name — `window.__aevistleBackX` contains `window.__aevistleBack` — so
     renaming the Java side by appending a character would have gone unnoticed,
     which is exactly the drift this is here to catch. Verified by breaking it
     in both directions. */
  if (!new RegExp(`window\\.${name}\\b`).test(backJava)) {
    failures.push(
      `${BACK_JAVA_FILE} does not call window.${name}() — the back gesture would fall ` +
        'through to the platform default, which closes the app from every screen',
    )
  }
  checked++
  // Publishing and calling are not enough: something has to *register* the
  // callback, or the dispatcher never routes the press here in the first place.
  if (!/addCallback\s*\(/.test(backJava) || !backJava.includes('OnBackPressedCallback')) {
    failures.push(
      `${BACK_JAVA_FILE} no longer registers an OnBackPressedCallback — the page would ` +
        'never be asked, and the platform default closes the app',
    )
  }
}

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

// --- the *payload* each side agrees on --------------------------------------

/*
 * Matching method names is not enough, and this section exists because of a
 * near miss.
 *
 * `oauthConsent` used to take a single `clientId`. It now takes `clientIds`, a
 * map keyed by signing fingerprint, and that rename had to land in two files at
 * once. Had it landed in only one, everything above would still have passed:
 * the method exists on both sides, TypeScript compiles (the payload is a plain
 * object literal), Java compiles (`call.getString` of an absent key returns the
 * default). The only symptom would have been at runtime, on a device — the
 * consent flow refusing with "started without everything it needs" for a
 * configuration that is perfectly correct. That is precisely the failure shape
 * this repository's gates exist to make impossible: no error, no crash, no log,
 * just a feature that quietly does nothing.
 *
 * So: every key Java reads out of a `PluginCall` must be a key the TypeScript
 * declaration for that method promises. The reverse direction is deliberately
 * only a warning — TypeScript may legitimately send something a handler has not
 * started using yet, and failing on that would block the half of a two-sided
 * change that has to land first.
 */
/*
 * Any `call.getX("key")`, not an enumerated list of accessors. The first
 * version listed them — `getString|getObject|getBool|…` — and quietly missed
 * `getBoolean`, because `getBool` matched its prefix and then the pattern
 * demanded a bracket that `ean(` is not. It then reported that `useDataFolder`
 * never reads `move`, on a handler that reads it on its second line. A gate
 * that cries wolf is a gate people learn to read past, which costs more than
 * the one it was added to catch.
 */
const CALL_READ = /\bcall\.get[A-Za-z]*\s*\(\s*"([^"]+)"/g

/**
 * A handler's body, plus the bodies of any activity callbacks it hands the call
 * off to.
 *
 * Capacitor's picker pattern splits a single logical handler in two: the
 * `@PluginMethod` starts an activity and returns, and an `@ActivityCallback`
 * receives the *same* `PluginCall` when the user comes back and reads the rest
 * of the payload there. `saveTextFile` is the example — it reads `name` and
 * `mime` up front and `text` only once a destination has been chosen, which is
 * the only order that makes sense: there is nothing to write the text to until
 * the picker resolves.
 *
 * Scanning only the first half reported `text` as never read, which is both
 * wrong and the kind of wrong that matters: it is a warning about a working
 * feature sitting next to warnings about broken ones.
 */
function scannedBodyOf(source, name) {
  const own = javaBodyOf(source, name)
  if (own === null) return null
  let text = own
  for (const [, callback] of own.matchAll(
    /startActivityForResult\s*\(\s*call\s*,[^,]*,\s*"([^"]+)"\s*\)/g,
  )) {
    text += '\n' + (javaBodyOf(source, callback) ?? '')
  }
  return text
}

/** The body of a Java method, brace-matched from its signature. */
function javaBodyOf(source, name) {
  const head = new RegExp(`(?:public|private|protected)\\s+void\\s+${name}\\s*\\([^)]*\\)\\s*\\{`).exec(
    source,
  )
  if (!head) return null
  let depth = 1
  let i = head.index + head[0].length
  const start = i
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    i++
  }
  return source.slice(start, i - 1)
}

/**
 * The option names a TypeScript method declaration promises.
 *
 * Read from the `opts: { … }` object literal in the declaration, at brace depth
 * one so that the fields of a nested shape are not mistaken for top-level keys
 * the handler may read.
 */
function tsPayloadKeys(source, name) {
  const head = new RegExp(`^\\s*${name}\\s*\\(\\s*opts\\s*:\\s*\\{`, 'm').exec(source)
  if (!head) return null
  let depth = 1
  let i = head.index + head[0].length
  const keys = []
  let segment = ''
  /*
   * Split on `;` and `,` as well as newline. These declarations are written
   * both ways in this file — `{ accountId: string; secret: string }` on one
   * line, and one-key-per-line for the longer ones — and a newline-only scan
   * silently returns just the first key of the single-line form. That is a
   * parser that reports "all clear" while checking almost nothing, which is a
   * worse failure than the one this gate is for.
   */
  const flush = () => {
    const m = /^\s*([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(segment)
    if (m) keys.push(m[1])
    segment = ''
  }
  while (i < source.length && depth > 0) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    if (depth === 0) {
      flush()
      break
    }
    // Separators only count at the top level of the options object; inside a
    // nested shape they belong to that shape's fields.
    if (depth === 1 && (ch === '\n' || ch === ';' || ch === ',')) flush()
    else if (depth === 1) segment += ch
    else if (ch === '\n') segment = ''
    i++
  }
  return keys
}

for (const name of tsMethods) {
  if (!javaMethods.has(name)) continue
  const body = scannedBodyOf(javaSource, name)
  const promised = tsPayloadKeys(tsSource, name)
  // No `opts: { … }` shape to compare against — a no-argument method, or one
  // taking a named type. Nothing to check rather than something to guess at.
  if (!body || !promised || promised.length === 0) continue
  for (const [, key] of body.matchAll(CALL_READ)) {
    check(
      `${name}() reads "${key}" from the call, but ${TS_FILE} never sends it`,
      promised.includes(key),
    )
  }
  const read = new Set([...body.matchAll(CALL_READ)].map((m) => m[1]))
  for (const key of promised) {
    if (!read.has(key)) {
      warnings.push(`${name}() is sent "${key}" but the Java handler never reads it`)
    }
  }
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
