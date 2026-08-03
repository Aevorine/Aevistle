package dev.aevistle.app;

import android.content.Context;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * On-disk cache for sanitized message bodies — the Android analogue of
 * `electron/inboxStore.ts`. Deliberately outside `InboxCache`'s SharedPreferences
 * blob for the same reason the desktop keeps bodies out of `state.json`: a
 * body can be large, and the metadata store gets read/written far more often
 * than any one body does.
 *
 * A cache, not a source of truth — deleting `inbox/` (or the whole data
 * folder) just means the next sync re-downloads and re-sanitizes.
 */
final class InboxBodyStore {

    private InboxBodyStore() {
    }

    private static File dir(Context context, String accountId, String folderPath) {
        File dir = new File(DataRoot.dir(context), "inbox" + File.separator
                + safe(accountId) + File.separator + slug(folderPath));
        dir.mkdirs();
        return dir;
    }

    static boolean hasBody(Context context, String accountId, String folderPath, long uid) {
        return file(context, accountId, folderPath, uid).isFile();
    }

    static JSONObject readBody(Context context, String accountId, String folderPath, long uid) {
        File file = file(context, accountId, folderPath, uid);
        if (!file.isFile()) return null;
        try {
            byte[] bytes = new byte[(int) file.length()];
            try (java.io.FileInputStream in = new java.io.FileInputStream(file)) {
                int off = 0;
                int read;
                while (off < bytes.length && (read = in.read(bytes, off, bytes.length - off)) != -1) off += read;
            }
            return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }

    static void writeBody(Context context, String accountId, String folderPath, long uid, JSONObject body)
            throws Exception {
        File file = file(context, accountId, folderPath, uid);
        try (Writer writer = new OutputStreamWriter(new FileOutputStream(file), StandardCharsets.UTF_8)) {
            writer.write(body.toString());
        }
    }

    private static File file(Context context, String accountId, String folderPath, long uid) {
        return new File(dir(context, accountId, folderPath), uid + ".json");
    }

    private static String safe(String value) {
        return value.replaceAll("[^A-Za-z0-9._\\-]", "_");
    }

    /** Same idea as `inboxStore.ts`'s `folderSlug`: a hash, so a folder path with
     * characters the filesystem dislikes never becomes an invalid directory name. */
    private static String slug(String folderPath) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-1");
            byte[] hash = digest.digest(folderPath.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : hash) sb.append(String.format("%02x", b));
            return sb.substring(0, 16);
        } catch (Exception e) {
            return safe(folderPath);
        }
    }
}
