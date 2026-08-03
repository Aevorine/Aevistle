package dev.aevistle.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/**
 * Every notification this app raises, in one place.
 *
 * It used to be a private method on {@link SendWorker}, which meant the only
 * thing that could notify was a scheduled send. The plugin's {@code notify}
 * method — the one the whole JavaScript side calls, including the arrival of a
 * verification code — was an empty {@code call.resolve()} with a comment
 * claiming the worker's channel delivered it. Nothing did. It returned success
 * and produced nothing, on every platform call, for as long as it existed:
 * exactly the silent failure this application is built to avoid.
 *
 * Two channels, because they are two different kinds of interruption and a
 * phone should let you silence one without losing the other:
 *
 *   status — a scheduled send succeeded or failed. Informational.
 *   codes  — a verification code just arrived. Time-critical by nature; you
 *            are standing at another screen waiting for it.
 */
final class Notifier {

    static final String CHANNEL_STATUS = "aevistle_status";
    static final String CHANNEL_CODES = "aevistle_codes";

    /** Distinct bases so a code never replaces a send result, or the reverse. */
    private static final int ID_STATUS_BASE = 4100;
    private static final int ID_CODES_BASE = 4600;

    private Notifier() {
    }

    /** A scheduled send result. */
    static void status(Context context, String key, String title, String body) {
        post(context, CHANNEL_STATUS, "Aevistle status", "Results of scheduled sends",
                NotificationManager.IMPORTANCE_DEFAULT,
                ID_STATUS_BASE + Math.abs(key.hashCode() % 400), title, body);
    }

    /**
     * A verification code, carrying the code in the notification itself.
     *
     * `IMPORTANCE_HIGH` so it arrives as a heads-up: the entire value of this
     * notification is being readable without switching apps, and a code that
     * sits silently in the shade until you go looking has saved nobody
     * anything.
     */
    static void code(Context context, String key, String title, String body) {
        post(context, CHANNEL_CODES, "Verification codes",
                "A code arrived in your mail", NotificationManager.IMPORTANCE_HIGH,
                ID_CODES_BASE + Math.abs(key.hashCode() % 400), title, body);
    }

    private static void post(Context context, String channelId, String channelName,
                             String channelDescription, int importance, int id,
                             String title, String body) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(channelId, channelName, importance);
            channel.setDescription(channelDescription);
            // Creating an existing channel is a no-op, so this is safe to call
            // on every post and removes the need for a separate init step that
            // could be skipped on some path into the app.
            manager.createNotificationChannel(channel);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ActivityCompat.checkSelfPermission(context, "android.permission.POST_NOTIFICATIONS")
                != PackageManager.PERMISSION_GRANTED) {
            // The user declined notifications; the activity log still records
            // what happened, and the codes screen still holds the code.
            return;
        }

        Notification notification = new NotificationCompat.Builder(context, channelId)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle(title)
                .setContentText(body)
                // The code is in the title, and a title is what gets truncated
                // first on a narrow lock screen. BigTextStyle keeps the whole
                // thing readable when the shade is expanded.
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(openApp(context))
                .setAutoCancel(true)
                .build();

        NotificationManagerCompat.from(context).notify(id, notification);
    }

    /** Tapping it brings the app up, rather than doing nothing at all. */
    private static PendingIntent openApp(Context context) {
        Intent intent = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getActivity(context, 0, intent, flags);
    }
}
