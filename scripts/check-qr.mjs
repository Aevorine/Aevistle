/**
 * Prove `src/core/qr.ts` correct against the reference implementation.
 *
 * A wrong QR encoder does not throw, log, or look wrong. It produces a picture
 * that is unmistakably a QR code and simply fails to scan — a bug discovered by
 * a person holding a phone in front of a login screen, which is the worst place
 * to discover anything. So it is checked module for module rather than by eye.
 *
 * The comparison is against *one of the eight masks*, not against whichever mask
 * each side chose. Mask selection is a scoring heuristic: two conforming
 * encoders can prefer different masks for the same payload and both be right.
 * What must be identical is everything else — version choice, byte-mode framing,
 * padding, Reed-Solomon codewords, block interleaving, function patterns,
 * alignment centres, format bits and the zig-zag data walk. If one masked
 * matrix matches exactly, all of that is provably identical.
 *
 * `qrcode-generator` is a devDependency and is never bundled: nothing here runs
 * in the app.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CASES = [
  'https://login.live.com/oauth20_authorize.srf?client_id=000000004C12AE6F',
  'https://example.com/verify?token=abc123',
  'https://github.com/login/device',
  'https://accounts.google.com/signin/v2/challenge?hl=en&flowName=GlifWebSignIn',
  'a',
  '1234567890',
  'https://mail.example.co.uk/reset-password?token=' + 'f'.repeat(64),
  'https://例子.测试/验证?token=中文令牌参数',
  'https://very.long.example.com/magic-link/' + 'x'.repeat(300),
  'https://a.example/' + 'y'.repeat(700),
  'HTTPS://UPPER.EXAMPLE/PATH',
  'https://example.com/a?b=1&c=2#frag',
]

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const out = mkdtempSync(join(tmpdir(), 'aevistle-qr-'))

try {
  /* `shell: true` because Node refuses to spawn a `.cmd` directly on Windows,
     which is how npx ships there. */
  execFileSync(
    'npx',
    ['esbuild', quote(join(root, 'src/core/qr.ts')), '--bundle', '--format=esm', `--outfile=${quote(join(out, 'qr.mjs'))}`, '--log-level=warning'],
    { stdio: ['ignore', 'ignore', 'inherit'], shell: true },
  )
} catch (e) {
  console.error('esbuild failed:', e.message)
  process.exit(1)
}

const { encodeQr } = await import(pathToFileURL(join(out, 'qr.mjs')).href)

let reference
try {
  reference = (await import('qrcode-generator')).default
} catch {
  console.error('check:qr needs the `qrcode-generator` devDependency — run `npm install`.')
  process.exit(1)
}

/*
 * The reference defaults to one byte per character, which silently mangles
 * anything outside Latin-1 — a CJK URL encodes shorter than it should and comes
 * back as mojibake in a scanner. `qr.ts` emits UTF-8 because that is what phones
 * actually decode, so the reference is switched to UTF-8 here; otherwise this
 * script would report our correct behaviour as a mismatch.
 */
reference.stringToBytes =
  reference.stringToBytesFuncs?.['UTF-8'] ?? ((text) => Array.from(new TextEncoder().encode(text)))

let failures = 0
let checked = 0

for (const text of CASES) {
  const mine = encodeQr(text)
  if (!mine) {
    /* Only legitimate for payloads past what version 20 at level L can hold. */
    const bytes = new TextEncoder().encode(text).length
    if (bytes > 858) {
      console.log(`  skip (too long, ${bytes} B, correctly refused): ${preview(text)}`)
      continue
    }
    console.error(`✗ refused a payload it should carry (${bytes} B): ${preview(text)}`)
    failures++
    continue
  }

  const qr = reference(0, 'L')
  qr.addData(text, 'Byte')
  qr.make()
  const refSize = qr.getModuleCount()

  if (refSize !== mine.size) {
    console.error(`✗ version mismatch for ${preview(text)}: mine ${mine.size}px, reference ${refSize}px`)
    failures++
    continue
  }

  let matchedMask = -1
  for (let mask = 0; mask < 8; mask++) {
    const candidate = encodeQr(text, { mask })
    let same = true
    for (let r = 0; r < refSize && same; r++) {
      for (let c = 0; c < refSize; c++) {
        if (candidate.modules[r][c] !== qr.isDark(r, c)) {
          same = false
          break
        }
      }
    }
    if (same) {
      matchedMask = mask
      break
    }
  }

  checked++
  if (matchedMask < 0) {
    console.error(`✗ no mask reproduces the reference matrix for ${preview(text)}`)
    failures++
  } else {
    console.log(`  ok  v${mine.version} ${mine.size}×${mine.size} mask ${matchedMask}  ${preview(text)}`)
  }
}

/* The SVG has to be well-formed too — an encoder that is right and a renderer
   that emits a broken path are the same failure to the person scanning it. */
const svgProbe = encodeQr('https://example.com/verify?token=abc123')
const { qrToSvg } = await import(pathToFileURL(join(out, 'qr.mjs')).href)
const svg = qrToSvg(svgProbe)
if (!svg.startsWith('<svg') || !svg.includes('viewBox="0 0 ') || !/ d="M/.test(svg)) {
  console.error('✗ qrToSvg did not produce a usable SVG')
  failures++
}

rmSync(out, { recursive: true, force: true })

/** Paths reach the shell here, and this repo lives under a path with spaces. */
function quote(p) {
  return `"${p}"`
}

function preview(text) {
  return text.length > 48 ? `${text.slice(0, 45)}…(${text.length})` : text
}

if (failures > 0) {
  console.error(`\ncheck:qr FAILED — ${failures} problem(s) across ${CASES.length} cases`)
  process.exit(1)
}
console.log(`\ncheck:qr ok — ${checked} payloads match the reference implementation exactly`)
