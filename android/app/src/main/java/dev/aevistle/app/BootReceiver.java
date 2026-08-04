package dev.aevistle.app;

import android.app.AlarmManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * Alarms do not survive a reboot, so every schedule has to be armed again.
 *
 * Also listens for the two "your app was updated / restored" broadcasts, which
 * clear alarms in exactly the same way and are easy to forget about — the
 * symptom is a reminder that quietly stops firing after a Play Store update.
 *
 * And for the moment the user grants "Alarms &amp; reminders". Every alarm
 * armed before that point was set with {@code setAndAllowWhileIdle} — Doze is
 * free to batch those, which is the whole reason the user was asked. Without
 * re-arming, granting the permission would change nothing until the next time
 * the app happened to be opened, and the user would reasonably conclude the
 * setting does not work. Android sends this broadcast to manifest receivers
 * specifically so an app can do this.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) return;

        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)) {
            AevistleScheduler.rearmAll(context);
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED.equals(action)) {
            // Re-check rather than assume: the broadcast says the state moved,
            // not which way, and the permission can be revoked again between it
            // being sent and this running. `rearmAll` asks `canScheduleExactAlarms`
            // itself for every alarm it sets, so calling it is the check.
            AevistleScheduler.rearmAll(context);
        }
    }
}
