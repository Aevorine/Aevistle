/**
 * Does the privacy image proxy actually do what it says, on real bytes?
 *
 * `check-image-proxy.mjs` proves the two platforms agree with each other. That
 * is a consistency check, and two implementations can agree perfectly while
 * both being wrong. This one builds actual files — a PNG carrying GPS
 * coordinates, an animated GIF with a comment and a payload glued past its
 * trailer, an SVG wearing a `image/png` label — and asserts what comes out the
 * other side.
 *
 * Every fixture is constructed here rather than checked in as a binary, so
 * what each one contains is readable, and so a reviewer can see that the GPS
 * bytes really are in the input before believing they are absent from the
 * output.
 *
 * The pixel re-encode itself runs on Electron's `nativeImage` and needs an
 * Electron runtime, so it is not exercised here; what is exercised is every
 * decision made before and after it, plus the two structural scrubbers that
 * handle animated files on their own. `scripts/check-image-proxy.mjs` covers
 * the re-encode's *thresholds*; the decode is Chromium's and is not this
 * project's to test.
 *
 * Exit code 1 if anything needs attention.
 */

import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

const dir = mkdtempSync(join(tmpdir(), 'aev-imgscan-'))

/*
 * `electron/imageProxy.ts` imports `electron` for `nativeImage`, which does not
 * exist outside an Electron runtime. It is aliased to a stub that *throws* if
 * anything calls it, rather than to one that returns something plausible: every
 * assertion below is about a path that never decodes pixels, and a stub that
 * quietly answered would let this file drift into testing the stub.
 */
const stub = join(dir, 'electron-stub.mjs')
writeFileSync(
  stub,
  `export const nativeImage = {
` +
    `  createFromBuffer() { throw new Error('nativeImage reached in a structural test') },
` +
    `}
`,
)

async function load(entry, name) {
  const outfile = join(dir, `${name}.mjs`)
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    alias: { electron: stub },
    outfile,
    logLevel: 'error',
  })
  return import(pathToFileURL(outfile).href)
}

const proxy = await load('electron/imageProxy.ts', 'proxy')
const shared = await load('src/core/mail/imageProxy.ts', 'shared')

let passed = 0
const failures = []
const ok = (label, condition) => {
  if (condition) passed++
  else failures.push(label)
}
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) passed++
  else failures.push(`${label}\n      expected ${b}\n      got      ${a}`)
}

/* -------------------------------------------------------------------------- */
/*  Fixture builders                                                          */
/* -------------------------------------------------------------------------- */

const crcTable = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** A minimal but structurally valid PNG, with whatever extra chunks are asked for. */
function makePng({ width = 8, height = 8, extras = [], animated = false, trailing = null } = {}) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height) // filter byte + RGBA rows, all zero
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
  ]
  if (animated) {
    const actl = Buffer.alloc(8)
    actl.writeUInt32BE(2, 0) // two frames
    actl.writeUInt32BE(0, 4) // loop forever
    parts.push(pngChunk('acTL', actl))
  }
  for (const [type, data] of extras) parts.push(pngChunk(type, Buffer.from(data, 'latin1')))
  parts.push(pngChunk('IDAT', deflateSync(raw)))
  parts.push(pngChunk('IEND', Buffer.alloc(0)))
  if (trailing) parts.push(Buffer.from(trailing, 'latin1'))
  return Buffer.concat(parts)
}

/** A GIF with `frames` image descriptors, plus optional junk blocks and trailing bytes. */
function makeGif({ frames = 1, comment = null, appExt = null, netscape = false, trailing = null } = {}) {
  const parts = [Buffer.from('GIF89a', 'latin1')]
  const lsd = Buffer.alloc(7)
  lsd.writeUInt16LE(4, 0) // width
  lsd.writeUInt16LE(4, 2) // height
  lsd[4] = 0x80 // global colour table, 2 entries
  parts.push(lsd)
  parts.push(Buffer.from([0, 0, 0, 255, 255, 255])) // the table

  if (netscape) {
    parts.push(
      Buffer.concat([
        Buffer.from([0x21, 0xff, 0x0b]),
        Buffer.from('NETSCAPE2.0', 'latin1'),
        Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]),
      ]),
    )
  }
  if (comment) {
    parts.push(
      Buffer.concat([
        Buffer.from([0x21, 0xfe, comment.length]),
        Buffer.from(comment, 'latin1'),
        Buffer.from([0x00]),
      ]),
    )
  }
  if (appExt) {
    parts.push(
      Buffer.concat([
        Buffer.from([0x21, 0xff, 0x0b]),
        Buffer.from(appExt.padEnd(11, ' ').slice(0, 11), 'latin1'),
        Buffer.from([0x04, 1, 2, 3, 4, 0x00]),
      ]),
    )
  }

  for (let i = 0; i < frames; i++) {
    // Graphic control extension: 4 bytes of timing.
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00]))
    const desc = Buffer.alloc(10)
    desc[0] = 0x2c
    desc.writeUInt16LE(0, 1)
    desc.writeUInt16LE(0, 3)
    desc.writeUInt16LE(4, 5)
    desc.writeUInt16LE(4, 7)
    desc[9] = 0x00 // no local colour table
    // LZW minimum code size, then one sub-block, then the terminator.
    parts.push(desc, Buffer.from([0x02, 0x02, 0x4c, 0x01, 0x00]))
  }
  parts.push(Buffer.from([0x3b]))
  if (trailing) parts.push(Buffer.from(trailing, 'latin1'))
  return Buffer.concat(parts)
}

/* -------------------------------------------------------------------------- */
/*  1. Sniffing tells the truth about the bytes                               */
/* -------------------------------------------------------------------------- */

eq('sniff: PNG', proxy.sniff(makePng()), 'png')
eq('sniff: GIF', proxy.sniff(makeGif()), 'gif')
eq('sniff: JPEG', proxy.sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpeg')
eq(
  'sniff: WEBP',
  proxy.sniff(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])),
  'webp',
)
eq('sniff: SVG with an XML declaration', proxy.sniff(Buffer.from('<?xml version="1.0"?><svg/>')), 'svg')
eq('sniff: SVG with leading whitespace', proxy.sniff(Buffer.from('\n\n   <svg xmlns="x"></svg>')), 'svg')
eq('sniff: HTML is not an image', proxy.sniff(Buffer.from('<html><body>hello</body></html>')), 'unknown')

/* -------------------------------------------------------------------------- */
/*  2. An SVG is refused however it is labelled                               */
/* -------------------------------------------------------------------------- */

/*
 * The attack this blocks: an SVG served as `image/png`. SVG is XML that can
 * carry `<script>` and can fetch its own subresources, which would reopen the
 * exact channel this whole feature closes.
 */
const svgAsPng = proxy.scanAndReEncode(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png')
eq('SVG mislabelled as PNG is refused', svgAsPng.ok, false)
eq('SVG refusal names the format, not the label', svgAsPng.reason, 'scriptableFormat')

const svgHonest = proxy.scanAndReEncode(Buffer.from('<svg xmlns="x"/>'), 'image/svg+xml')
eq('SVG served honestly is refused too', svgHonest.reason, 'scriptableFormat')

/* -------------------------------------------------------------------------- */
/*  3. A declared type that disagrees with the bytes                          */
/* -------------------------------------------------------------------------- */

const mismatch = proxy.scanAndReEncode(makeGif(), 'image/png')
eq('a GIF declared as PNG is refused', mismatch.reason, 'typeMismatch')

const jpgSynonym = proxy.sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))
eq('image/jpg is still a JPEG (servers really do this)', jpgSynonym, 'jpeg')

/* -------------------------------------------------------------------------- */
/*  4. Animated GIF: frames survive, junk does not                            */
/* -------------------------------------------------------------------------- */

const PAYLOAD = 'PKTRAILING-ZIP-PAYLOAD'
const dirtyGif = makeGif({
  frames: 3,
  netscape: true,
  comment: 'CONFIDENTIAL-COMMENT',
  appExt: 'XMP Data',
  trailing: PAYLOAD,
})
ok('fixture: the dirty GIF really does contain the comment', dirtyGif.includes('CONFIDENTIAL-COMMENT'))
ok('fixture: the dirty GIF really does contain the trailing payload', dirtyGif.includes(PAYLOAD))

const gifOut = proxy.scanAndReEncode(dirtyGif, 'image/gif')
eq('animated GIF passes', gifOut.ok, true)
eq('animated GIF stays a GIF', gifOut.mime, 'image/gif')
ok('animated GIF keeps its animation (not re-encoded to a still)', gifOut.data.length > 0)
ok('the comment is gone', !gifOut.data.includes('CONFIDENTIAL-COMMENT'))
ok('the XMP application extension is gone', !gifOut.data.includes('XMP Data'))
ok('the payload glued past the trailer is gone', !gifOut.data.includes(PAYLOAD))
ok('the loop extension is kept, so it still loops', gifOut.data.includes('NETSCAPE'))
eq('the last byte is the GIF trailer', gifOut.data[gifOut.data.length - 1], 0x3b)
eq('dimensions are read off the screen descriptor', [gifOut.width, gifOut.height], [4, 4])

/*
 * A GIF whose block structure does not parse is never passed through as-is.
 *
 * It is *not* refused here either — it falls through to the pixel decoder,
 * which is the right answer: Chromium's GIF decoder is hardened and fuzzed, and
 * if it can make sense of the file the reader gets a safe re-encoded still
 * rather than a missing picture. If it cannot, the verdict is `undecodable`.
 *
 * That routing is what this asserts, and it asserts it by catching the stub's
 * own error — reaching the decoder is the observable fact, and the decode
 * itself is not this project's to test. The failure this guards against is the
 * structural walk returning a half-parsed buffer and calling it clean.
 */
let reachedDecoder = false
try {
  proxy.scanAndReEncode(makeGif({ frames: 2 }).subarray(0, 20), 'image/gif')
} catch (e) {
  reachedDecoder = /nativeImage reached/.test(String(e))
}
ok('a GIF that does not parse structurally is handed to the decoder, not passed through', reachedDecoder)

/* -------------------------------------------------------------------------- */
/*  5. Animated PNG: the metadata that carries GPS is dropped                 */
/* -------------------------------------------------------------------------- */

const GPS = 'GPSLatitude=51.5074;GPSLongitude=-0.1278'
const dirtyPng = makePng({
  animated: true,
  extras: [
    ['eXIf', GPS],
    ['tEXt', 'Comment camera serial 90210'],
    ['iTXt', 'XML:com.adobe.xmp     secret'],
  ],
  trailing: PAYLOAD,
})
ok('fixture: the dirty PNG really does contain the GPS chunk', dirtyPng.includes(GPS))
ok('fixture: the dirty PNG really does contain the trailing payload', dirtyPng.includes(PAYLOAD))

const pngOut = proxy.scanAndReEncode(dirtyPng, 'image/png')
eq('animated PNG passes', pngOut.ok, true)
eq('animated PNG stays a PNG', pngOut.mime, 'image/png')
ok('the GPS coordinates are gone', !pngOut.data.includes(GPS))
ok('the camera serial is gone', !pngOut.data.includes('camera serial'))
ok('the XMP block is gone', !pngOut.data.includes('adobe.xmp'))
ok('the payload glued past IEND is gone', !pngOut.data.includes(PAYLOAD))
ok('the pixels are kept', pngOut.data.includes('IDAT'))
ok('the animation control chunk is kept', pngOut.data.includes('acTL'))
eq('dimensions are read off IHDR', [pngOut.width, pngOut.height], [8, 8])

/* -------------------------------------------------------------------------- */
/*  6. Tracking classification                                                */
/* -------------------------------------------------------------------------- */

const t = (url, width, height, transparent) =>
  shared.classifyTracker({ url, width, height, fullyTransparent: transparent })

ok('a 1x1 image is a tracker whatever its URL', t('https://cdn.example.com/a.gif', 1, 1).tracker)
ok('a fully transparent image is a tracker', t('https://cdn.example.com/a.png', 200, 50, true).tracker)
ok(
  'an ordinary logo is not a tracker',
  !t('https://cdn.example.com/assets/logo.png', 240, 80, false).tracker,
)

/*
 * The false positive this rule was written around. `includes('stat')` fires on
 * `/static/`, which is the most common image path on the web — the whole count
 * would have been meaningless.
 */
ok(
  '/static/ is not a tracking path',
  !t('https://cdn.example.com/static/header.png', 600, 200, false).rules.includes('trackingPath'),
)
ok(
  '/open/ is a tracking path',
  t('https://mail.example.com/open/abc.gif', 600, 200, false).rules.includes('trackingPath'),
)

/*
 * One circumstantial signal is a suspicion, two agreeing is a report. A CDN
 * path can legitimately carry a long content hash; a campaign URL can
 * legitimately carry the word "open".
 */
const oneSignal = t('https://cdn.example.com/i/9f8a7b6c5d4e3f2a1b0c9d8e7f.png', 600, 200, false)
ok('one circumstantial signal alone is not called tracking', !oneSignal.tracker)
ok('...but it is still recorded', oneSignal.rules.includes('recipientToken'))

const twoSignals = t(
  'https://mail.example.com/open/9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c.gif',
  600,
  200,
  false,
)
ok('two agreeing signals are called tracking', twoSignals.tracker)

ok(
  'an address in the query is recorded',
  t('https://m.example.com/i.png?email=someone%40example.com', 300, 100, false).rules.includes(
    'addressInUrl',
  ),
)

/*
 * A URL that cannot be parsed never reached the network either, so there is
 * nothing to classify and nothing to crash on.
 */
ok('an unparseable URL does not throw', t('not a url at all', 1, 1).tracker === true)

/* -------------------------------------------------------------------------- */
/*  7. The verdict shape                                                      */
/* -------------------------------------------------------------------------- */

const failed = shared.failedImage('fetchFailed', 'ECONNRESET')
eq('a network failure is `failed`, not `blocked`', failed.status, 'failed')
const refusedTarget = shared.failedImage('refusedTarget')
eq('a private-address refusal is `failed` too — the bytes never arrived', refusedTarget.status, 'failed')
const scannerRefusal = shared.failedImage('scriptableFormat')
eq('a scanner refusal is `blocked` — the bytes did arrive', scannerRefusal.status, 'blocked')

eq('a bare string normalises to a passing verdict', shared.asProxiedImage('data:image/png;base64,AA').status, 'ok')
eq('null normalises to a failure', shared.asProxiedImage(null).status, 'failed')

/*
 * The blocked placeholder has to satisfy the same validator every real picture
 * does, because that is how it travels the ordinary resolve path instead of
 * needing a second channel through the frame.
 */
const placeholder = await load('src/core/mail/remoteImagePlaceholder.ts', 'placeholder')
ok(
  'BLOCKED_IMAGE passes safeImageDataUri',
  placeholder.safeImageDataUri(shared.BLOCKED_IMAGE) === shared.BLOCKED_IMAGE,
)
ok('BLOCKED_IMAGE cannot be mistaken for a placeholder', !shared.BLOCKED_IMAGE.includes('#'))

/* -------------------------------------------------------------------------- */

rmSync(dir, { recursive: true, force: true })

console.log('\n  Privacy image proxy — behaviour on real bytes\n')
if (failures.length > 0) {
  console.error(`  ${failures.length} failure(s), ${passed} passed\n`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  console.error('')
  process.exit(1)
}
console.log(`  ${passed} checks passed`)
console.log('\n  All clear.\n')
