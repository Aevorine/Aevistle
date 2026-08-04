/**
 * A QR encoder, byte mode, error-correction level L, versions 1–20.
 *
 * Here rather than as a dependency because the only thing this app needs a QR
 * code for is "put this sign-in link on the phone next to the laptop", and the
 * smallest library that does it is a third-party package pulled into a product
 * whose whole pitch is no server, no telemetry, nothing phoning home. Six
 * hundred lines of well-understood, fully offline bit arithmetic is a better
 * trade than one more supply-chain edge for one button.
 *
 * Not trusted on inspection, though: `scripts/check-qr.mjs` re-encodes a corpus
 * of URLs with the reference implementation (`qrcode-generator`, a *dev*
 * dependency that never ships) and compares the two matrices module for module.
 * A QR encoder that is subtly wrong produces a picture that looks exactly like
 * a QR code and simply fails to scan, which is the kind of bug that is
 * discovered by a person standing in front of a login screen.
 *
 * Level L, not M: this encodes URLs, they get long, and L carries about 25%
 * more of them at a given size. The code is displayed on a clean screen at
 * generous size rather than printed on a box, so the redundancy that L gives up
 * is redundancy against damage that never happens here.
 */

/** Total data codewords, then the block layout, per version at level L. */
interface VersionSpec {
  /** EC codewords per block. */
  ecPerBlock: number
  /** [blockCount, dataCodewordsPerBlock] for each of the one or two groups. */
  groups: Array<[number, number]>
}

const VERSIONS: VersionSpec[] = [
  { ecPerBlock: 7, groups: [[1, 19]] },
  { ecPerBlock: 10, groups: [[1, 34]] },
  { ecPerBlock: 15, groups: [[1, 55]] },
  { ecPerBlock: 20, groups: [[1, 80]] },
  { ecPerBlock: 26, groups: [[1, 108]] },
  { ecPerBlock: 18, groups: [[2, 68]] },
  { ecPerBlock: 20, groups: [[2, 78]] },
  { ecPerBlock: 24, groups: [[2, 97]] },
  { ecPerBlock: 30, groups: [[2, 116]] },
  { ecPerBlock: 18, groups: [[2, 68], [2, 69]] },
  { ecPerBlock: 20, groups: [[4, 81]] },
  { ecPerBlock: 24, groups: [[2, 92], [2, 93]] },
  { ecPerBlock: 26, groups: [[4, 107]] },
  { ecPerBlock: 30, groups: [[3, 115], [1, 116]] },
  { ecPerBlock: 22, groups: [[5, 87], [1, 88]] },
  { ecPerBlock: 24, groups: [[5, 98], [1, 99]] },
  { ecPerBlock: 28, groups: [[1, 107], [5, 108]] },
  { ecPerBlock: 30, groups: [[5, 120], [1, 121]] },
  { ecPerBlock: 28, groups: [[3, 113], [4, 114]] },
  { ecPerBlock: 28, groups: [[3, 107], [5, 108]] },
]

/** Alignment-pattern centre coordinates, indexed by version - 1. */
const ALIGNMENT: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54],
  [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
  [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86],
  [6, 34, 62, 90],
]

// --- GF(256), primitive polynomial 0x11D -----------------------------------

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

/** Generator polynomial for `degree` error-correction codewords. */
function generatorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1])
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

function reedSolomon(data: Uint8Array, ecLength: number): Uint8Array {
  const gen = generatorPoly(ecLength)
  const out = new Uint8Array(ecLength)
  for (const byte of data) {
    const factor = byte ^ out[0]
    out.copyWithin(0, 1)
    out[ecLength - 1] = 0
    if (factor !== 0) {
      for (let i = 0; i < ecLength; i++) out[i] ^= gfMul(gen[i + 1], factor)
    }
  }
  return out
}

// --- bit buffer -------------------------------------------------------------

class Bits {
  private readonly bytes: number[] = []
  private length = 0

  push(value: number, width: number): void {
    for (let i = width - 1; i >= 0; i--) {
      const bit = (value >>> i) & 1
      const index = this.length >>> 3
      if (this.bytes.length <= index) this.bytes.push(0)
      if (bit) this.bytes[index] |= 0x80 >>> (this.length & 7)
      this.length++
    }
  }

  get bitLength(): number {
    return this.length
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }
}

// --- encoding ---------------------------------------------------------------

/** UTF-8 bytes; QR byte mode is nominally Latin-1 but every scanner reads UTF-8. */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function charCountBits(version: number): number {
  return version < 10 ? 8 : 16
}

function totalDataCodewords(spec: VersionSpec): number {
  return spec.groups.reduce((sum, [count, size]) => sum + count * size, 0)
}

function pickVersion(byteLength: number): number {
  for (let version = 1; version <= VERSIONS.length; version++) {
    const spec = VERSIONS[version - 1]
    const capacityBits = totalDataCodewords(spec) * 8
    const needed = 4 + charCountBits(version) + byteLength * 8
    if (needed <= capacityBits) return version
  }
  return 0
}

/** Data codewords, then EC codewords, interleaved as the spec requires. */
function buildCodewords(data: Uint8Array, version: number): Uint8Array {
  const spec = VERSIONS[version - 1]
  const bits = new Bits()
  bits.push(0b0100, 4)
  bits.push(data.length, charCountBits(version))
  for (const byte of data) bits.push(byte, 8)

  const target = totalDataCodewords(spec)
  const capacityBits = target * 8
  /* Terminator: up to four zero bits, fewer if the buffer is nearly full. */
  bits.push(0, Math.min(4, capacityBits - bits.bitLength))
  /* Pad to a whole codeword, then alternate the two specified pad bytes. */
  if (bits.bitLength % 8 !== 0) bits.push(0, 8 - (bits.bitLength % 8))
  const raw = Array.from(bits.toBytes())
  for (let i = 0; raw.length < target; i++) raw.push(i % 2 === 0 ? 0xec : 0x11)
  const dataCodewords = Uint8Array.from(raw)

  const blocks: Uint8Array[] = []
  const ecBlocks: Uint8Array[] = []
  let offset = 0
  for (const [count, size] of spec.groups) {
    for (let i = 0; i < count; i++) {
      const block = dataCodewords.slice(offset, offset + size)
      offset += size
      blocks.push(block)
      ecBlocks.push(reedSolomon(block, spec.ecPerBlock))
    }
  }

  const out: number[] = []
  const maxData = Math.max(...blocks.map((b) => b.length))
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) if (i < block.length) out.push(block[i])
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i])
  }
  return Uint8Array.from(out)
}

// --- matrix -----------------------------------------------------------------

type Matrix = Int8Array[]

function blankMatrix(size: number): Matrix {
  return Array.from({ length: size }, () => new Int8Array(size).fill(-1))
}

function placeFinder(m: Matrix, row: number, col: number): void {
  const size = m.length
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const y = row + r
      const x = col + c
      if (y < 0 || y >= size || x < 0 || x >= size) continue
      const onRing = r === 0 || r === 6 || c === 0 || c === 6
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4
      const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6
      m[y][x] = inside && (onRing || inCore) ? 1 : 0
    }
  }
}

function placeFunctionPatterns(m: Matrix, version: number): void {
  const size = m.length
  placeFinder(m, 0, 0)
  placeFinder(m, 0, size - 7)
  placeFinder(m, size - 7, 0)

  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0
    m[6][i] = bit
    m[i][6] = bit
  }

  const centres = ALIGNMENT[version - 1]
  for (const r of centres) {
    for (const c of centres) {
      /* The three corners already hold finder patterns. */
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc))
          m[r + dr][c + dc] = ring === 1 ? 0 : 1
        }
      }
    }
  }

  /* Always-dark module, and the format-info area reserved as non-data. */
  m[size - 8][8] = 1
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === -1) m[8][i] = 0
    if (m[i][8] === -1) m[i][8] = 0
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === -1) m[8][size - 1 - i] = 0
    if (m[size - 1 - i][8] === -1) m[size - 1 - i][8] = 0
  }

  if (version >= 7) {
    const bits = versionBits(version)
    for (let i = 0; i < 18; i++) {
      const bit = (bits >> i) & 1
      m[Math.floor(i / 3)][size - 11 + (i % 3)] = bit
      m[size - 11 + (i % 3)][Math.floor(i / 3)] = bit
    }
  }
}

/** BCH(18,6) over the version number, as the spec's version-information block. */
function versionBits(version: number): number {
  let value = version << 12
  for (let i = 0; i < 6; i++) {
    if (value & (1 << (17 - i))) value ^= 0x1f25 << (5 - i)
  }
  return (version << 12) | value
}

/** BCH(15,5) plus the fixed mask, for level L (`01`) and the chosen mask. */
function formatBits(mask: number): number {
  const data = (0b01 << 3) | mask
  let value = data << 10
  for (let i = 0; i < 5; i++) {
    if (value & (1 << (14 - i))) value ^= 0x537 << (4 - i)
  }
  return ((data << 10) | value) ^ 0x5412
}

function placeFormat(m: Matrix, mask: number): void {
  const size = m.length
  const bits = formatBits(mask)
  for (let i = 0; i < 15; i++) {
    const bit = (bits >> i) & 1
    /* Copy one: down the left column and along the top row, skipping timing. */
    if (i < 6) m[i][8] = bit
    else if (i < 8) m[i + 1][8] = bit
    else if (i === 8) m[8][7] = bit
    else m[8][14 - i] = bit
    /* Copy two: the duplicate pair beside the other two finders. */
    if (i < 8) m[8][size - 1 - i] = bit
    else m[size - 15 + i][8] = bit
  }
  m[size - 8][8] = 1
}

const MASKS: Array<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

/** Zig-zag placement, right to left in column pairs, skipping the timing column. */
function placeData(m: Matrix, codewords: Uint8Array, mask: number): void {
  const size = m.length
  let bitIndex = 0
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step
      for (let offset = 0; offset < 2; offset++) {
        const col = right - offset
        if (m[row][col] !== -1) continue
        const byte = codewords[bitIndex >>> 3]
        const bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex & 7))) & 1
        bitIndex++
        m[row][col] = MASKS[mask](row, col) ? bit ^ 1 : bit
      }
    }
    upward = !upward
  }
}

function penalty(m: Matrix): number {
  const size = m.length
  let score = 0

  // Rule 1 — runs of five or more identical modules, per row and per column.
  for (let i = 0; i < size; i++) {
    for (const readRow of [true, false]) {
      let run = 1
      let prev = readRow ? m[i][0] : m[0][i]
      for (let j = 1; j < size; j++) {
        const value = readRow ? m[i][j] : m[j][i]
        if (value === prev) {
          run++
        } else {
          if (run >= 5) score += run - 2
          run = 1
          prev = value
        }
      }
      if (run >= 5) score += run - 2
    }
  }

  // Rule 2 — every 2×2 block of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c]
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3
    }
  }

  // Rule 3 — the finder-like 1:1:3:1:1 sequence with four light modules beside it.
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (c + 11 <= size) {
        let a = true
        let b = true
        for (let k = 0; k < 11; k++) {
          if (m[r][c + k] !== A[k]) a = false
          if (m[r][c + k] !== B[k]) b = false
        }
        if (a || b) score += 40
      }
      if (r + 11 <= size) {
        let a = true
        let b = true
        for (let k = 0; k < 11; k++) {
          if (m[r + k][c] !== A[k]) a = false
          if (m[r + k][c] !== B[k]) b = false
        }
        if (a || b) score += 40
      }
    }
  }

  // Rule 4 — deviation from an even split of dark and light.
  let dark = 0
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c] === 1) dark++
  const ratio = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10

  return score
}

export interface QrCode {
  size: number
  /** Row-major, `true` for a dark module. */
  modules: boolean[][]
  version: number
}

/**
 * `null` when the text is longer than version 20 at level L can carry (~858 bytes).
 *
 * `mask` exists for `scripts/check-qr.mjs`, which proves this encoder correct by
 * showing that one of its eight masked matrices is identical, module for module,
 * to the reference implementation's output. Comparing only the *chosen* mask
 * would test the penalty function rather than the encoder — two encoders can
 * disagree about which mask reads best and both still be right.
 */
export function encodeQr(text: string, opts: { mask?: number } = {}): QrCode | null {
  const data = utf8(text)
  const version = pickVersion(data.length)
  if (version === 0) return null

  const codewords = buildCodewords(data, version)
  const size = 17 + version * 4

  const render = (mask: number): Matrix => {
    const m = blankMatrix(size)
    placeFunctionPatterns(m, version)
    /* Format modules are written after masking; `placeFunctionPatterns` has
       already claimed them as non-data so they cannot take data bits. */
    placeData(m, codewords, mask)
    placeFormat(m, mask)
    return m
  }

  let best: Matrix | null = null
  if (opts.mask !== undefined) {
    best = render(opts.mask)
  } else {
    let bestScore = Infinity
    for (let mask = 0; mask < 8; mask++) {
      const m = render(mask)
      const score = penalty(m)
      if (score < bestScore) {
        bestScore = score
        best = m
      }
    }
  }
  if (!best) return null

  return {
    size,
    version,
    modules: best.map((row) => Array.from(row, (v) => v === 1)),
  }
}

/**
 * The dark modules as one SVG path, offset by the quiet zone.
 *
 * One path of rectangles rather than a `<rect>` per module: a version-18 code
 * is nearly eight thousand modules, and that many DOM nodes inside a dialog is
 * a visible hitch on the phone this feature exists to serve.
 *
 * `quietZone` defaults to the specified four modules. It is not decoration —
 * a QR code butted against a card border is measurably harder for a camera to
 * lock onto, which presents as "it just doesn't scan" rather than as an error.
 */
export function qrPath(qr: QrCode, quietZone = 4): string {
  let path = ''
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r][c]) path += `M${c + quietZone} ${r + quietZone}h1v1h-1z`
    }
  }
  return path
}

/** The whole code as a standalone SVG document — used for export and by `check:qr`. */
export function qrToSvg(qr: QrCode, opts: { quietZone?: number } = {}): string {
  const quiet = opts.quietZone ?? 4
  const span = qr.size + quiet * 2
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges">` +
    `<rect width="${span}" height="${span}" fill="#fff"/>` +
    `<path d="${qrPath(qr, quiet)}" fill="#000"/>` +
    `</svg>`
  )
}
