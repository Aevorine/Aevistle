package dev.aevistle.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Iterator;

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
    /**
     * Mirror of `Settings.localDeviceId` — see its doc in `src/core/types.ts`.
     * Compared against `ScheduledJob.executorDeviceId` by both
     * {@link AevistleScheduler#rearmAll} and {@link SendWorker}, the same two
     * places that already read {@link #KEY_NOTIFY_SUCCESS} for the same
     * reason: a worker with no WebView attached has to already have it.
     */
    private static final String KEY_LOCAL_DEVICE_ID = "localDeviceId";
    /**
     * `jobId:instant` for every occurrence that has already been dispatched.
     * See {@link #claimOccurrence}. The mirror of the `fired` set in
     * `electron/scheduler.ts`, made durable because the case it guards is a
     * reboot loop and a set in memory does not survive one.
     */
    private static final String KEY_CLAIMS = "firedOccurrences";
    /**
     * How long a claim is kept. Past this, no route can put the instant back:
     * a run report has long since pruned it out of `occurrences` on both sides,
     * and the web layer's `rearm` collapses a backlog to its most recent entry.
     * Same day-long window `electron/scheduler.ts` prunes its set with.
     */
    private static final long CLAIM_RETENTION_MS = 24 * 60 * 60 * 1000L;

    private final SharedPreferences prefs;

    JobStore(Context context) {
        this.prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    void save(JSONArray jobs, JSONArray accounts, boolean notifyOnSuccess, boolean notifyOnFailure, String localDeviceId) {
        SharedPreferences.Editor editor = prefs.edit()
                .putString(KEY_JOBS, jobs.toString())
                .putString(KEY_ACCOUNTS, accounts.toString())
                .putBoolean(KEY_NOTIFY_SUCCESS, notifyOnSuccess)
                .putBoolean(KEY_NOTIFY_FAILURE, notifyOnFailure);
        // Never cleared by an absent value — an older web layer that has not
        // learned this yet must not erase what a newer one already told us.
        if (localDeviceId != null && !localDeviceId.isEmpty()) {
            editor.putString(KEY_LOCAL_DEVICE_ID, localDeviceId);
        }
        editor.apply();
    }

    /** Null until the first `syncJobs` call that carries one — see {@link #KEY_LOCAL_DEVICE_ID}. */
    String localDeviceId() {
        return prefs.getString(KEY_LOCAL_DEVICE_ID, null);
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

    /**
     * Record a run that a send condition deliberately called off.
     *
     * Not {@link #recordRun} with {@code ok = false}: a skip is neither a
     * success nor a failure, and filing it as one would be wrong in a way that
     * changes behaviour rather than just wording. {@code lastResult} stays
     * exactly as it was, because a `previousRunFailed` condition on a later
     * chain stage reads it — marking a skip as "failed" would make the
     * escalation fire off a run that never happened. {@code runCount} is not
     * bumped either: nothing was sent, and an `afterCount` end rule counts
     * sends. Both match the skip branch of `electron/scheduler.ts`.
     *
     * The occurrence is still consumed. Leaving it in place would re-evaluate
     * the same condition on the next wake, and then fire late and unexpectedly
     * the moment it changed.
     *
     * @return the queued run report, or null when the job was not found.
     */
    JSONObject recordSkip(String jobId, long ranAt, String reasonKey, JSONObject reasonValues) {
        JSONObject run = consume(jobId, ranAt, ranAt);
        /*
         * The reason travels on the queued report, not only on the live event.
         *
         * On this platform the app is usually shut when a skip happens, so the
         * live event reaches nobody and the queued report is the only surviving
         * record. Without these two the web layer had nothing to write: the
         * schedule row moved off "waiting to send" and no activity line
         * anywhere said which condition had held the mail back. `JobRun` in
         * `src/core/bridge.ts` declares both, and the drain effect in
         * `AppState` writes the log line when they are present.
         */
        if (run != null && reasonKey != null) {
            try {
                run.put("skipReasonKey", reasonKey);
                if (reasonValues != null) run.put("skipReasonValues", reasonValues);
                // `consume` has already queued a copy without the reason.
                // Queueing again replaces it rather than adding a second entry:
                // `queueRun` keeps one report per job id, by design.
                queueRun(run);
            } catch (Exception e) {
                Log.e(TAG, "recordSkip: could not attach the reason for job " + jobId, e);
            }
        }
        return run;
    }

    /**
     * Drop occurrences up to and including {@code through} without recording a
     * run at all — the job did not send and did not decide anything.
     *
     * Used for exactly one case: an occurrence that {@link #claimOccurrence}
     * says was already dispatched. Something has to remove it, or the alarm
     * armed for it is re-armed for it forever and the schedule row keeps
     * offering a past instant as the next send.
     */
    JSONObject dropOccurrencesThrough(String jobId, long through) {
        return consume(jobId, through, null);
    }

    /**
     * Shared body of {@link #recordSkip} and {@link #dropOccurrencesThrough}:
     * prune the occurrence list, restate the status, and queue the result for
     * the web layer.
     *
     * @param ranAt stamped as `lastRunAt` when non-null; left untouched when not.
     */
    private JSONObject consume(String jobId, long through, Long ranAt) {
        JSONArray all = jobs();
        JSONObject run = null;
        for (int i = 0; i < all.length(); i++) {
            JSONObject job = all.optJSONObject(i);
            if (job == null || !jobId.equals(job.optString("id"))) continue;

            try {
                if (ranAt != null) job.put("lastRunAt", (long) ranAt);

                JSONArray remaining = new JSONArray();
                JSONArray occurrences = job.optJSONArray("occurrences");
                if (occurrences != null) {
                    for (int k = 0; k < occurrences.length(); k++) {
                        long at = occurrences.optLong(k, 0L);
                        if (at > through) remaining.put(at);
                    }
                }
                job.put("occurrences", remaining);

                // Same rule {@link #recordRun} uses: "armed" means waiting for
                // the next one, and a repeating job stays armed at zero
                // remaining because the web layer refills the list on open.
                // Note this clears a previous "failed" *status* — `lastResult`
                // is what still says the last send failed, and that is left
                // alone above.
                boolean repeats = !"once".equals(recurrenceKind(job));
                String status = (remaining.length() > 0 || repeats) ? "armed" : "done";
                job.put("status", status);

                run = new JSONObject();
                run.put("jobId", jobId);
                run.put("runCount", job.optInt("runCount", 0));
                run.put("lastRunAt", job.optLong("lastRunAt", System.currentTimeMillis()));
                if (job.has("lastResult")) run.put("lastResult", job.optString("lastResult"));
                if (job.has("lastError")) run.put("lastError", job.optString("lastError"));
                run.put("status", status);
                run.put("occurrences", remaining);
            } catch (Exception e) {
                // `put` only throws for a null key and every key here is a
                // literal. Logged rather than ignored because a half-written
                // job would leave the consumed instant in the list, and the
                // alarm for it would be re-armed on every sync.
                Log.e(TAG, "consume: bookkeeping failed for job " + jobId, e);
            }
            break;
        }
        prefs.edit().putString(KEY_JOBS, all.toString()).apply();
        if (run != null) queueRun(run);
        return run;
    }

    // -----------------------------------------------------------------------
    // Occurrence claims
    // -----------------------------------------------------------------------

    /**
     * Claim one (job, instant) pair before dispatching it.
     *
     * The mirror of `this.fired.add(`${job.id}:${fireAt}`)` in
     * `electron/scheduler.ts`, and the reason a missed occurrence can now be
     * paid at all: {@link AevistleScheduler} arms an immediate alarm for a past
     * instant, and every route that arms alarms runs repeatedly — on boot, on
     * package replacement, on the exact-alarm permission changing, and on every
     * `syncJobs` the app makes. Without a claim the same instant would be armed
     * and sent again each time, and a device that reboots twice would send the
     * same reminder twice. Duplicate mail is worse than the late reminder this
     * whole mechanism exists to deliver, so the claim is not optional.
     *
     * Written with {@code commit()}, not {@code apply()}. {@code apply()}
     * returns before the write reaches disk, and the caller is a worker that
     * may be killed the moment the send finishes — the one case where losing
     * the claim produces the duplicate it exists to prevent.
     *
     * @return true when the pair had not been claimed before, i.e. the caller
     *         owns this dispatch. False means somebody already sent it.
     */
    boolean claimOccurrence(String jobId, long instant) {
        String key = claimKey(jobId, instant);
        JSONObject claims = claims();
        if (claims.has(key)) return false;

        JSONObject next = pruneClaims(claims);
        try {
            next.put(key, instant);
        } catch (Exception e) {
            // A claim that cannot be stored cannot stop a second send. Refusing
            // the dispatch loses at most one reminder; allowing it risks the
            // same mail arriving on every reboot, which is the failure people
            // cannot undo.
            Log.e(TAG, "claimOccurrence: could not record the claim for " + key, e);
            return false;
        }
        prefs.edit().putString(KEY_CLAIMS, next.toString()).commit();
        return true;
    }

    /**
     * Has this pair already been dispatched? A read-only peek, so
     * {@link AevistleScheduler} can decline to arm an alarm that would only be
     * thrown away — without taking a claim it is not going to act on.
     */
    boolean occurrenceClaimed(String jobId, long instant) {
        return claims().has(claimKey(jobId, instant));
    }

    private static String claimKey(String jobId, long instant) {
        return jobId + ":" + instant;
    }

    private JSONObject claims() {
        try {
            return new JSONObject(prefs.getString(KEY_CLAIMS, "{}"));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    /**
     * Drop claims older than {@link #CLAIM_RETENTION_MS} so this does not grow
     * for the life of the install. The value stored against each key is the
     * instant itself, which is what makes the sweep a single pass with no
     * parsing of the key back apart.
     */
    private static JSONObject pruneClaims(JSONObject claims) {
        long cutoff = System.currentTimeMillis() - CLAIM_RETENTION_MS;
        JSONObject kept = new JSONObject();
        Iterator<String> keys = claims.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            long at = claims.optLong(key, 0L);
            if (at < cutoff) continue;
            try {
                kept.put(key, at);
            } catch (Exception e) {
                Log.w(TAG, "pruneClaims: could not keep the claim " + key, e);
            }
        }
        return kept;
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
