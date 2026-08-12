package dev.aevistle.app;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.TimeUnit;

/**
 * Pushes the flag changes {@link InboxCache#markSeen} queued — today, the
 * "Mark as read" button on a new-mail notification.
 *
 * A worker rather than the work happening in {@link MarkReadReceiver} itself,
 * for the two reasons that button has to answer to. A receiver has about ten
 * seconds before the system considers it hung, and an IMAP connect, log in,
 * SELECT and STORE over a phone's mobile data can spend all of it; and the tap
 * has to look answered *immediately*, which it cannot if the notification is
 * waiting on a socket. So the receiver does the two instant things — the local
 * cache write and dismissing the notification — and this does the part that
 * has to wait for a server.
 *
 * The retry is the other half of the point. Somebody clearing a notification
 * on a phone in a lift has no network at all; WorkManager's own constraint
 * holds this until there is one, and its backoff covers a server that is
 * merely down. Nothing is dropped in the meantime: the queue is on disk and
 * {@link MailFetcher#flushPendingSeen} drains it again before the next sync
 * lists anything.
 */
public class InboxFlagWorker extends Worker {

    private static final String TAG = "InboxFlagWorker";
    static final String UNIQUE_NAME = "aevistle-inbox-flags";

    /**
     * How many times a failing push is worth waking a phone up for.
     *
     * Past this the queue stays on disk and the next sync's flush is what
     * tries again — which is the right cadence for a change that has stopped
     * being about this one tap and started being about an account that cannot
     * reach its server at all.
     */
    private static final int MAX_ATTEMPTS = 5;

    public InboxFlagWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    /**
     * Ask for a push as soon as there is a network.
     *
     * `APPEND_OR_REPLACE` rather than `KEEP`: a second notification marked
     * while the first push is mid-flight has to be pushed too, and `KEEP`
     * would discard the request that carries it. Appending costs one extra run
     * that finds an empty queue, which is a no-op that opens no connection.
     */
    static void kick(Context context) {
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();

        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(InboxFlagWorker.class)
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .addTag(UNIQUE_NAME)
                .build();

        WorkManager.getInstance(context)
                .enqueueUniqueWork(UNIQUE_NAME, ExistingWorkPolicy.APPEND_OR_REPLACE, request);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        InboxCache cache = new InboxCache(context);
        SecretStore secrets = new SecretStore(context);

        JSONArray pending = cache.pendingSeen();
        if (pending.length() == 0) return Result.success();

        try {
            for (String accountId : accountsIn(pending)) {
                JSONObject config = cache.account(accountId);
                if (config == null) {
                    // The account was removed after the mark. Nothing to push
                    // it to and nothing that will ever be able to; logged
                    // because the entry now sits in the queue until the
                    // account comes back.
                    Log.w(TAG, "doWork: no cached account for " + accountId + ", cannot push its read state");
                    continue;
                }
                String secret = secrets.get(accountId, "imap");
                if (secret == null) secret = secrets.get(accountId, "smtp");
                MailFetcher.flushPendingSeen(context, config, secret);
            }
        } finally {
            // Same reasoning as InboxSyncWorker: once doWork() returns the
            // process may be killed, and MailFetcher's idle timer cannot close
            // a socket from inside a process that no longer exists.
            MailFetcher.closeIdleConnections();
        }

        if (cache.pendingSeen().length() == 0) return Result.success();

        if (getRunAttemptCount() + 1 >= MAX_ATTEMPTS) {
            // Not `failure()` with the work discarded quietly: the queue is
            // still on disk and the next sync will flush it. This is the line
            // that says why a "Mark as read" is taking hours to reach the
            // server, which is otherwise indistinguishable from it never
            // having been sent.
            Log.e(TAG, "doWork: gave up after " + MAX_ATTEMPTS
                    + " attempts with " + cache.pendingSeen().length()
                    + " flag change(s) still queued — the next sync will try again");
            return Result.failure();
        }
        return Result.retry();
    }

    private static Set<String> accountsIn(JSONArray pending) {
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < pending.length(); i++) {
            JSONObject item = pending.optJSONObject(i);
            if (item == null) continue;
            String accountId = item.optString("accountId", "");
            if (!accountId.isEmpty()) ids.add(accountId);
        }
        return ids;
    }
}
