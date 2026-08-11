/**
 * Moving a mailbox password from one paired device to the other without the
 * plaintext ever existing in a renderer.
 *
 * This is the half of `core/syncLoop.ts` that could not be written where the
 * rest of it lives. Everything else a sync cycle carries — reminders,
 * contacts, templates, the theme — is already in `AppState`, so the renderer
 * can read it, seal it and send it. A password is deliberately not: `bridge
 * .ts` offers `setSecret`/`hasSecret`/`deleteSecret` and no reader, because an
 * SMTP credential that leaks can send mail from anywhere, and the renderer is
 * the layer web content runs in. `getSyncSecret` is the one documented
 * exception and it is narrowed to `kind: 'sync'` on both platforms
 * specifically so it cannot become a general secret reader.
 *
 * So the naive fix — "let the renderer read the password and put it in the
 * payload" — is not available, and would not be taken if it were: it would
 * undo the one boundary this app is careful about in order to implement a
 * background poll. What is available is to move the sealing *to* the layer
 * that already holds the keystore. Electron main and the Android plugin both
 * read secrets today (`electron/store.ts`'s `getSecret`, `SecretStore.get`);
 * this file is what they seal them with, and the renderer only ever handles
 * the resulting `PairingEnvelope` — an opaque `{iv, ciphertext}` it puts into
 * the payload on one side and hands back to the trusted layer on the other.
 *
 * **What this does and does not buy.** It buys: no plaintext credential in
 * any renderer, in `state.json`, in a log line, or in a React state tree, on
 * either side of the exchange. It does not buy secrecy from a *fully
 * compromised* renderer — that renderer can call `getSyncSecret`, derive the
 * key below itself, and open the envelope. That is not a regression this file
 * introduces; it is the standing consequence of `getSyncSecret` existing at
 * all, and closing it would mean moving the whole ECDH handshake out of the
 * renderer, which is a different change. Said plainly here rather than left
 * for someone to discover from the absence of a comment.
 *
 * The key is HKDF'd away from the sync key rather than being the sync key.
 * `core/syncLoop.ts` seals every ordinary cycle under the sync key directly,
 * so reusing it here would put credentials and reminders under one key with
 * nothing but a JSON field name separating them: anything that could ever be
 * persuaded to decrypt one could decrypt the other. A separate `info` string
 * costs one HKDF call and makes "opens a sync payload" and "opens a
 * credential bundle" two different capabilities.
 */

import {
  base64ToBytes,
  openWithRandomIv,
  sealWithRandomIv,
  type PairingEnvelope,
} from './pairingCrypto'

/**
 * The HKDF `info` that separates this key from the sync key itself. Mirrored
 * byte for byte in `android/.../SecretTransport.java` — the two sides must
 * derive the same bits from the same stored key or a phone would seal
 * something a desktop cannot open, and the failure would look like a wrong
 * password rather than a wrong key.
 */
export const ACCOUNT_SECRET_INFO = 'aevistle-sync-v1:account-secret'

/**
 * Fixed, not random, and not a secret.
 *
 * `pairingCrypto.ts` salts its HKDF with the one-time pairing token, which is
 * available there because the handshake is happening. Nothing equivalent
 * exists at sync time: the two sides share exactly one thing, the stored sync
 * key, and a random salt would have to travel alongside the envelope — which
 * is legal but pointless, since the input keying material is already 256 bits
 * of uniformly random AES key rather than a low-entropy password. RFC 5869 §3.1
 * is explicit that a salt is optional in exactly this case.
 */
const ACCOUNT_SECRET_SALT = 'aevistle-sync-v1'

/** Bumped only for a change that an older peer could not open — the sealed bundle carries it so a mismatch is a clear refusal rather than a parse error. */
export const ACCOUNT_SECRET_VERSION = 1

/**
 * One account's credentials as they cross the wire.
 *
 * Both kinds travel, because both are things the user typed and neither is
 * recoverable from the other: an account whose SMTP password synced but whose
 * IMAP password did not is an account that can send and cannot read, which is
 * a stranger state to land a user in than either "fully moved" or "not moved".
 * Absent fields simply mean this device holds no secret of that kind.
 */
export interface AccountSecret {
  accountId: string
  smtp?: string
  imap?: string
}

interface AccountSecretBundle {
  v: number
  secrets: AccountSecret[]
}

function toBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as BufferSource
}

/**
 * The AES-GCM key credentials travel under, from the base64 sync key the
 * keystore holds for this pairing.
 *
 * Non-extractable: nothing that gets a `CryptoKey` out of this function can
 * turn it back into bytes to store or send somewhere else.
 */
export async function deriveAccountSecretKey(longLivedKeyB64: string): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    toBufferSource(base64ToBytes(longLivedKeyB64)),
    'HKDF',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toBufferSource(new TextEncoder().encode(ACCOUNT_SECRET_SALT)),
      info: toBufferSource(new TextEncoder().encode(ACCOUNT_SECRET_INFO)),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Seal a bundle for the peer this sync key belongs to.
 *
 * Random IV rather than a counter, for the reason `sealWithRandomIv`'s own doc
 * gives: this key outlives the process, and nothing durable would remember
 * where a counter had got to across a restart.
 */
export async function sealAccountSecrets(
  longLivedKeyB64: string,
  secrets: readonly AccountSecret[],
): Promise<PairingEnvelope> {
  const key = await deriveAccountSecretKey(longLivedKeyB64)
  const bundle: AccountSecretBundle = { v: ACCOUNT_SECRET_VERSION, secrets: [...secrets] }
  return sealWithRandomIv(key, bundle)
}

/**
 * Open one, or throw.
 *
 * Throwing rather than resolving empty on a version this build does not know:
 * "there were no credentials in there" and "I could not read the credentials
 * that were in there" lead to opposite conclusions on the receiving side —
 * the first means leave `hasSecret` alone, the second means say so — and a
 * function that cannot tell them apart guarantees the wrong one is picked.
 */
export async function openAccountSecrets(
  longLivedKeyB64: string,
  envelope: PairingEnvelope,
): Promise<AccountSecret[]> {
  const key = await deriveAccountSecretKey(longLivedKeyB64)
  const bundle = await openWithRandomIv<Partial<AccountSecretBundle>>(key, envelope)
  if (bundle.v !== ACCOUNT_SECRET_VERSION) {
    throw new Error(`unsupported account-secret bundle version ${String(bundle.v)}`)
  }
  if (!Array.isArray(bundle.secrets)) throw new Error('malformed account-secret bundle')
  return bundle.secrets.filter(
    (s): s is AccountSecret => Boolean(s) && typeof s.accountId === 'string' && s.accountId.length > 0,
  )
}
