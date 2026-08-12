package dev.aevistle.app;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

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

        try {
            return syncAll(context, cache, secrets, accounts);
        } finally {
            /*
             * Hand back every IMAP connection before this method returns.
             *
             * {@link MailFetcher} keeps an authenticated connection alive for a
             * couple of minutes after an operation finishes, which is what turns
             * a burst of reading in the foreground into one handshake instead of
             * five. In here that is the wrong default and its idle timer is not
             * a safe way to undo it: once doWork() returns, WorkManager is free
             * to let this process be killed, and a timer in a dead process never
             * fires. The socket would survive only as long as the process did,
             * with nothing scheduled to close it in between — the definition of
             * a connection held open for no reason.
             *
             * Runs after the loop rather than after each account because the
             * retry path benefits: a run that ends in Result.retry() comes back
             * on WorkManager's backoff, and the accounts it is retrying are the
             * same ones. Runs in a finally because a thrown sync must not be the
             * thing that leaves a connection behind.
             */
            MailFetcher.closeIdleConnections();
        }
    }

    private Result syncAll(Context context, InboxCache cache, SecretStore secrets,
                           List<JSONObject> accounts) {
        boolean anyFailure = false;
        for (JSONObject config : accounts) {
            String accountId = config.optString("accountId", "");
            try {
                String secret = secrets.get(accountId, "imap");
                JSONObject updated = MailFetcher.sync(context, config, secret);
                cache.upsert(updated);
                /*
                 * After the cache is written, never before.
                 *
                 * If notifying threw, the messages would still be stored, so
                 * the next run would compare against the *new* baseline and
                 * the arrivals would never be announced at all — the worst of
                 * both outcomes. This way a notification failure costs one
                 * notification, not the mail.
                 */
                announce(AppSettingsSignal.localizedContext(context), config, updated);
                // And tell an app that is open, which `onInboxEvent` promised
                // and nothing delivered: the web layer treats this as "re-read
                // that account", so mail this pass found shows up at once
                // instead of waiting for the web timer's next turn.
                AevistleNativePlugin.emitInboxEvent(accountId);
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

    /**
     * How recent a message has to be to be worth a notification.
     *
     * Thirty minutes, matching `NEW_MAIL_WINDOW_MS` in `src/core/newMail.ts` —
     * `check-new-mail.mjs` holds the two files to the same number. It is wider
     * than this worker's own fifteen-minute floor so a run delayed by Doze
     * still reports what it found, and far narrower than a working day so a
     * phone that has been off since yesterday does not wake up and recite it.
     */
    private static final long WINDOW_MS = 30L * 60L * 1000L;

    /**
     * Tell the user what arrived, if anything did.
     *
     * This is the half of the feature that did not exist. The worker fetched
     * mail on the system's own schedule, wrote it into {@link InboxCache}, and
     * said nothing — so with the app closed, which is the state a phone spends
     * almost all of its time in, receiving mail produced no sign whatsoever.
     * The verification-code notification did not help: it is raised from
     * JavaScript, and there is no WebView in this process.
     *
     * Three rules decide what qualifies, and they are the same three
     * `core/newMail.ts` applies on the other platform:
     *
     *   - unseen. A message already read in webmail or on a laptop is not news.
     *   - inside {@link #WINDOW_MS}. New to the cache is not the same as new to
     *     the world; an account that has been offline catches up in one sync.
     *   - not in the previous message list. This is what "arrived" means, and
     *     it is why `before` is read from the config as it was *passed in*,
     *     which {@link #doWork} has not yet overwritten.
     *
     * There is no "primed" rule here, and it is not an omission: unlike the
     * renderer, this worker never starts from an empty baseline. It only ever
     * runs against an account the app has already synced at least once, because
     * `syncInbox` is what put it in the cache in the first place.
     */
    private static void announce(Context context, JSONObject before, JSONObject after) {
        try {
            Set<String> known = idsOf(before);
            List<JSONObject> arrivals = new ArrayList<>();
            long cutoff = System.currentTimeMillis() - WINDOW_MS;

            JSONArray messages = after.optJSONArray("messages");
            if (messages == null) return;
            for (int i = 0; i < messages.length(); i++) {
                JSONObject m = messages.optJSONObject(i);
                if (m == null) continue;
                String id = m.optString("id", "");
                if (id.isEmpty() || known.contains(id)) continue;
                if (m.optBoolean("seen", false)) continue;
                if (m.optLong("date", 0L) < cutoff) continue;
                arrivals.add(m);
            }
            if (arrivals.isEmpty()) return;

            JSONObject newest = arrivals.get(0);
            for (JSONObject m : arrivals) {
                if (m.optLong("date", 0L) > newest.optLong("date", 0L)) newest = m;
            }

            String from = senderName(newest.optString("from", ""));
            String subject = newest.optString("subject", "");
            if (subject.isEmpty()) subject = context.getString(R.string.notify_no_subject);
            String snippet = newest.optString("snippet", "").replaceAll("\\s+", " ").trim();
            String body = snippet.isEmpty() ? subject : subject + " — " + snippet;
            // Which account's cache the "Mark as read" action should update —
            // the same account this whole sync ran against.
            String accountId = after.optString("accountId", "");
            String markReadLabel = context.getString(R.string.notify_mark_read);

            if (arrivals.size() == 1) {
                Notifier.mail(context, newest.optString("id", ""),
                        context.getString(R.string.notify_new_mail_one, from),
                        body, newest.optString("id", ""), accountId, markReadLabel);
                return;
            }

            /*
             * More than one: post the newest as the child people will actually
             * read, then the summary the group collapses into. In that order —
             * Android shows a summary with no children as an empty group
             * heading, which is a notification that says a number and nothing
             * else.
             *
             * The action still only ever marks `newest` — the one message this
             * notification is actually about and the same one its tap target
             * opens — not every arrival in the batch.
             */
            Notifier.mail(context, newest.optString("id", ""),
                    context.getString(R.string.notify_new_mail_many, arrivals.size(), from),
                    body, newest.optString("id", ""), accountId, markReadLabel);
            Notifier.mailSummary(context,
                    context.getString(R.string.notify_new_mail_summary, arrivals.size()),
                    context.getString(R.string.notify_new_mail_one, from));
        } catch (Exception e) {
            // Never at the cost of the sync. The mail is already cached and the
            // Inbox screen will show it; a notification that could not be
            // raised is a smaller loss than a run reported as failed, which
            // would put WorkManager into backoff and delay the next fetch.
            Log.w(TAG, "announce: could not raise a new-mail notification", e);
        }
    }

    private static Set<String> idsOf(JSONObject account) {
        Set<String> ids = new HashSet<>();
        JSONArray messages = account.optJSONArray("messages");
        if (messages == null) return ids;
        for (int i = 0; i < messages.length(); i++) {
            JSONObject m = messages.optJSONObject(i);
            if (m != null) ids.add(m.optString("id", ""));
        }
        return ids;
    }

    /**
     * `"Alex Chen" <alex@example.com>` becomes `Alex Chen`; a bare address is
     * left alone. Mirrors `senderName` in `src/core/newMail.ts` so the same
     * arrival is worded the same whichever side notices it.
     */
    private static String senderName(String from) {
        int bracket = from.indexOf('<');
        if (bracket <= 0) return from.trim();
        String name = from.substring(0, bracket).trim();
        if (name.startsWith("\"") && name.endsWith("\"") && name.length() >= 2) {
            name = name.substring(1, name.length() - 1).trim();
        }
        return name.isEmpty() ? from.trim() : name;
    }
}
