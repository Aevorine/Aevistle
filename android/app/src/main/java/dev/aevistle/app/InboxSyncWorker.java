package dev.aevistle.app;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

import java.util.List;

/**
 * Runs on the system's own 15-minute-floor schedule (WorkManager will not
 * honor anything shorter for periodic work — a platform limit, not a choice
 * made here) and syncs every account that has receiving turned on.
 *
 * No WebView exists when this runs, so — same as {@link SendWorker} — it
 * reads everything it needs from a native-side store ({@link InboxCache})
 * rather than asking JavaScript.
 */
public class InboxSyncWorker extends Worker {

    private static final String TAG = "InboxSyncWorker";
    static final String UNIQUE_NAME = "aevistle-inbox-sync";

    public InboxSyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        InboxCache cache = new InboxCache(context);
        SecretStore secrets = new SecretStore(context);

        List<JSONObject> accounts = cache.enabledAccounts();
        if (accounts.isEmpty()) return Result.success();

        boolean anyFailure = false;
        for (JSONObject config : accounts) {
            String accountId = config.optString("accountId", "");
            try {
                String secret = secrets.get(accountId, "imap");
                JSONObject updated = MailFetcher.sync(context, config, secret);
                cache.upsert(updated);
            } catch (Exception e) {
                anyFailure = true;
                try {
                    config.put("lastSyncError", e.getMessage() == null ? e.toString() : e.getMessage());
                    cache.upsert(config);
                } catch (Exception recordError) {
                    // The sync itself already failed (`e`) — this block exists
                    // only to tell the Inbox screen why, by writing
                    // `lastSyncError` onto the cached account. If that write
                    // throws too, the account is left exactly as it was before
                    // this run: no new messages and no error, which the Inbox
                    // screen cannot tell apart from "nothing new". Log it so the
                    // failure is at least diagnosable, and try once more against
                    // a fresh copy of the account rather than repeating the
                    // mutation that may itself have caused this to throw.
                    Log.e(TAG, "doWork: could not record sync failure for account " + accountId, recordError);
                    try {
                        JSONObject retry = new JSONObject(config.toString());
                        retry.put("lastSyncError", e.getMessage() == null ? e.toString() : e.getMessage());
                        cache.upsert(retry);
                    } catch (Exception fallbackError) {
                        Log.e(TAG, "doWork: fallback sync-error record also failed for account " + accountId, fallbackError);
                    }
                }
            }
        }

        // A failed sync should be retried on WorkManager's own backoff rather
        // than silently waiting a further 15 minutes — a transient network
        // blip on a phone is common, not exceptional.
        return anyFailure ? Result.retry() : Result.success();
    }
}
