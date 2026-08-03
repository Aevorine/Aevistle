/**
 * Formatting a plain-text body without turning it into a rich-text editor.
 *
 * The message body is a `<textarea>` and stays one. A contenteditable would
 * bring its own paste sanitisation, its own undo stack, its own selection bugs,
 * and — worst here — a document model that has to be serialised back to text
 * before it can be sent. The format the app already supports is Markdown, so
 * the toolbar inserts Markdown and the box stays a box.
 *
 * Every operation is a pure string transform over `(text, start, end)` so it
 * can be tested without a DOM, and every one of them reports where the caret
 * should end up afterwards. That second part is what separates a toolbar
 * people use from one they try once: bold with nothing selected has to leave
 * the caret *between* the markers, and bold with a word selected has to leave
 * the word selected.
 */

export interface EditResult {
  text: string
  selectionStart: number
  selectionEnd: number
}

export type MarkupAction = 'bold' | 'italic' | 'code' | 'link' | 'bullet' | 'number' | 'quote'

/** Wrap the selection, or open an empty pair for typing into. */
function wrap(text: string, start: number, end: number, marker: string): EditResult {
  const selected = text.slice(start, end)

  // Already wrapped? Unwrap. A toolbar button that only ever adds markers
  // turns a second click into `****bold****`, which is not what pressing a
  // pressed-looking button means.
  const before = text.slice(Math.max(0, start - marker.length), start)
  const after = text.slice(end, end + marker.length)
  if (before === marker && after === marker) {
    return {
      text: text.slice(0, start - marker.length) + selected + text.slice(end + marker.length),
      selectionStart: start - marker.length,
      selectionEnd: end - marker.length,
    }
  }
  if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= marker.length * 2) {
    const inner = selected.slice(marker.length, -marker.length)
    return {
      text: text.slice(0, start) + inner + text.slice(end),
      selectionStart: start,
      selectionEnd: start + inner.length,
    }
  }

  return {
    text: text.slice(0, start) + marker + selected + marker + text.slice(end),
    selectionStart: start + marker.length,
    selectionEnd: start + marker.length + selected.length,
  }
}

/**
 * Prefix every line the selection touches.
 *
 * Line-based, not selection-based: selecting the middle of three lines and
 * pressing "bullet" means all three become bullets, because that is what the
 * user is looking at. Toggles off when every touched line already has it.
 */
function prefixLines(
  text: string,
  start: number,
  end: number,
  prefix: (index: number) => string,
): EditResult {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  let lineEnd = text.indexOf('\n', end)
  if (lineEnd === -1) lineEnd = text.length

  const block = text.slice(lineStart, lineEnd)
  const lines = block.split('\n')
  // A generated prefix (`1. `, `2. `) cannot be compared literally, so the
  // check is on the shape rather than on the exact string.
  const shape = /^(\s*)([-*+]\s|\d+\.\s|>\s)/
  const allPrefixed = lines.every((l) => l.trim() === '' || shape.test(l))

  const next = lines
    .map((line, i) => {
      if (line.trim() === '') return line
      if (allPrefixed) return line.replace(shape, '$1')
      return prefix(i) + line
    })
    .join('\n')

  return {
    text: text.slice(0, lineStart) + next + text.slice(lineEnd),
    selectionStart: lineStart,
    selectionEnd: lineStart + next.length,
  }
}

export function applyMarkup(
  action: MarkupAction,
  text: string,
  start: number,
  end: number,
): EditResult {
  switch (action) {
    case 'bold':
      return wrap(text, start, end, '**')
    case 'italic':
      return wrap(text, start, end, '*')
    case 'code':
      return wrap(text, start, end, '`')
    case 'bullet':
      return prefixLines(text, start, end, () => '- ')
    case 'number':
      return prefixLines(text, start, end, (i) => `${i + 1}. `)
    case 'quote':
      return prefixLines(text, start, end, () => '> ')
    case 'link': {
      const selected = text.slice(start, end)
      // A selection that is already a URL becomes the *target*, not the label —
      // pasting a link and pressing the button is the commonest way this gets
      // used, and putting the URL in the label position would be backwards.
      const isUrl = /^(https?:\/\/|mailto:)\S+$/i.test(selected.trim())
      const inserted = isUrl ? `[](${selected.trim()})` : `[${selected}](https://)`
      return {
        text: text.slice(0, start) + inserted + text.slice(end),
        // Caret lands where the missing half goes: inside the label for a URL,
        // inside the target otherwise.
        selectionStart: isUrl ? start + 1 : start + selected.length + 3,
        selectionEnd: isUrl ? start + 1 : start + selected.length + 3 + 'https://'.length,
      }
    }
  }
}
