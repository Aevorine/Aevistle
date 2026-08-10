/**
 * The public half of the Ed25519 key that signs `SHA256SUMS.txt` for the
 * in-app updater specifically.
 *
 * This is deliberately a *second* key, separate from the GPG key documented
 * in `SECURITY.md` for anyone verifying a download by hand with `gpg
 * --verify`. That key stays exactly as it is — this one exists only because
 * the updater in `electron/updater.ts` needs to check a signature itself,
 * in-process, with no dependency heavier than `node:crypto`, and parsing an
 * OpenPGP-armored signature would mean either shipping a full OpenPGP
 * implementation or hand-rolling a packet parser — both worse than a second
 * key with a trivial verification path.
 *
 * The corresponding private key lives at `~/.aevistle/update-signing-key.pem`,
 * outside the repository, exactly like the GPG and Android signing keys.
 * `scripts/sign-update-manifest.mjs` is the only thing that reads it.
 *
 * A public key is not a secret — this file is committed on purpose. What
 * must never happen is a second value here that disagrees with the key that
 * actually signed the currently-published manifest; `check-update-signing.mjs`
 * exists to catch exactly that.
 */
export const UPDATE_SIGNING_PUBLIC_KEY_SPKI_BASE64 =
  'MCowBQYDK2VwAyEAZXk6/ykQP43HhygVDqqHITfvi1RQgr+6+Utnv32OBI4='
