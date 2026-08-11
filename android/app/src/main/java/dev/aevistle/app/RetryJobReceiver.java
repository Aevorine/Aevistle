package dev.aevistle.app;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationManagerCompat;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.WorkManager;

/**
 * The "Retry now" button on a failed scheduled-send notification.
 *
 * Same reasoning as {@link CopyCodeReceiver} and {@link MarkReadReceiver}: a
 * {@link BroadcastReceiver} rather than an activity, because pressing the
 * button must not bring the app to the front, and enqueuing work is not
 * something that needs one to.
 *
 * The enqueue itself mirrors {@link AlarmReceiver} exactly — same worker,
 * same unique name, same {@code KEEP} policy — because this *is* the same
 * dispatch an alarm firing for this job would produce. {@link SendWorker}
 * cannot tell the difference and does not need to: it re-reads the job fresh
 * from {@link JobStore}, re-checks send conditions, and claims its own
 * dispatch-ledger entry the same way either path would.
 *
 * Not exported, and must stay that way — an exported receiver would let any
 * app on the device make this app send a scheduled job's mail on demand by
 * broadcasting its id.
 */
public class RetryJobReceiver extends BroadcastReceiver {

    private static final String ACTION = "dev.aevistle.app.RETRY_JOB";
    private static final String EXTRA_JOB_ID = "jobId";
    private static final String EXTRA_NOTIFICATION_ID = "notificationId";

    static PendingIntent intentFor(Context context, String jobId, int notificationId) {
        Intent intent = new Intent(context, RetryJobReceiver.class)
                .setAction(ACTION)
                .putExtra(EXTRA_JOB_ID, jobId)
                .putExtra(EXTRA_NOTIFICATION_ID, notificationId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        // The request code is the notification id, same as CopyCodeReceiver —
        // one job can fail more than once, and each failure's own button must
        // retry *that* attempt's job id rather than PendingIntent's
        // extras-blind matching silently handing an older notification's
        // button the newest failure's id.
        return PendingIntent.getBroadcast(context, notificationId, intent, flags);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION.equals(intent.getAction())) return;
        String jobId = intent.getStringExtra(EXTRA_JOB_ID);
        if (jobId == null || jobId.isEmpty()) return;

        Data input = new Data.Builder()
                .putString(SendWorker.KEY_JOB_ID, jobId)
                .build();

        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(SendWorker.class)
                .setInputData(input)
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .addTag(SendWorker.TAG)
                .build();

        // KEEP, not REPLACE — see AlarmReceiver: if a run for this job is
        // somehow already in flight, a second tap must not start a duplicate
        // send.
        WorkManager.getInstance(context).enqueueUniqueWork(
                SendWorker.uniqueName(jobId),
                ExistingWorkPolicy.KEEP,
                request);

        int notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, -1);
        if (notificationId >= 0) {
            NotificationManagerCompat.from(context).cancel(notificationId);
        }
    }
}
