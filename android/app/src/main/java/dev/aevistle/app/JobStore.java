package dev.aevistle.app;

import android.content.Context;
import android.content.SharedPreferences;

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

    private static final String PREFS = "aevistle_jobs";
    private static final String KEY_JOBS = "jobs";
    private static final String KEY_ACCOUNTS = "accounts";

    private final SharedPreferences prefs;

    JobStore(Context context) {
        this.prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    void save(JSONArray jobs, JSONArray accounts) {
        prefs.edit()
                .putString(KEY_JOBS, jobs.toString())
                .putString(KEY_ACCOUNTS, accounts.toString())
                .apply();
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
     */
    void recordRun(String jobId, long ranAt, boolean ok, String error) {
        JSONArray all = jobs();
        for (int i = 0; i < all.length(); i++) {
            JSONObject job = all.optJSONObject(i);
            if (job == null || !jobId.equals(job.optString("id"))) continue;

            try {
                job.put("runCount", job.optInt("runCount", 0) + 1);
                job.put("lastRunAt", ranAt);
                job.put("lastResult", ok ? "ok" : "failed");
                if (error != null) job.put("lastError", error);
                job.put("status", ok ? "armed" : "failed");

                JSONArray remaining = new JSONArray();
                JSONArray occurrences = job.optJSONArray("occurrences");
                if (occurrences != null) {
                    for (int k = 0; k < occurrences.length(); k++) {
                        long at = occurrences.optLong(k, 0L);
                        if (at > ranAt) remaining.put(at);
                    }
                }
                job.put("occurrences", remaining);
            } catch (Exception ignored) {
            }
            break;
        }
        prefs.edit().putString(KEY_JOBS, all.toString()).apply();
    }
}
