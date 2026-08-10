package dev.aevistle.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.security.SecureRandom;
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
     * Per-occurrence send state — see the "Dispatch ledger" section below.
     * Replaces the old boolean `firedOccurrences` claim entirely.
     */
    private static final String KEY_LEDGER = "dispatchLedger";

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
     * Shared body of {@link #recordSkip}: prune the occurrence list, restate
     * the status, and queue the result for the web layer.
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
    // Dispatch ledger
    // -----------------------------------------------------------------------
    //
    // Replaces the old boolean "firedOccurrences" claim entirely -- not run
    // alongside it. That claim only ever answered "did we start sending
    // this", and a crash between MailSender.send() accepting a message and
    // recordRun() catching up looked exactly like a crash *before* anything
    // was sent; both resolved to "never touch it again" ("duplicate is worse
    // than a miss", the old comment said). This ledger records *how far* an
    // occurrence's send got -- 'claimed' -> 'sending' -> 'accepted' -- one
    // entry per occurrence, keyed the same way the old claim was
    // (`${jobId}:${occurrenceMs}`), so AevistleScheduler#nextOccurrence's
    // restart-recovery hook can tell an unconfirmed attempt (resend it) from
    // a confirmed one (leave it alone, just catch the bookkeeping up).
    // Mirrors `src/core/dispatchLedger.ts` and the "Dispatch ledger" section
    // of `electron/store.ts` field for field; see those for the full
    // rationale behind the new "prefer a duplicate over a silent miss" policy.

    /** Same window the old claim was kept for -- see its retired doc comment. */
    private static final long LEDGER_MAX_AGE_MS = 24 * 60 * 60 * 1000L;
    private static final char[] HEX_DIGITS = "0123456789abcdef".toCharArray();

    static String ledgerClaimKey(String jobId, long occurrenceMs) {
        return jobId + ":" + occurrenceMs;
    }

    private JSONObject ledger() {
        try {
            return new JSONObject(prefs.getString(KEY_LEDGER, "{}"));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    /**
     * Drop entries older than {@link #LEDGER_MAX_AGE_MS} so this does not grow
     * for the life of the install — applied on every write, mirroring
     * `pruneLedger` in `electron/store.ts`. Entries are normally removed the
     * moment they are done (see {@link #deleteLedgerEntry}); this is only the
     * safety net for ones a crash left behind with nobody left to clean them
     * up.
     */
    private static JSONObject pruneLedger(JSONObject ledger) {
        long cutoff = System.currentTimeMillis() - LEDGER_MAX_AGE_MS;
        JSONObject kept = new JSONObject();
        Iterator<String> keys = ledger.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            JSONObject entry = ledger.optJSONObject(key);
            if (entry == null || entry.optLong("claimedAt", 0L) < cutoff) continue;
            try {
                kept.put(key, entry);
            } catch (Exception e) {
                Log.w(TAG, "pruneLedger: could not keep the entry " + key, e);
            }
        }
        return kept;
    }

    private void writeLedger(JSONObject ledger, boolean durable) {
        SharedPreferences.Editor editor = prefs.edit().putString(KEY_LEDGER, pruneLedger(ledger).toString());
        if (durable) {
            editor.commit();
        } else {
            editor.apply();
        }
    }

    /** Read-only peek at one entry, or null when there is none. */
    JSONObject ledgerEntry(String claimKey) {
        return ledger().optJSONObject(claimKey);
    }

    /**
     * Whatever ledger entry belongs to this job, if any. There should be at
     * most one: {@link AlarmReceiver} enqueues {@link SendWorker} with
     * {@code ExistingWorkPolicy.KEEP}, which never lets two instances for the
     * same job run at once. Used to recover a claim's key and message id on a
     * WorkManager retry, where {@link AevistleScheduler#dueOccurrence} can no
     * longer find the occurrence — the first attempt's {@link #recordRun} has
     * already dropped it out of `job.occurrences` by the time a retry re-reads
     * the job fresh.
     *
     * If more than one somehow exists (an older, orphaned entry that a
     * restart-recovery pass has not yet reached — see
     * {@link AevistleScheduler#nextOccurrence}), the most recently claimed one
     * wins: that is the one this attempt's own {@link #claimLedgerEntry} call
     * just wrote.
     */
    JSONObject ledgerEntryForJob(String jobId) {
        JSONObject ledger = ledger();
        JSONObject latest = null;
        Iterator<String> keys = ledger.keys();
        while (keys.hasNext()) {
            JSONObject entry = ledger.optJSONObject(keys.next());
            if (entry == null || !jobId.equals(entry.optString("jobId", null))) continue;
            if (latest == null || entry.optLong("claimedAt", 0L) > latest.optLong("claimedAt", 0L)) {
                latest = entry;
            }
        }
        return latest;
    }

    /**
     * `<${claimKey}.${16 hex chars}@aevistle.local>` — shaped like an RFC
     * 5322 msg-id, not validated as one, mirroring `mintMessageId` in
     * `src/core/dispatchLedger.ts`. {@link SecureRandom} with no seeding is
     * the same convention {@link OAuthConsent#randomToken} already uses for
     * this app's other unguessable-string needs.
     *
     * Best-effort duplicate hinting for the recipient's mail system, not a
     * deduplication guarantee — most mail clients do not dedupe on
     * `Message-Id` at all, and the ones that do are under no obligation to.
     */
    static String mintMessageId(String claimKey) {
        byte[] bytes = new byte[8];
        new SecureRandom().nextBytes(bytes);
        char[] hex = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            int v = bytes[i] & 0xFF;
            hex[i * 2] = HEX_DIGITS[v >>> 4];
            hex[i * 2 + 1] = HEX_DIGITS[v & 0x0F];
        }
        return "<" + claimKey + "." + new String(hex) + "@aevistle.local>";
    }

    /**
     * Durably record that this occurrence has been picked to fire — the
     * 'claimed' state. Reuses an existing entry's message id and bumps its
     * `attempts` count when this claimKey was already claimed by a prior
     * attempt (a restart-recovered resend); mints a fresh id otherwise.
     *
     * Written with {@code apply()}. Unlike the old boolean claim, losing this
     * particular write is not a correctness problem under the new policy: a
     * missing entry and a 'claimed' entry both resolve to "resend" on restart
     * (see {@link AevistleScheduler#nextOccurrence}), so nothing but
     * {@link #markLedgerSending}'s durability — immediately before the SMTP
     * call — is load-bearing here.
     *
     * @return the claimed entry, or null if it could not even be built —
     *         {@link SendWorker} falls back to a locally-minted message id in
     *         that case and sends anyway, matching the desktop build's
     *         tolerance for a failed claim write.
     */
    JSONObject claimLedgerEntry(String jobId, long occurrenceMs) {
        String claimKey = ledgerClaimKey(jobId, occurrenceMs);
        JSONObject ledger = ledger();
        JSONObject existing = ledger.optJSONObject(claimKey);
        try {
            JSONObject entry = new JSONObject();
            entry.put("claimKey", claimKey);
            entry.put("jobId", jobId);
            entry.put("occurrenceMs", occurrenceMs);
            entry.put("state", "claimed");
            entry.put("messageId", existing != null && existing.has("messageId")
                    ? existing.optString("messageId")
                    : mintMessageId(claimKey));
            entry.put("claimedAt", System.currentTimeMillis());
            entry.put("attempts", (existing != null ? existing.optLong("attempts", 0L) : 0L) + 1);

            ledger.put(claimKey, entry);
            writeLedger(ledger, false);
            return entry;
        } catch (Exception e) {
            Log.e(TAG, "claimLedgerEntry: could not claim " + claimKey, e);
            return null;
        }
    }

    /**
     * Durably record that an SMTP attempt for this claimKey is starting right
     * now — written with {@code commit()}, not {@code apply()}, for the same
     * reason the old claim write was: the caller is about to hand control to
     * {@link MailSender#send}, which may be the last thing that runs before
     * the OS kills this process, and {@code commit()} blocks until the write
     * has actually reached disk. Written once per WorkManager attempt —
     * {@link SendWorker} calls this again on every retry, the same way
     * `sendOnce()`'s retry loop writes it once per actual attempt on the
     * desktop build — without re-claiming, so the entry's `attempts` count
     * keeps meaning "attempts across restarts", not "attempts across retries".
     *
     * A no-op if there is no entry to transition — the claim write above
     * failed, or was itself lost. Nothing durable to update in that case; the
     * send proceeds regardless.
     */
    void markLedgerSending(String claimKey) {
        JSONObject ledger = ledger();
        JSONObject entry = ledger.optJSONObject(claimKey);
        if (entry == null) return;
        try {
            entry.put("state", "sending");
            entry.put("sendingAt", System.currentTimeMillis());
            ledger.put(claimKey, entry);
            writeLedger(ledger, true);
        } catch (Exception e) {
            Log.e(TAG, "markLedgerSending: could not record sending for " + claimKey, e);
        }
    }

    /**
     * Durably record that the SMTP server accepted the message — the one
     * state with positive proof of delivery.
     */
    void markLedgerAccepted(String claimKey) {
        JSONObject ledger = ledger();
        JSONObject entry = ledger.optJSONObject(claimKey);
        if (entry == null) return;
        try {
            entry.put("state", "accepted");
            entry.put("acceptedAt", System.currentTimeMillis());
            ledger.put(claimKey, entry);
            writeLedger(ledger, false);
        } catch (Exception e) {
            Log.e(TAG, "markLedgerAccepted: could not record acceptance for " + claimKey, e);
        }
    }

    /**
     * Remove the ledger entry for this claimKey — the completion signal. A
     * missing entry means "fully done", exactly like the boolean claim file
     * it replaced. Called once the job's own bookkeeping ({@link #recordRun},
     * {@link #recordSkip}, or {@link #completeAcceptedRecovery}) has recorded
     * this occurrence's outcome, whatever that outcome was.
     */
    void deleteLedgerEntry(String claimKey) {
        JSONObject ledger = ledger();
        if (!ledger.has(claimKey)) return;
        ledger.remove(claimKey);
        writeLedger(ledger, false);
    }

    /**
     * Apply the same bookkeeping {@link #recordRun} does for a successful
     * send, for an occurrence the ledger has positive proof was already sent
     * before a crash — without attempting the send again and without
     * re-evaluating send conditions, because the send already genuinely
     * happened. Mirrors `completeAcceptedRecovery` in `electron/scheduler.ts`,
     * which reuses the same `completeRun` its live send path does;
     * {@link #recordRun} is that shared function here.
     *
     * @return null when this occurrence is not pending any more — the job's
     *         own bookkeeping may already have caught up with it before the
     *         crash that left the ledger entry behind ({@link #recordRun} and
     *         {@link #deleteLedgerEntry} are two separate steps) — in which
     *         case there is nothing left to record.
     */
    JSONObject completeAcceptedRecovery(String jobId, long occurrenceMs) {
        JSONObject job = job(jobId);
        if (job == null) return null;
        JSONArray occurrences = job.optJSONArray("occurrences");
        boolean stillPending = false;
        if (occurrences != null) {
            for (int i = 0; i < occurrences.length(); i++) {
                if (occurrences.optLong(i, 0L) == occurrenceMs) {
                    stillPending = true;
                    break;
                }
            }
        }
        if (!stillPending) return null;
        return recordRun(jobId, System.currentTimeMillis(), true, null);
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
