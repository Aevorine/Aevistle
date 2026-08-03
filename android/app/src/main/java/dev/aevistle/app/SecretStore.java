package dev.aevistle.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * SMTP passwords, encrypted with a key that never leaves the Android Keystore.
 *
 * Written against the platform Keystore directly rather than pulling in
 * androidx.security:security-crypto — that library is deprecated, its stable
 * release still ships alpha-era APIs, and the whole job here is about sixty
 * lines of AES-GCM. Fewer dependencies is also the right answer for the one
 * file in the app that handles credentials.
 *
 * The key is generated once, is not exportable, and on devices with a secure
 * element is hardware-backed. A stolen `secrets.xml` is therefore useless off
 * the device it came from.
 */
final class SecretStore {

    private static final String PREFS = "aevistle_secrets";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "aevistle_secret_key_v1";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;
    private static final int IV_BYTES = 12;

    private final SharedPreferences prefs;

    SecretStore(Context context) {
        this.prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);

        KeyStore.Entry entry = store.getEntry(KEY_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // Deliberately not requiring user authentication: a scheduled
                // send has to work at 03:00 with the phone locked, which is the
                // entire point of the app.
                .setUserAuthenticationRequired(false)
                .build());
        return generator.generateKey();
    }

    /**
     * Mirrors `secretKey()` in `electron/store.ts`: an account's SMTP and IMAP
     * passwords are different secrets that happen to share an account id, so
     * they need different keystore entries or turning one off would clobber
     * the other. `smtp` keeps the original bare key — every secret written
     * before IMAP existed used that key, and this way it still reads back.
     */
    private static String key(String accountId, String kind) {
        return kind == null || "smtp".equals(kind) ? accountId : accountId + ":" + kind;
    }

    void put(String accountId, String kind, String secret) throws Exception {
        Cipher cipher = Cipher.getInstance(TRANSFORM);
        cipher.init(Cipher.ENCRYPT_MODE, key());

        byte[] iv = cipher.getIV();
        byte[] cipherText = cipher.doFinal(secret.getBytes("UTF-8"));

        byte[] combined = new byte[iv.length + cipherText.length];
        System.arraycopy(iv, 0, combined, 0, iv.length);
        System.arraycopy(cipherText, 0, combined, iv.length, cipherText.length);

        prefs.edit()
                .putString(key(accountId, kind), Base64.encodeToString(combined, Base64.NO_WRAP))
                .apply();
    }

    String get(String accountId, String kind) {
        String stored = prefs.getString(key(accountId, kind), null);
        if (stored == null) return null;
        try {
            byte[] combined = Base64.decode(stored, Base64.NO_WRAP);
            if (combined.length <= IV_BYTES) return null;

            byte[] iv = new byte[IV_BYTES];
            System.arraycopy(combined, 0, iv, 0, IV_BYTES);
            byte[] cipherText = new byte[combined.length - IV_BYTES];
            System.arraycopy(combined, IV_BYTES, cipherText, 0, cipherText.length);

            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(GCM_TAG_BITS, iv));
            return new String(cipher.doFinal(cipherText), "UTF-8");
        } catch (Exception e) {
            // Key rotated, app data restored onto a different device, or the
            // blob was tampered with — in every case we simply do not have the
            // password any more.
            return null;
        }
    }

    boolean has(String accountId, String kind) {
        return prefs.contains(key(accountId, kind));
    }

    void remove(String accountId, String kind) {
        prefs.edit().remove(key(accountId, kind)).apply();
    }
}
