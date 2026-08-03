/**
 * Recompute `SHA256SUMS.txt` for the release artifacts — `npm run release:hashes`.
 *
 * Exists as a script rather than a shell one-liner for one reason: the hashes
 * are the only thing standing between a user and a tampered installer, and a
 * one-liner retyped each release is a one-liner that will eventually hash the
 * *previous* build. This reads the artifacts by their exact expected names,
 * refuses to write a file if any of them is missing, and prints sizes so a
 * 0-byte artifact cannot slip through as a valid-looking hash.
 *
 * Pass `--verify <dir>` to check downloaded copies against the manifest
 * instead of writing one — that is the "download it back and re-verify" half,
 * and it deliberately re-reads the file from disk rather than trusting the
 * upload tool's report of success.
 */

import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const RELEASE_DIR = 'release'

/** The artifacts that make up a release, in the order they appear in the manifest. */
function artifactNames(version) {
  return [
    `Aevistle-${version}-win-x64-setup.exe`,
    `Aevistle-${version}-win-x64-portable.exe`,
    `Aevistle-${version}.apk`,
  ]
}

async function sha256(path) {
  const buf = await readFile(path)
  return createHash('sha256').update(buf).digest('hex')
}

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const names = artifactNames(pkg.version)

const verifyIndex = process.argv.indexOf('--verify')
const verifyDir = verifyIndex >= 0 ? process.argv[verifyIndex + 1] : null

if (verifyDir) {
  const manifest = await readFile(join(verifyDir, 'SHA256SUMS.txt'), 'utf8')
  const expected = new Map()
  for (const line of manifest.trim().split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim())
    if (m) expected.set(m[2], m[1])
  }

  let bad = 0
  for (const name of names) {
    const path = join(verifyDir, name)
    let actual
    try {
      actual = await sha256(path)
    } catch {
      console.error(`  ✗ ${name} — not downloaded`)
      bad++
      continue
    }
    const want = expected.get(name)
    const size = (await stat(path)).size
    if (!want) {
      console.error(`  ✗ ${name} — not listed in SHA256SUMS.txt`)
      bad++
    } else if (want !== actual) {
      console.error(`  ✗ ${name} — MISMATCH\n      manifest ${want}\n      download ${actual}`)
      bad++
    } else {
      console.log(`  ok  ${name}  ${size.toLocaleString()} bytes  ${actual.slice(0, 16)}…`)
    }
  }
  console.log(bad === 0 ? `\n${names.length}/${names.length} verified` : `\n${bad} FAILED`)
  process.exit(bad === 0 ? 0 : 1)
}

const lines = []
for (const name of names) {
  const path = join(RELEASE_DIR, name)
  const info = await stat(path).catch(() => null)
  if (!info) {
    console.error(`Missing artifact: ${path}`)
    console.error('Refusing to write a partial manifest.')
    process.exit(1)
  }
  if (info.size === 0) {
    console.error(`Zero-byte artifact: ${path}`)
    process.exit(1)
  }
  const hash = await sha256(path)
  lines.push(`${hash} *${name}`)
  console.log(`  ${name}  ${info.size.toLocaleString()} bytes  ${hash.slice(0, 16)}…`)
}

const out = join(RELEASE_DIR, 'SHA256SUMS.txt')
await writeFile(out, lines.join('\n') + '\n', 'utf8')
console.log(`\nWrote ${out}`)
