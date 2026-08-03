/*
 * Proof that the two-typeface split survives the production build.
 *
 * Why this exists as a browser script rather than a unit test: the thing that
 * can break is not the CSS we write, it is the CSS that ships. Minification
 * strips the quotes out of `local("Times New Roman")`, and whether the engine
 * still resolves the bare form is a property of the engine, not of the source.
 * The only honest check is to render glyphs in the built bundle and look at
 * the pixels.
 *
 * How to run:
 *   npm run build:web
 *   npx vite preview --host 127.0.0.1 --port 5310 --strictPort
 *   then paste the function below into DevTools on http://127.0.0.1:5310/
 *   (or evaluate it through CDP / Playwright) and read the verdicts.
 *
 * What it asserts, per the brief: Han characters and full-width punctuation
 * come from 宋体; Latin, digits and Western punctuation come from Times New
 * Roman. Both are checked against foils, because "matches the font we wanted"
 * means nothing unless it also fails to match the fonts we did not.
 *
 * Method note — this is the part that bit us. The first version hashed the
 * absolute indices of inked pixels, so an identical glyph drawn one pixel to
 * the left scored as a different font, and it reported 宋体 as a miss while
 * 宋体 was exactly what was rendering. Glyphs are therefore cropped to their
 * ink bounding box before comparison. Pixel *count* alone is not enough
 * either: it is a weak fingerprint that different faces can collide on.
 */

async function proveFonts() {
  await document.fonts.ready
  const stack = getComputedStyle(document.body).fontFamily

  const bitmap = (text, font, size = 96) => {
    const canvas = document.createElement('canvas')
    canvas.width = size * (text.length + 2)
    canvas.height = size * 2
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#000'
    ctx.font = `${size}px ${font}`
    ctx.textBaseline = 'middle'
    ctx.fillText(text, size / 2, canvas.height / 2)

    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let x0 = canvas.width, y0 = canvas.height, x1 = -1, y1 = -1
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if (img.data[(y * canvas.width + x) * 4] < 200) {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
    }
    if (x1 < 0) return null

    const w = x1 - x0 + 1
    const h = y1 - y0 + 1
    const cells = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        cells[y * w + x] = img.data[((y + y0) * canvas.width + (x + x0)) * 4] < 200 ? 1 : 0
      }
    }
    return { w, h, cells }
  }

  // Scored rather than demanded exactly: two rasterisations of the same face
  // can disagree by a hair of antialiasing.
  const agreement = (a, b) => {
    if (!a || !b || a.w !== b.w || a.h !== b.h) return 0
    let same = 0
    for (let i = 0; i < a.cells.length; i++) if (a.cells[i] === b.cells[i]) same++
    return Math.round((same / a.cells.length) * 1000) / 10
  }

  const check = (samples, expected, foils) =>
    samples.map((sample) => {
      const rendered = bitmap(sample, stack)
      const vsExpected = agreement(rendered, bitmap(sample, expected))
      const vsFoils = foils.map((f) => [f, agreement(rendered, bitmap(sample, f))])
      return {
        sample,
        expected,
        vsExpected: `${vsExpected}%`,
        vsFoils: vsFoils.map(([f, v]) => `${f}:${v}%`).join('  '),
        verdict: vsExpected >= 99 && vsFoils.every(([, v]) => v < 95) ? 'PASS' : 'FAIL',
      }
    })

  const rows = [
    ...check(['界', '面', '设'], '"SimSun"', ['"Microsoft YaHei"', '"KaiTi"', '"FangSong"']),
    ...check(['，。、；：'], '"SimSun"', ['"Microsoft YaHei"', '"KaiTi"']),
    ...check(
      ['Aevistle', 'Schedule 09:30', 'Reminder, sent.'],
      '"Times New Roman"',
      ['"Arial"', '"Segoe UI"', '"Georgia"'],
    ),
    ...check(['.,;:!?()"'], '"Times New Roman"', ['"Arial"', '"Segoe UI"']),
  ]

  console.table(rows)
  const failed = rows.filter((r) => r.verdict === 'FAIL')
  console.log(
    failed.length === 0
      ? `all ${rows.length} samples PASS — stack: ${stack}`
      : `${failed.length}/${rows.length} FAILED`,
  )
  return rows
}

proveFonts()
