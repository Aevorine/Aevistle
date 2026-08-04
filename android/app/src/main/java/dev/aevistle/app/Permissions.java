package dev.aevistle.app;

import android.app.AlarmManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;

/**
 * The two permissions this app cannot do its job without, and the honest state
 * of each one.
 *
 * Both were declared in the manifest and never asked for. That is not a small
 * omission on either count:
 *
 *   POST_NOTIFICATIONS became a runtime permission in Android 13 (API 33). A
 *   permission that is declared but never requested is *denied*, so
 *   {@link Notifier} took its early return on every phone sold since 2022 and
 *   no notification this app raised has ever appeared on one.
 *
 *   SCHEDULE_EXACT_ALARM stopped being granted at install time in Android 14
 *   for apps that are not alarm clocks. Without it {@link AevistleScheduler}
 *   degrades to {@code setAndAllowWhileIdle}, which Doze is free to batch — so
 *   "09:00" becomes "some time after 09:00" for an app whose entire promise is
 *   that it sends on time.
 *
 * Neither is fixed by asking harder. Notifications get one system dialog, at a
 * moment when the reason for it is on screen; exact alarms get no dialog at all
 * (only a settings screen), so the app has to explain and then take the user
 * there. What this class provides is the state to say that with, and the two
 * intents to act on it. Nothing here fires an intent on its own — every entry
 * point is reached from a user action.
 */
final class Permissions {

    static final String POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS";
    /** The handle {@code requestPermissionForAlias} and Capacitor's cache use. */
    static final String ALIAS_NOTIFICATIONS = "notifications";

    /** The permission is held, or the platform never required it. */
    static final String GRANTED = "granted";
    /** Asking would produce the system dialog. */
    static final String PROMPT = "prompt";
    /** Asking would do nothing; only the settings screen can change this. */
    static final String BLOCKED = "blocked";
    /** Exact alarms are not permissioned on this Android version. */
    static final String NOT_REQUIRED = "not-required";
    /** Exact alarms are permissioned, and refused. */
    static final String DENIED = "denied";

    private static final String PREFS = "aevistle_permissions";
    /**
     * Set when the user does something that makes notifications matter — arms a
     * reminder, turns on an inbox — and cleared by the one prompt it earns.
     *
     * The flag exists so the dialog is never raised by app launch. Cold start
     * calls {@code syncJobs} with the jobs that were already armed, which is
     * indistinguishable from arming them again unless somebody remembers which
     * ones were there before. See {@link #noteNewlyArmed}.
     */
    private static final String KEY_PROMPT_DUE = "notificationPromptDue";

    private Permissions() {
    }

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    /**
     * Where notifications stand, folding two separate switches into one answer.
     *
     * Capacitor's permission state covers the runtime grant, and it is the only
     * thing that can tell "never asked" from "asked and permanently refused" —
     * it caches that at the moment of refusal, which is the only moment Android
     * makes it visible. But it cannot see the *other* off switch: a user who
     * granted the permission and later turned the app's notifications off in
     * system settings still reads as GRANTED while nothing is delivered. So the
     * channel-level answer is checked too, and either one being off is
     * {@link #BLOCKED} — because settings is the only route back in both cases.
     *
     * Below API 33 the permission does not exist. {@code checkSelfPermission}
     * answers "denied" for it there, which is why a plain Capacitor state check
     * would report a permission problem on an Android 12 phone that is happily
     * showing notifications.
     */
    static String notifications(Context context, String capacitorState) {
        boolean enabled = NotificationManagerCompat.from(context).areNotificationsEnabled();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return enabled ? GRANTED : BLOCKED;
        }
        if (GRANTED.equals(capacitorState)) return enabled ? GRANTED : BLOCKED;
        // Capacitor's "denied" means permanently: it is only written after a
        // refusal that shouldShowRequestPermissionRationale said cannot be
        // asked about again.
        if (DENIED.equals(capacitorState)) return BLOCKED;
        return PROMPT;
    }

    /**
     * Whether {@link AevistleScheduler} can set an alarm for the minute asked
     * for, rather than for roughly then.
     *
     * Deliberately not "can we ask" — there is no dialog for this one. Android
     * 12 introduced the permission with it granted on install; Android 14
     * stopped granting it to anything that is not an alarm clock. Either way
     * the only route to it is a settings screen the user has to be sent to.
     */
    static String exactAlarms(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return NOT_REQUIRED;
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        if (alarms == null) return NOT_REQUIRED;
        return alarms.canScheduleExactAlarms() ? GRANTED : DENIED;
    }

    // -----------------------------------------------------------------------
    // When to ask
    // -----------------------------------------------------------------------

    /**
     * Did this batch of jobs contain one that was not armed before?
     *
     * Called with the store's previous contents and the incoming set, because
     * "the user just armed a reminder" is the moment where a notification
     * permission dialog explains itself and "the app just started" is the
     * moment where people reflexively deny it. The two are the same call —
     * {@code syncJobs} — and only the diff tells them apart.
     */
    static void noteNewlyArmed(Context context, java.util.Set<String> before,
                               java.util.Set<String> after) {
        for (String id : after) {
            if (!before.contains(id)) {
                prefs(context).edit().putBoolean(KEY_PROMPT_DUE, true).apply();
                return;
            }
        }
    }

    /** The other moment worth asking at: an inbox was just switched on. */
    static void notePromptDue(Context context) {
        prefs(context).edit().putBoolean(KEY_PROMPT_DUE, true).apply();
    }

    /**
     * Consume the flag. Returns true at most once per event that set it, so a
     * dialog the user dismissed does not come back on the next sync.
     */
    static boolean takePromptDue(Context context) {
        SharedPreferences p = prefs(context);
        if (!p.getBoolean(KEY_PROMPT_DUE, false)) return false;
        p.edit().remove(KEY_PROMPT_DUE).apply();
        return true;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // -----------------------------------------------------------------------
    // Routes into settings
    //
    // Both are only ever reached from an explicit tap. Throwing the user into
    // a settings screen unasked is how an app gets uninstalled.
    // -----------------------------------------------------------------------

    /**
     * The app's notification settings, or its details page on API 24–25 where
     * the per-app notification screen does not exist yet.
     */
    static boolean openNotificationSettings(Context context, android.app.Activity activity) {
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
        } else {
            intent = appDetails(context);
        }
        return start(context, activity, intent, appDetails(context));
    }

    /**
     * "Alarms & reminders" for this app.
     *
     * Carries the package URI so it opens on this app's entry rather than the
     * list of every app on the device — the version without it is technically
     * the same screen and practically a different task.
     */
    static boolean openExactAlarmSettings(Context context, android.app.Activity activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false;
        Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                Uri.parse("package:" + context.getPackageName()));
        return start(context, activity, intent, appDetails(context));
    }

    private static Intent appDetails(Context context) {
        return new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + context.getPackageName()));
    }

    /**
     * Prefer the activity so the settings screen lands on top of the app and
     * Back returns to it. The application context works, but only as its own
     * task, which is a worse place to come back from.
     */
    private static boolean start(Context context, android.app.Activity activity,
                                 Intent intent, Intent fallback) {
        for (Intent candidate : new Intent[]{intent, fallback}) {
            if (candidate == null) continue;
            try {
                if (activity != null) {
                    activity.startActivity(candidate);
                } else {
                    context.startActivity(candidate.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                }
                return true;
            } catch (Exception ignored) {
                // Some OEM builds ship without one of these screens; try the
                // generic app-details page before giving up.
            }
        }
        return false;
    }
}
