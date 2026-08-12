package dev.aevistle.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * The native side's own copy of each account's inbox state — same shape as
 * `InboxAccountState` in `src/core/types.ts`.
 *
 * This exists for the same reason {@link JobStore} does: {@link
 * InboxSyncWorker} runs on the system's own schedule, hours after the WebView
 * last existed, and cannot ask JavaScript what accounts have receiving turned
 * on or what messages it already knows about. Message *bodies* still live on
 * disk under the active data folder ({@link DataRoot}), not here — this only
 * holds the metadata needed to decide what to sync and what is already seen.
 */
final class InboxCache {

    private static final String TAG = "InboxCache";
    private static final String PREFS = "aevistle_inbox";
    private static final String KEY_ACCOUNTS = "accounts";

    private final SharedPreferences prefs;

    InboxCache(Context context) {
        this.prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    JSONArray accounts() {
        String raw = prefs.getString(KEY_ACCOUNTS, "[]");
        try {
            return new JSONArray(raw);
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    /** Every account currently marked `enabled: true`. */
    List<JSONObject> enabledAccounts() {
        List<JSONObject> out = new ArrayList<>();
        JSONArray all = accounts();
        for (int i = 0; i < all.length(); i++) {
            JSONObject a = all.optJSONObject(i);
            if (a != null && a.optBoolean("enabled", false)) out.add(a);
        }
        return out;
    }

    JSONObject account(String accountId) {
        JSONArray all = accounts();
        for (int i = 0; i < all.length(); i++) {
            JSONObject a = all.optJSONObject(i);
            if (a != null && accountId.equals(a.optString("accountId"))) return a;
        }
        return null;
    }

    /** Replace one account's cached state, keeping the others untouched. */
    void upsert(JSONObject updated) {
        String accountId = updated.optString("accountId", "");
        if (accountId.isEmpty()) return;

        JSONArray all = accounts();
        JSONArray next = new JSONArray();
        boolean replaced = false;
        for (int i = 0; i < all.length(); i++) {
            JSONObject a = all.optJSONObject(i);
            if (a != null && accountId.equals(a.optString("accountId"))) {
                next.put(updated);
                replaced = true;
            } else if (a != null) {
                next.put(a);
            }
        }
        if (!replaced) next.put(updated);

        prefs.edit().putString(KEY_ACCOUNTS, next.toString()).apply();
    }

    /** Dropped entirely — used when the account (or just its IMAP secret) is removed. */
    void remove(String accountId) {
        JSONArray all = accounts();
        JSONArray next = new JSONArray();
        for (int i = 0; i < all.length(); i++) {
            JSONObject a = all.optJSONObject(i);
            if (a != null && !accountId.equals(a.optString("accountId"))) next.put(a);
        }
        prefs.edit().putString(KEY_ACCOUNTS, next.toString()).apply();
    }

    /**
     * Drop the given (folderPath, uid) pairs from an account's cached message
     * list. Local-cache-only, same as the desktop `deleteInboxMessages` IPC
     * handler — never touches the IMAP server.
     *
     * @return false when the pruned list could not actually be written back —
     *         the caller should surface that as a failure rather than
     *         resolving as if the messages were gone, because {@code upsert}
     *         below would otherwise silently re-save the account with its
     *         original, unpruned `messages` still attached.
     */
    boolean deleteMessages(String accountId, JSONArray items) {
        JSONObject account = account(accountId);
        if (account == null || items == null) return true;

        JSONArray messages = account.optJSONArray("messages");
        if (messages == null) return true;

        JSONArray kept = new JSONArray();
        for (int i = 0; i < messages.length(); i++) {
            JSONObject m = messages.optJSONObject(i);
            if (m == null) continue;
            if (!matches(m, items)) kept.put(m);
        }
        try {
            account.put("messages", kept);
        } catch (Exception e) {
            // `kept` is the pruned list. If it cannot be attached to
            // `account`, the `upsert` below would save `account` exactly as
            // it was read — the deletion the caller asked for would silently
            // not happen while the JS layer, told nothing, believes it did.
            // Log it and tell the caller so it can reject instead of
            // resolving.
            Log.e(TAG, "deleteMessages: could not prune messages for account " + accountId, e);
            return false;
        }
        upsert(account);
        return true;
    }

    /**
     * Mark one cached message read: locally now, and on the server as soon as
     * something can reach it.
     *
     * This used to write `seen` into the cache and stop there, on the grounds
     * that there is no WebView in this process to hand a `setMessageFlags`
     * call to. There does not need to be one — {@link MailFetcher#setSeen} is
     * a static method that takes a config and a password, and {@link
     * SecretStore} hands out the password to whatever asks. What the old
     * reasoning actually produced was a button that undid itself: the next
     * sync read `\Seen` off the server, found it clear, and wrote the message
     * back to unread. Every single time, on every message, with nothing to
     * show for the tap.
     *
     * So the change is recorded twice. The cache write is what the Inbox
     * screen shows immediately; the queued record is what {@link
     * InboxFlagWorker} pushes, what the next sync flushes before it lists
     * anything, and what {@link #applyPendingSeen} re-applies to a listing
     * that came back before the push landed. Only the server clearing the
     * record ends it.
     *
     * The queue entry is written even when the message is no longer in the
     * cache, which is the case the old comment called a no-op: a row the
     * Inbox screen has already re-synced past is a row the *next* sync will
     * list again, still unread, unless this is on record somewhere.
     */
    void markSeen(String accountId, String messageId) {
        if (accountId == null || accountId.isEmpty() || messageId == null || messageId.isEmpty()) {
            return;
        }

        // `id` is `<accountId>:<folderPath>:<uid>` (MailFetcher.sync writes
        // it). Read from the right-hand end so an accountId containing a colon
        // cannot shift the fields.
        int lastColon = messageId.lastIndexOf(':');
        int prevColon = lastColon <= 0 ? -1 : messageId.lastIndexOf(':', lastColon - 1);
        long uid = -1L;
        String folderPath = "INBOX";
        if (prevColon >= 0) {
            try {
                uid = Long.parseLong(messageId.substring(lastColon + 1));
                folderPath = messageId.substring(prevColon + 1, lastColon);
            } catch (NumberFormatException e) {
                // An id this class did not mint. The local write below still
                // matches on the whole string, so the screen updates; there is
                // just no UID to name in a queue entry.
                Log.w(TAG, "markSeen: no uid in message id " + messageId, e);
                uid = -1L;
            }
        }
        if (uid > 0) queueSeen(accountId, folderPath, uid, true);

        JSONObject account = account(accountId);
        if (account == null) return;
        JSONArray messages = account.optJSONArray("messages");
        if (messages == null) return;

        boolean changed = false;
        for (int i = 0; i < messages.length(); i++) {
            JSONObject m = messages.optJSONObject(i);
            if (m == null || !messageId.equals(m.optString("id", ""))) continue;
            try {
                m.put("seen", true);
                changed = true;
            } catch (Exception e) {
                Log.e(TAG, "markSeen: could not update message " + messageId, e);
            }
            break;
        }
        if (changed) upsert(account);
    }

    // -----------------------------------------------------------------------
    // Flag changes that still owe the server a visit
    //
    // Small and short-lived: one entry per message marked from a notification,
    // gone as soon as a STORE succeeds. It exists because the two ends of that
    // action happen at different times — the tap has to be answered now, on a
    // device that may have no network, and the server may not be reachable for
    // hours. Anything in here is a promise the app has already shown the user
    // as kept.
    // -----------------------------------------------------------------------

    private static final String KEY_PENDING_SEEN = "pendingSeen";

    /**
     * One lock for the queue, static because callers construct their own
     * {@link InboxCache}. The notification receiver and a running sync
     * genuinely do touch this at the same time, and a read-modify-write over
     * one preferences string is exactly the shape that loses an entry when
     * they do.
     */
    private static final Object PENDING_LOCK = new Object();

    /** Every queued flag change, for every account. */
    JSONArray pendingSeen() {
        try {
            return new JSONArray(prefs.getString(KEY_PENDING_SEEN, "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    /** The subset belonging to one account. */
    JSONArray pendingSeen(String accountId) {
        JSONArray all = pendingSeen();
        JSONArray mine = new JSONArray();
        for (int i = 0; i < all.length(); i++) {
            JSONObject item = all.optJSONObject(i);
            if (item != null && accountId.equals(item.optString("accountId", ""))) mine.put(item);
        }
        return mine;
    }

    /**
     * Record that this message's `\Seen` flag owes the server a visit.
     *
     * Written with `commit()` rather than `apply()`. This is called from a
     * {@link android.content.BroadcastReceiver} whose process the system is
     * free to kill the moment `onReceive` returns, and an `apply()` still
     * sitting in its background writer at that point is the whole fix lost —
     * silently, and only on the devices where it matters most.
     */
    void queueSeen(String accountId, String folderPath, long uid, boolean seen) {
        synchronized (PENDING_LOCK) {
            JSONArray next = new JSONArray();
            JSONArray all = pendingSeen();
            for (int i = 0; i < all.length(); i++) {
                JSONObject item = all.optJSONObject(i);
                if (item == null) continue;
                // One entry per message: a second mark supersedes the first
                // rather than queueing a duplicate STORE behind it.
                if (matchesFlag(item, accountId, folderPath, uid)) continue;
                next.put(item);
            }
            try {
                JSONObject item = new JSONObject();
                item.put("accountId", accountId);
                item.put("folderPath", folderPath);
                item.put("uid", uid);
                item.put("seen", seen);
                item.put("queuedAt", System.currentTimeMillis());
                next.put(item);
            } catch (Exception e) {
                // Nothing to fall back to: without the entry the flag change
                // exists only in the local cache and the next sync erases it.
                // The caller has no way to know, so this log is the only trace
                // there will ever be.
                Log.e(TAG, "queueSeen: could not queue " + accountId + ":" + folderPath + ":" + uid, e);
                return;
            }
            prefs.edit().putString(KEY_PENDING_SEEN, next.toString()).commit();
        }
    }

    /** Drop entries the server has now accepted. */
    void clearPendingSeen(JSONArray done) {
        if (done == null || done.length() == 0) return;
        synchronized (PENDING_LOCK) {
            JSONArray all = pendingSeen();
            JSONArray next = new JSONArray();
            for (int i = 0; i < all.length(); i++) {
                JSONObject item = all.optJSONObject(i);
                if (item == null) continue;
                boolean cleared = false;
                for (int j = 0; j < done.length(); j++) {
                    JSONObject d = done.optJSONObject(j);
                    if (d != null && matchesFlag(item, d.optString("accountId", ""),
                            d.optString("folderPath", ""), d.optLong("uid", -1L))) {
                        cleared = true;
                        break;
                    }
                }
                if (!cleared) next.put(item);
            }
            prefs.edit().putString(KEY_PENDING_SEEN, next.toString()).commit();
        }
    }

    /**
     * Re-assert queued read state over a listing that has just come back from
     * the server.
     *
     * Called between a sync and the {@link #upsert} that stores its result. A
     * sync reads `\Seen` off the server and writes it onto every row, so a
     * mark whose STORE has not landed yet — no network at the notification,
     * an auth failure, a push still in {@link InboxFlagWorker}'s backoff —
     * would be undone by the very next listing, which is the bug this whole
     * queue exists to close. The record outranks the server until the server
     * has been told.
     */
    void applyPendingSeen(JSONObject account) {
        if (account == null) return;
        JSONArray pending = pendingSeen(account.optString("accountId", ""));
        if (pending.length() == 0) return;
        JSONArray messages = account.optJSONArray("messages");
        if (messages == null) return;

        // Per folder, how many rows this actually changed — see the unread
        // adjustment below.
        List<String> flippedIn = new ArrayList<>();
        for (int i = 0; i < messages.length(); i++) {
            JSONObject m = messages.optJSONObject(i);
            if (m == null) continue;
            for (int j = 0; j < pending.length(); j++) {
                JSONObject item = pending.optJSONObject(j);
                if (item == null) continue;
                if (!matchesFlag(item, m.optString("accountId", ""),
                        m.optString("folderPath", ""), m.optLong("uid", -1L))) {
                    continue;
                }
                boolean want = item.optBoolean("seen", true);
                if (m.optBoolean("seen", false) == want) break;
                try {
                    m.put("seen", want);
                    if (want) flippedIn.add(m.optString("folderPath", ""));
                } catch (Exception e) {
                    Log.e(TAG, "applyPendingSeen: could not re-apply read state to "
                            + m.optString("id", ""), e);
                }
                break;
            }
        }
        adjustUnread(account, flippedIn);
    }

    /**
     * Take the rows just marked read back off the folder's unread count.
     *
     * By the delta, not by recounting: the count describes the whole mailbox
     * and the row list is capped at the most recent fifty, so counting rows
     * would report a mailbox of four hundred messages as having at most fifty
     * unread. Without this the Inbox tab keeps a badge for messages every row
     * on screen shows as read, which is the same "the app disagrees with
     * itself" the mark-as-read button already produced once.
     */
    private void adjustUnread(JSONObject account, List<String> flippedIn) {
        if (flippedIn.isEmpty()) return;
        JSONArray folders = account.optJSONArray("folders");
        if (folders == null) return;
        for (int i = 0; i < folders.length(); i++) {
            JSONObject folder = folders.optJSONObject(i);
            if (folder == null) continue;
            int flipped = 0;
            for (String path : flippedIn) {
                if (path.equals(folder.optString("path", ""))) flipped++;
            }
            if (flipped == 0) continue;
            try {
                folder.put("unreadCount", Math.max(0, folder.optInt("unreadCount", 0) - flipped));
            } catch (Exception e) {
                Log.e(TAG, "applyPendingSeen: could not adjust the unread count for "
                        + folder.optString("path", ""), e);
            }
        }
    }

    private static boolean matchesFlag(JSONObject item, String accountId, String folderPath,
                                       long uid) {
        return item.optLong("uid", -1L) == uid
                && accountId.equals(item.optString("accountId", ""))
                && folderPath.equals(item.optString("folderPath", ""));
    }

    private static boolean matches(JSONObject message, JSONArray items) {
        String folderPath = message.optString("folderPath", "");
        long uid = message.optLong("uid", -1);
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item == null) continue;
            if (folderPath.equals(item.optString("folderPath", "")) && uid == item.optLong("uid", -2)) {
                return true;
            }
        }
        return false;
    }
}
