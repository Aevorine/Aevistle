package dev.aevistle.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Environment;
import android.os.StatFs;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Where the app keeps the files it writes — attachments, above all.
 *
 * Android does not let an app write to an arbitrary directory. The document
 * picker hands back a {@code content://} tree, and a tree URI is useless to the
 * background sender: {@link SendWorker} runs hours later, possibly after a
 * reboot, and has to open the attachment as a plain {@link File}. So instead of
 * pretending to offer "any folder", this offers the volumes that genuinely
 * work, each with its real path shown:
 *
 * <ul>
 *   <li>{@code default}  — internal app storage, private, always available</li>
 *   <li>{@code external} — {@code Android/data/dev.aevistle.app/files} on the
 *       built-in shared storage, reachable from a file manager or over USB</li>
 *   <li>{@code sdcard}   — the same, on a removable card, when one is present</li>
 * </ul>
 *
 * The chosen id lives in its own SharedPreferences file. The scheduled jobs
 * ({@link JobStore}) and the passwords ({@link SecretStore}) deliberately do not
 * move: the system starts the worker without the app, and it must be able to
 * read the schedule even when an SD card has been pulled out.
 */
final class DataRoot {

    static final String ID_DEFAULT = "default";
    static final String ID_EXTERNAL = "external";
    static final String ID_SDCARD = "sdcard";

    private static final String PREFS = "aevistle_data";
    private static final String KEY_ROOT = "root_id";

    private DataRoot() {
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** The id the user picked, or {@code default}. */
    static String currentId(Context context) {
        String id = prefs(context).getString(KEY_ROOT, ID_DEFAULT);
        File dir = resolve(context, id);
        // A card that was removed, or an OS upgrade that took the path away:
        // fall back rather than fail every future attachment write.
        if (dir == null || !ensure(dir)) return ID_DEFAULT;
        return id;
    }

    /** The directory in use right now. Guaranteed to exist and be writable. */
    static File dir(Context context) {
        File dir = resolve(context, currentId(context));
        if (dir == null || !ensure(dir)) dir = context.getFilesDir();
        return dir;
    }

    /** The attachment directory inside the active data folder. */
    static File attachments(Context context) {
        File dir = new File(dir(context), "attachments");
        ensure(dir);
        return dir;
    }

    static File resolve(Context context, String id) {
        if (id == null) return context.getFilesDir();
        switch (id) {
            case ID_EXTERNAL: {
                File[] all = context.getExternalFilesDirs(null);
                return all != null && all.length > 0 ? all[0] : null;
            }
            case ID_SDCARD: {
                File[] all = context.getExternalFilesDirs(null);
                return all != null && all.length > 1 ? all[1] : null;
            }
            case ID_DEFAULT:
            default:
                return context.getFilesDir();
        }
    }

    private static boolean ensure(File dir) {
        if (dir == null) return false;
        if (!dir.exists() && !dir.mkdirs()) return false;
        return dir.canWrite();
    }

    /** Every option, available or not, so the UI can grey the missing ones out. */
    static JSONArray options(Context context) {
        JSONArray out = new JSONArray();
        out.put(option(context, ID_DEFAULT));
        out.put(option(context, ID_EXTERNAL));

        File[] all = context.getExternalFilesDirs(null);
        if (all != null && all.length > 1 && all[1] != null) {
            out.put(option(context, ID_SDCARD));
        }
        return out;
    }

    private static JSONObject option(Context context, String id) {
        JSONObject o = new JSONObject();
        File dir = resolve(context, id);
        boolean available = dir != null
                && (ID_DEFAULT.equals(id)
                || Environment.MEDIA_MOUNTED.equals(Environment.getExternalStorageState(dir)));
        try {
            o.put("id", id);
            o.put("path", dir == null ? "" : dir.getAbsolutePath());
            o.put("available", available && ensure(dir));
            if (dir != null && available) {
                StatFs stat = new StatFs(dir.getAbsolutePath());
                o.put("freeBytes", stat.getAvailableBytes());
            }
        } catch (Exception ignored) {
        }
        return o;
    }

    /**
     * Switch to another volume, optionally taking the existing files along.
     *
     * Copy first, delete afterwards, and never touch the source until every
     * copy has landed — an interrupted move is the one failure that would cost
     * a user the attachments a scheduled reminder still needs.
     *
     * @return a human-readable warning, or {@code null} when all went well.
     */
    static String switchTo(Context context, String id, boolean move) throws Exception {
        File target = resolve(context, id);
        if (target == null || !ensure(target)) {
            throw new IllegalStateException("That storage location is not available.");
        }

        File source = dir(context);
        if (source.getAbsolutePath().equals(target.getAbsolutePath())) return null;

        String warning = null;
        if (move) {
            File from = new File(source, "attachments");
            if (from.isDirectory()) {
                copyTree(from, new File(target, "attachments"));
                if (!deleteTree(from)) {
                    warning = "The files were copied, but the old folder could not be emptied.";
                }
            }
        }

        prefs(context).edit().putString(KEY_ROOT, id).apply();
        return warning;
    }

    /** Total size of the active data folder, for the settings panel. */
    static long size(Context context) {
        return sizeOf(dir(context));
    }

    private static long sizeOf(File file) {
        if (file == null || !file.exists()) return 0L;
        if (file.isFile()) return file.length();
        File[] children = file.listFiles();
        if (children == null) return 0L;
        long total = 0L;
        for (File child : children) total += sizeOf(child);
        return total;
    }

    private static void copyTree(File from, File to) throws Exception {
        if (from.isDirectory()) {
            if (!to.exists() && !to.mkdirs()) {
                throw new IllegalStateException("Could not create " + to.getAbsolutePath());
            }
            File[] children = from.listFiles();
            if (children == null) return;
            for (File child : children) copyTree(child, new File(to, child.getName()));
            return;
        }

        File parent = to.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IllegalStateException("Could not create " + parent.getAbsolutePath());
        }
        try (InputStream in = new FileInputStream(from);
             OutputStream out = new FileOutputStream(to)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
        }
    }

    private static boolean deleteTree(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    if (!deleteTree(child)) return false;
                }
            }
        }
        return file.delete();
    }
}
