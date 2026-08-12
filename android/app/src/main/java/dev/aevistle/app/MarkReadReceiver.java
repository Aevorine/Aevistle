package dev.aevistle.app;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationManagerCompat;

/**
 * The "Mark as read" button on a new-mail notification.
 *
 * Same reasoning as {@link CopyCodeReceiver}: a {@link BroadcastReceiver}
 * rather than an activity, because pressing the button must not bring the app
 * to the front.
 *
 * Split in two, deliberately. What happens here is instant and cannot fail on
 * a network — the cache write the Inbox screen reads, and dismissing the
 * notification — so the tap is answered the moment it is made. The server side
 * of the same change is queued by {@link InboxCache#markSeen} and pushed by
 * {@link InboxFlagWorker}, because an IMAP connect, log in and STORE can
 * outlast a receiver's ten-second budget on mobile data, and because it has to
 * survive being made with no signal at all. Doing it inline was never an
 * option; doing it *nowhere*, which is what this used to do, meant the next
 * sync read `\Seen` off the server and put the message straight back to unread.
 *
 * Not exported, and must stay that way — an exported receiver would let any
 * app on the device mark arbitrary messages read (or worse, feed it an
 * account/message id pair of its own choosing) by broadcasting the action.
 */
public class MarkReadReceiver extends BroadcastReceiver {

    private static final String ACTION = "dev.aevistle.app.MARK_READ";
    private static final String EXTRA_ACCOUNT_ID = "accountId";
    private static final String EXTRA_MESSAGE_ID = "messageId";
    private static final String EXTRA_NOTIFICATION_ID = "notificationId";

    static PendingIntent intentFor(Context context, String accountId, String messageId,
                                   int notificationId) {
        Intent intent = new Intent(context, MarkReadReceiver.class)
                .setAction(ACTION)
                .putExtra(EXTRA_ACCOUNT_ID, accountId)
                .putExtra(EXTRA_MESSAGE_ID, messageId)
                .putExtra(EXTRA_NOTIFICATION_ID, notificationId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        // Request code from the notification id, same as CopyCodeReceiver —
        // PendingIntent matches on everything but extras, so two mail
        // notifications sharing a request code would have the second silently
        // overwrite the first's account/message pair.
        return PendingIntent.getBroadcast(context, notificationId, intent, flags);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION.equals(intent.getAction())) return;
        String accountId = intent.getStringExtra(EXTRA_ACCOUNT_ID);
        String messageId = intent.getStringExtra(EXTRA_MESSAGE_ID);
        if (accountId == null || accountId.isEmpty() || messageId == null || messageId.isEmpty()) return;

        new InboxCache(context).markSeen(accountId, messageId);

        int notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, -1);
        if (notificationId >= 0) {
            NotificationManagerCompat.from(context).cancel(notificationId);
        }

        // Last, and only after the queue entry above is on disk: the worker
        // reads that queue, and enqueuing it first would let it run against a
        // queue this receiver had not written to yet.
        InboxFlagWorker.kick(context);
    }
}
