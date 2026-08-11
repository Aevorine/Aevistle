package dev.aevistle.app;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

/**
 * Performs one scheduled send, then arms the next occurrence.
 *
 * Runs with no UI and no WebView. Everything it needs is in {@link JobStore}
 * and {@link SecretStore}.
 *
 * Two gates stand in front of the send, and neither used to exist here:
 * {@link Conditions}, which is why a job saying "only if they haven't replied"
 * now honours that on a phone as well as on a desktop; and the dispatch-ledger
 * claim in {@link JobStore#claimLedgerEntry}, which is what makes an immediate
 * alarm for a missed reminder safe to arm repeatedly — see
 * {@link AevistleScheduler#nextOccurrence} for the restart-recovery half of
 * that story.
 */
public class SendWorker extends Worker {

    static final String TAG = "aevistle-send";
    static final String KEY_JOB_ID = "jobId";

    public SendWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static String uniqueName(String jobId) {
        return "aevistle_job_" + jobId;
    }

    @NonNull
    @Override
    public Result doWork() {
        String jobId = getInputData().getString(KEY_JOB_ID);
        if (jobId == null || jobId.isEmpty()) return Result.failure();

        Context context = getApplicationContext();
        JobStore store = new JobStore(context);

        JSONObject job = store.job(jobId);
        if (job == null || !job.optBoolean("enabled", false)) {
            // Deleted or paused between the alarm firing and the work running.
            return Result.success();
        }
        if (!AevistleScheduler.isMyJob(job, store.localDeviceId())) {
            // Defense in depth, not the primary guard: `AevistleScheduler
            // .rearmAll` already refuses to arm a job assigned to another
            // device. This only matters for an alarm that was armed before
            // an executor reassignment synced in and has not been cancelled
            // yet — the same "already in flight when the rule changed"
            // window `SendWorker`'s other checks below exist for.
            return Result.success();
        }

        JSONObject draft = job.optJSONObject("draft");
        if (draft == null) return Result.failure();

        /*
         * Which instant is being paid, and what ledger entry tracks it?
         *
         * `dueOccurrence` is the identity of this dispatch — the mirror of
         * `${job.id}:${fireAt}` in `electron/scheduler.ts`. Claimed fresh here
         * on the worker's first attempt (minting or reusing a dispatch-ledger
         * entry — see {@link JobStore#claimLedgerEntry}); recovered from the
         * store on a WorkManager retry instead, via
         * {@link JobStore#ledgerEntryForJob}, because by then this same
         * attempt's own {@link JobStore#recordRun} call — below — has already
         * dropped the occurrence out of `job.occurrences` on the failed try
         * that led to the retry, so `dueOccurrence` would find nothing to
         * re-derive a claimKey from.
         *
         * Stale-claim recovery itself does not live here any more — see
         * {@link AevistleScheduler#nextOccurrence}, which has already resolved
         * (resent, or completed the bookkeeping for) any ledger entry a
         * crashed prior attempt left behind, before this worker ever runs. A
         * fresh claim here should therefore not collide with an old one; if it
         * somehow does, {@link JobStore#claimLedgerEntry} just bumps
         * `attempts` and carries the existing message id forward — worst case
         * is the occasional duplicate the new policy already accepts.
         *
         * `due <= 0` means no occurrence is due at all — an alarm that arrived
         * a hair early, or a list the web layer has already pruned. There is
         * no occurrence identity to track in that case; sending with no ledger
         * entry at all is the old, correct behaviour: an alarm that fired is a
         * reminder the user asked for.
         */
        long due = AevistleScheduler.dueOccurrence(job);
        JSONObject ledgerEntry = getRunAttemptCount() == 0
                ? (due > 0 ? store.claimLedgerEntry(jobId, due) : null)
                : store.ledgerEntryForJob(jobId);
        String claimKey = ledgerEntry != null
                ? ledgerEntry.optString("claimKey", null)
                : (due > 0 ? JobStore.ledgerClaimKey(jobId, due) : null);
        // A usable id even when the durable claim write above failed — a send
        // should proceed with *some* id rather than drop a reminder the user
        // is waiting on, matching the desktop build's claimThenRun.
        String messageId = ledgerEntry != null
                ? ledgerEntry.optString("messageId", null)
                : (claimKey != null ? JobStore.mintMessageId(claimKey) : null);

        /*
         * Send conditions, checked here because here is where a scheduled run
         * is actually decided — the same place and for the same reason
         * `electron/scheduler.ts` checks them, and before the account lookup so
         * a run the user asked to be called off does not complain about
         * unrelated configuration.
         *
         * There was no check at all on this platform. See {@link Conditions}.
         */
        Conditions.Verdict verdict = Conditions.evaluate(context, job);
        if (!verdict.send) {
            long ranAt = System.currentTimeMillis();
            JSONObject run = store.recordSkip(jobId, ranAt, verdict.reasonKey, verdict.reasonValues);
            /*
             * Reported three ways, because a skip nobody can see is the bug
             * that replaces the one being fixed — and on this platform the app
             * is usually not running when it happens:
             *
             *   - the live event, which becomes the activity-log line when the
             *     app is open, carrying the reason as its detail;
             *   - the queued run report above, which moves the schedule row off
             *     "waiting to send" on the next open;
             *   - a notification, gated on the same switch a failed send uses,
             *     which is the only one of the three that reaches somebody who
             *     was not looking at the app. Keyed by job id like every other
             *     status notification, so a repeatedly-blocked reminder
             *     replaces its own row instead of stacking.
             */
            AevistleNativePlugin.emitJobEvent(jobId, ranAt, verdict.toSendResult(), run);
            if (store.notifyOnFailure()) {
                notify(context, jobId, "Not sent — " + job.optString("name", "Aevistle"),
                        verdict.reason == null ? "A send condition was not met" : verdict.reason);
            }

            armNext(context, store, jobId);
            // No SMTP attempt was ever made for this claimKey — the ledger
            // entry, if any, is still sitting in 'claimed'. Cleared here
            // rather than left for a future restart to resolve, so a
            // condition that skips every time does not leave it hanging
            // around until the 24-hour prune — mirrors the skip branch of
            // `run()` in electron/scheduler.ts.
            if (claimKey != null) store.deleteLedgerEntry(claimKey);
            // Success: the worker did exactly what it was asked to. A failure
            // here would hand the job to WorkManager's backoff and re-run the
            // same decision every few minutes.
            return Result.success();
        }

        JSONObject account = store.account(draft.optString("accountId", ""));
        if (account == null) {
            store.recordRun(jobId, System.currentTimeMillis(), false,
                    "The account this schedule uses no longer exists");
            // The run is recorded either way — the schedule screen shows it on
            // next open. Only the interruption is optional.
            if (store.notifyOnFailure()) {
                notify(context, jobId, "Aevistle", "Scheduled send failed: no such account");
            }
            if (claimKey != null) store.deleteLedgerEntry(claimKey);
            return Result.failure();
        }

        String secret = new SecretStore(context).get(account.optString("id", ""), "smtp");
        // Durable before the SMTP call, not after — see
        // JobStore#markLedgerSending. Written once per WorkManager attempt,
        // the same way `sendOnce()`'s retry loop on the desktop build writes
        // it once per actual attempt.
        if (claimKey != null) store.markLedgerSending(claimKey);
        MailSender.Result result = MailSender.send(context, draft, account, secret, messageId);
        // The one state with positive proof the SMTP server accepted the
        // message — anything short of it resolves towards a resend on
        // restart. See AevistleScheduler#nextOccurrence.
        if (claimKey != null && result.ok) store.markLedgerAccepted(claimKey);

        long ranAt = System.currentTimeMillis();
        JSONObject run = store.recordRun(jobId, ranAt, result.ok, result.error);
        /*
         * Tell an app that is open right now, as well as queueing the report.
         *
         * Most scheduled sends on Android happen with nothing open, which is
         * why the queue exists — but the case where the user is *looking at the
         * schedule screen* when their 07:00 reminder goes out was the one where
         * nothing happened at all: the row kept saying "waiting to send" until
         * they switched apps and came back, because `onJobEvent` was subscribed
         * to an event name no code path emitted. A no-op when nothing is open.
         */
        AevistleNativePlugin.emitJobEvent(jobId, ranAt, result.toJson(), run);

        // Re-arm from whatever occurrences remain. The list is refilled by the
        // JavaScript layer next time the app opens; until then the job keeps
        // firing off the horizon that was computed when it was saved.
        armNext(context, store, jobId);

        if (!result.ok) {
            String title = job.optString("name", "Aevistle");
            // Gated on the switch that names it. This fired unconditionally
            // before, so turning "announce failures" off in the settings screen
            // changed nothing at all on this platform.
            if (store.notifyOnFailure()) {
                notifyFailure(context, jobId, "Scheduled send failed — " + title,
                        result.error == null ? "Unknown error" : result.error);
            }

            // Retryable classes get WorkManager's own backoff; a wrong password
            // would fail identically forever, so it is reported and dropped.
            String kind = result.errorKind == null ? "unknown" : result.errorKind;
            boolean retryable = "network".equals(kind) || "tls".equals(kind)
                    || "quota".equals(kind) || "unknown".equals(kind);
            int maxAttempts = job.optJSONObject("retry") == null
                    ? 3
                    : job.optJSONObject("retry").optInt("maxAttempts", 3);
            if (retryable && getRunAttemptCount() + 1 < maxAttempts) {
                // Not terminal — the ledger entry stays in 'sending' so a
                // crash during the wait for this retry still resolves towards
                // resending it (see AevistleScheduler#nextOccurrence), and the
                // next attempt reuses the same claimKey/messageId via
                // JobStore#ledgerEntryForJob above.
                return Result.retry();
            }
            if (claimKey != null) store.deleteLedgerEntry(claimKey);
            return Result.failure();
        }

        /*
         * From the store, not from the job.
         *
         * This read `job.optBoolean("notifyOnSuccess", false)`, and no job has
         * ever carried that key — `ScheduledJob` in `src/core/types.ts` does
         * not define it and nothing has ever written it. So the expression was
         * a constant `false`: a scheduled send that succeeded has never raised
         * a notification on Android, whatever the settings screen showed. It is
         * an application setting and now arrives as one, through `syncJobs`.
         */
        if (claimKey != null) store.deleteLedgerEntry(claimKey);
        if (store.notifyOnSuccess()) {
            notify(context, jobId, "Aevistle", "Sent: " + draft.optString("subject", ""));
        }
        return Result.success();
    }

    /**
     * Arm whatever comes next for this job, re-read from the store.
     *
     * Re-read rather than reusing the in-memory copy, because every path that
     * reaches here has just changed the occurrence list — a completed send, a
     * condition skip, or an instant somebody else already paid. Shared by all
     * three so none of them can be the one that forgets, which is how a job
     * stops firing altogether.
     */
    private static void armNext(Context context, JobStore store, String jobId) {
        JSONObject refreshed = store.job(jobId);
        if (refreshed == null) return;
        long next = AevistleScheduler.nextOccurrence(context, refreshed);
        if (next > 0) AevistleScheduler.armOne(context, jobId, next);

        // A send or a skip just consumed this job's occurrence — the one
        // schedule change `rearmAll` never sees, because nothing calls it on
        // this path. See `NextSendWidgetProvider`'s class comment.
        NextSendWidgetProvider.refresh(context);
    }

    /**
     * Delegated to {@link Notifier}, which is also what the plugin's
     * {@code notify} method uses. Two copies of channel setup was how the
     * plugin ended up with a comment claiming this worker delivered its
     * notifications while actually delivering none.
     */
    private void notify(Context context, String jobId, String title, String body) {
        Notifier.status(context, jobId, title, body);
    }

    /**
     * A send failure, with a "Retry now" action that runs this exact job
     * without opening the app.
     *
     * Only for this one call site — the plain SMTP failure — and not for the
     * condition-skip or missing-account notifications above: retrying either
     * of those would reach the same outcome every time (the condition is
     * still unmet; the account still does not exist), so offering a button
     * that always does nothing new would be worse than no button at all.
     * `jobId` doubles as the retry target, since that is exactly the job this
     * notification is about.
     */
    private void notifyFailure(Context context, String jobId, String title, String body) {
        String retryLabel = AppSettingsSignal.localizedContext(context)
                .getString(R.string.notify_retry_now);
        Notifier.status(context, jobId, title, body, jobId, retryLabel);
    }
}
