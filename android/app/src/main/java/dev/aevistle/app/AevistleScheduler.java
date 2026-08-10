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
     * the immediate alarm that pays it.
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

        if (owed > 0 && paysCatchUp(job)) {
            /*
             * Unless it was already paid. Every route into this method runs
             * repeatedly — boot, package replacement, the exact-alarm
             * permission changing, and every `syncJobs` the app makes — and the
             * web layer keeps the missed instant in its own copy of the job
             * until a run report round-trips back to it. So without this check
             * the same instant would be re-armed on each pass. The claim is
             * taken in {@link SendWorker}, where the send actually happens;
             * this only declines to wake up for work that is already done.
             */
            if (!new JobStore(context).occurrenceClaimed(job.optString("id", ""), owed)) {
                return now;
            }
        }
        return soonest;
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
