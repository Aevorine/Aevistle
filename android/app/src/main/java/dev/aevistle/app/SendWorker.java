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
 * now honours that on a phone as well as on a desktop; and the occurrence claim
 * in {@link JobStore#claimOccurrence}, which is what makes an immediate alarm
 * for a missed reminder safe to arm repeatedly.
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
         * Which instant is being paid, and has it been paid already?
         *
         * `dueOccurrence` is the identity of this dispatch — the mirror of
         * `${job.id}:${fireAt}` in `electron/scheduler.ts`. It matters now that
         * {@link AevistleScheduler} arms an immediate alarm for an occurrence
         * missed while the device was off: everything that arms alarms runs
         * again on the next boot, the next package update and the next
         * `syncJobs`, so without a claim a phone that reboots twice would send
         * the same missed reminder twice.
         *
         * Only on the first attempt. A WorkManager retry is a continuation of a
         * dispatch that was already claimed, and re-checking would turn every
         * transient network failure into a permanently dropped send.
         *
         * -1 means no occurrence is due yet — an alarm that arrived a hair
         * early, or a list the web layer has already pruned on a retry. Sending
         * unclaimed is the old behaviour and the right one: an alarm that fired
         * is a reminder the user asked for.
         */
        long due = AevistleScheduler.dueOccurrence(job);
        if (due > 0 && getRunAttemptCount() == 0 && !store.claimOccurrence(jobId, due)) {
            // Somebody already sent this one. Consume the occurrence so the
            // alarm is not re-armed for it forever and the schedule row stops
            // offering a past instant as its next send, then move on.
            store.dropOccurrencesThrough(jobId, due);
            armNext(context, store, jobId);
            return Result.success();
        }

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
            return Result.failure();
        }

        String secret = new SecretStore(context).get(account.optString("id", ""), "smtp");
        MailSender.Result result = MailSender.send(context, draft, account, secret);

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
                notify(context, jobId, "Scheduled send failed — " + title,
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
            if (retryable && getRunAttemptCount() + 1 < maxAttempts) return Result.retry();
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
}
