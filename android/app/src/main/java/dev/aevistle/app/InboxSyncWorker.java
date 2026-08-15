package dev.aevistle.app;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/**
 * Runs on the system's own 15-minute-floor schedule (WorkManager will not
 * honor anything shorter for periodic work — a platform limit, not a choice
 * made here) and syncs every account that has receiving turned on.
 *
 * This is the floor, not the whole story: while {@link InboxIdleService} is
 * alive it repeats the same pass every couple of minutes instead of fifteen,
 * because a foreground service is exempt from the Doze/App Standby throttling
 * that would otherwise stretch this worker's own runs well past its nominal
 * interval. The floor still matters on its own — a manufacturer that killed
 * the foreground service, or a stretch before it has been (re)armed — which
 * is why this keeps running rather than being replaced outright. Both share
 * {@link InboxSyncRunner} so neither can drift into different arrival/notify
 * rules from the other.
 *
 * No WebView exists when this runs, so — same as {@link SendWorker} — the
 * actual sync reads everything it needs from a native-side store ({@link
 * InboxCache}) rather than asking JavaScript.
 */
public class InboxSyncWorker extends Worker {

    static final String UNIQUE_NAME = "aevistle-inbox-sync";

    public InboxSyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            boolean anyFailure = InboxSyncRunner.runOnce(getApplicationContext());
            // A failed sync should be retried on WorkManager's own backoff
            // rather than silently waiting a further 15 minutes — a transient
            // network blip on a phone is common, not exceptional.
            return anyFailure ? Result.retry() : Result.success();
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
             * `InboxIdleService` does not do this after its own runs, on
             * purpose: it is the one caller of `InboxSyncRunner` that is
             * guaranteed to still be alive a few minutes later, so keeping the
             * pooled connection is the same win MailFetcher gives the
             * foreground app — one handshake per account instead of one per
             * pass.
             */
            MailFetcher.closeIdleConnections();
        }
    }
}
