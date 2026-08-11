package dev.aevistle.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.DateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * The home-screen mirror of the Windows tray label — see {@code refreshTrayMenu}
 * in {@code electron/main.ts}, which draws "Next: <time>" (or "Nothing
 * scheduled") at the top of the tray menu because that is the one thing worth
 * reading in a menu that is otherwise just shortcuts. Android had no
 * equivalent: checking whether a reminder is still armed meant unlocking the
 * phone, opening the app, and navigating to the Schedule screen. This widget
 * answers the same question from the home screen.
 *
 * Refreshed from two places, deliberately not from {@link #onUpdate} alone:
 *
 *   - {@link AevistleScheduler#rearmAll}, which already recomputes every job's
 *     next occurrence on every path that can change the schedule —
 *     {@code syncJobs} from the web layer, a reboot, an app update, and the
 *     exact-alarm permission being granted or revoked;
 *   - {@link SendWorker#armNext}, the one path that changes an occurrence list
 *     *without* going through {@code rearmAll} at all — an alarm actually
 *     firing, a send completing or a condition skipping it.
 *
 * Between those two, this is current the moment anything on the device could
 * make it stale. {@code updatePeriodMillis} in {@code widget_next_send_info.xml}
 * is only the fallback for whatever those two miss — it is Android's own
 * enforced floor of 30 minutes, too coarse to be the primary refresh path on
 * its own; left alone for half an hour, "Next: 07:00" would otherwise still
 * be showing at 07:05.
 */
public class NextSendWidgetProvider extends AppWidgetProvider {

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        pushUpdate(context, manager, appWidgetIds);
    }

    /**
     * Recompute the next scheduled send and push it to every placed instance
     * of this widget. A safe no-op when none is placed —
     * {@link AppWidgetManager#getAppWidgetIds} returns an empty array rather
     * than null when nobody has added the widget, so every caller can reach
     * for this without checking first.
     */
    static void refresh(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, NextSendWidgetProvider.class));
        if (ids.length == 0) return;
        pushUpdate(context, manager, ids);
    }

    private static void pushUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        // The app's own display-language choice, the same source
        // `InboxSyncWorker` reads for its notification text — this runs with
        // no WebView in the process either, so it has no other way to ask
        // `src/i18n/*.ts` what language the rest of the app is showing.
        Context localized = AppSettingsSignal.localizedContext(context);
        String text = nextSendText(localized);
        PendingIntent openApp = openAppIntent(context);

        for (int id : appWidgetIds) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_next_send);
            views.setTextViewText(R.id.widget_next_send_text, text);
            views.setOnClickPendingIntent(R.id.widget_next_send_root, openApp);
            manager.updateAppWidget(id, views);
        }
    }

    /**
     * "Next: 12 Aug 2026, 07:00" (localized) or "Nothing scheduled".
     *
     * Mirrors {@code refreshTrayMenu}'s {@code nextLabel} field for field:
     * only enabled jobs, only their still-future occurrences, the soonest of
     * those. The one addition is {@link AevistleScheduler#isMyJob} — a filter
     * the desktop tray has no equivalent of, because Android is the platform
     * where a schedule can be pinned to run from a *different* signed-in
     * device; showing an occurrence this device will never actually fire
     * would be a different bug in the same shape as the one this widget
     * exists to fix.
     */
    private static String nextSendText(Context localized) {
        long next = nextSendAt(localized);
        if (next <= 0) return localized.getString(R.string.widget_nothing_due);

        Locale locale = localized.getResources().getConfiguration().getLocales().get(0);
        DateFormat format = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT, locale);
        return localized.getString(R.string.widget_next_at) + " " + format.format(new Date(next));
    }

    private static long nextSendAt(Context context) {
        JobStore store = new JobStore(context);
        JSONArray jobs = store.jobs();
        String localDeviceId = store.localDeviceId();
        long now = System.currentTimeMillis();
        long soonest = -1;

        for (int i = 0; i < jobs.length(); i++) {
            JSONObject job = jobs.optJSONObject(i);
            if (job == null || !job.optBoolean("enabled", false)) continue;
            if (!AevistleScheduler.isMyJob(job, localDeviceId)) continue;

            JSONArray occurrences = job.optJSONArray("occurrences");
            if (occurrences == null) continue;
            for (int k = 0; k < occurrences.length(); k++) {
                long at = occurrences.optLong(k, 0L);
                if (at > now && (soonest < 0 || at < soonest)) soonest = at;
            }
        }
        return soonest;
    }

    /**
     * Tapping the widget brings the app up — the same {@code MainActivity}
     * entry every notification in {@link Notifier} taps, just with no message
     * id to carry through.
     */
    private static PendingIntent openAppIntent(Context context) {
        Intent intent = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getActivity(context, 0, intent, flags);
    }
}
