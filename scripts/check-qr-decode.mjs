/**
 * Round-trip `core/sync/qr.ts`'s encoder through `core/sync/qrDecode.ts`'s decoder.
 *
 * `scripts/check-qr.mjs` proves the encoder produces exactly the matrix a
 * reference *encoder* would. That says nothing about whether a real QR
 * *reader* can get the text back out of it — a matrix can be a byte-for-byte
 * correct QR code and still be handed to jsQR in a form it chokes on (wrong
 * polarity, no quiet zone, a scale too small for its module-size heuristic).
 * This is the other half of the proof: draw the code the same way the app
 * would show it on screen, read it back with the same decoder
 * `PairingScanner.tsx` uses, and check the text survived.
 *
 * Fixtures include an actual `aevistle-pair:{...}` payload — the pairing
 * scheme's own encode/decode round trip (`encodePairingText`/
 * `decodePairingText` in `core/sync/pairing.ts`) is exercised elsewhere, but only
 * this script proves that text actually survives being turned into pixels and
 * back, which is the step neither of those unit-level checks touches.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/* Fixture-only bytes for the pairing-payload cases below, built at runtime
   rather than spelled out as base64 literals — a literal that long and that
   random-looking is indistinguishable from a real credential to
   `scripts/audit.mjs`'s SEC-01 check, and it is right to be suspicious of
   that shape. This is not a key from anywhere; it is a placeholder this
   script invents for one QR round trip and never uses again. */
const fixtureBytes = (label) => Buffer.from(`not-a-real-secret-${label}`).toString('base64')

const CASES = [
  'aevistle-pair:' +
    JSON.stringify({
      v: 1,
      host: '192.168.1.42',
      port: 51423,
      token: fixtureBytes('token'),
      epk: fixtureBytes('epk'),
      exp: Date.now() + 120_000,
      mode: 'ongoing',
    }),
  'aevistle-pair:' +
    JSON.stringify({
      v: 1,
      host: '10.0.0.7',
      port: 8080,
      token: fixtureBytes('token2'),
      epk: fixtureBytes('epk2'),
      exp: Date.now() + 120_000,
      mode: 'once',
    }),
  'https://example.com/verify?token=abc123',
  'a',
  '1234567890',
  'https://例子.测试/验证?token=中文令牌参数',
  'https://very.long.example.com/magic-link/' + 'x'.repeat(300),
]

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const out = mkdtempSync(join(tmpdir(), 'aevistle-qrdecode-'))

try {
  execFileSync(
    'npx',
    [
      'esbuild',
      quote(join(root, 'src/core/sync/qr.ts')),
      quote(join(root, 'src/core/sync/qrDecode.ts')),
      '--bundle',
      '--format=esm',
      '--platform=node',
      `--outdir=${quote(out)}`,
      '--log-level=warning',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], shell: true },
  )
} catch (e) {
  console.error('esbuild failed:', e.message)
  process.exit(1)
}

const { encodeQr } = await import(pathToFileURL(join(out, 'qr.js')).href)
const { decodeQr } = await import(pathToFileURL(join(out, 'qrDecode.js')).href)

/**
 * Turn the module grid into the RGBA pixel buffer a camera frame would give
 * `getUserMedia`/`<canvas>` — black modules, a white quiet zone, no anti-
 * aliasing. `scale` is pixels per module: jsQR's own finder-pattern heuristic
 * needs each module to be a handful of pixels wide, the way a code actually
 * fills a chunk of a camera frame, not a single-pixel-per-module thumbnail
 * nothing would ever really scan.
 */
function rasterize(qr, scale = 6, quietZone = 4) {
  const span = (qr.size + quietZone * 2) * scale
  const data = new Uint8ClampedArray(span * span * 4).fill(255)
  const setPixel = (x, y) => {
    const i = (y * span + x) * 4
    data[i] = 0
    data[i + 1] = 0
    data[i + 2] = 0
    data[i + 3] = 255
  }
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (!qr.modules[r][c]) continue
      const px0 = (c + quietZone) * scale
      const py0 = (r + quietZone) * scale
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) setPixel(px0 + dx, py0 + dy)
      }
    }
  }
  return { data, width: span, height: span }
}

let failures = 0
let checked = 0

for (const text of CASES) {
  const qr = encodeQr(text)
  if (!qr) {
    console.error(`✗ encodeQr refused a payload it should carry: ${preview(text)}`)
    failures++
    continue
  }

  const { data, width, height } = rasterize(qr)
  const decoded = decodeQr(data, width, height)

  checked++
  if (decoded === text) {
    console.log(`  ok  v${qr.version} ${qr.size}×${qr.size} (${text.length} chars)  ${preview(text)}`)
  } else if (decoded === null) {
    console.error(`✗ decoder found nothing in the rasterised code for: ${preview(text)}`)
    failures++
  } else {
    console.error(`✗ decoded text does not match for ${preview(text)}\n    got: ${preview(decoded)}`)
    failures++
  }
}

rmSync(out, { recursive: true, force: true })

function quote(p) {
  return `"${p}"`
}

function preview(text) {
  return text.length > 60 ? `${text.slice(0, 57)}…(${text.length})` : text
}

if (failures > 0) {
  console.error(`\ncheck:qr-decode FAILED — ${failures} problem(s) across ${CASES.length} cases`)
  process.exit(1)
}
console.log(`\ncheck:qr-decode ok — ${checked} payloads round-tripped through encode → pixels → decode`)
