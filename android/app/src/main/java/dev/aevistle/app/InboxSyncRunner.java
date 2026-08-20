package dev.aevistle.app;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * One pass over every enabled account: sync, then notify about whatever
 * arrived. Shared by {@link InboxSyncWorker} (the 15-minute WorkManager
 * floor) and {@link InboxIdleService} (the foreground service that repeats
 * this far more often while it is alive) so the two schedules cannot drift
 * into subtly different arrival/notify rules — see the file header on
 * {@code imapIdle.ts} for the same reasoning on the desktop side.
 *
 * Neither caller is exclusive: the worker is the floor that still applies
 * when the service is not running (killed, never started, or a manufacturer
 * that would not let it start at all), and the service is what turns that
 * floor from fifteen minutes into however often it is configured to run.
 * Whichever ran most recently simply has less to report.
 */
final class InboxSyncRunner {

    private static final String TAG = "InboxSyncRunner";

    private InboxSyncRunner() {
    }

    /**
     * How recent a message has to be to be worth a notification.
     *
     * Matches {@code NEW_MAIL_WINDOW_MS} in {@code src/core/newMail.ts} —
     * {@code check-new-mail.mjs} holds the two files to the same number. Wider
     * than either caller's own interval so a run delayed by Doze still
     * reports what it found, and far narrower than a working day so a phone
     * that has been off since yesterday does not wake up and recite it.
     */
    private static final long WINDOW_MS = 30L * 60L * 1000L;

    /**
     * The furthest back {@link #recencyCutoff} may be widened by an account's
     * last-sync time.
     *
     * Matches {@code MISSED_MAIL_MAX_AGE_MS} in {@code src/core/mail/newMail.ts}
     * — {@code check-new-mail.mjs} holds the two files to the same number. It
     * exists because {@code lastSyncAt} is only as trustworthy as the run that
     * wrote it: a phone left off for a fortnight, an account paused since last
     * month, a clock that jumped. Past this the ordinary window is the honest
     * rule, because a fortnight of mail is not an arrival.
     */
    private static final long MISSED_MAX_AGE_MS = 7L * 24L * 60L * 60L * 1000L;

    /** @return true if any account failed to sync — callers use this to decide on a retry. */
    static boolean runOnce(Context context) {
        InboxCache cache = new InboxCache(context);
        SecretStore secrets = new SecretStore(context);

        List<JSONObject> accounts = cache.enabledAccounts();
        if (accounts.isEmpty()) return false;

        boolean anyFailure = false;
        for (JSONObject config : accounts) {
            String accountId = config.optString("accountId", "");
            try {
                String secret = secrets.get(accountId, "imap");
                // Before the listing, never after: a sync writes the server's
                // `\Seen` onto every row, so a "Mark as read" that has not
                // reached the server yet is a mark this run would erase. Opens
                // nothing when there is nothing queued, which is every run but
                // the rare one. See MailFetcher#flushPendingSeen.
                MailFetcher.flushPendingSeen(context, config, secret);
                JSONObject updated = MailFetcher.sync(context, config, secret);
                // And for whatever the flush could not push — no network, a
                // server refusing — the queue still outranks what came back.
                cache.applyPendingSeen(updated);
                cache.upsert(updated);
                /*
                 * After the cache is written, never before.
                 *
                 * If notifying threw, the messages would still be stored, so
                 * the next run would compare against the *new* baseline and
                 * the arrivals would never be announced at all — the worst of
                 * both outcomes. This way a notification failure costs one
                 * notification, not the mail.
                 */
                announce(AppSettingsSignal.localizedContext(context), config, updated);
                // And tell an app that is open, which `onInboxEvent` promised
                // and nothing delivered: the web layer treats this as "re-read
                // that account", so mail this pass found shows up at once
                // instead of waiting for the web timer's next turn.
                AevistleNativePlugin.emitInboxEvent(accountId);
            } catch (Exception e) {
                anyFailure = true;
                try {
                    config.put("lastSyncError", e.getMessage() == null ? e.toString() : e.getMessage());
                    cache.upsert(config);
                } catch (Exception recordError) {
                    Log.e(TAG, "runOnce: could not record sync failure for account " + accountId, recordError);
                    try {
                        JSONObject retry = new JSONObject(config.toString());
                        retry.put("lastSyncError", e.getMessage() == null ? e.toString() : e.getMessage());
                        cache.upsert(retry);
                    } catch (Exception fallbackError) {
                        Log.e(TAG, "runOnce: fallback sync-error record also failed for account " + accountId, fallbackError);
                    }
                }
            }
        }
        return anyFailure;
    }

    /**
     * Tell the user what arrived, if anything did.
     *
     * Three rules decide what qualifies, matching {@code core/newMail.ts} on
     * the other platform: unseen, inside {@link #WINDOW_MS}, and not in the
     * previous message list (read from {@code before} as it was *passed in*,
     * ahead of this pass's own write to the cache) — and, ahead of all three,
     * the two switches that decide whether to speak at all. See
     * {@link AppSettingsSignal#flag} for why those had to be added: they were
     * read on one platform and not on this one.
     *
     * There is no "primed" rule here: unlike the renderer, this never starts
     * from an empty baseline, because it only ever runs against an account
     * the app has already synced at least once — that is what put it in the
     * cache in the first place.
     */
    private static void announce(Context context, JSONObject before, JSONObject after) {
        try {
            long now = System.currentTimeMillis();
            /*
             * The three settings this method used to ignore.
             *
             * Every one of them is honoured by the renderer and was honoured by
             * nothing here, so all three were decoration on the platform where
             * they matter most: a notification raised while the app is closed is
             * exactly the notification these switches are about. Turning
             * "announce new mail" off silenced the app while it was open and
             * changed nothing at all when it was not.
             */
            if (!AppSettingsSignal.flag(context, "notifyOnNewMail", true)) return;
            if (AppSettingsSignal.isQuiet(context, now)) return;
            /*
             * Rule 2, and the reason it can be switched off.
             *
             * A phone very often has a second mail app on the same account, and
             * that app marks everything `\Seen` within seconds of delivery. By
             * the time this runner looks, nothing is unread, and this one line
             * therefore discards *every* arrival — permanently, on every device
             * at once, while the mail itself syncs and lists perfectly.
             * Measured on the reporting install: 187 cached messages, 187 of
             * them already read, zero notifications for three days.
             */
            boolean includeRead = AppSettingsSignal.flag(context, "notifyReadElsewhere", false);

            Set<String> known = idsOf(before);
            List<JSONObject> arrivals = new ArrayList<>();
            long cutoff = recencyCutoff(now, before.optLong("lastSyncAt", 0L));

            JSONArray messages = after.optJSONArray("messages");
            if (messages == null) return;
            for (int i = 0; i < messages.length(); i++) {
                JSONObject m = messages.optJSONObject(i);
                if (m == null) continue;
                String id = m.optString("id", "");
                if (id.isEmpty() || known.contains(id)) continue;
                if (m.optBoolean("seen", false) && !includeRead) continue;
                if (m.optLong("date", 0L) < cutoff) continue;
                arrivals.add(m);
            }
            if (arrivals.isEmpty()) return;

            JSONObject newest = arrivals.get(0);
            for (JSONObject m : arrivals) {
                if (m.optLong("date", 0L) > newest.optLong("date", 0L)) newest = m;
            }

            String from = senderName(newest.optString("from", ""));
            String subject = newest.optString("subject", "");
            if (subject.isEmpty()) subject = context.getString(R.string.notify_no_subject);
            String snippet = newest.optString("snippet", "").replaceAll("\\s+", " ").trim();
            String body = snippet.isEmpty() ? subject : subject + " — " + snippet;
            String accountId = after.optString("accountId", "");
            String markReadLabel = context.getString(R.string.notify_mark_read);

            if (arrivals.size() == 1) {
                Notifier.mail(context, newest.optString("id", ""),
                        context.getString(R.string.notify_new_mail_one, from),
                        body, newest.optString("id", ""), accountId, markReadLabel);
                return;
            }

            Notifier.mail(context, newest.optString("id", ""),
                    context.getString(R.string.notify_new_mail_many, arrivals.size(), from),
                    body, newest.optString("id", ""), accountId, markReadLabel);
            Notifier.mailSummary(context,
                    context.getString(R.string.notify_new_mail_summary, arrivals.size()),
                    context.getString(R.string.notify_new_mail_one, from));
        } catch (Exception e) {
            Log.w(TAG, "announce: could not raise a new-mail notification", e);
        }
    }

    /**
     * The oldest a message may be and still count as an arrival.
     *
     * Mirrors {@code recencyCutoff} in {@code src/core/mail/newMail.ts}, and
     * matters more here than it does there. This runner is the one that has to
     * cope with the process not having run: WorkManager's fifteen-minute floor
     * is a floor and not a promise, Doze stretches it, and a manufacturer's
     * background-app manager can freeze this app for hours at a stretch. Every
     * one of those cases hands this method a gap wider than {@link #WINDOW_MS},
     * and with a fixed window the mail that arrived inside the gap is exactly
     * the mail that gets dropped — the phone wakes up, syncs, says nothing, and
     * the user finds out by opening the app.
     *
     * {@code lastSyncAt} is when this account last completed a sync, so
     * everything after it is by definition unlooked-at. It never narrows the
     * window; {@link #MISSED_MAX_AGE_MS} bounds how far a stale value reaches.
     * A zero or negative value means "never synced" and falls back to the
     * ordinary window.
     */
    static long recencyCutoff(long now, long lastSyncAt) {
        long ordinary = now - WINDOW_MS;
        if (lastSyncAt <= 0L) return ordinary;
        return Math.max(now - MISSED_MAX_AGE_MS, Math.min(ordinary, lastSyncAt));
    }

    private static Set<String> idsOf(JSONObject account) {
        Set<String> ids = new HashSet<>();
        JSONArray messages = account.optJSONArray("messages");
        if (messages == null) return ids;
        for (int i = 0; i < messages.length(); i++) {
            JSONObject m = messages.optJSONObject(i);
            if (m != null) ids.add(m.optString("id", ""));
        }
        return ids;
    }

    /**
     * `"Alex Chen" <alex@example.com>` becomes `Alex Chen`; a bare address is
     * left alone. Mirrors `senderName` in `src/core/newMail.ts` so the same
     * arrival is worded the same whichever side notices it.
     */
    private static String senderName(String from) {
        int bracket = from.indexOf('<');
        if (bracket <= 0) return from.trim();
        String name = from.substring(0, bracket).trim();
        if (name.startsWith("\"") && name.endsWith("\"") && name.length() >= 2) {
            name = name.substring(1, name.length() - 1).trim();
        }
        return name.isEmpty() ? from.trim() : name;
    }
}
