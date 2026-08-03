package dev.aevistle.app;

import android.content.Context;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

/**
 * Arms or cancels {@link InboxSyncWorker}'s periodic run based on whether any
 * account currently has receiving turned on.
 *
 * Called after every write to {@link InboxCache} that could change that
 * answer — a manual sync (which is how a newly-enabled account first gets
 * into the cache), or a credential delete (which is how a disable gets
 * noticed; see `AevistleNativePlugin.deleteSecret`). Cheap and idempotent
 * either way: `KEEP` leaves an already-running schedule alone rather than
 * resetting its 15-minute window on every save.
 */
final class InboxSyncScheduler {

    private static final long INTERVAL_MINUTES = 15;

    private InboxSyncScheduler() {
    }

    static void rearm(Context context) {
        WorkManager manager = WorkManager.getInstance(context);
        boolean anyEnabled = !new InboxCache(context).enabledAccounts().isEmpty();

        if (!anyEnabled) {
            manager.cancelUniqueWork(InboxSyncWorker.UNIQUE_NAME);
            return;
        }

        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();

        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                InboxSyncWorker.class, INTERVAL_MINUTES, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .addTag(InboxSyncWorker.UNIQUE_NAME)
                .build();

        manager.enqueueUniquePeriodicWork(
                InboxSyncWorker.UNIQUE_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request);
    }
}
