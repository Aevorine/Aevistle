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

        JSONObject draft = job.optJSONObject("draft");
        if (draft == null) return Result.failure();

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
        JSONObject refreshed = store.job(jobId);
        if (refreshed != null) {
            long next = AevistleScheduler.nextOccurrence(refreshed);
            if (next > 0) AevistleScheduler.armOne(context, jobId, next);
        }

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
     * Delegated to {@link Notifier}, which is also what the plugin's
     * {@code notify} method uses. Two copies of channel setup was how the
     * plugin ended up with a comment claiming this worker delivered its
     * notifications while actually delivering none.
     */
    private void notify(Context context, String jobId, String title, String body) {
        Notifier.status(context, jobId, title, body);
    }
}
