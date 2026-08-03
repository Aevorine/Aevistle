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
const IMPLICIT_TLS_PORTS = new Set([465, 8465])

/** Ports where the session starts in the clear and upgrades. */
const STARTTLS_PORTS = new Set([587, 25, 2525, 1025])

export interface Endpoint {
  port: number
  security: TransportSecurity
}

function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  return a.port === b.port && a.security === b.security
}

/**
 * The endpoints to try, the user's own choice first.
 *
 * Their choice always leads: they may be pointing at an internal server that
 * does something unconventional, and silently overriding that would be worse
 * than one wasted attempt. What follows is the conventional partner for the
 * port — 465 and 587 are the same service on nearly every provider — so a
 * blackholed implicit-TLS port stops being a dead end.
 *
 * Capped at three rungs. Beyond that the wait costs more than the extra
 * chance of success is worth.
 */
export function endpointLadder(
  port: number,
  security: TransportSecurity,
  autoNegotiate = true,
): Endpoint[] {
  const chosen: Endpoint = { port, security }
  if (!autoNegotiate) return [chosen]

  const alternatives: Endpoint[] = []

  if (IMPLICIT_TLS_PORTS.has(port)) {
    // Implicit TLS is unreachable surprisingly often — some networks blackhole
    // 465 rather than refusing it, which is what turns into a two-minute stall.
    alternatives.push({ port: 587, security: 'starttls' })
    alternatives.push({ port, security: 'starttls' })
  } else if (STARTTLS_PORTS.has(port)) {
    alternatives.push({ port: 465, security: 'ssl' })
    alternatives.push({ port, security: 'ssl' })
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
 */
export function advisoryKey(
  errorKind: string | undefined,
  port: number,
  security: TransportSecurity,
): string | null {
  if (errorKind === 'auth') return 'error.authHint'
  if (errorKind === 'timeout') return 'error.timeoutHint'
  if (errorKind === 'network') return 'error.networkHint'
  if (errorKind === 'attachment') return 'error.attachmentHint'
  if (errorKind === 'handshake' || errorKind === 'tls') {
    if (IMPLICIT_TLS_PORTS.has(port) && security !== 'ssl') return 'error.use465Ssl'
    if (STARTTLS_PORTS.has(port) && security === 'ssl') return 'error.use587Starttls'
    return 'error.tlsHint'
  }
  return null
}
