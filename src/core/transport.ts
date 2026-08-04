/**
 * Everything both platforms need to know about *how* to open an SMTP
 * connection, with none of the socket code.
 *
 * Two reported failures drove this file into existence, and both of them made
 * the app look broken when it was really just misconfigured or unlucky:
 *
 *   1. "Testing…" that never came back. Every SMTP client times out a single
 *      connection attempt — but a hostname resolves to several addresses, and
 *      the timer is re-armed for each one in turn. The wait a user actually
 *      experiences is the timeout multiplied by however many A/AAAA records
 *      the provider publishes. Measured on a normal home connection:
 *      smtp.gmail.com:465 with a 15 s timeout took 121 s to connect, and
 *      smtp.qq.com:465 took 132 s. The same providers answered on port 587
 *      with STARTTLS in 0.4–2.8 s.
 *
 *   2. "Unexpected socket close". That is what a server does when you speak
 *      plaintext at a port expecting implicit TLS, or announce STARTTLS on a
 *      stream that is already encrypted. The message is accurate and useless:
 *      the fix is a different port or encryption mode, which a non-technical
 *      user cannot be expected to guess.
 *
 * Both have the same answer — try the other sensible endpoints, quickly, under
 * a budget that guarantees an answer — so both live here.
 */

import type { TransportSecurity } from './types'

/** Ports where the stream is encrypted from the first byte. */
const IMPLICIT_TLS_PORTS = new Set([465, 8465, 993, 995])

/** Ports where the session starts in the clear and upgrades. */
const STARTTLS_PORTS = new Set([587, 25, 2525, 1025, 143, 110])

/** Submission ports, as opposed to the retrieval ports below. */
const SMTP_PORTS = new Set([25, 465, 587, 2525, 1025, 8465])
/** Retrieval ports — a ladder must never offer an SMTP port as the partner of one. */
const IMAP_PORTS = new Set([143, 993])

export interface Endpoint {
  port: number
  security: TransportSecurity
}

function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  return a.port === b.port && a.security === b.security
}

/**
 * The encryption mode a port is *supposed* to be spoken with, or `null` when
 * the port carries no convention and only the user knows what is on it.
 */
export function canonicalSecurityFor(port: number): TransportSecurity | null {
  if (IMPLICIT_TLS_PORTS.has(port)) return 'ssl'
  if (STARTTLS_PORTS.has(port)) return 'starttls'
  return null
}

/** The other half of a port pair: 465↔587, 993↔143, 995↔110. */
const PARTNER_PORT: Record<number, number> = {
  465: 587,
  8465: 587,
  587: 465,
  25: 465,
  2525: 465,
  1025: 465,
  993: 143,
  143: 993,
  995: 110,
  110: 995,
}

/**
 * Microsoft's mail hosts, which are the reason this file grew a host argument.
 *
 * Every other big provider answers on both 465/implicit-TLS and
 * 587/STARTTLS, so a ladder that guesses between them eventually lands.
 * Microsoft answers on 587/STARTTLS and *nothing else* for submission, and on
 * 993/SSL and nothing else for retrieval — port 465 is not merely discouraged
 * there, it is not listening. Confirmed against Microsoft's own settings page
 * (smtp-mail.outlook.com:587 STARTTLS, outlook.office365.com:993 SSL/TLS) and
 * the Exchange Online client-submission doc, which describes SMTP AUTH as
 * "typically on TCP port 587".
 *
 * So for these hosts the ladder stops guessing and goes straight to the one
 * endpoint that exists.
 */
const MICROSOFT_MAIL_HOST =
  /(^|\.)(outlook\.com|office365\.com|office\.com|hotmail\.com|live\.com|msn\.com|outlook\.cn|partner\.outlook\.cn)$/i

export function isMicrosoftMailHost(host: string | undefined): boolean {
  if (!host) return false
  return MICROSOFT_MAIL_HOST.test(host.trim().toLowerCase())
}

/** The endpoint Microsoft actually serves for the family `port` belongs to. */
function microsoftEndpointFor(port: number): Endpoint | null {
  if (SMTP_PORTS.has(port)) return { port: 587, security: 'starttls' }
  if (IMAP_PORTS.has(port)) return { port: 993, security: 'ssl' }
  return null
}

/**
 * The endpoints to try, the user's own choice first.
 *
 * Their choice always leads: they may be pointing at an internal server that
 * does something unconventional, and silently overriding that would be worse
 * than one wasted attempt.
 *
 * What follows used to be only the *other port* — 465 for a STARTTLS port, 587
 * for an implicit-TLS one — which quietly left out the single most common
 * misconfiguration there is: the right port with the wrong encryption mode.
 * `endpointLadder(587, 'ssl')` produced `[587/SSL, 465/SSL]` and never once
 * tried `587/STARTTLS`, so a Microsoft account configured that way failed on
 * every rung: 587 does not speak implicit TLS (that is the BoringSSL
 * `WRONG_VERSION_NUMBER` users were seeing) and Microsoft does not listen on
 * 465 at all. The port's own canonical mode is now the first alternative,
 * which is both the likeliest fix and the cheapest one to try.
 *
 * Capped at three rungs. Beyond that the wait costs more than the extra
 * chance of success is worth.
 */
export function endpointLadder(
  port: number,
  security: TransportSecurity,
  autoNegotiate = true,
  host?: string,
): Endpoint[] {
  const chosen: Endpoint = { port, security }
  if (!autoNegotiate) return [chosen]

  // Microsoft: one alternative, and it is not a guess.
  if (isMicrosoftMailHost(host)) {
    const only = microsoftEndpointFor(port)
    if (only && !sameEndpoint(chosen, only)) return [chosen, only]
    if (only) return [chosen]
  }

  const alternatives: Endpoint[] = []
  const canonical = canonicalSecurityFor(port)

  if (canonical) {
    // 1. Same port, the mode the port is meant to be spoken with.
    alternatives.push({ port, security: canonical })
    // 2. The partner port with *its* canonical mode — implicit TLS is
    //    unreachable surprisingly often, some networks blackhole 465 rather
    //    than refusing it, which is what turns into a two-minute stall.
    const partner = PARTNER_PORT[port]
    if (partner !== undefined) {
      const partnerSecurity = canonicalSecurityFor(partner)
      if (partnerSecurity) alternatives.push({ port: partner, security: partnerSecurity })
    }
    // 3. Same port, the other mode — last, because it contradicts convention.
    alternatives.push({ port, security: canonical === 'ssl' ? 'starttls' : 'ssl' })
  } else {
    // A non-standard port: the port is deliberate, so only the encryption mode
    // is in question.
    alternatives.push({ port, security: security === 'ssl' ? 'starttls' : 'ssl' })
  }

  const ladder = [chosen]
  for (const candidate of alternatives) {
    if (ladder.length >= 3) break
    // Never *downgrade* to plaintext on the user's behalf: trying it would
    // send their password in the clear just to find out whether that works,
    // which is not a trade this app is allowed to make silently.
    if (candidate.security === 'none' && security !== 'none') continue
    if (!ladder.some((e) => sameEndpoint(e, candidate))) ladder.push(candidate)
  }

  return ladder
}

/**
 * Whether a failed attempt is worth retrying against a different endpoint.
 *
 * A rejected password is a rejected password on every port; retrying it three
 * times only slows the error down and, with providers that count failures,
 * spends the user's lockout budget for nothing.
 */
export function isNegotiable(errorKind: string | undefined, message: string): boolean {
  if (errorKind === 'auth' || errorKind === 'recipient' || errorKind === 'quota') return false
  if (errorKind === 'handshake' || errorKind === 'tls' || errorKind === 'timeout') return true
  const m = (message || '').toLowerCase()
  return (
    m.includes('unexpected socket close') ||
    m.includes('wrong version number') ||
    m.includes('econnreset') ||
    m.includes('econnrefused') ||
    m.includes('etimedout') ||
    m.includes('epipe') ||
    m.includes('greeting never received') ||
    m.includes('handshake') ||
    m.includes('ssl') ||
    m.includes('tls')
  )
}

/**
 * Split the user's total patience across the rungs.
 *
 * Not `perAttempt × rungs`: that is exactly how you get a two-minute spinner.
 * Each rung gets a slice big enough to be a fair try (8 s clears a healthy
 * handshake with room to spare) and no bigger, so a stalling endpoint yields
 * to the alternative instead of eating the whole budget.
 */
export function rungBudgetMs(totalMs: number, rungs: number): number {
  return Math.max(8_000, Math.floor(totalMs / Math.max(rungs, 1)))
}

/** Total wall-clock budget for a connection test, from the user's setting. */
export function totalBudgetMs(connectTimeoutSeconds: number): number {
  const seconds = Number.isFinite(connectTimeoutSeconds) ? connectTimeoutSeconds : 20
  return Math.min(Math.max(Math.round(seconds * 1000), 10_000), 120_000)
}

export class TimeoutError extends Error {
  constructor(seconds: number) {
    super(`No answer from the server within ${seconds} seconds`)
    this.name = 'TimeoutError'
  }
}

/**
 * Run `work` with a hard ceiling.
 *
 * `onTimeout` exists because rejecting the promise does not close the socket —
 * the underlying client is still sitting there mid-handshake, and on the
 * desktop that means a live TCP connection nobody can see plus a process that
 * will not exit. The caller passes its own teardown.
 */
export async function withDeadline<T>(
  work: () => Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          try {
            onTimeout()
          } catch {
            /* teardown is best-effort; the rejection below is what matters */
          }
          reject(new TimeoutError(Math.round(ms / 1000)))
        }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The suggestion shown under a failed connection test.
 *
 * Returns an i18n key rather than a sentence so the six translations stay in
 * one place, and `null` when there is nothing useful to add — a wrong password
 * does not need a paragraph explaining what a password is.
 *
 * `context` is optional and additive on purpose: callers that pass only the
 * first three arguments keep exactly the behaviour they had. Passing the host
 * and the server's own words is what unlocks the provider-specific advice —
 * "Microsoft turns SMTP AUTH off by default" is the correct answer to a 535
 * from Exchange Online and the wrong answer to a 535 from anyone else.
 */
export function advisoryKey(
  errorKind: string | undefined,
  port: number,
  security: TransportSecurity,
  context?: { host?: string; message?: string },
): string | null {
  const microsoft = isMicrosoftMailHost(context?.host)

  if (errorKind === 'auth') {
    if (microsoft || looksLikeMicrosoftAuthBlock(context?.message)) return 'error.microsoftSmtpAuth'
    return 'error.authHint'
  }
  if (errorKind === 'timeout') return 'error.timeoutHint'
  if (errorKind === 'network') return 'error.networkHint'
  if (errorKind === 'attachment') return 'error.attachmentHint'
  if (errorKind === 'handshake' || errorKind === 'tls') {
    if (microsoft) return 'error.microsoftEndpoint'
    const canonical = canonicalSecurityFor(port)
    if (canonical && canonical !== security) {
      if (port === 465 || port === 8465) return 'error.use465Ssl'
      if (port === 587) return 'error.use587Starttls'
      if (port === 993 || port === 995) return 'error.use993Ssl'
      if (port === 143 || port === 110) return 'error.use143Starttls'
    }
    return 'error.tlsHint'
  }
  return null
}

// ---------------------------------------------------------------------------
// Turning what the server (or OpenSSL) said into something a person can act on
// ---------------------------------------------------------------------------

/**
 * Microsoft's way of saying "the password was fine, we just do not accept
 * passwords here".
 *
 * `5.7.139` is the Exchange Online enhanced status code for a mailbox or
 * tenant with SMTP AUTH switched off, and it is the failure every Microsoft
 * account hits by default: Microsoft ships SMTP AUTH disabled and is retiring
 * basic authentication for client submission outright in favour of OAuth2.
 * Treating it as "wrong password" sends the user off to reset a password that
 * was never the problem.
 */
function looksLikeMicrosoftAuthBlock(message: string | undefined): boolean {
  if (!message) return false
  const m = message.toLowerCase()
  return (
    m.includes('5.7.139') ||
    m.includes('smtpclientauthentication is disabled') ||
    m.includes('basic authentication is disabled') ||
    m.includes('authentication unsuccessful') ||
    m.includes('authenticate first') ||
    (m.includes('5.7.57') && m.includes('authenticated'))
  )
}

/** A rung of the ladder and what it ran into, for the failure report. */
export interface AttemptNote {
  port: number
  security: TransportSecurity
  error: string
}

const SECURITY_SHORT: Record<TransportSecurity, string> = {
  ssl: 'SSL/TLS',
  starttls: 'STARTTLS',
  none: 'no encryption',
}

/**
 * One line per rung, so "it did not work" can be read as "here is what each
 * endpoint said". Without this a three-rung ladder reports only the last
 * failure, and the last rung is by construction the least likely one to be
 * the informative error.
 */
export function formatAttempts(notes: AttemptNote[]): string {
  if (notes.length === 0) return ''
  return notes
    .map((n) => `${n.port}/${SECURITY_SHORT[n.security]} → ${n.error}`)
    .join('; ')
}

export interface TransportErrorSummary {
  /** A sentence a person can act on. Never an OpenSSL dump. */
  summary: string
  /** The original text, when it differs from the summary and is worth keeping. */
  detail?: string
}

/**
 * Translate a transport failure into something worth putting on screen.
 *
 * The motivating example, reported verbatim by a user:
 *
 *   1090880:error:100000f7:SSL routines:OPENSSL_internal:WRONG_VERSION_NUMBER:
 *   ..\..\third_party\boringssl\src\ssl\tls_record.cc:127:
 *
 * That is a correct and completely unusable description of "you spoke TLS at a
 * port that starts in the clear". The raw text still matters — it is the only
 * thing worth pasting into a bug report — so it is returned separately rather
 * than thrown away.
 *
 * Deliberately no i18n here: this runs in the main process, which has no
 * locale. The translated, actionable half is `advisoryKey`; this half exists
 * so that what sits above it is a sentence rather than a stack offset.
 */
export function summarizeTransportError(
  raw: string,
  context?: { host?: string; port?: number; security?: TransportSecurity },
): TransportErrorSummary {
  const text = (raw || '').trim()
  if (!text) return { summary: 'The connection failed for an unknown reason' }
  const m = text.toLowerCase()
  const microsoft = isMicrosoftMailHost(context?.host)

  // Authentication that was refused for a reason other than the password.
  if (looksLikeMicrosoftAuthBlock(text) && (microsoft || m.includes('5.7.139'))) {
    return {
      summary:
        'The server accepted the connection but refused the sign-in: Microsoft turns off ' +
        'password-based SMTP/IMAP (SMTP AUTH) by default. For a work or school account an ' +
        'administrator must tick Microsoft 365 admin center → Users → Active users → the ' +
        'user → Mail → Manage email apps → Authenticated SMTP. For a personal Outlook.com ' +
        'or Hotmail account, create an app password at ' +
        'https://account.live.com/proofs/AppPassword and use that instead of your normal ' +
        'password. Microsoft is retiring password sign-in for mail clients in favour of OAuth2.',
      detail: text,
    }
  }

  // The record layer refused to parse — always a port/mode mismatch in practice.
  if (
    m.includes('wrong_version_number') ||
    m.includes('wrong version number') ||
    m.includes('unknown_protocol') ||
    m.includes('packet length too long') ||
    m.includes('record layer failure') ||
    m.includes('ssl3_get_record')
  ) {
    const base =
      'The server is not speaking TLS on this port. That happens when an encrypted ' +
      'connection is opened against a port that starts in the clear and upgrades with ' +
      'STARTTLS — port 587 works that way, port 465 does not.'
    return {
      summary: microsoft
        ? `${base} Microsoft only accepts SMTP on port 587 with STARTTLS and IMAP on port 993 with SSL/TLS; it does not listen on 465.`
        : base,
      detail: text,
    }
  }

  if (m.includes('unexpected socket close') || m.includes('greeting never received')) {
    return {
      summary:
        'The server closed the connection before saying anything. Nearly always the port ' +
        'and the encryption mode do not match — try 587 with STARTTLS, or 465 with SSL/TLS.',
      detail: text,
    }
  }

  if (
    m.includes('self signed') ||
    m.includes('self-signed') ||
    m.includes('unable to verify') ||
    m.includes('cert_has_expired') ||
    m.includes('altnames') ||
    m.includes('hostname/ip does not match')
  ) {
    return {
      summary:
        "The server's TLS certificate did not check out against the host name you entered. " +
        'Check the server address, or allow an invalid certificate only if you know why it is invalid.',
      detail: text,
    }
  }

  if (m.includes('econnrefused')) {
    return { summary: 'Nothing is listening on that port — the connection was refused.', detail: text }
  }
  if (m.includes('enotfound') || m.includes('eai_again') || m.includes('getaddrinfo')) {
    return { summary: 'That server name could not be looked up. Check the address and your network.', detail: text }
  }
  if (m.includes('right-hand side of')) {
    // Should now be unreachable; if it ever comes back it must not read like a
    // mail problem, because it is not one.
    return { summary: 'The mail client hit an internal error before it could report the real failure.', detail: text }
  }

  // Everything else — a 535, a 550, a plain timeout — already reads as a
  // sentence, and rewriting it would only hide what the server actually said.
  return { summary: text }
}

/** `summary`, then the raw text on its own line so a UI can fold it away. */
export function renderTransportError(result: TransportErrorSummary, trace?: string): string {
  const lines = [result.summary]
  if (trace) lines.push(`Tried: ${trace}`)
  if (result.detail && result.detail !== result.summary) lines.push(result.detail)
  return lines.join('\n')
}
