package dev.aevistle.app;

import android.app.ActivityManager;
import android.app.AlarmManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;

/**
 * The permissions this app cannot do its job without, and the honest state of
 * each one.
 *
 * All three were declared in the manifest and never asked for. That is not a
 * small omission on any of the three counts:
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
 *   Battery optimization is not a manifest permission at all — every app
 *   starts subject to it — but the settings screen it is undone from needs
 *   the same {@code REQUEST_IGNORE_BATTERY_OPTIMIZATIONS} declaration the
 *   other two get, so it is told apart here rather than elsewhere. A phone
 *   whose manufacturer manages background apps aggressively (Xiaomi, Huawei,
 *   OPPO, vivo, Samsung all ship their own layer on top of stock Doze) can
 *   freeze this app's process between alarms even with exact-alarm and
 *   notification permission both granted — the mail simply never gets sent,
 *   with nothing on screen to say why, because the process that would have
 *   said so was the one that got frozen.
 *
 * None of the three is fixed by asking harder. Notifications get one system
 * dialog, at a moment when the reason for it is on screen; exact alarms get no
 * dialog at all (only a settings screen); battery optimization gets a dialog
 * too, but — unlike notifications — it can be re-shown as many times as the
 * user keeps saying no, because Android's "don't ask again" bookkeeping does
 * not apply to it, so this class has to explain each time rather than fall
 * back to a settings screen. What this class provides is the state to say
 * that with, and the intents to act on it. Nothing here fires an intent on its
 * own — every entry point is reached from a user action.
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

    /**
     * Is this app exempt from battery optimization?
     *
     * `isIgnoringBatteryOptimizations` is the platform's own name for "yes,
     * exempt" — a double negative, but it is the API Android actually offers,
     * and the naming is echoed here only in the doc, not in the answer: this
     * still returns {@link #GRANTED} for "exempt", matching {@link
     * #exactAlarms}'s shape so the settings screen can treat both the same
     * way. `NOT_REQUIRED` below API 23, where the mechanism does not exist at
     * all.
     */
    static String batteryOptimized(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return NOT_REQUIRED;
        PowerManager power = context.getSystemService(PowerManager.class);
        if (power == null) return NOT_REQUIRED;
        return power.isIgnoringBatteryOptimizations(context.getPackageName()) ? GRANTED : DENIED;
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

    /**
     * Ask, directly — the one permission-adjacent screen here that is a
     * dialog rather than a settings page.
     *
     * `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` raises the system's own
     * "Allow Aevistle to ignore battery optimizations?" prompt right over the
     * app, with Allow/Deny in it — no trip to Settings required, unlike
     * exact alarms. Requires {@code REQUEST_IGNORE_BATTERY_OPTIMIZATIONS} in
     * the manifest; without it Android throws rather than degrading, so the
     * fallback below is a genuine second attempt, not defensive padding.
     */
    static boolean openBatteryOptimizationSettings(Context context, android.app.Activity activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return false;
        Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:" + context.getPackageName()));
        Intent fallback = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
        return start(context, activity, intent, fallback);
    }

    /**
     * Is the foreground sync loop actually alive right now?
     *
     * Every other reader in this file answers "did the user grant X", and none
     * of them answers the question that decides whether mail arrives with the
     * app closed. A phone can have notifications allowed, exact alarms allowed
     * and battery optimisation waived, and still have {@link InboxIdleService}
     * killed within minutes by a manufacturer's own background-app manager —
     * which is not a permission, has no API, and is invisible from inside the
     * app except by looking at whether the service is still there.
     *
     * That gap is why "I get no notifications" was previously unanswerable: the
     * permission strip said everything was fine, because everything it knew
     * about *was* fine. This is the one row that can say otherwise.
     *
     * {@code getRunningServices} is deprecated for inspecting *other* apps and
     * has returned only the caller's own services since API 26 — which is
     * exactly and only what is wanted here, so the deprecation does not apply
     * to this use.
     */
    @SuppressWarnings("deprecation")
    static String backgroundService(Context context) {
        if (new InboxCache(context).enabledAccounts().isEmpty()) return NOT_REQUIRED;
        ActivityManager manager = context.getSystemService(ActivityManager.class);
        if (manager == null) return DENIED;
        try {
            for (ActivityManager.RunningServiceInfo info
                    : manager.getRunningServices(Integer.MAX_VALUE)) {
                if (InboxIdleService.class.getName().equals(info.service.getClassName())) {
                    return GRANTED;
                }
            }
        } catch (Exception e) {
            // A refusal to enumerate is not evidence either way, and claiming
            // the service is dead would send the user off to fix a setting
            // that was never the problem.
            return NOT_REQUIRED;
        }
        return DENIED;
    }

    /**
     * Open the manufacturer's own auto-start / background-app manager.
     *
     * There is no platform API for this and no common Intent action: each
     * vendor ships a private activity, they are renamed between OS versions,
     * and several are not exported on some builds. So this is a list of known
     * component names tried in order, ending at the app-details page — which
     * always exists, and from which every one of these managers is reachable in
     * two or three taps.
     *
     * Worth having despite the fragility, because on the vendors listed it is
     * the difference between mail arriving and not: the standard notification
     * permission and the standard battery-optimisation exemption can both be
     * granted and the app still be frozen between syncs by this separate,
     * vendor-only list. Huawei/Honor lead the list because that is where the
     * behaviour was reported, not because the others are less strict.
     *
     * Failure here is not an error the user needs to see — {@code start}
     * already falls back — so the caller reports only whether *something*
     * opened.
     */
    static boolean openAutoStartSettings(Context context, android.app.Activity activity) {
        String[][] candidates = {
                // Huawei / Honor — "Startup manager" under Battery.
                {"com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"},
                {"com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"},
                // Xiaomi / Redmi — Security app's autostart list.
                {"com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"},
                // OPPO / realme.
                {"com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"},
                {"com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"},
                // vivo.
                {"com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"},
                // Samsung — device care's battery list.
                {"com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"},
        };

        for (String[] candidate : candidates) {
            Intent intent = new Intent().setComponent(new ComponentName(candidate[0], candidate[1]));
            if (start(context, activity, intent, null)) return true;
        }
        // Nothing vendor-specific matched — a Pixel, an emulator, or a build
        // that renamed its manager again. The app's own settings page is the
        // honest fallback rather than a dead button.
        return start(context, activity, appDetails(context), null);
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
