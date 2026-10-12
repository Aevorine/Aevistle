/**
 * Does the office preview read real .docx/.xlsx bytes? —
 * `npm run check:office-preview`.
 *
 * The fixtures are genuine ZIP archives built right here — local headers,
 * central directory, EOCD — one stored and one deflated, because the parser
 * under test walks that structure itself and a canned base64 blob would rot
 * the day the parser's arithmetic changed. CRCs are zero on purpose: the
 * reader does not check them, and asserting on bytes it ignores would be
 * asserting nothing.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

const failures = []
let checked = 0
const check = (what, ok) => {
  checked++
  if (!ok) {
    failures.push(what)
    console.log(`  FAIL  ${what}`)
  } else {
    console.log(`  ok    ${what}`)
  }
}

function makeZip(files, deflate) {
  const enc = new TextEncoder()
  const chunks = []
  const central = []
  let offset = 0
  for (const [name, content] of files) {
    const nameB = Buffer.from(enc.encode(name))
    const data = Buffer.from(enc.encode(content))
    const comp = deflate ? deflateRawSync(data) : data
    const method = deflate ? 8 : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameB.length, 26)
    chunks.push(local, nameB, comp)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(method, 10)
    cen.writeUInt32LE(comp.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameB.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameB)
    offset += 30 + nameB.length + comp.length
  }
  const cenBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cenBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...chunks, cenBuf, eocd]))
}

const out = mkdtempSync(join(tmpdir(), 'aevistle-office-'))
try {
  execFileSync(
    'npx',
    [
      'esbuild',
      `"${join(root, 'src/core/files/officePreview.ts')}"`,
      '--bundle',
      '--format=esm',
      '--platform=node',
      `--outfile="${join(out, 'op.mjs')}"`,
      '--log-level=warning',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], shell: true },
  )
  const { officeHtml, officeKind, canPreviewOffice } = await import(pathToFileURL(join(out, 'op.mjs')).href)

  check('this engine can inflate at all', canPreviewOffice() === true)
  check('kind detection: docx / xlsx / neither', officeKind('a.DOCX') === 'docx' && officeKind('b.xlsx') === 'xlsx' && officeKind('c.pdf') === null)

  const docx = makeZip(
    [
      [
        'word/document.xml',
        '<w:document><w:body>' +
          '<w:p><w:r><w:t>预算 &amp; 决算</w:t></w:r><w:r><w:t xml:space="preserve">（第二版）</w:t></w:r></w:p>' +
          '<w:p></w:p>' +
          '<w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>' +
          '</w:body></w:document>',
      ],
    ],
    true, // deflated, the way real writers store it
  )
  const dhtml = await officeHtml('report.docx', docx)
  check('a deflated docx yields its paragraphs', dhtml !== null)
  check('runs join inside one paragraph, entities decoded, output re-escaped', dhtml?.includes('<p>预算 &amp; 决算（第二版）</p>') === true)
  check('an empty paragraph is dropped, order kept', dhtml !== null && dhtml.indexOf('预算') < dhtml.indexOf('<p>Second paragraph</p>'))

  const xlsx = makeZip(
    [
      ['xl/sharedStrings.xml', '<sst><si><t>项目</t></si><si><t xml:space="preserve">金额</t><t>（元）</t></si></sst>'],
      [
        'xl/worksheets/sheet1.xml',
        '<worksheet><sheetData>' +
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2"><v>3847.56</v></c><c r="D2"><v>7</v></c></row>' +
          '</sheetData></worksheet>',
      ],
    ],
    false, // stored — method 0 is legal and some writers use it for small parts
  )
  const xhtml = await officeHtml('bill.xlsx', xlsx)
  check('a stored xlsx yields a table', xhtml !== null && xhtml.includes('<table>'))
  check('shared strings resolve, multi-run ones joined', xhtml?.includes('<td>金额（元）</td>') === true)
  check('an inline number survives as itself', xhtml?.includes('<td>3847.56</td>') === true)
  check('a skipped column leaves an empty cell, not a shifted row', xhtml?.includes('<td>项目</td><td>3847.56</td><td></td><td>7</td>') === true)

  check('bytes that are not a zip answer null, not a throw', (await officeHtml('x.docx', new Uint8Array([1, 2, 3]))) === null)
  check('a zip without its document answers null', (await officeHtml('x.docx', makeZip([['other.xml', '<a/>']], false))) === null)
  check('a name outside the two kinds answers null untouched', (await officeHtml('x.pdf', docx)) === null)
} finally {
  rmSync(out, { recursive: true, force: true })
}

const label = 'office attachments preview from their own words, or step aside honestly'
if (failures.length === 0) {
  console.log(`\n  ${label}\n  ${checked} checks\n\n  All clear.\n`)
  process.exit(0)
}
console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
process.exit(1)
