package dev.aevistle.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.WorkManager;

/**
 * Woken by the alarm; hands the actual send to WorkManager.
 *
 * A BroadcastReceiver gets roughly ten seconds before Android kills it, which
 * is nowhere near enough for an SMTP round trip with a 10 MB attachment on a
 * bad connection. Enqueuing expedited work moves the job somewhere it can take
 * its time and be retried.
 */
public class AlarmReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String jobId = intent.getStringExtra(AevistleScheduler.EXTRA_JOB_ID);
        if (jobId == null || jobId.isEmpty()) return;

        Data input = new Data.Builder()
                .putString(SendWorker.KEY_JOB_ID, jobId)
                .build();

        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(SendWorker.class)
                .setInputData(input)
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .addTag(SendWorker.TAG)
                .build();

        // KEEP, not REPLACE: if an earlier run for this job is still going, a
        // duplicate alarm must not start a second copy and send the mail twice.
        WorkManager.getInstance(context).enqueueUniqueWork(
                SendWorker.uniqueName(jobId),
                ExistingWorkPolicy.KEEP,
                request);
    }
}
