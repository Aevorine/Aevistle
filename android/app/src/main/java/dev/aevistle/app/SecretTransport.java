package dev.aevistle.app;

import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * The Java half of `src/core/secretTransport.ts` — sealing a mailbox password
 * for a paired device without the WebView ever seeing it.
 *
 * Everything here has a line-for-line counterpart in that TypeScript file, and
 * has to: the two run on opposite ends of the same pairing, so a phone sealing
 * under different bits than a desktop derives is not a mismatch anyone would
 * debug quickly — it surfaces as "the password synced but the account will not
 * log in", which reads as a mail-server problem. Read that file's module doc
 * for why this is HKDF'd away from the sync key rather than being the sync key,
 * and for the honest account of what this boundary buys.
 *
 * HKDF is written out below rather than reached for from a library because
 * Android ships no `javax.crypto.KDF` before API 35 and this app's `minSdk` is
 * far under that. It is thirty lines of RFC 5869 over `Mac`, which is a
 * smaller thing to own than a dependency.
 *
 * `SecretStore` is where the plaintext comes from and goes back to. This class
 * deliberately holds no `Context` and touches no storage: it turns bytes into
 * other bytes, and the plugin method around it is what decides which account's
 * secret is in scope.
 */
final class SecretTransport {

    /** Byte-identical to `ACCOUNT_SECRET_INFO` in `secretTransport.ts`. */
    private static final String INFO = "aevistle-sync-v1:account-secret";
    /** Byte-identical to `ACCOUNT_SECRET_SALT` in `secretTransport.ts`. Fixed, and not a secret — see that file. */
    private static final String SALT = "aevistle-sync-v1";
    private static final int VERSION = 1;

    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;
    private static final int IV_BYTES = 12;

    /** One account's credentials, as they cross the wire. Absent fields mean this device holds no secret of that kind. */
    static final class AccountSecret {
        final String accountId;
        final String smtp;
        final String imap;

        AccountSecret(String accountId, String smtp, String imap) {
            this.accountId = accountId;
            this.smtp = smtp;
            this.imap = imap;
        }
    }

    private SecretTransport() {}

    // -----------------------------------------------------------------------
    // HKDF-SHA256 (RFC 5869)
    // -----------------------------------------------------------------------

    private static byte[] hmac(byte[] key, byte[] data) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        // An all-zero key is legal HMAC input but `SecretKeySpec` rejects an
        // empty one, which is what an absent salt would be. Not reachable here
        // — SALT is a constant — but left explicit so a future caller passing
        // an empty salt gets RFC 5869's behaviour rather than an exception.
        mac.init(new SecretKeySpec(key.length == 0 ? new byte[32] : key, "HmacSHA256"));
        return mac.doFinal(data);
    }

    /** Extract-then-expand, for exactly the one 32-byte output this file needs. */
    private static byte[] hkdf32(byte[] ikm, byte[] salt, byte[] info) throws Exception {
        byte[] prk = hmac(salt, ikm);
        byte[] input = new byte[info.length + 1];
        System.arraycopy(info, 0, input, 0, info.length);
        input[info.length] = 1; // T(1) — one block is 32 bytes, which is the whole key
        return hmac(prk, input);
    }

    private static SecretKeySpec accountSecretKey(String syncKeyB64) throws Exception {
        byte[] ikm = Base64.decode(syncKeyB64, Base64.DEFAULT);
        byte[] bits = hkdf32(
                ikm,
                SALT.getBytes(StandardCharsets.UTF_8),
                INFO.getBytes(StandardCharsets.UTF_8));
        return new SecretKeySpec(bits, "AES");
    }

    // -----------------------------------------------------------------------
    // Seal / open
    // -----------------------------------------------------------------------

    /**
     * `{iv, ciphertext}`, both base64 — the same `PairingEnvelope` shape
     * `pairingCrypto.ts` puts on the wire everywhere else.
     *
     * A fresh random IV per message rather than a counter, for the reason
     * `sealWithRandomIv`'s doc gives: this key outlives the process and nothing
     * durable would remember where a counter had reached across a restart.
     */
    static JSONObject seal(String syncKeyB64, List<AccountSecret> secrets) throws Exception {
        JSONArray list = new JSONArray();
        for (AccountSecret secret : secrets) {
            JSONObject one = new JSONObject();
            one.put("accountId", secret.accountId);
            if (secret.smtp != null) one.put("smtp", secret.smtp);
            if (secret.imap != null) one.put("imap", secret.imap);
            list.put(one);
        }
        JSONObject bundle = new JSONObject();
        bundle.put("v", VERSION);
        bundle.put("secrets", list);

        byte[] iv = new byte[IV_BYTES];
        new SecureRandom().nextBytes(iv);
        Cipher cipher = Cipher.getInstance(TRANSFORM);
        cipher.init(Cipher.ENCRYPT_MODE, accountSecretKey(syncKeyB64), new GCMParameterSpec(GCM_TAG_BITS, iv));
        byte[] cipherText = cipher.doFinal(bundle.toString().getBytes(StandardCharsets.UTF_8));

        JSONObject envelope = new JSONObject();
        // NO_WRAP: `bytesToBase64` in `pairingCrypto.ts` emits one unbroken
        // line, and a newline every 76 characters would not survive its
        // hand-written decoder's alphabet lookup as the same bytes.
        envelope.put("iv", Base64.encodeToString(iv, Base64.NO_WRAP));
        envelope.put("ciphertext", Base64.encodeToString(cipherText, Base64.NO_WRAP));
        return envelope;
    }

    /**
     * Open one, or throw.
     *
     * Throwing rather than returning empty on an unknown version: "there were
     * no credentials in there" and "I could not read the ones that were" lead
     * to opposite conclusions on this side, and a method that cannot tell them
     * apart guarantees the wrong one.
     */
    static List<AccountSecret> open(String syncKeyB64, String ivB64, String ciphertextB64) throws Exception {
        byte[] iv = Base64.decode(ivB64, Base64.DEFAULT);
        byte[] cipherText = Base64.decode(ciphertextB64, Base64.DEFAULT);
        Cipher cipher = Cipher.getInstance(TRANSFORM);
        cipher.init(Cipher.DECRYPT_MODE, accountSecretKey(syncKeyB64), new GCMParameterSpec(GCM_TAG_BITS, iv));
        String plain = new String(cipher.doFinal(cipherText), StandardCharsets.UTF_8);

        JSONObject bundle = new JSONObject(plain);
        if (bundle.optInt("v", -1) != VERSION) {
            throw new IllegalStateException("unsupported account-secret bundle version");
        }
        JSONArray list = bundle.optJSONArray("secrets");
        List<AccountSecret> out = new ArrayList<>();
        if (list == null) return out;
        for (int i = 0; i < list.length(); i++) {
            JSONObject one = list.optJSONObject(i);
            if (one == null) continue;
            String accountId = one.optString("accountId", "");
            if (accountId.isEmpty()) continue;
            // `has() && !isNull()` rather than `optString(key, null)`: org.json
            // hands back the four-character string "null" for a key explicitly
            // set to JSON null, which would be stored as somebody's password.
            String smtp = one.has("smtp") && !one.isNull("smtp") ? one.optString("smtp") : null;
            String imap = one.has("imap") && !one.isNull("imap") ? one.optString("imap") : null;
            out.add(new AccountSecret(accountId, smtp, imap));
        }
        return out;
    }
}
