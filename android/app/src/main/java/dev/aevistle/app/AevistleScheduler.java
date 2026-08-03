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

            long next = nextOccurrence(job);
            if (next <= 0) continue;

            arm(context, alarms, jobId, next);
        }
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

    /** The earliest occurrence still in the future, or -1 when there is none. */
    static long nextOccurrence(JSONObject job) {
        JSONArray occurrences = job.optJSONArray("occurrences");
        if (occurrences == null) return -1;
        long now = System.currentTimeMillis();
        long best = -1;
        for (int i = 0; i < occurrences.length(); i++) {
            long at = occurrences.optLong(i, 0L);
            if (at > now && (best < 0 || at < best)) best = at;
        }
        return best;
    }
}
