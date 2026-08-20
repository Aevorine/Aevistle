package dev.aevistle.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.util.Log;

import org.json.JSONObject;

import java.util.Calendar;

/**
 * Reads the settings the app's own settings screen writes — display
 * theme, display language, and the three that decide whether background mail
 * says anything — from where {@code @capacitor/preferences}
 * actually keeps them, for the native code that has to know them before any
 * WebView exists to ask: {@link MainActivity}'s very first frame, and
 * {@link InboxSyncWorker}'s background notification, which runs on
 * WorkManager's own schedule with no bridge in the process at all.
 *
 * `@capacitor/preferences` on Android is {@link SharedPreferences} under a
 * fixed group name, holding the whole app state under a fixed key — see
 * {@code Preferences.java} in the plugin and {@code STATE_KEY} in
 * {@code src/core/bridge-android.ts}. Reading it here reads the same file
 * the JS layer already reads and writes; nothing new is stored, and nothing
 * here ever writes to it — a worker or a cold-start activity guessing wrong
 * about a setting is a smaller problem than one of them clobbering it.
 */
final class AppSettingsSignal {

    private static final String TAG = "AppSettingsSignal";
    /** {@code PreferencesConfiguration.DEFAULTS.group} in the plugin — never overridden by this app. */
    private static final String PREFS_GROUP = "CapacitorStorage";
    /** {@code STATE_KEY} in {@code src/core/bridge-android.ts}. */
    private static final String STATE_KEY = "aevistle.state.v1";

    private AppSettingsSignal() {
    }

    /**
     * One boolean out of the app's own settings, with the default it has on the
     * other platform.
     *
     * Exists because the background notification path was reading none of them.
     * {@code notifyOnNewMail} and the quiet window are honoured by the renderer
     * and were ignored entirely by {@link InboxSyncRunner}, so turning the
     * switch off silenced the app while it was open and changed nothing about
     * the notifications that arrive when it is closed — which are the ones the
     * setting is actually about. A switch that does nothing on the platform
     * where it matters most is worse than an absent one: it is a promise.
     *
     * Absent reads as {@code fallback}, so a state file written before a
     * setting existed behaves as the app's own default rather than as `false`.
     */
    static boolean flag(Context context, String key, boolean fallback) {
        JSONObject settings = readSettings(context);
        if (settings == null || settings.isNull(key)) return fallback;
        return settings.optBoolean(key, fallback);
    }

    /**
     * True when the moment falls inside the user's quiet window.
     *
     * Mirrors {@code isQuiet} in {@code src/core/schedule/schedule.ts},
     * including the direction it fails in: an unparseable or zero-length window
     * is *not* quiet. Holding mail back because a time string could not be read
     * is the one outcome worse than announcing during the night.
     */
    static boolean isQuiet(Context context, long at) {
        JSONObject settings = readSettings(context);
        if (settings == null || !settings.optBoolean("quietHoursEnabled", false)) return false;
        int start = minutesOfDay(settings.optString("quietStart", ""));
        int end = minutesOfDay(settings.optString("quietEnd", ""));
        if (start < 0 || end < 0 || start == end) return false;

        Calendar cal = Calendar.getInstance();
        cal.setTimeInMillis(at);
        int now = cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE);
        // `start > end` is a window that wraps midnight — 22:00 to 07:00 — which
        // is the shape almost every user actually picks.
        return start < end ? now >= start && now < end : now >= start || now < end;
    }

    /** `HH:mm` as minutes past midnight, or -1 for anything that is not that. */
    private static int minutesOfDay(String hhmm) {
        if (hhmm == null) return -1;
        java.util.regex.Matcher m = HHMM.matcher(hhmm.trim());
        if (!m.matches()) return -1;
        int h = Integer.parseInt(m.group(1));
        int min = Integer.parseInt(m.group(2));
        if (h > 23 || min > 59) return -1;
        return h * 60 + min;
    }

    private static final java.util.regex.Pattern HHMM =
            java.util.regex.Pattern.compile("^(\\d{1,2}):(\\d{2})$");

    /** The `settings` object out of the persisted app state, or null if there is none yet. */
    private static JSONObject readSettings(Context context) {
        try {
            SharedPreferences prefs = context.getApplicationContext()
                    .getSharedPreferences(PREFS_GROUP, Context.MODE_PRIVATE);
            String raw = prefs.getString(STATE_KEY, null);
            if (raw == null) return null;
            return new JSONObject(raw).optJSONObject("settings");
        } catch (Exception e) {
            // A first launch — nothing saved yet — reads as this too, not just
            // a parse failure, and both fall back to the device signal below.
            Log.w(TAG, "readSettings: could not read the app's own settings", e);
            return null;
        }
    }

    /**
     * Whether the page is currently painting its dark theme.
     *
     * Mirrors the renderer's own effect in {@code AppState.tsx}: {@code
     * 'dark'} is dark, {@code 'light'} is light, {@code 'system'} — and a
     * first launch, where the setting does not exist yet — follows the
     * device's own night mode, the same fallback {@code data-theme} gets on
     * the web side by simply not being set, leaving {@code theme.css}'s
     * {@code prefers-color-scheme} block to decide.
     */
    static boolean isDarkTheme(Context context) {
        JSONObject settings = readSettings(context);
        String mode = settings == null ? "system" : settings.optString("themeMode", "system");
        if ("dark".equals(mode)) return true;
        if ("light".equals(mode)) return false;
        int night = context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return night == Configuration.UI_MODE_NIGHT_YES;
    }

    /**
     * The app's own display-language choice — one of the six {@code LocaleId}
     * values `src/core/types.ts` declares — or null when it is {@code
     * 'system'}, unset, or unreadable. A null means "use the device locale",
     * which is what every caller here already did before this existed.
     */
    static String displayLocale(Context context) {
        JSONObject settings = readSettings(context);
        if (settings == null) return null;
        String locale = settings.optString("locale", "system");
        return "system".equals(locale) || locale.isEmpty() ? null : locale;
    }

    /**
     * A context whose string resources answer in the app's own display
     * language rather than the device's.
     *
     * For the native-only notification text — {@code InboxSyncWorker}'s
     * new-mail strings and {@code SendWorker}'s retry-action label — which
     * lives in Android's own resources precisely because neither worker has a
     * WebView to ask `src/i18n/*.ts` for anything. Resource qualifiers key off
     * the *device* locale by default, a different setting from the one the
     * user chose on the settings screen; this only changes which qualifier
     * gets picked, via an explicit {@link java.util.Locale} on the {@link
     * Configuration}, the mechanism Android already has for exactly this.
     * {@code 'system'} (or nothing saved yet) returns the context unchanged,
     * which is the previous behaviour and the correct one.
     */
    static Context localizedContext(Context context) {
        String appLocale = displayLocale(context);
        if (appLocale == null) return context;
        java.util.Locale locale = toAndroidLocale(appLocale);
        if (locale == null) return context;
        Configuration config = new Configuration(context.getResources().getConfiguration());
        config.setLocale(locale);
        return context.createConfigurationContext(config);
    }

    /** The six `LocaleId` values `src/core/types.ts` declares, mapped to the resource qualifiers `values-*` actually uses. */
    private static java.util.Locale toAndroidLocale(String localeId) {
        switch (localeId) {
            case "en": return java.util.Locale.ENGLISH;
            case "zh-CN": return java.util.Locale.SIMPLIFIED_CHINESE;
            case "fr": return java.util.Locale.FRENCH;
            case "es": return new java.util.Locale("es");
            case "ru": return new java.util.Locale("ru");
            case "ar": return new java.util.Locale("ar");
            default: return null;
        }
    }
}
