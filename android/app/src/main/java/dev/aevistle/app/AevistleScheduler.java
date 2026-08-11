package dev.aevistle.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Turns the precomputed occurrence lists into Android alarms.
 *
 * Why AlarmManager and not WorkManager's initialDelay: WorkManager batches
 * work to save battery and will happily run a job twenty minutes late. That is
 * fine for a sync, and useless for "remind the team at 09:00". So an exact
 * alarm does the waking, and WorkManager does the actual send — it is the part
 * that survives process death and handles retry properly.
 *
 * On Android 12+ exact alarms need a permission the user can revoke. When it
 * is not granted we fall back to an inexact alarm rather than failing: a
 * reminder a few minutes late still beats no reminder, and the UI says so.
 */
final class AevistleScheduler {

    private static final String TAG = "AevistleScheduler";
    static final String ACTION_FIRE = "dev.aevistle.app.FIRE_JOB";
    static final String EXTRA_JOB_ID = "jobId";

    private AevistleScheduler() {
    }

    /** Cancel everything we previously armed, then arm the current set. */
    static void rearmAll(Context context) {
        JobStore store = new JobStore(context);
        JSONArray jobs = store.jobs();
        String localDeviceId = store.localDeviceId();
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        if (alarms == null) return;

        for (int i = 0; i < jobs.length(); i++) {
            JSONObject job = jobs.optJSONObject(i);
            if (job == null) continue;

            String jobId = job.optString("id", "");
            if (jobId.isEmpty()) continue;

            PendingIntent existing = pendingIntent(context, jobId, PendingIntent.FLAG_NO_CREATE);
            if (existing != null) {
                alarms.cancel(existing);
                existing.cancel();
            }

            if (!job.optBoolean("enabled", false)) continue;
            // Assigned to a different device — see `isMyJob`. The cancel
            // above already dropped any alarm this device had previously
            // armed for it, so there is nothing left to do.
            if (!isMyJob(job, localDeviceId)) continue;

            long next = nextOccurrence(context, job);
            if (next <= 0) continue;

            arm(context, alarms, jobId, next);
        }

        // Every path that reaches `rearmAll` — `syncJobs`, a reboot, an app
        // update, the exact-alarm permission changing — is exactly a path
        // that may have moved the soonest still-future occurrence. See
        // `NextSendWidgetProvider`'s class comment for the other refresh site.
        NextSendWidgetProvider.refresh(context);
    }

    /**
     * Whether *this* device is allowed to let `job` actually fire — mirrors
     * `Scheduler.isMyJob` in `electron/scheduler.ts`; see its doc for why
     * absent `executorDeviceId` or an unknown `localDeviceId` both default to
     * "yes, arm it" rather than refusing.
     */
    static boolean isMyJob(JSONObject job, String localDeviceId) {
        String executorDeviceId = job.optString("executorDeviceId", "");
        return executorDeviceId.isEmpty() || localDeviceId == null || executorDeviceId.equals(localDeviceId);
    }

    static void armOne(Context context, String jobId, long triggerAt) {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        if (alarms != null) arm(context, alarms, jobId, triggerAt);
    }

    private static void arm(Context context, AlarmManager alarms, String jobId, long triggerAt) {
        PendingIntent intent = pendingIntent(context, jobId, PendingIntent.FLAG_UPDATE_CURRENT);
        if (intent == null) return;

        boolean canBeExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms();
        try {
            if (canBeExact) {
                alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, intent);
            } else {
                alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, intent);
            }
        } catch (SecurityException e) {
            // The permission was revoked between the check and the call.
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, intent);
            Log.w(TAG, "exact alarm denied, fell back to inexact", e);
        }
    }

    private static PendingIntent pendingIntent(Context context, String jobId, int extraFlags) {
        Intent intent = new Intent(context, AlarmReceiver.class)
                .setAction(ACTION_FIRE)
                .putExtra(EXTRA_JOB_ID, jobId);
        return PendingIntent.getBroadcast(
                context,
                jobId.hashCode(),
                intent,
                extraFlags | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * When to wake for this job next, or -1 when there is nothing to arm.
     *
     * Usually the earliest occurrence still ahead of us. But an occurrence that
     * is already *past* means a reminder was missed while the device was off,
     * and this returned -1 for it: the whole list was filtered to
     * {@code at > now}, so the missed instant was dropped on the floor and
     * nothing on this side ever read `occurrences` again. The web layer had
     * already done its half of the work — `rearm` in `src/core/schedule.ts`
     * puts the missed instant back at the head of the list precisely so the
     * platform scheduler can pay it, and `electron/scheduler.ts`'s `tick()`
     * does. The phone threw it away, so the two platforms disagreed about
     * whether a reminder missed overnight ever arrives. It did not, here.
     *
     * A backlog collapses to its most recent entry — waking a phone after a
     * week owes one reminder, not seven — and is armed for *now*, which is
     * the immediate alarm that pays it, unless the dispatch ledger says that
     * instant was already handled — see the restart-recovery block below.
     */
    static long nextOccurrence(Context context, JSONObject job) {
        JSONArray occurrences = job.optJSONArray("occurrences");
        if (occurrences == null) return -1;

        long now = System.currentTimeMillis();
        long soonest = -1;
        long owed = -1;
        for (int i = 0; i < occurrences.length(); i++) {
            long at = occurrences.optLong(i, 0L);
            if (at <= 0) continue;
            if (at > now) {
                if (soonest < 0 || at < soonest) soonest = at;
            } else if (at > owed) {
                owed = at;
            }
        }

        if (owed > 0) {
            /*
             * Restart recovery — the dispatch-ledger mirror of
             * `resolveLedgerEntryOnRestart` in `src/core/dispatchLedger.ts`.
             * Every route into this method runs repeatedly — boot, package
             * replacement, the exact-alarm permission changing, every
             * `syncJobs` the app makes — so a {@link SendWorker} that started
             * dispatching `owed` and never got to finish (a crash, an OS kill,
             * a force-stop) leaves a ledger entry behind for exactly this
             * check to find.
             *
             * Checked before, and independently of, {@link #paysCatchUp}
             * below: a dispatch that may already be in flight is a different
             * question from whether a *merely missed, never-attempted*
             * reminder is still worth firing late, and a job that opts out of
             * catch-up must not leave a crashed send's occurrence stuck in its
             * list forever — either unresent, or, worse, unrecorded if it did
             * go out.
             */
            JobStore store = new JobStore(context);
            String jobId = job.optString("id", "");
            String claimKey = JobStore.ledgerClaimKey(jobId, owed);
            JSONObject entry = store.ledgerEntry(claimKey);

            if (entry != null) {
                if ("accepted".equals(entry.optString("state", "claimed"))) {
                    // Positive proof the SMTP server already accepted this
                    // message — resending would be a guaranteed duplicate for
                    // no benefit. Catch the bookkeeping up instead; do not wake.
                    completeAcceptedOccurrence(store, jobId, owed, entry);
                    return soonest;
                }
                // 'claimed' or 'sending': no confirmed evidence the SMTP call
                // this entry describes ever completed — it may have succeeded,
                // failed, or never reached the server, and there is no way to
                // tell from here. The new policy resolves that ambiguity
                // towards resending rather than towards silence (see
                // src/core/dispatchLedger.ts). Drop the stale entry and wake
                // now so SendWorker claims it fresh.
                store.deleteLedgerEntry(claimKey);
                return now;
            }

            // No ledger entry at all: an ordinary occurrence missed while the
            // device was off or asleep, never even attempted. Whether that
            // still deserves an immediate wake is the job's own catch-up
            // policy, unchanged from before this ledger existed.
            if (paysCatchUp(job)) return now;
        }
        return soonest;
    }

    /**
     * Positive proof this occurrence's SMTP attempt was already accepted
     * before whatever stopped this device short — catch the job's own
     * bookkeeping up to that fact via the same {@link JobStore#recordRun} a
     * live successful send uses (mirrors `completeAcceptedRecovery` in
     * `electron/scheduler.ts`, which reuses its live send path's
     * `completeRun` the same way), tell an app that happens to be open right
     * now, and clear the entry. No send is attempted and no send condition is
     * re-evaluated — the send already genuinely happened.
     */
    private static void completeAcceptedOccurrence(
            JobStore store, String jobId, long occurrenceMs, JSONObject entry) {
        String messageId = entry.optString("messageId", null);
        JSONObject run = store.completeAcceptedRecovery(jobId, occurrenceMs);
        store.deleteLedgerEntry(JobStore.ledgerClaimKey(jobId, occurrenceMs));
        // Null means the job's own bookkeeping already caught up with this
        // occurrence in an earlier pass — see completeAcceptedRecovery's doc.
        if (run == null) return;

        JSONObject result = new JSONObject();
        try {
            result.put("ok", true);
            if (messageId != null) result.put("messageId", messageId);
            result.put("accepted", new JSONArray());
            result.put("rejected", new JSONArray());
            result.put("durationMs", 0);
        } catch (Exception e) {
            Log.w(TAG, "completeAcceptedOccurrence: could not build the recovered send result", e);
        }
        AevistleNativePlugin.emitJobEvent(jobId, System.currentTimeMillis(), result, run);
    }

    /**
     * Does this job's catch-up policy owe a missed occurrence?
     *
     * `'fireOnce'` and nothing else, which needs saying because the two halves
     * of the desktop disagree: `rearm` produces a backlog only for `fireOnce`,
     * while `tick()` fires anything it finds unless the policy is `'skip'`.
     * They differ on a policy that is absent.
     *
     * `rearm` is the one to match. It is the gate that decides whether a
     * missed instant is in the list at all when a machine comes back from
     * being off, which is exactly the situation this method is asked about —
     * on the desktop `tick()` never sees such an instant, because the renderer
     * re-armed before the scheduler was told anything. `tick()`'s looser rule
     * applies to an instant that elapsed while the process was running, and the
     * Android equivalent of that is an alarm AlarmManager delivers late, which
     * fires without consulting this list at all.
     *
     * So: absent or unrecognised means no catch-up, matching
     * `rec.catchUp === 'fireOnce'`. `defaultRecurrence()` sets `fireOnce`, so
     * the default is still to pay.
     */
    private static boolean paysCatchUp(JSONObject job) {
        JSONObject recurrence = job.optJSONObject("recurrence");
        return recurrence != null && "fireOnce".equals(recurrence.optString("catchUp", ""));
    }

    /**
     * The most recent occurrence that is already due, or -1 when none is.
     *
     * What {@link SendWorker} claims before it sends. Deliberately *not* gated
     * on the catch-up policy: this is the identity of the instant being paid,
     * used to stop it being paid twice, and an ordinary on-time alarm needs
     * that protection just as much as a catch-up does.
     */
    static long dueOccurrence(JSONObject job) {
        JSONArray occurrences = job.optJSONArray("occurrences");
        if (occurrences == null) return -1;
        long now = System.currentTimeMillis();
        long best = -1;
        for (int i = 0; i < occurrences.length(); i++) {
            long at = occurrences.optLong(i, 0L);
            if (at > 0 && at <= now && at > best) best = at;
        }
        return best;
    }
}
