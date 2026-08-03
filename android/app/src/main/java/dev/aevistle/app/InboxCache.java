package dev.aevistle.app;

import android.content.Context;
import android.content.SharedPreferences;

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
     */
    void deleteMessages(String accountId, JSONArray items) {
        JSONObject account = account(accountId);
        if (account == null || items == null) return;

        JSONArray messages = account.optJSONArray("messages");
        if (messages == null) return;

        JSONArray kept = new JSONArray();
        for (int i = 0; i < messages.length(); i++) {
            JSONObject m = messages.optJSONObject(i);
            if (m == null) continue;
            if (!matches(m, items)) kept.put(m);
        }
        try {
            account.put("messages", kept);
        } catch (Exception ignored) {
        }
        upsert(account);
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
