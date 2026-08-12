package dev.aevistle.app;

import android.content.Context;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;

/**
 * The on-disk half of the privacy image proxy — the reason opening a message
 * makes no network requests at all.
 *
 * Mirrors `electron/remoteImage.ts`'s cache, deliberately down to the details
 * that matter:
 *
 *   · keyed by a SHA-256 of the URL and nothing else. Not by message, not by
 *     account. The same tracking pixel appears in a hundred newsletters and
 *     fetching it once is the point — and it means the directory is a pile of
 *     hashes rather than a browsable history of everywhere this mailbox has
 *     pointed.
 *   · the whole verdict is stored, not just the picture. A reopened message
 *     reads entirely out of here, so a tracker count that lived only in the
 *     fetch would report zero on every open after the first.
 *   · a <em>blocked</em> image is cached too. The refusal is a property of the
 *     bytes, not of the moment, and re-fetching a picture the scanner has
 *     already refused would mean a fresh request to the sender on every open —
 *     precisely the signal this whole thing exists to stop sending.
 *   · a <em>failed</em> one is not. A dropped connection is a moment in time,
 *     and writing it down would make one bad minute permanent.
 *
 * Everything here fails soft. A cache that cannot be written must never be a
 * reason a message does not render.
 */
final class ImageCacheStore {

    private static final String DIR = "imagecache";
    /** Total bytes before the least recently used entries are dropped. */
    private static final long MAX_BYTES = 120L * 1024 * 1024;
    /** Prune down to this, so a full cache does not re-prune on every write. */
    private static final long TARGET_BYTES = (long) (MAX_BYTES * 0.8);
    /** One entry holds a whole data URI; past this it is not ours to keep. */
    private static final int MAX_ENTRY_BYTES = 8 * 1024 * 1024;

    private ImageCacheStore() {
    }

    private static File dir(Context context) {
        File root = new File(DataRoot.dir(context), DIR);
        if (!root.exists()) //noinspection ResultOfMethodCallIgnored
            root.mkdirs();
        return root;
    }

    /**
     * The filename for a URL. SHA-256 rather than anything reversible, for the
     * reason in the class doc.
     */
    private static File fileFor(Context context, String url) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] digest = md.digest(url.getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder(64);
        for (byte b : digest) sb.append(String.format("%02x", b));
        return new File(dir(context), sb + ".json");
    }

    /** The stored verdict, or null for a miss or an unreadable entry — the same thing to a caller. */
    static JSONObject read(Context context, String url) {
        try {
            File file = fileFor(context, url);
            if (!file.isFile()) return null;
            byte[] buf = new byte[(int) Math.min(file.length(), MAX_ENTRY_BYTES)];
            try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
                raf.readFully(buf);
            }
            JSONObject entry = new JSONObject(new String(buf, StandardCharsets.UTF_8));
            if (entry.optInt("v", 0) != 2) return null;
            // mtime is the LRU clock, so a hit has to touch it. Failing is not
            // worth reporting: the entry merely looks older than it is.
            //noinspection ResultOfMethodCallIgnored
            file.setLastModified(System.currentTimeMillis());
            entry.put("fromCache", true);
            return entry;
        } catch (Throwable t) {
            return null;
        }
    }

    /** Store a verdict. Failures are not stored — see the class doc. */
    static void write(Context context, String url, JSONObject verdict) {
        try {
            if ("failed".equals(verdict.optString("status"))) return;
            JSONObject entry = new JSONObject(verdict.toString());
            entry.put("v", 2);
            byte[] bytes = entry.toString().getBytes(StandardCharsets.UTF_8);
            if (bytes.length > MAX_ENTRY_BYTES) return;
            File file = fileFor(context, url);
            // Write-then-rename, so a crash mid-write cannot leave a half-file
            // that reads back as a corrupt entry.
            File tmp = new File(file.getPath() + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(bytes);
            }
            if (!tmp.renameTo(file)) {
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
                return;
            }
            prune(context);
        } catch (Throwable ignored) {
            // The picture still displays; it just will not be there next time.
        }
    }

    static boolean has(Context context, String url) {
        return read(context, url) != null;
    }

    /** One sweep at a time — a burst of thirty images must not start thirty of them. */
    private static final Object PRUNE_LOCK = new Object();
    private static boolean pruning = false;

    private static void prune(Context context) {
        synchronized (PRUNE_LOCK) {
            if (pruning) return;
            pruning = true;
        }
        try {
            File[] files = dir(context).listFiles();
            if (files == null) return;
            long total = 0;
            List<File> entries = new ArrayList<>();
            for (File f : files) {
                if (!f.isFile()) continue;
                entries.add(f);
                total += f.length();
            }
            if (total <= MAX_BYTES) return;
            // Oldest touch first: `read` bumps mtime on every hit, which is what
            // makes this least-recently-used rather than oldest-fetched.
            entries.sort((a, b) -> Long.compare(a.lastModified(), b.lastModified()));
            for (File f : entries) {
                if (total <= TARGET_BYTES) break;
                long size = f.length();
                if (f.delete()) total -= size;
            }
        } catch (Throwable ignored) {
            // No cache directory yet, or unreadable. Nothing to prune.
        } finally {
            synchronized (PRUNE_LOCK) {
                pruning = false;
            }
        }
    }

    /**
     * Delete every cached image. Part of "reset everything".
     *
     * The cache holds only pictures that were already public on someone else's
     * server — but the <em>set</em> of them is a record of which mail was
     * opened, and a reset that leaves a folder of hashes behind has not done
     * what it said.
     */
    static void clear(Context context) {
        try {
            File[] files = dir(context).listFiles();
            if (files == null) return;
            for (File f : files) //noinspection ResultOfMethodCallIgnored
                f.delete();
        } catch (Throwable ignored) {
            // A cache that cannot be emptied is not a reason to report that a
            // reset failed when accounts, secrets and schedule are all gone.
        }
    }

    /** Only for the self-check panel: how much the cache is holding. */
    static long sizeBytes(Context context) {
        File[] files = dir(context).listFiles();
        if (files == null) return 0;
        long total = 0;
        for (File f : files) if (f.isFile()) total += f.length();
        return total;
    }
}
