/**
 * Scan and re-encode a fetched image before anything renders it.
 *
 * `remoteImage.ts` gets the bytes safely (SSRF shield, one DNS resolution, no
 * redirects, size cap). This file decides whether those bytes are an image at
 * all, and turns the ones that are into bytes this app produced rather than
 * bytes a stranger produced. See `src/core/mail/imageProxy.ts` for why the
 * pipeline exists and what it promises.
 *
 * ## Why a re-encode and not a scanner
 *
 * A scanner is a list of things somebody thought of. Decoding an image to
 * pixels and writing a new file from those pixels is a *whitelist by
 * construction*: whatever survives is, definitionally, the picture. Everything
 * that is not the picture — EXIF (which carries GPS coordinates and camera
 * serial numbers), ICC profiles, XMP, comments, thumbnails, and any payload
 * appended after the image's own end marker — is simply not part of the output,
 * without anybody having had to enumerate it.
 *
 * The decoder is Chromium's, via Electron's `nativeImage`. That is deliberate:
 * it is the most-attacked image decoding stack in existence, it is fuzzed
 * continuously, and it is already in this process. Adding `sharp` would mean a
 * native module in an Electron build, a second decoder to keep patched, and no
 * help at all on Android, which has to do this in Java regardless.
 *
 * ## Why animated files take a different path
 *
 * `nativeImage` decodes one frame. Running it over an animated GIF returns a
 * still, and "your animations silently stopped working" is not an acceptable
 * price. Those get a structural scrub instead: the file is walked block by
 * block and rebuilt from only the blocks that carry pixels or timing, which
 * drops comments, unknown application extensions and anything after the
 * trailer. That is weaker than a re-encode — it trusts the decoder to handle
 * the pixel data — and it is applied only where a re-encode would destroy the
 * content.
 */

import { nativeImage } from 'electron'
import {
  classifyTracker,
  type ImageBlockReason,
  type ProxiedImage,
} from '../src/core/mail/imageProxy'

/** Refuse anything whose pixel count could exhaust memory on decode. */
const MAX_PIXELS = 40_000_000
/** Refuse anything whose processed form would be absurd to inline as a data URI. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
/** Above this, a JPEG source is re-encoded as JPEG rather than PNG. */
const JPEG_REENCODE_THRESHOLD = 64 * 1024
/** Quality for that path. 82 is visually indistinguishable at photo sizes. */
const JPEG_QUALITY = 82

export type ImageKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'svg' | 'unknown'

export interface ScanOutcome {
  ok: boolean
  reason?: ImageBlockReason
  detail?: string
  /** The processed bytes, when `ok`. */
  data?: Buffer
  mime?: string
  width: number
  height: number
  fullyTransparent?: boolean
}

/* -------------------------------------------------------------------------- */
/*  What is this actually?                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The format the *bytes* say they are, which is the only claim worth acting on.
 *
 * `Content-Type` is whatever the sender's server chose to answer with. It is
 * checked too — the two having to agree is what catches a server declaring
 * `image/png` over a file that is something else — but it is never the basis
 * for how the bytes are handled.
 */
export function sniff(buffer: Buffer): ImageKind {
  if (buffer.length < 12) return 'unknown'
  if (buffer[0] === 0x89 && buffer.subarray(1, 4).toString('latin1') === 'PNG') return 'png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg'
  if (buffer.subarray(0, 6).toString('latin1') === 'GIF89a') return 'gif'
  if (buffer.subarray(0, 6).toString('latin1') === 'GIF87a') return 'gif'
  if (
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp'
  }
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'bmp'
  /*
   * SVG is XML, so it can begin with a comment, a doctype, an XML declaration
   * or whitespace. Sniffed only to *refuse* it, so a loose test is the right
   * kind of loose: a false positive here costs one picture, a false negative
   * admits a format that can carry `<script>` and fetch its own subresources.
   */
  const head = buffer.subarray(0, 1024).toString('latin1').trimStart().toLowerCase()
  if (head.startsWith('<?xml') || head.startsWith('<!doctype svg') || head.startsWith('<svg')) {
    return 'svg'
  }
  return 'unknown'
}

const MIME_FOR: Record<Exclude<ImageKind, 'svg' | 'unknown'>, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

/**
 * Does the server's declared type agree with what the bytes are?
 *
 * A disagreement is not automatically an attack — plenty of servers mislabel
 * JPEGs as `image/jpg` or serve everything as `application/octet-stream`. It is
 * treated as one anyway, because the cost of being wrong in the permissive
 * direction is executing an attacker's chosen decoder, and the cost of being
 * wrong in the strict direction is one missing picture with a stated reason.
 * The synonyms real servers actually use are accepted by name.
 */
function typeAgrees(declared: string, kind: ImageKind): boolean {
  if (kind === 'svg' || kind === 'unknown') return false
  const want = MIME_FOR[kind]
  const got = declared.toLowerCase().trim()
  if (got === want) return true
  if (kind === 'jpeg' && (got === 'image/jpg' || got === 'image/pjpeg')) return true
  if (kind === 'png' && got === 'image/x-png') return true
  if (kind === 'bmp' && (got === 'image/x-ms-bmp' || got === 'image/x-bmp')) return true
  return false
}

/* -------------------------------------------------------------------------- */
/*  Animation detection                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Does this GIF have more than one frame?
 *
 * Walked properly rather than counting occurrences of the image-separator byte:
 * `0x2C` appears constantly inside compressed pixel data, so a naive count says
 * every GIF is animated. The walk below is also what `scrubGif` uses, so the
 * two cannot disagree about where the blocks are.
 */
function gifFrameCount(buffer: Buffer): number {
  const walked = walkGif(buffer)
  return walked === null ? 1 : walked.frames
}

/** APNG announces itself with an `acTL` chunk before the first `IDAT`. */
function isAnimatedPng(buffer: Buffer): boolean {
  const idat = buffer.indexOf('IDAT', 0, 'latin1')
  const actl = buffer.indexOf('acTL', 0, 'latin1')
  return actl !== -1 && (idat === -1 || actl < idat)
}

/** An animated WebP carries an `ANIM` chunk in its RIFF container. */
function isAnimatedWebp(buffer: Buffer): boolean {
  return buffer.subarray(0, 64).indexOf('ANIM', 0, 'latin1') !== -1
}

function isAnimated(buffer: Buffer, kind: ImageKind): boolean {
  if (kind === 'gif') return gifFrameCount(buffer) > 1
  if (kind === 'png') return isAnimatedPng(buffer)
  if (kind === 'webp') return isAnimatedWebp(buffer)
  return false
}

/* -------------------------------------------------------------------------- */
/*  GIF structural scrub                                                      */
/* -------------------------------------------------------------------------- */

interface GifWalk {
  /** Everything up to and including the trailer, with junk blocks removed. */
  rebuilt: Buffer
  frames: number
  width: number
  height: number
  /** Was there anything after the trailer? */
  trailing: boolean
}

/**
 * Walk a GIF block by block and rebuild it from the blocks that matter.
 *
 * Kept: the header, the logical screen descriptor, the global colour table,
 * every Graphic Control Extension (frame timing and transparency), every Image
 * Descriptor and its data, and the Netscape application extension that carries
 * the loop count — without which an animation plays once and stops.
 *
 * Dropped: Comment Extensions, Plain Text Extensions, every other Application
 * Extension, and every byte after the trailer. That last one is the important
 * one: appending a ZIP or a script after `0x3B` is the standard way to build a
 * polyglot, and every decoder in the world ignores it — which is exactly why it
 * is a good place to hide something for a *different* program to find.
 *
 * Returns `null` if the structure does not parse, which is itself a verdict:
 * a GIF this cannot walk is a GIF this will not serve.
 */
function walkGif(buffer: Buffer): GifWalk | null {
  if (buffer.length < 13) return null
  const sig = buffer.subarray(0, 6).toString('latin1')
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null

  const out: Buffer[] = []
  const width = buffer.readUInt16LE(6)
  const height = buffer.readUInt16LE(8)
  const packed = buffer[10]
  let p = 13

  // Header + logical screen descriptor.
  out.push(buffer.subarray(0, 13))

  // Global colour table, if the packed field says there is one.
  if (packed & 0x80) {
    const size = 3 * (1 << ((packed & 0x07) + 1))
    if (p + size > buffer.length) return null
    out.push(buffer.subarray(p, p + size))
    p += size
  }

  /** Read a chain of length-prefixed sub-blocks, returning the end offset. */
  const skipSubBlocks = (from: number): number => {
    let q = from
    while (q < buffer.length) {
      const len = buffer[q]
      if (len === 0) return q + 1
      q += 1 + len
    }
    return -1
  }

  let frames = 0
  let trailing = false

  while (p < buffer.length) {
    const marker = buffer[p]

    if (marker === 0x3b) {
      out.push(Buffer.from([0x3b]))
      trailing = p + 1 < buffer.length
      return { rebuilt: Buffer.concat(out), frames, width, height, trailing }
    }

    if (marker === 0x21) {
      // Extension. The label decides whether it is kept.
      const label = buffer[p + 1]
      const end = skipSubBlocks(p + 2)
      if (end === -1) return null
      const isGraphicControl = label === 0xf9
      const isNetscapeLoop =
        label === 0xff && buffer.subarray(p + 3, p + 14).toString('latin1').startsWith('NETSCAPE')
      if (isGraphicControl || isNetscapeLoop) out.push(buffer.subarray(p, end))
      // Comment (0xFE), Plain Text (0x01) and every other application
      // extension fall through and are simply not copied.
      p = end
      continue
    }

    if (marker === 0x2c) {
      // Image descriptor: 10 bytes, then an optional local colour table, then
      // the LZW minimum code size, then the pixel sub-blocks.
      if (p + 10 > buffer.length) return null
      const localPacked = buffer[p + 9]
      let q = p + 10
      if (localPacked & 0x80) q += 3 * (1 << ((localPacked & 0x07) + 1))
      if (q + 1 > buffer.length) return null
      q += 1 // LZW minimum code size
      const end = skipSubBlocks(q)
      if (end === -1) return null
      out.push(buffer.subarray(p, end))
      frames++
      p = end
      continue
    }

    // Anything else at block level is not a GIF this understands.
    return null
  }

  // Ran off the end without a trailer. Salvageable — append one — but only
  // because a truncated animation is common and harmless; the frames that did
  // parse are real.
  if (frames === 0) return null
  out.push(Buffer.from([0x3b]))
  return { rebuilt: Buffer.concat(out), frames, width, height, trailing }
}

/* -------------------------------------------------------------------------- */
/*  PNG structural scrub                                                      */
/* -------------------------------------------------------------------------- */

/** Chunks an APNG needs. Everything else — text, EXIF, private — is dropped. */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'gAMA', 'acTL', 'fcTL', 'fdAT', 'IDAT', 'IEND'])

/**
 * Rebuild a PNG from its structural chunks only.
 *
 * Same idea as `walkGif`: chunk lengths are declared, so the file can be walked
 * exactly, and anything after `IEND` is dropped. `eXIf`, `tEXt`, `iTXt`, `zTXt`
 * and every private chunk are simply not copied — which is where the GPS
 * coordinates in a photo live.
 */
function scrubPng(buffer: Buffer): { rebuilt: Buffer; trailing: boolean } | null {
  if (buffer.length < 8) return null
  const sigOk = buffer[0] === 0x89 && buffer.subarray(1, 4).toString('latin1') === 'PNG'
  if (!sigOk) return null

  const out: Buffer[] = [buffer.subarray(0, 8)]
  let p = 8
  let sawEnd = false

  while (p + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(p)
    const type = buffer.subarray(p + 4, p + 8).toString('latin1')
    const total = 12 + length // length + type + data + crc
    if (length > buffer.length || p + total > buffer.length) return null
    if (PNG_KEEP.has(type)) out.push(buffer.subarray(p, p + total))
    p += total
    if (type === 'IEND') {
      sawEnd = true
      break
    }
  }

  if (!sawEnd) return null
  return { rebuilt: Buffer.concat(out), trailing: p < buffer.length }
}

/* -------------------------------------------------------------------------- */
/*  The pipeline                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Decode to pixels and write a fresh file.
 *
 * `nativeImage.createFromBuffer` returning an empty image is how Chromium says
 * "I could not decode that", and it is the single most valuable signal in this
 * file: a malformed or hostile file fails here, before anything renders it.
 *
 * PNG out, except for JPEG sources big enough that PNG would balloon them —
 * a photograph re-encoded as PNG can be five times its original size, and these
 * end up as base64 data URIs inside an HTML string.
 */
function reEncodeStill(buffer: Buffer, kind: ImageKind): ScanOutcome {
  const image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty()) {
    return { ok: false, reason: 'undecodable', width: 0, height: 0 }
  }
  const size = image.getSize()
  if (size.width * size.height > MAX_PIXELS) {
    return { ok: false, reason: 'tooLarge', width: size.width, height: size.height }
  }

  const asJpeg = kind === 'jpeg' && buffer.length > JPEG_REENCODE_THRESHOLD
  const data = asJpeg ? image.toJPEG(JPEG_QUALITY) : image.toPNG()
  if (data.length === 0) {
    return { ok: false, reason: 'undecodable', detail: 're-encode produced nothing', width: 0, height: 0 }
  }
  if (data.length > MAX_OUTPUT_BYTES) {
    return { ok: false, reason: 'tooLarge', width: size.width, height: size.height }
  }

  /*
   * "Is every pixel transparent?" — one of the two conclusive tracking signals,
   * and only answerable here, where the raw bitmap exists.
   *
   * Sampled rather than walked in full: a 4000x3000 photo is 48MB of RGBA and
   * scanning all of it to answer a question about newsletters is not a trade
   * worth making. Tracking pixels are tiny, so the small-image case — the one
   * that matters — is exact.
   */
  let fullyTransparent = false
  if (size.width * size.height <= 4096) {
    const bitmap = image.toBitmap()
    fullyTransparent = bitmap.length >= 4
    for (let i = 3; i < bitmap.length; i += 4) {
      if (bitmap[i] !== 0) {
        fullyTransparent = false
        break
      }
    }
  }

  return {
    ok: true,
    data,
    mime: asJpeg ? 'image/jpeg' : 'image/png',
    width: size.width,
    height: size.height,
    fullyTransparent,
  }
}

/**
 * Everything between "bytes arrived" and "safe to render".
 *
 * `declaredMime` is the server's claim. It is compared with the sniffed type
 * and then never used again.
 */
export function scanAndReEncode(buffer: Buffer, declaredMime: string): ScanOutcome {
  if (buffer.length === 0) return { ok: false, reason: 'notAnImage', width: 0, height: 0 }

  const kind = sniff(buffer)
  if (kind === 'svg') {
    return {
      ok: false,
      reason: 'scriptableFormat',
      detail: 'SVG',
      width: 0,
      height: 0,
    }
  }
  if (kind === 'unknown') {
    return { ok: false, reason: 'notAnImage', width: 0, height: 0 }
  }
  if (!typeAgrees(declaredMime, kind)) {
    return {
      ok: false,
      reason: 'typeMismatch',
      detail: `declared ${declaredMime}, bytes are ${kind}`,
      width: 0,
      height: 0,
    }
  }

  if (!isAnimated(buffer, kind)) return reEncodeStill(buffer, kind)

  /*
   * Animated: keep the frames, drop everything that is not one.
   *
   * WebP is the exception and is refused rather than scrubbed. Its RIFF
   * container can hold an arbitrary set of chunks and writing a correct
   * animated-WebP rebuilder is a much larger piece of work than this round can
   * verify — and an unverified scrubber is worse than none, because it looks
   * like protection. An animated WebP therefore falls back to a still frame,
   * which `reEncodeStill` produces safely.
   */
  if (kind === 'gif') {
    const walked = walkGif(buffer)
    if (walked === null) return { ok: false, reason: 'undecodable', detail: 'GIF structure', width: 0, height: 0 }
    if (walked.rebuilt.length > MAX_OUTPUT_BYTES) {
      return { ok: false, reason: 'tooLarge', width: walked.width, height: walked.height }
    }
    return {
      ok: true,
      data: walked.rebuilt,
      mime: 'image/gif',
      width: walked.width,
      height: walked.height,
    }
  }

  if (kind === 'png') {
    const scrubbed = scrubPng(buffer)
    if (scrubbed === null) return { ok: false, reason: 'undecodable', detail: 'PNG structure', width: 0, height: 0 }
    if (scrubbed.rebuilt.length > MAX_OUTPUT_BYTES) {
      return { ok: false, reason: 'tooLarge', width: 0, height: 0 }
    }
    // Dimensions come off the IHDR, which `scrubPng` has already validated.
    const width = scrubbed.rebuilt.readUInt32BE(16)
    const height = scrubbed.rebuilt.readUInt32BE(20)
    if (width * height > MAX_PIXELS) return { ok: false, reason: 'tooLarge', width, height }
    return { ok: true, data: scrubbed.rebuilt, mime: 'image/png', width, height }
  }

  return reEncodeStill(buffer, kind)
}

/**
 * The whole verdict for one URL, from raw bytes to something the renderer can
 * splice — scan, re-encode, classify, and encode as a data URI.
 */
export function processImage(url: string, buffer: Buffer, declaredMime: string): ProxiedImage {
  const scan = scanAndReEncode(buffer, declaredMime)
  if (!scan.ok || !scan.data || !scan.mime) {
    return {
      dataUri: null,
      status: 'blocked',
      reason: scan.reason ?? 'notAnImage',
      detail: scan.detail,
      tracker: false,
      trackerRules: [],
      width: scan.width,
      height: scan.height,
      bytes: 0,
      fromCache: false,
    }
  }

  const verdict = classifyTracker({
    url,
    width: scan.width,
    height: scan.height,
    fullyTransparent: scan.fullyTransparent,
  })

  return {
    dataUri: `data:${scan.mime};base64,${scan.data.toString('base64')}`,
    status: 'ok',
    tracker: verdict.tracker,
    trackerRules: verdict.rules,
    width: scan.width,
    height: scan.height,
    bytes: scan.data.length,
    fromCache: false,
  }
}
