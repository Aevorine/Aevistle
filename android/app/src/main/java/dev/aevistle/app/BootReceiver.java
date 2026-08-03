package dev.aevistle.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Alarms do not survive a reboot, so every schedule has to be armed again.
 *
 * Also listens for the two "your app was updated / restored" broadcasts, which
 * clear alarms in exactly the same way and are easy to forget about — the
 * symptom is a reminder that quietly stops firing after a Play Store update.
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
        }
    }
}
