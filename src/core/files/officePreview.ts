/**
 * Word and Excel attachments, previewed in place — with no parser dependency.
 *
 * A .docx or .xlsx is a ZIP of XML, and a *preview* needs exactly two things
 * out of it: the words, in order, and — for a workbook — which cell they sat
 * in. So this reads the ZIP by hand (the format's central directory is a page
 * of arithmetic), inflates entries through the engine's own
 * `DecompressionStream('deflate-raw')`, and pulls text with anchored regexes
 * over the two files that carry it. Not a renderer: styles, images, charts
 * and formulas do not survive, and the preview does not pretend otherwise —
 * it is the difference between "see what the file says" and a click that
 * hands a reader's machine to another program.
 *
 * Where `DecompressionStream` lacks `deflate-raw` (WebViews older than
 * Chromium 103 — the minSdk floor allows them), `canPreviewOffice()` says no
 * and the caller keeps the behaviour every office attachment had before: the
 * OS opens it. Feature-tested, never version-sniffed.
 *
 * Regexes over XML are usually the wrong tool; they are used here *because*
 * this must also run under Node for `check-office-preview.mjs`, which has no
 * DOMParser — and because OOXML's word/sheet markup is machine-written with
 * fixed prefixes, which is the one dialect regexes survive. The fallback for
 * a file they misread is the fallback for everything else: the OS handler.
 */

// --- the zip ---------------------------------------------------------------

interface ZipEntry {
  name: string
  method: number
  start: number
  size: number
}

const u16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8)
const u32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 0x1000000

/** The central directory, or a throw for anything that is not a zip. */
function zipEntries(bytes: Uint8Array): ZipEntry[] {
  // The end-of-central-directory record sits at the tail, behind a comment of
  // up to 64k — scanned backwards for its signature.
  let eocd = -1
  for (let i = bytes.length - 22, floor = Math.max(0, bytes.length - 65557); i >= floor; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip archive')
  const count = u16(bytes, eocd + 10)
  let off = u32(bytes, eocd + 16)
  const entries: ZipEntry[] = []
  const dec = new TextDecoder()
  for (let n = 0; n < count; n++) {
    if (u32(bytes, off) !== 0x02014b50) break
    const method = u16(bytes, off + 10)
    const size = u32(bytes, off + 20)
    const nameLen = u16(bytes, off + 28)
    const extraLen = u16(bytes, off + 30)
    const commentLen = u16(bytes, off + 32)
    const local = u32(bytes, off + 42)
    const name = dec.decode(bytes.subarray(off + 46, off + 46 + nameLen))
    // The local header repeats the name/extra lengths and may disagree with
    // the central copy; the data starts after the *local* ones.
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28)
    entries.push({ name, method, start, size })
    off += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

async function entryText(bytes: Uint8Array, entry: ZipEntry): Promise<string> {
  const comp = bytes.subarray(entry.start, entry.start + entry.size)
  if (entry.method === 0) return new TextDecoder().decode(comp)
  if (entry.method !== 8) throw new Error(`zip method ${entry.method}`)
  const stream = new Blob([comp.slice().buffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Response(stream).text()
}

// --- the words -------------------------------------------------------------

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** XML character entities back to characters — the inverse of what the writer did. */
function unxml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Which office preview a filename gets, if any. */
export function officeKind(name: string): 'docx' | 'xlsx' | null {
  if (/\.docx$/i.test(name)) return 'docx'
  if (/\.xlsx$/i.test(name)) return 'xlsx'
  return null
}

/** Whether this engine can inflate a zip at all. */
export function canPreviewOffice(): boolean {
  try {
    new DecompressionStream('deflate-raw')
    return true
  } catch {
    return false
  }
}

const PARAGRAPH_CAP = 2000
const ROW_CAP = 500
const COL_CAP = 64

function docxBody(xml: string): string {
  const paragraphs: string[] = []
  for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
    const runs = [...p.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => unxml(m[1]))
    const line = runs.join('')
    if (line.trim()) paragraphs.push(`<p>${esc(line)}</p>`)
    if (paragraphs.length >= PARAGRAPH_CAP) {
      paragraphs.push('<p>…</p>')
      break
    }
  }
  return paragraphs.join('\n')
}

/** Column letters to a zero-based index — `A` 0, `AA` 26. */
function colIndex(ref: string): number {
  let n = 0
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64)
  return Math.max(0, n - 1)
}

function xlsxBody(sheetXml: string, shared: string[]): string {
  const rows: string[] = []
  for (const row of sheetXml.match(/<row[ >][\s\S]*?<\/row>/g) ?? []) {
    const cells: string[] = []
    for (const m of row.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = m[1]
      const inner = m[2] ?? ''
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1]
      const idx = ref ? colIndex(ref) : cells.length
      if (idx >= COL_CAP) continue
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? /<t(?: [^>]*)?>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? ''
      const isShared = /t="s"/.test(attrs)
      const value = isShared ? (shared[Number(v)] ?? '') : unxml(v)
      while (cells.length < idx) cells.push('')
      cells[idx] = value
    }
    rows.push(`<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    if (rows.length >= ROW_CAP) {
      rows.push('<tr><td>…</td></tr>')
      break
    }
  }
  return `<table>${rows.join('\n')}</table>`
}

/**
 * The file as preview markup, or `null` for one this cannot honestly show.
 *
 * `null`, not a throw, is the contract with the caller: the next move is
 * always the same — hand the file to the OS, exactly as before this existed.
 */
export async function officeHtml(name: string, bytes: Uint8Array): Promise<string | null> {
  const kind = officeKind(name)
  if (!kind || !canPreviewOffice()) return null
  let body: string
  try {
    const entries = zipEntries(bytes)
    const find = (re: RegExp) => entries.filter((e) => re.test(e.name)).sort((a, b) => (a.name < b.name ? -1 : 1))[0]
    if (kind === 'docx') {
      const doc = find(/^word\/document\.xml$/)
      if (!doc) return null
      body = docxBody(await entryText(bytes, doc))
    } else {
      const sheet = find(/^xl\/worksheets\/sheet\d+\.xml$/)
      if (!sheet) return null
      const sharedEntry = find(/^xl\/sharedStrings\.xml$/)
      const shared = sharedEntry
        ? ((await entryText(bytes, sharedEntry)).match(/<si>[\s\S]*?<\/si>/g) ?? []).map((si) =>
            [...si.matchAll(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join(''),
          )
        : []
      body = xlsxBody(await entryText(bytes, sheet), shared)
    }
  } catch {
    return null
  }
  if (!body.trim()) return null
  return [
    '<meta charset="utf-8">',
    '<style>',
    'body{font-family:system-ui,sans-serif;margin:16px;line-height:1.6;word-break:break-word}',
    'table{border-collapse:collapse}',
    'td{border:1px solid #ccc;padding:2px 8px;font-variant-numeric:tabular-nums}',
    'p{margin:0 0 .6em}',
    '</style>',
    body,
  ].join('\n')
}
