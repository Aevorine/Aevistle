/**
 * Does every empty `catch` block on the Android side explain why it is safe
 * to say nothing?
 *
 * The failure class this exists for is "runs fine, reports nothing, does
 * nothing": a `catch (Exception ignored) {}` with no comment anywhere near
 * it, sitting in a background worker or a native bridge method the WebView
 * has no way to interrogate afterwards. JobStore's `recordRun`, once, threw
 * partway through its bookkeeping and swallowed it bare — the send had
 * already happened, but the Schedule screen kept showing the job as armed
 * forever, because nothing downstream of the empty catch ever heard about
 * the failure. Every *other* catch in that file explained itself; that one
 * didn't, and the inconsistency was the only signal anything was wrong.
 *
 * That is the pattern this checks for, mechanically: a `catch` whose body
 * has no real code in it — the only thing distinguishing a deliberate,
 * reasoned "this is safe to ignore" from an oversight is whether someone
 * wrote that reasoning down. A body that is empty of code but carries a
 * comment (inside the braces, or on the line(s) directly above `catch`)
 * passes; the wording is free-form, and `// silent-ok: <reason>` is offered
 * as one plain way to write it for a case that doesn't need more than a
 * sentence. A body with no comment anywhere near it fails, listed by
 * file:line so a new one cannot land unnoticed the way the eight originals
 * did.
 *
 * A catch with a real statement in its body — a log call, a field
 * assignment, a fallback — is not this checker's concern even if it never
 * rethrows: it is doing something, which is a design question for code
 * review, not a silence this script exists to catch.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const JAVA_ROOT = 'android/app/src/main/java'

const failures = []
let checked = 0

// --- collect every .java file under the Android source tree ----------------

const files = []
function walk(dir) {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) walk(rel)
    else if (entry.name.endsWith('.java')) files.push(rel)
  }
}
walk(JAVA_ROOT)

/**
 * Blank out comments, keeping length and newlines so indices and line
 * numbers still land on the real source — the approach `check-android-
 * plugin.mjs` established. Character by character, not by regex, because a
 * string literal has to be walked past rather than scanned: a `/*` inside a
 * quoted MIME type or error message is not a comment opener.
 */
function stripComments(text) {
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
      const end = text.indexOf('\n', i)
      const stop = end === -1 ? text.length : end
      out += text.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else if (c === '"' || c === "'") {
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

/** 1-based line number of a character offset. */
const lineAt = (text, index) => text.slice(0, index).split('\n').length

/** The nearest non-blank line strictly above `lineNo` (1-based), or '' if none. */
function lineAbove(lines, lineNo) {
  for (let n = lineNo - 2; n >= 0; n--) {
    const trimmed = lines[n].trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

const isCommentLine = (line) => line.startsWith('//') || line.startsWith('/*') || line.endsWith('*/') || line.startsWith('*')

for (const rel of files) {
  const source = readFileSync(path.join(ROOT, rel), 'utf8')
  const codeOnly = stripComments(source)
  const lines = source.split('\n')

  // Every `catch (...) {`, matched on the comment-blanked text so a `catch`
  // mentioned in prose or inside a string cannot be mistaken for a real one.
  for (const m of codeOnly.matchAll(/\bcatch\s*\([^()]*\)\s*\{/g)) {
    const bodyStart = m.index + m[0].length
    checked++

    // Brace-match forward to find where this catch body actually ends.
    let depth = 1
    let i = bodyStart
    while (i < codeOnly.length && depth > 0) {
      if (codeOnly[i] === '{') depth++
      else if (codeOnly[i] === '}') depth--
      i++
    }
    const bodyEnd = i - 1

    const codeBody = codeOnly.slice(bodyStart, bodyEnd)
    if (codeBody.trim() !== '') continue // real statements in here — not this checker's business

    const rawBody = source.slice(bodyStart, bodyEnd)
    const catchLine = lineAt(source, m.index)

    const documentedInside = rawBody.trim() !== ''
    const documentedAbove = isCommentLine(lineAbove(lines, catchLine))

    if (!documentedInside && !documentedAbove) {
      failures.push(`${rel}:${catchLine}`)
    }
  }
}

// --- sanity: a parser that finds nothing must not report "all clear" -------

const label = 'every empty catch block on Android explains itself'

if (checked === 0) {
  console.log(`\n  ${label}\n  FAIL  no catch blocks were found under ${JAVA_ROOT} — the parser is broken, not the codebase\n`)
  process.exit(1)
}

if (failures.length === 0) {
  console.log(`\n  ${label}\n  ${checked} catch blocks checked across ${files.length} files\n`)
  console.log('  All clear.\n')
  process.exit(0)
}

console.log(`\n  ${label}\n  ${checked} catch blocks checked across ${files.length} files, ${failures.length} undocumented\n`)
for (const f of failures) {
  console.log(`  FAIL  ${f} — empty catch with no comment inside or immediately above`)
}
console.log(
  `\n  Explain why it is safe to say nothing (inside the braces, or the line above ` +
    `\`catch\`), or mark it deliberately with \`// silent-ok: <reason>\`.\n`,
)
process.exit(1)
