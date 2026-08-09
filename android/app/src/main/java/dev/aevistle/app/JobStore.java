package dev.aevistle.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The scheduled jobs and the accounts they send from, in a store the native
 * side can read.
 *
 * The WebView is not running when an alarm fires at 07:00, so the worker
 * cannot ask JavaScript anything. Whatever it needs has to already be here.
 * Passwords are the exception — those stay in {@link SecretStore} and are
 * looked up by account id.
 */
final class JobStore {

    private static final String TAG = "JobStore";
    private static final String PREFS = "aevistle_jobs";
    private static final String KEY_JOBS = "jobs";
    private static final String KEY_ACCOUNTS = "accounts";
    /** Run reports waiting for a WebView to exist. See {@link #recordRun}. */
    private static final String KEY_PENDING_RUNS = "pendingRuns";
    /**
     * The two notification switches, mirrored from the settings screen.
     *
     * They live here rather than on each job because that is what they are —
     * application settings — and because reading them off the job is the exact
     * bug this replaced: {@link SendWorker} asked each job for
     * {@code notifyOnSuccess}, a field `ScheduledJob` in `src/core/types.ts`
     * has never had, so the answer was always the {@code false} default and a
     * scheduled send that succeeded notified nobody, on any device, whatever
     * the switch said.
     */
    private static final String KEY_NOTIFY_SUCCESS = "notifyOnSuccess";
    private static final String KEY_NOTIFY_FAILURE = "notifyOnFailure";

    private final SharedPreferences prefs;

    JobStore(Context context) {
        this.prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    void save(JSONArray jobs, JSONArray accounts, boolean notifyOnSuccess, boolean notifyOnFailure) {
        prefs.edit()
                .putString(KEY_JOBS, jobs.toString())
                .putString(KEY_ACCOUNTS, accounts.toString())
                .putBoolean(KEY_NOTIFY_SUCCESS, notifyOnSuccess)
                .putBoolean(KEY_NOTIFY_FAILURE, notifyOnFailure)
                .apply();
    }

    /**
     * Both default to true — matching `DEFAULT_SETTINGS` — so an install whose
     * stored jobs predate these keys announces rather than falling silent. A
     * missing preference must never be read as "the user turned this off".
     */
    boolean notifyOnSuccess() {
        return prefs.getBoolean(KEY_NOTIFY_SUCCESS, true);
    }

    boolean notifyOnFailure() {
        return prefs.getBoolean(KEY_NOTIFY_FAILURE, true);
    }

    JSONArray jobs() {
        return readArray(KEY_JOBS);
    }

    JSONArray accounts() {
        return readArray(KEY_ACCOUNTS);
    }

    private JSONArray readArray(String key) {
        String raw = prefs.getString(key, "[]");
        try {
            return new JSONArray(raw);
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    JSONObject job(String jobId) {
        JSONArray all = jobs();
        for (int i = 0; i < all.length(); i++) {
            JSONObject job = all.optJSONObject(i);
            if (job != null && jobId.equals(job.optString("id"))) return job;
        }
        return null;
    }

    JSONObject account(String accountId) {
        JSONArray all = accounts();
        for (int i = 0; i < all.length(); i++) {
            JSONObject account = all.optJSONObject(i);
            if (account != null && accountId.equals(account.optString("id"))) return account;
        }
        return null;
    }

    /**
     * Record the outcome of a run and drop every occurrence that has now passed.
     *
     * The next fire time is whatever remains at the head of the list. Refilling
     * the list is the JavaScript layer's job — it owns all the calendar rules —
     * and happens the next time the app is opened.
     *
     * The result is also queued for the web layer in `KEY_PENDING_RUNS`. Almost
     * every scheduled send on Android happens with no WebView alive to notify,
     * so an event alone would be delivered to nobody: the mail would go out and
     * the schedule row would still read "waiting to send" the next time the app
     * was opened. The queue is what closes that gap — `drainRuns` hands it over
     * on the next launch or resume.
     *
     * @return the run report that was queued, so the caller can also hand it
     *         straight to an app that happens to be open right now
     *         ({@link AevistleNativePlugin#emitJobEvent}). Null when the job
     *         was not found — deleted between the alarm and the work running.
     *         Returning it rather than having the caller reconstruct it is what
     *         keeps the live event and the queued one identical by
     *         construction.
     */
    JSONObject recordRun(String jobId, long ranAt, boolean ok, String error) {
        JSONArray all = jobs();
        JSONObject run = null;
        for (int i = 0; i < all.length(); i++) {
            JSONObject job = all.optJSONObject(i);
            if (job == null || !jobId.equals(job.optString("id"))) continue;

            try {
                job.put("runCount", job.optInt("runCount", 0) + 1);
                job.put("lastRunAt", ranAt);
                job.put("lastResult", ok ? "ok" : "failed");
                if (error != null) job.put("lastError", error);

                JSONArray remaining = new JSONArray();
                JSONArray occurrences = job.optJSONArray("occurrences");
                if (occurrences != null) {
                    for (int k = 0; k < occurrences.length(); k++) {
                        long at = occurrences.optLong(k, 0L);
                        if (at > ranAt) remaining.put(at);
                    }
                }
                job.put("occurrences", remaining);

                // "armed" means *waiting for the next one*, so it is only true
                // when there is a next one. A one-off that has just fired is
                // finished, and saying "waiting to send" about it is the exact
                // complaint this whole change exists to fix. Repeating kinds
                // keep "armed" even at zero remaining, because the JS layer
                // refills the list on the next open.
                boolean repeats = !"once".equals(recurrenceKind(job));
                String status = !ok ? "failed" : (remaining.length() > 0 || repeats) ? "armed" : "done";
                job.put("status", status);

                run = new JSONObject();
                run.put("jobId", jobId);
                run.put("runCount", job.optInt("runCount", 0));
                run.put("lastRunAt", ranAt);
                run.put("lastResult", ok ? "ok" : "failed");
                if (error != null) run.put("lastError", error);
                run.put("status", status);
                run.put("occurrences", remaining);
            } catch (Exception e) {
                // The send already happened by the time this runs — `ok` is
                // the real outcome, independent of anything below. If the
                // bookkeeping above throws partway through, `run` would stay
                // null and `queueRun` below would be skipped entirely: a send
                // that genuinely occurred would never reach the web layer,
                // and the Schedule screen would show the job as armed
                // forever. Log it for logcat and fall back to a minimal
                // report so `drainRuns` still has something to deliver.
                Log.e(TAG, "recordRun: bookkeeping failed for job " + jobId, e);
                run = fallbackRun(jobId, ranAt, ok, error);
            }
            break;
        }
        prefs.edit().putString(KEY_JOBS, all.toString()).apply();
        if (run != null) queueRun(run);
        return run;
    }

    /**
     * A minimal run report for when the bookkeeping in {@link #recordRun}
     * fails partway through. Status is reported as "failed" even when `ok`
     * was true — an overstatement, deliberately: "something needs a look"
     * beats the job silently staying "armed" for a send that already went out.
     */
    private static JSONObject fallbackRun(String jobId, long ranAt, boolean ok, String error) {
        JSONObject run = new JSONObject();
        try {
            run.put("jobId", jobId);
            run.put("lastRunAt", ranAt);
            run.put("lastResult", ok ? "ok" : "failed");
            run.put("status", "failed");
            run.put("lastError", error != null ? error : "recordRun bookkeeping failed");
        } catch (Exception e) {
            // put() only throws for a null key, and every key above is a
            // string literal — unreachable in practice, but the checked
            // exception still has to land somewhere.
            Log.e(TAG, "recordRun: fallback run report itself failed for job " + jobId, e);
        }
        return run;
    }

    private static String recurrenceKind(JSONObject job) {
        JSONObject recurrence = job.optJSONObject("recurrence");
        return recurrence == null ? "once" : recurrence.optString("kind", "once");
    }

    /** Append one run report to the queue the web layer drains on next open. */
    private void queueRun(JSONObject run) {
        JSONArray queued = pendingRuns();
        // One entry per job: the web layer only ever applies the latest state,
        // and an unbounded queue would grow for the whole time the app is not
        // opened — a minute-interval reminder left alone for a week is 10 000
        // entries of which 9 999 are stale.
        JSONArray next = new JSONArray();
        String jobId = run.optString("jobId");
        for (int i = 0; i < queued.length(); i++) {
            JSONObject existing = queued.optJSONObject(i);
            if (existing != null && !jobId.equals(existing.optString("jobId"))) next.put(existing);
        }
        next.put(run);
        prefs.edit().putString(KEY_PENDING_RUNS, next.toString()).apply();
    }

    JSONArray pendingRuns() {
        try {
            return new JSONArray(prefs.getString(KEY_PENDING_RUNS, "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    /**
     * Hand over every queued run report and clear the queue.
     *
     * Cleared only after the caller has the data in hand, so a crash between
     * the two leaves the reports to be delivered again rather than losing them.
     * Applying the same report twice is harmless — it is absolute state, not a
     * delta.
     */
    JSONArray drainRuns() {
        JSONArray pending = pendingRuns();
        prefs.edit().remove(KEY_PENDING_RUNS).apply();
        return pending;
    }
}
