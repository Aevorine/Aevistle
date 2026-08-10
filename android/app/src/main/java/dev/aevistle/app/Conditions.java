package dev.aevistle.app;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.Calendar;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Send conditions, decided on the device at the moment an alarm fires.
 *
 * The port of `src/core/conditions.ts`, and it exists because there was no
 * port at all: {@link AlarmReceiver} woke {@link SendWorker}, which read the
 * draft and sent it. Nothing on this side had ever looked at `conditions` — a
 * field every job has carried since the feature shipped, and which arrives here
 * intact, because {@code syncJobs} stores whole `ScheduledJob` objects. So
 * "only send if they haven't replied" chased people who had replied, "only if
 * the report exists" mailed an absent report, and "only between 09:00 and
 * 18:00" went out at three in the morning. Every one of those looked completely
 * ordinary in the activity log, because from this side nothing unusual had
 * happened: the desktop checked conditions at `electron/scheduler.ts`'s `run`,
 * the phone did not check them anywhere.
 *
 * The two rules in the TypeScript header hold here unchanged:
 *
 *  - **A condition nobody can answer does not block the send.** If no inbox has
 *    ever synced on this device we do not know whether anyone replied, and
 *    holding mail back on a guess turns a convenience into a silent drop. Those
 *    cases report {@code undecidable} and go out.
 *  - **A skip is an event, not a silence.** Every block below carries both the
 *    translation key the desktop uses and the same sentence in plain English,
 *    because this side has no i18n and a notification is read by a person.
 *
 * One deliberate divergence, in the safe direction: a condition {@code kind}
 * this class does not recognise **blocks**, where `conditions.ts` passes it.
 * Passing is right in the renderer, which is the same build as the condition
 * editor and cannot disagree with it. Here it would mean a future condition
 * kind silently sending on Android while the desktop honours it — the exact
 * shape of the bug this file was written to close. Blocking is visible; sending
 * anyway is not.
 */
final class Conditions {

    private static final String TAG = "Conditions";

    /** Same shape as `HH:mm` accepts in `conditions.ts` — one or two hour digits. */
    private static final Pattern HHMM = Pattern.compile("^(\\d{1,2}):(\\d{2})$");

    /** The address out of `Name <a@b.c>`, matching `conditionContext` in AppState. */
    private static final Pattern ANGLE_ADDRESS = Pattern.compile("<([^>]+)>");

    private Conditions() {
    }

    /** Mirrors `ConditionVerdict` in `src/core/conditions.ts`. */
    static final class Verdict {

        /** False only when a condition actually answered "no". */
        final boolean send;
        /** Translation key for the web layer, from the set `conditions.ts` uses. */
        final String reasonKey;
        /** Interpolations for {@link #reasonKey}, or null when there are none. */
        final JSONObject reasonValues;
        /**
         * The same reason in plain English.
         *
         * Two of the three places a skip becomes visible on this platform — the
         * notification, and the `error` field of the run report the activity log
         * prints as its detail line — are read by a person rather than passed
         * through `t()`. The native side has no translations (see `notify` in
         * `core/bridge-android.ts`), so the sentence is built here.
         */
        final String reason;
        /**
         * True when nothing could be established. Never blocks — see the class
         * header — but carried so a caller can say "sent anyway, could not
         * check" rather than implying the check passed.
         */
        final boolean undecidable;

        private Verdict(boolean send, String reasonKey, JSONObject reasonValues, String reason,
                        boolean undecidable) {
            this.send = send;
            this.reasonKey = reasonKey;
            this.reasonValues = reasonValues;
            this.reason = reason;
            this.undecidable = undecidable;
        }

        static Verdict pass() {
            return new Verdict(true, null, null, null, false);
        }

        static Verdict undecided() {
            return new Verdict(true, null, null, null, true);
        }

        static Verdict block(String reasonKey, JSONObject reasonValues, String reason) {
            return new Verdict(false, reasonKey, reasonValues, reason, false);
        }

        /**
         * This skip as a `SendResult`, so it travels the route a send result
         * already travels — {@link AevistleNativePlugin#emitJobEvent} to an open
         * app, and nothing else needs teaching a new shape.
         *
         * `ok: false` with `skipped: true` is what `src/core/types.ts` defines:
         * nothing went wrong and nothing was delivered, and a result that had to
         * choose between the green tick and the red cross would misreport one of
         * the two.
         */
        JSONObject toSendResult() {
            JSONObject o = new JSONObject();
            try {
                o.put("ok", false);
                o.put("skipped", true);
                if (reasonKey != null) o.put("skipReasonKey", reasonKey);
                if (reasonValues != null) o.put("skipReasonValues", reasonValues);
                o.put("accepted", new JSONArray());
                o.put("rejected", new JSONArray());
                o.put("durationMs", 0);
                // Not a failure, and deliberately still filled in: the web
                // layer's `onJobEvent` prints `result.error` as the log line's
                // detail, and that line is the only thing that tells the user
                // *which* condition held the mail back.
                if (reason != null) o.put("error", reason);
            } catch (Exception e) {
                // Every key is a string literal, so unreachable in practice.
                // Logged rather than swallowed because the alternative is a
                // skip that reaches the app as an empty object — a run that
                // decided something, reported as a run that did nothing.
                Log.e(TAG, "toSendResult: could not serialise the skip", e);
            }
            return o;
        }
    }

    /**
     * Evaluate every condition on this job. All must pass; the first block wins
     * and is the one reported, exactly as `evaluateConditions` does — listing
     * five reasons a message did not go out is not five times as helpful.
     *
     * @param job the stored job, straight out of {@link JobStore}. Everything
     *            the evaluators need is on it: `conditions`, `draft`,
     *            `lastRunAt`, `lastResult` and `createdAt`.
     */
    static Verdict evaluate(Context context, JSONObject job) {
        JSONArray conditions = job.optJSONArray("conditions");
        if (conditions == null || conditions.length() == 0) return Verdict.pass();

        JSONObject draft = job.optJSONObject("draft");
        if (draft == null) return Verdict.pass();

        boolean undecidable = false;
        for (int i = 0; i < conditions.length(); i++) {
            JSONObject cond = conditions.optJSONObject(i);
            if (cond == null) continue;
            Verdict verdict = evaluateOne(context, cond, draft, job);
            if (!verdict.send) return verdict;
            if (verdict.undecidable) undecidable = true;
        }
        return undecidable ? Verdict.undecided() : Verdict.pass();
    }

    private static Verdict evaluateOne(Context context, JSONObject cond, JSONObject draft,
                                       JSONObject job) {
        String kind = cond.optString("kind", "");
        switch (kind) {
            case "attachmentsPresent":
                return attachmentsPresent(draft);

            case "fileExists": {
                String path = cond.optString("path", "");
                // An empty path is not a condition, it is an unfinished one, and
                // `conditions.ts` passes it rather than blocking on a question
                // that was never asked.
                if (path.isEmpty()) return Verdict.pass();
                return exists(path)
                        ? Verdict.pass()
                        : Verdict.block("condition.blocked.fileMissing", values("path", path),
                                "Not sent: " + path + " does not exist");
            }

            case "fileMissing": {
                String path = cond.optString("path", "");
                if (path.isEmpty()) return Verdict.pass();
                return exists(path)
                        ? Verdict.block("condition.blocked.filePresent", values("path", path),
                                "Not sent: " + path + " is there")
                        : Verdict.pass();
            }

            case "noReplySince":
                return noReplySince(context, draft, job);

            case "timeWindow":
                return timeWindow(cond);

            case "previousRunFailed":
                return previousRunFailed(job);

            default:
                /*
                 * A kind this build does not know. See the class header: the
                 * renderer may pass one because it ships with the editor that
                 * wrote it, this cannot. Blocked with a reason the user can
                 * read, which is the difference between "your Android build is
                 * too old for this condition" and a chase mail that went out
                 * against an instruction not to send it.
                 *
                 * The English `error` string stays as the fallback for anything
                 * that reads `error` rather than the key.
                 */
                return Verdict.block("condition.blocked.unsupportedKind", values("kind", kind),
                        "Not sent: this version cannot check the condition \"" + kind + "\"");
        }
    }

    // -----------------------------------------------------------------------
    // The evaluators
    // -----------------------------------------------------------------------

    private static Verdict attachmentsPresent(JSONObject draft) {
        JSONArray attachments = draft.optJSONArray("attachments");
        if (attachments == null || attachments.length() == 0) return Verdict.pass();

        StringBuilder missing = new StringBuilder();
        for (int i = 0; i < attachments.length(); i++) {
            JSONObject a = attachments.optJSONObject(i);
            if (a == null) continue;
            if (exists(a.optString("path", ""))) continue;
            // The ideographic comma, because that is the separator
            // `conditions.ts` joins with and the two lists have to read the
            // same in the log whichever platform produced them.
            if (missing.length() > 0) missing.append('、');
            missing.append(a.optString("name", a.optString("path", "?")));
        }
        if (missing.length() == 0) return Verdict.pass();

        String names = missing.toString();
        return Verdict.block("condition.blocked.attachments", values("names", names),
                "Not sent: these attachments are missing — " + names);
    }

    /**
     * Has anyone we are about to chase written back since we last chased them?
     *
     * Answerable on this platform, and that was worth checking before writing
     * it: {@link InboxCache} keeps each account's message rows — `from` and
     * `date` included — for {@link InboxSyncWorker}, which runs in the same
     * no-WebView world this does. So the question is answered from the same
     * cache the desktop renderer answers it from, rather than by opening an
     * IMAP connection inside a send.
     *
     * The desktop *scheduler* cannot do this at all: `electron/scheduler.ts`
     * passes no `latestInboundFrom`, because the inbox lives in the renderer, so
     * a scheduled `noReplySince` reports undecidable there and sends. This is
     * therefore the one place where Android is stricter than the desktop, and
     * stricter in the direction the user asked for.
     */
    private static Verdict noReplySince(Context context, JSONObject draft, JSONObject job) {
        InboxCache cache = new InboxCache(context);
        List<JSONObject> accounts = cache.enabledAccounts();

        boolean inboxKnown = false;
        for (JSONObject account : accounts) {
            // `lastSyncAt !== undefined` in `conditionContext`: an account that
            // has never completed a sync knows nothing, and its empty message
            // list must not be read as "nobody has replied".
            if (account.has("lastSyncAt")) {
                inboxKnown = true;
                break;
            }
        }
        if (!inboxKnown) return Verdict.undecided();

        Map<String, Long> latestInbound = new HashMap<>();
        for (JSONObject account : accounts) {
            JSONArray messages = account.optJSONArray("messages");
            if (messages == null) continue;
            for (int i = 0; i < messages.length(); i++) {
                JSONObject m = messages.optJSONObject(i);
                if (m == null) continue;
                String key = addressKey(m.optString("from", ""));
                if (key.isEmpty()) continue;
                long at = m.optLong("date", 0L);
                Long prev = latestInbound.get(key);
                if (prev == null || at > prev) latestInbound.put(key, at);
            }
        }

        /*
         * `lastRunAt ?? armedAt ?? now`, and the middle term is the one that
         * matters. `armedAt` is the job's `createdAt` at both desktop call
         * sites; without it the window opened at the epoch, so a first arming
         * asked "have they ever written to me" and a reminder to chase someone
         * who last mailed in 2019 was blocked before it ever ran.
         */
        long since = job.optLong("lastRunAt", 0L);
        if (since <= 0) since = job.optLong("createdAt", 0L);
        if (since <= 0) since = System.currentTimeMillis();

        for (String address : recipients(draft)) {
            Long at = latestInbound.get(addressKey(address));
            if (at != null && at > since) {
                return Verdict.block("condition.blocked.replied", values("who", address),
                        "Not sent: " + address + " has replied");
            }
        }
        return Verdict.pass();
    }

    private static Verdict timeWindow(JSONObject cond) {
        String fromText = cond.optString("from", "");
        String toText = cond.optString("to", "");
        int from = minutesOfDay(fromText);
        int to = minutesOfDay(toText);
        // An unparseable or zero-width window must never hold mail back — the
        // same failing-open rule quiet hours uses, and the same one
        // `conditions.ts` applies here.
        if (from < 0 || to < 0 || from == to) return Verdict.pass();

        Calendar cal = Calendar.getInstance();
        int at = cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE);
        // `from > to` is a window that crosses midnight, e.g. 22:00–06:00.
        boolean inside = from < to ? (at >= from && at < to) : (at >= from || at < to);
        if (inside) return Verdict.pass();

        JSONObject reasonValues = new JSONObject();
        try {
            reasonValues.put("from", fromText);
            reasonValues.put("to", toText);
        } catch (Exception e) {
            Log.w(TAG, "timeWindow: could not build the reason values", e);
        }
        return Verdict.block("condition.blocked.outsideWindow", reasonValues,
                "Not sent: outside " + fromText + "–" + toText);
    }

    private static Verdict previousRunFailed(JSONObject job) {
        String lastResult = job.optString("lastResult", "");
        if (lastResult.isEmpty()) {
            // Never run, so there is no earlier failure to escalate from. This
            // is the one condition that blocks by default, and it has to: an
            // escalation stage that fires on its own is the thing the earlier
            // stage exists to prevent.
            return Verdict.block("condition.blocked.noPreviousRun", null,
                    "Not sent: there is no earlier run to escalate from");
        }
        return "failed".equals(lastResult)
                ? Verdict.pass()
                : Verdict.block("condition.blocked.previousOk", null,
                        "Not sent: the previous run succeeded");
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /**
     * Does this path exist right now?
     *
     * A path we are not allowed to stat answers "yes", which looks backwards and
     * is what the desktop does for the same reason: a `SecurityException` is not
     * proof of absence, and `fileMissing` blocking on one would hold mail back
     * over a permission error. Say "missing" only when we really looked.
     */
    private static boolean exists(String path) {
        if (path == null || path.isEmpty()) return false;
        try {
            return new File(path).exists();
        } catch (SecurityException e) {
            Log.w(TAG, "could not stat " + path + ", treating it as present", e);
            return true;
        }
    }

    /** `to` and `cc`, the two lists `noReplySince` considers. Not `bcc`. */
    private static String[] recipients(JSONObject draft) {
        JSONArray to = draft.optJSONArray("to");
        JSONArray cc = draft.optJSONArray("cc");
        int size = (to == null ? 0 : to.length()) + (cc == null ? 0 : cc.length());
        String[] out = new String[size];
        int n = 0;
        if (to != null) for (int i = 0; i < to.length(); i++) out[n++] = to.optString(i, "");
        if (cc != null) for (int i = 0; i < cc.length(); i++) out[n++] = cc.optString(i, "");
        return out;
    }

    /**
     * The comparison key for one address, matching `conditionContext` in
     * `src/state/AppState.tsx` exactly: the part inside angle brackets when
     * there is one, trimmed and lower-cased. A cached row's `from` is
     * `Name <a@b.c>`; a recipient is usually the bare address, and the two have
     * to meet somewhere or every comparison silently fails.
     */
    private static String addressKey(String raw) {
        if (raw == null) return "";
        Matcher m = ANGLE_ADDRESS.matcher(raw);
        String address = m.find() ? m.group(1) : raw;
        return address == null ? "" : address.trim().toLowerCase();
    }

    /** Minutes since midnight for `HH:mm`, or -1 when it is not one. */
    private static int minutesOfDay(String hhmm) {
        if (hhmm == null) return -1;
        Matcher m = HHMM.matcher(hhmm.trim());
        if (!m.matches()) return -1;
        try {
            int h = Integer.parseInt(m.group(1));
            int min = Integer.parseInt(m.group(2));
            if (h > 23 || min > 59) return -1;
            return h * 60 + min;
        } catch (NumberFormatException e) {
            // The pattern already bounds this to four digits, so it cannot
            // overflow; caught because `parseInt` is checked-by-convention here
            // and a throw would turn a bad time into a lost reminder.
            return -1;
        }
    }

    private static JSONObject values(String key, String value) {
        JSONObject o = new JSONObject();
        try {
            o.put(key, value);
        } catch (Exception e) {
            // Only throws for a null key, and every caller passes a literal.
            // The reason key still arrives; it interpolates to a blank.
            Log.w(TAG, "could not build the reason values for " + key, e);
        }
        return o;
    }
}
