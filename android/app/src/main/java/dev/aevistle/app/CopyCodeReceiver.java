package dev.aevistle.app;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationManagerCompat;

/**
 * The "Copy" button on a verification-code notification.
 *
 * The code notification exists so a code can be read without switching apps,
 * and it stopped one step short of the thing people actually want: you could
 * read six digits and then had to leave the screen you were on, open this app,
 * and press the card. A notification action closes that gap — the code goes on
 * the clipboard from the shade, and the app is never opened at all.
 *
 * A {@link BroadcastReceiver} rather than an activity because that is the
 * distinction the user feels: an activity would bring the app to the front,
 * which is precisely what pressing Copy is meant to avoid. Nothing here touches
 * the network or the filesystem, so it finishes well inside a receiver's
 * ten-second budget.
 *
 * Not exported, and it must stay that way — see the manifest. An exported
 * receiver would let any app on the device drive this app's clipboard with a
 * string of its choosing.
 */
public class CopyCodeReceiver extends BroadcastReceiver {

    private static final String ACTION = "dev.aevistle.app.COPY_CODE";
    private static final String EXTRA_VALUE = "value";
    private static final String EXTRA_NOTIFICATION_ID = "notificationId";

    /**
     * The pending intent the notification's action button fires.
     *
     * `notificationId` travels with it so the notification can dismiss itself
     * once its one job is done: a code notification still sitting in the shade
     * after the code has been copied and used is a stale one, and the next
     * code's arrival would leave two of them there.
     *
     * The request code is derived from the notification id for the reason
     * spelled out in {@link Notifier#openApp}: `PendingIntent` matches on
     * everything *except* extras, so two codes sharing a request code would
     * have the second silently overwrite the first's value, and pressing Copy
     * on the older notification would paste the newer code.
     */
    static PendingIntent intentFor(Context context, String value, int notificationId) {
        Intent intent = new Intent(context, CopyCodeReceiver.class)
                .setAction(ACTION)
                .putExtra(EXTRA_VALUE, value)
                .putExtra(EXTRA_NOTIFICATION_ID, notificationId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getBroadcast(context, notificationId, intent, flags);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION.equals(intent.getAction())) return;
        String value = intent.getStringExtra(EXTRA_VALUE);
        if (value == null || value.isEmpty()) return;

        ClipboardManager clipboard = context.getSystemService(ClipboardManager.class);
        if (clipboard == null) return;
        /*
         * Labelled with the app's name rather than with the code. On Android 12
         * and below the system shows a toast quoting the clipboard label, and a
         * verification code read aloud on the screen of a phone somebody else
         * can see is not a feature. Same reasoning as `clipboardWrite` in the
         * plugin.
         */
        clipboard.setPrimaryClip(ClipData.newPlainText("Aevistle", value));

        int notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, -1);
        if (notificationId >= 0) {
            NotificationManagerCompat.from(context).cancel(notificationId);
        }
    }
}
