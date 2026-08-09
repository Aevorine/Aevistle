package dev.aevistle.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.BitmapFactory;
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
 * Three channels, because they are three different kinds of interruption and a
 * phone should let you silence one without losing the others:
 *
 *   status — a scheduled send succeeded or failed. Informational.
 *   codes  — a verification code just arrived. Time-critical by nature; you
 *            are standing at another screen waiting for it.
 *   mail   — ordinary mail arrived. Quiet by design: {@code IMPORTANCE_DEFAULT}
 *            with no heads-up, because a newsletter that jumps in front of what
 *            you are doing is how people turn an app's notifications off
 *            wholesale, taking the code channel with them.
 *
 * Three things this class does that the first version did not, and each was a
 * separate complaint about the notifications not being good enough:
 *
 *   - it wears the app's own icon. The small icon was
 *     {@code android.R.drawable.stat_notify_sync}, the platform's generic sync
 *     glyph, so a notification from this app was visually indistinguishable
 *     from any background sync on the device. {@code ic_notification} plus
 *     {@code setColor} and a large launcher icon fixes that at all three sizes
 *     the shade uses.
 *   - tapping it goes somewhere. Every notification used to open the app on
 *     whatever screen it was last on. A mail notification now carries its
 *     message id through to {@link MainActivity}, which hands it to the
 *     WebView, which opens that message.
 *   - a code can be copied without opening anything. The whole point of the
 *     code notification is not having to switch apps, and it stopped one step
 *     short of that — you could read the code but then had to type it. The
 *     action button writes it straight to the clipboard.
 */
final class Notifier {

    static final String CHANNEL_STATUS = "aevistle_status";
    static final String CHANNEL_CODES = "aevistle_codes";
    static final String CHANNEL_MAIL = "aevistle_mail";

    /** Distinct bases so a code never replaces a send result, or the reverse. */
    private static final int ID_STATUS_BASE = 4100;
    private static final int ID_CODES_BASE = 4600;
    private static final int ID_MAIL_BASE = 5100;

    /**
     * The id the mail *summary* notification always occupies.
     *
     * Fixed rather than hashed: there is exactly one summary at a time and each
     * new one must replace the last, which is what makes the group collapse
     * into a single row rather than accumulating a stack of "3 new messages",
     * "5 new messages", "6 new messages".
     */
    private static final int ID_MAIL_SUMMARY = ID_MAIL_BASE - 1;

    /** Groups the per-message notifications under one expandable heading. */
    private static final String GROUP_MAIL = "dev.aevistle.app.MAIL";

    /** Extra on the tap intent: which inbox message to open. See MainActivity. */
    static final String EXTRA_MESSAGE_ID = "dev.aevistle.app.OPEN_MESSAGE_ID";

    private Notifier() {
    }

    /** A scheduled send result. */
    static void status(Context context, String key, String title, String body) {
        NotificationCompat.Builder builder = base(context, CHANNEL_STATUS, "Aevistle status",
                "Results of scheduled sends", NotificationManager.IMPORTANCE_DEFAULT, title, body);
        post(context, ID_STATUS_BASE + slot(key), builder);
    }

    /**
     * A verification code, carrying the code in the notification itself.
     *
     * `IMPORTANCE_HIGH` so it arrives as a heads-up: the entire value of this
     * notification is being readable without switching apps, and a code that
     * sits silently in the shade until you go looking has saved nobody
     * anything.
     *
     * `value` is the bare code — what the Copy action puts on the clipboard.
     * Passing it separately rather than parsing it back out of the title is the
     * difference between a button that pastes `482913` and one that pastes
     * "Verification code: 482 913".
     */
    static void code(Context context, String key, String title, String body, String value,
                     String copyLabel) {
        NotificationCompat.Builder builder = base(context, CHANNEL_CODES, "Verification codes",
                "A code arrived in your mail", NotificationManager.IMPORTANCE_HIGH, title, body);
        int id = ID_CODES_BASE + slot(key);
        if (value != null && !value.isEmpty()) {
            // Icon 0 — Android 7 and later draw notification actions as text
            // only, and supplying a glyph nothing renders is a resource to
            // keep in step for no visible gain.
            builder.addAction(0, copyLabel, CopyCodeReceiver.intentFor(context, value, id));
        }
        post(context, id, builder);
    }

    /**
     * Ordinary mail arrived.
     *
     * Grouped, and that is the whole reason this takes a message id rather than
     * being another call to {@link #status}: five separate rows for five
     * messages is how a notification shade becomes something people swipe away
     * without reading. Android collapses everything sharing {@link #GROUP_MAIL}
     * behind the summary posted by {@link #mailSummary}, so the shade shows one
     * line that expands into the individual senders.
     *
     * @param messageId the inbox message to open on tap; may be null for a
     *                  notification that has no single message behind it.
     */
    static void mail(Context context, String key, String title, String body, String messageId) {
        NotificationCompat.Builder builder = base(context, CHANNEL_MAIL, "New mail",
                "Mail arriving in a mailbox you receive from",
                NotificationManager.IMPORTANCE_DEFAULT, title, body);
        builder.setGroup(GROUP_MAIL);
        builder.setContentIntent(openApp(context, messageId));
        post(context, ID_MAIL_BASE + slot(key), builder);
    }

    /**
     * The one line the mail group collapses to.
     *
     * Only meaningful alongside at least two {@link #mail} notifications —
     * Android shows a lone child directly and ignores the summary — so callers
     * post it once, after the children, when there is more than one.
     */
    static void mailSummary(Context context, String title, String body) {
        NotificationCompat.Builder builder = base(context, CHANNEL_MAIL, "New mail",
                "Mail arriving in a mailbox you receive from",
                NotificationManager.IMPORTANCE_DEFAULT, title, body);
        builder.setGroup(GROUP_MAIL);
        builder.setGroupSummary(true);
        post(context, ID_MAIL_SUMMARY, builder);
    }

    /**
     * A stable, bounded notification id for a key.
     *
     * `Math.abs` on a hash is not enough on its own: `Integer.MIN_VALUE` is its
     * own absolute value in two's complement, so a key hashing to exactly that
     * produced a negative slot and, added to the base, an id in a neighbouring
     * range. Masking the sign bit off first cannot.
     */
    private static int slot(String key) {
        return (key.hashCode() & 0x7fffffff) % 400;
    }

    /**
     * Everything every notification here shares: the app's marks, the tap
     * target, and the long-body style.
     */
    private static NotificationCompat.Builder base(Context context, String channelId,
                                                   String channelName, String channelDescription,
                                                   int importance, String title, String body) {
        ensureChannel(context, channelId, channelName, channelDescription, importance);
        return new NotificationCompat.Builder(context, channelId)
                .setSmallIcon(R.drawable.ic_notification)
                // Tints the small icon and the app-name line. Without it the
                // system picks a neutral grey and the result reads as a
                // platform message rather than as this app's.
                .setColor(androidx.core.content.ContextCompat.getColor(context, R.color.notification_accent))
                .setLargeIcon(BitmapFactory.decodeResource(context.getResources(), R.mipmap.ic_launcher))
                .setContentTitle(title)
                .setContentText(body)
                // The code is in the title, and a title is what gets truncated
                // first on a narrow lock screen. BigTextStyle keeps the whole
                // thing readable when the shade is expanded.
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(openApp(context, null))
                .setAutoCancel(true);
    }

    /** Creating an existing channel is a no-op, so this is safe on every post. */
    private static void ensureChannel(Context context, String channelId, String channelName,
                                      String channelDescription, int importance) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(channelId, channelName, importance);
        channel.setDescription(channelDescription);
        manager.createNotificationChannel(channel);
    }

    private static void post(Context context, int id, NotificationCompat.Builder builder) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ActivityCompat.checkSelfPermission(context, Permissions.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            // The user declined notifications; the activity log still records
            // what happened, and the codes screen still holds the code.
            return;
        }
        Notification notification = builder.build();
        NotificationManagerCompat.from(context).notify(id, notification);
    }

    /**
     * Tapping it brings the app up — and, when the notification is about one
     * particular message, brings it up on that message.
     *
     * The id travels as an intent extra rather than through a live channel to
     * the WebView, because on the path that matters most there is no WebView:
     * the tap may be what starts the app, fifteen minutes after a background
     * sync ran with the process dead. {@link MainActivity} parks it and the
     * page collects it when it is ready.
     *
     * The request code is derived from the message id. `PendingIntent` treats
     * two intents differing only in their extras as the *same* pending intent
     * and, with `FLAG_UPDATE_CURRENT`, quietly rewrites the first one's extras
     * to match the second — so five mail notifications would all have ended up
     * opening whichever message arrived last.
     */
    private static PendingIntent openApp(Context context, String messageId) {
        Intent intent = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (messageId != null && !messageId.isEmpty()) {
            intent.putExtra(EXTRA_MESSAGE_ID, messageId);
        }
        int requestCode = messageId == null ? 0 : (messageId.hashCode() & 0x7fffffff);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getActivity(context, requestCode, intent, flags);
    }
}
