/**
 * Bulk contact import.
 *
 * Two entry points feed the same `buildContactImport`: a CSV picked off disk
 * on desktop (`parseContactsCsv`), and one contact at a time off Android's
 * system picker (`ContactsView.tsx`, via `bridge.pickContact`). Both end up
 * as plain `{ name, address, tags?, note? }` rows so the dedup/validation
 * rules — and the summary the user sees before anything is written — are
 * identical on both platforms rather than two parallel implementations that
 * could quietly drift apart.
 */

import { isValidAddress } from './validate'
import { newId, type Contact } from './types'

export interface ParsedContactRow {
  /** 1-based source line, header excluded. Used only for the skip summary. */
  line: number
  name: string
  address: string
  tags: string[]
  note?: string
}

export type ContactSkipReason =
  | 'no-address'
  | 'invalid-address'
  | 'duplicate-in-file'
  | 'duplicate-existing'

export interface SkippedContactRow {
  line: number
  raw: string
  reason: ContactSkipReason
}

export interface ContactImportResult {
  toAdd: Contact[]
  skipped: SkippedContactRow[]
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/**
 * Split one CSV line into fields, honouring double-quoted fields that may
 * contain commas or an escaped `""`.
 *
 * A hand-rolled parser rather than a library: the format this reads is one
 * row of plain fields, nothing nested, nothing multi-line — every real
 * contacts export (Gmail, Outlook, a spreadsheet saved as CSV) fits this,
 * and pulling in a dependency for it would be a lot of code for the one
 * quoting rule RFC 4180 actually adds over splitting on commas.
 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      fields.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  fields.push(cur)
  return fields.map((f) => f.trim())
}

const NAME_HEADERS = new Set(['name', 'full name', 'fullname', 'contact name', 'contact', '姓名', '名前'])
const ADDRESS_HEADERS = new Set(['email', 'e-mail', 'address', 'email address', 'mail', '邮箱', '邮件', '邮件地址'])
const TAGS_HEADERS = new Set(['tags', 'tag', 'group', 'groups', 'label', 'labels', '标签'])
const NOTE_HEADERS = new Set(['note', 'notes', 'comment', 'comments', '备注'])

/**
 * Parse CSV text into rows, `name,email` at minimum.
 *
 * The header row is matched by column *name*, not position — `email,name`
 * and `name,email` both work, and so does a header that only names the email
 * column ("that other column must be the name"). A file with no recognisable
 * header at all falls back to position (column 0 = name, column 1 = email)
 * rather than being refused outright, because a spreadsheet saved without
 * headers is a perfectly ordinary CSV.
 */
export function parseContactsCsv(text: string): { rows: ParsedContactRow[]; malformed: number[] } {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) return { rows: [], malformed: [] }

  const firstFields = splitCsvLine(lines[0]).map((f) => f.toLowerCase())
  let nameCol = firstFields.findIndex((f) => NAME_HEADERS.has(f))
  let addressCol = firstFields.findIndex((f) => ADDRESS_HEADERS.has(f))
  const tagsCol = firstFields.findIndex((f) => TAGS_HEADERS.has(f))
  const noteCol = firstFields.findIndex((f) => NOTE_HEADERS.has(f))
  const hasHeader = nameCol !== -1 || addressCol !== -1

  let startLine = 0
  if (hasHeader) {
    startLine = 1
    if (addressCol === -1) {
      // A header that names a "name" column but nothing recognisable for the
      // address: take whichever other column exists rather than refusing the
      // whole file over one unfamiliar header word.
      addressCol = firstFields.findIndex((_, i) => i !== nameCol)
    }
  } else {
    nameCol = 0
    addressCol = 1
  }

  const rows: ParsedContactRow[] = []
  const malformed: number[] = []
  for (let i = startLine; i < lines.length; i++) {
    const fields = splitCsvLine(lines[i])
    const address = (addressCol >= 0 ? fields[addressCol] : '') ?? ''
    const name = (nameCol >= 0 ? fields[nameCol] : '') ?? ''
    if (!address && !name) {
      malformed.push(i + 1)
      continue
    }
    const tags =
      tagsCol >= 0
        ? (fields[tagsCol] ?? '')
            .split(/[;,]/)
            .map((s) => s.trim())
            .filter(Boolean)
        : []
    const note = noteCol >= 0 ? fields[noteCol]?.trim() : undefined
    rows.push({ line: i + 1, name: name.trim(), address: address.trim(), tags, note: note || undefined })
  }
  return { rows, malformed }
}

// ---------------------------------------------------------------------------
// Validate + dedup, shared by CSV and the Android picker
// ---------------------------------------------------------------------------

/**
 * Turn parsed rows into contacts ready to save, plus what got skipped and
 * why — dedup is address-only, case-insensitively, against both the address
 * book already on this device and every earlier row in the same batch. A
 * name typo is not this function's problem; an address either already
 * belongs to a contact or it doesn't, same as `dedupeAddresses` elsewhere in
 * the app.
 */
export function buildContactImport(
  rows: ParsedContactRow[],
  existing: Contact[],
  now: number = Date.now(),
): ContactImportResult {
  const existingAddresses = new Set(existing.map((c) => c.address.toLowerCase()))
  const seenInBatch = new Set<string>()
  const toAdd: Contact[] = []
  const skipped: SkippedContactRow[] = []

  for (const row of rows) {
    const raw = row.name ? `${row.name} <${row.address}>` : row.address
    if (!row.address) {
      skipped.push({ line: row.line, raw, reason: 'no-address' })
      continue
    }
    if (!isValidAddress(row.address)) {
      skipped.push({ line: row.line, raw, reason: 'invalid-address' })
      continue
    }
    const key = row.address.toLowerCase()
    if (existingAddresses.has(key)) {
      skipped.push({ line: row.line, raw, reason: 'duplicate-existing' })
      continue
    }
    if (seenInBatch.has(key)) {
      skipped.push({ line: row.line, raw, reason: 'duplicate-in-file' })
      continue
    }
    seenInBatch.add(key)
    toAdd.push({
      id: newId('c'),
      name: row.name,
      address: row.address,
      tags: row.tags,
      note: row.note,
      createdAt: now,
    })
  }

  return { toAdd, skipped }
}
