/**
 * A QR *decoder*, wrapping `jsqr` — the one runtime dependency this repo adds
 * for the whole sync feature, and worth explaining why here rather than
 * writing one from scratch the way `core/qr.ts` does for encoding.
 *
 * Encoding is arithmetic: version selection, Reed–Solomon codewords, a fixed
 * zig-zag walk — deterministic steps with one right answer, checked module for
 * module against a reference in `scripts/check-qr.mjs`. Decoding starts from a
 * camera frame: finder-pattern detection in noisy pixels, perspective
 * correction for a code held at an angle, then the same bit recovery in
 * reverse. That is a materially different, materially larger problem, and a
 * hand-rolled version of it would be the least-tested, least-obviously-correct
 * code in the app — exactly the part nobody wants to discover is subtly wrong
 * while standing between two phones trying to pair them. `jsqr` is ~10KB,
 * does no image processing, decoding, or *anything* over the network, and pulls
 * in nothing itself — it reads pixels the browser already handed this app
 * through `getUserMedia`. That is a better trade than the risk of getting
 * perspective correction wrong.
 *
 * Kept DOM-free on purpose: this module takes a raw pixel buffer, not a
 * `<video>` or `<canvas>` element, so `scripts/check-qr-decode.mjs` can call it
 * from plain Node — rasterising `core/qr.ts`'s own output into pixels — as
 * well as `components/PairingScanner.tsx` calling it from a browser canvas.
 */

import jsQR from 'jsqr'

/**
 * `null` when no QR code is found in the frame — the overwhelmingly common
 * case while a camera is still hunting for one, not an error.
 */
export function decodeQr(data: Uint8ClampedArray, width: number, height: number): string | null {
  const result = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' })
  return result?.data ?? null
}
