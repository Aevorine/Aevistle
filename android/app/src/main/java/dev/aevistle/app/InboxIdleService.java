package dev.aevistle.app;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * The other half of "even with the app closed": a foreground service that
 * keeps {@link InboxSyncRunner} running every couple of minutes instead of
 * waiting on {@link InboxSyncWorker}'s 15-minute WorkManager floor.
 *
 * Why a service and not just a shorter WorkManager interval: WorkManager
 * will not honor anything under fifteen minutes for periodic work, and even
 * that floor is Doze/App-Standby's to stretch once it decides this process
 * is idle. A *foreground* service is the one category of background work
 * Android exempts from that throttling — in exchange for the one thing this
 * class cannot avoid giving back: a visible, unclosable notification for as
 * long as it runs. {@link Notifier#foregroundSyncing} keeps that about as
 * quiet as a notification can be (`IMPORTANCE_MIN`, no sound, no status-bar
 * icon), because it exists to satisfy the platform requirement, not to tell
 * the user anything they need to see.
 *
 * What this deliberately does not do is replace the worker. A manufacturer's
 * own background-app manager (see {@code Permissions.java}'s header) can
 * still refuse to let this service start or keep it running at all, on top
 * of stock Doze; the 15-minute floor is what still applies when it does. Nor
 * does it hold a real IMAP IDLE connection open — that would mean teaching
 * `MailFetcher`'s pooled, endpoint-laddered `Store` handling how to sit in a
 * blocking `IMAPFolder.idle()` call per account, which is a larger change
 * than turning "at best every fifteen minutes, possibly much longer" into
 * "every couple of minutes, reliably" — the gap this exists to close.
 */
public class InboxIdleService extends Service {

    private static final String TAG = "InboxIdleService";

    /**
     * How often to repeat {@link InboxSyncRunner#runOnce} while this service
     * is alive.
     *
     * Short enough that "closed the app, mail arrived, got told" reads as
     * prompt rather than as the old fifteen-minute wait; long enough not to
     * hammer a mail server or the battery for an app whose whole selling
     * point on this platform, next to the ordinary polling floor, is doing
     * less of exactly that. Not configurable — this is the same tradeoff
     * `RECYCLE_MS` and `BACKOFF_MAX_MS` make on the desktop side, picked once
     * rather than exposed as a setting nobody has enough information to set
     * better than this.
     */
    private static final long INTERVAL_SECONDS = 90;

    private ScheduledExecutorService executor;
    private ScheduledFuture<?> task;

    /**
     * Start (or leave running) the foreground sync loop.
     *
     * Safe to call whether or not it is already running — {@link
     * InboxSyncScheduler#rearm} calls this unconditionally alongside its own
     * WorkManager (re)arm rather than tracking service state separately.
     * {@code ContextCompat.startForegroundService} is what makes this legal
     * to call from a background thread on Android 8+: a plain {@code
     * startService} there would throw once the calling process itself is no
     * longer in the foreground.
     */
    static void start(Context context) {
        ContextCompat.startForegroundService(context, new Intent(context, InboxIdleService.class));
    }

    /** Stop the loop — called when the last receiving account is disabled. */
    static void stop(Context context) {
        context.stopService(new Intent(context, InboxIdleService.class));
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        // Required within seconds of `startForegroundService` returning, and
        // unconditionally: this also runs after the system recreates a
        // killed process with `intent == null`, which is exactly the case
        // `START_STICKY` exists for.
        Context localized = AppSettingsSignal.localizedContext(this);
        startForeground(Notifier.ID_SYNC_FOREGROUND, Notifier.foregroundSyncing(
                localized,
                localized.getString(R.string.notify_sync_title),
                localized.getString(R.string.notify_sync_body)));

        if (new InboxCache(this).enabledAccounts().isEmpty()) {
            // Nothing to watch — a stale restart after the last account was
            // disabled, or `start()` racing a `stop()`. Stopping here rather
            // than never starting the loop below is what keeps this correct
            // in both orderings.
            stopSelf();
            return START_NOT_STICKY;
        }

        if (task == null || task.isCancelled()) {
            if (executor == null || executor.isShutdown()) {
                executor = Executors.newSingleThreadScheduledExecutor();
            }
            task = executor.scheduleWithFixedDelay(this::runSafely, 0, INTERVAL_SECONDS, TimeUnit.SECONDS);
        }
        return START_STICKY;
    }

    private void runSafely() {
        try {
            InboxSyncRunner.runOnce(getApplicationContext());
        } catch (Exception e) {
            // A pass that throws should not take the loop down with it — the
            // next scheduled run is the retry, the same shape `InboxSyncWorker`
            // gets for free from `Result.retry()`.
            Log.w(TAG, "runSafely: a sync pass failed", e);
        }
    }

    /**
     * Android 15's budget for a {@code dataSync} foreground service: six
     * hours of running time per rolling 24-hour window, after which the
     * system calls this instead of just killing the process. Stopping
     * cleanly here — rather than letting the platform do it — is what lets
     * `onDestroy` release the pooled IMAP connections instead of abandoning
     * them; the 15-minute worker keeps covering mail while this service is
     * off the clock, and the next {@code rearm} (a sync, a paired account, a
     * reboot) starts a fresh budget.
     */
    @Override
    public void onTimeout(int startId, int fgsType) {
        stopSelf();
    }

    @Override
    public void onDestroy() {
        if (task != null) task.cancel(false);
        if (executor != null) executor.shutdown();
        // Same reasoning as `InboxSyncWorker`'s finally block: once this
        // service is no longer alive to reuse them, a parked connection is
        // just a socket nothing will ever close.
        MailFetcher.closeIdleConnections();
        super.onDestroy();
    }
}
