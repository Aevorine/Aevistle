/**
 * Template variables and mail merge.
 *
 * One message written once, personalised per recipient: `{{name}}` becomes the
 * contact's name, `{{email}}` their address, and anything you put in a
 * contact's custom fields becomes a variable of that name.
 *
 * Two deliberate limits:
 *
 * - **Substitution is literal, never evaluated.** `{{name}}` is a lookup in a
 *   plain object and nothing else — no expressions, no function calls, no
 *   nested templates. A mail merge that can run code is a mail merge that can
 *   be handed a malicious contact list.
 * - **An unknown variable is left standing, not blanked.** `{{nmae}}` arriving
 *   as `{{nmae}}` in the preview is how you find the typo; arriving as an empty
 *   string is how you send forty people a letter starting "Dear ,".
 */

import type { Contact, MessageDraft } from './types'

/** `{{ name }}` — braces doubled, whitespace tolerated, word characters only. */
const TOKEN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g

export interface MergeVars {
  [name: string]: string
}

/** Variables every merge has, regardless of what the contact list carries. */
export function builtinVars(now = Date.now(), locale = 'en'): MergeVars {
  const d = new Date(now)
  const two = (n: number) => (n < 10 ? `0${n}` : String(n))
  return {
    date: `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`,
    time: `${two(d.getHours())}:${two(d.getMinutes())}`,
    year: String(d.getFullYear()),
    month: two(d.getMonth() + 1),
    day: two(d.getDate()),
    weekday: new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(d),
  }
}

/**
 * Everything a single recipient's message can refer to.
 *
 * `address` is always defined — it is the one thing a recipient is guaranteed
 * to have. `name` falls back to the local part of the address rather than to
 * an empty string, so "Hi {{name}}" degrades to "Hi lena" instead of "Hi".
 */
export function varsForRecipient(
  address: string,
  contact: Contact | undefined,
  extra: MergeVars = {},
): MergeVars {
  const local = address.split('@')[0] ?? address
  return {
    ...extra,
    ...(contact?.fields ?? {}),
    email: address,
    address,
    name: contact?.name?.trim() || local,
    firstName: (contact?.name?.trim() || local).split(/\s+/)[0],
    note: contact?.note ?? '',
  }
}

/** Substitute `{{tokens}}`. Unknown names are left exactly as written. */
export function render(text: string, vars: MergeVars): string {
  return text.replace(TOKEN, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole,
  )
}

/** Every distinct variable name used in a piece of text, in first-seen order. */
export function usedVars(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(TOKEN)) {
    if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}

/** Variables the text asks for that this recipient cannot supply. */
export function missingVars(text: string, vars: MergeVars): string[] {
  return usedVars(text).filter((n) => !Object.prototype.hasOwnProperty.call(vars, n))
}

export interface MergeMessage {
  address: string
  draft: MessageDraft
  /** Names this message could not fill in — surfaced before sending, not after. */
  missing: string[]
}

/**
 * Expand one draft into one message per recipient.
 *
 * Cc and Bcc are dropped from the expanded copies on purpose. A merge sends
 * each person their own letter; carrying the whole Cc list into all forty of
 * them would send the carbon-copied reader forty near-identical messages and
 * leak the recipient list the merge existed to keep private.
 *
 * Returns a single unmodified message when merging is off, so callers have one
 * code path either way.
 */
export function buildMergeMessages(
  draft: MessageDraft,
  contacts: Contact[],
  opts: { enabled: boolean; now?: number; locale?: string } = { enabled: true },
): MergeMessage[] {
  const base = builtinVars(opts.now ?? Date.now(), opts.locale ?? 'en')

  if (!opts.enabled) {
    const vars = { ...base }
    return [
      {
        address: draft.to.join(', '),
        draft: {
          ...draft,
          subject: render(draft.subject, vars),
          body: render(draft.body, vars),
        },
        missing: [
          ...new Set([
            ...missingVars(draft.subject, vars),
            ...missingVars(draft.body, vars),
          ]),
        ],
      },
    ]
  }

  const byAddress = new Map<string, Contact>()
  for (const c of contacts) byAddress.set(c.address.trim().toLowerCase(), c)

  return draft.to.map((address) => {
    const contact = byAddress.get(address.trim().toLowerCase())
    const vars = varsForRecipient(address, contact, base)
    return {
      address,
      draft: {
        ...draft,
        to: [address],
        cc: [],
        bcc: [],
        subject: render(draft.subject, vars),
        body: render(draft.body, vars),
        individualDelivery: false,
      },
      missing: [
        ...new Set([...missingVars(draft.subject, vars), ...missingVars(draft.body, vars)]),
      ],
    }
  })
}

/** True when the draft contains at least one `{{token}}`. */
export function hasVars(draft: MessageDraft): boolean {
  return usedVars(draft.subject).length > 0 || usedVars(draft.body).length > 0
}
