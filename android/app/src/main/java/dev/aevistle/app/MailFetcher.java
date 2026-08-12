package dev.aevistle.app;

import android.content.Context;
import android.text.TextUtils;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import javax.mail.Address;
import javax.mail.BodyPart;
import javax.mail.Flags;
import javax.mail.Folder;
import javax.mail.FolderClosedException;
import javax.mail.Message;
import javax.mail.Multipart;
import javax.mail.Part;
import javax.mail.Session;
import javax.mail.Store;
import javax.mail.StoreClosedException;
import javax.mail.UIDFolder;
import javax.mail.internet.InternetAddress;
import javax.mail.internet.MimeUtility;

/**
 * IMAP on Android, via JavaMail.
 *
 * Mirrors `electron/imap.ts` in scope, not line for line — the desktop file's
 * header explains the boundaries and they apply here unchanged: INBOX only,
 * no folder hierarchy, polling rather than IDLE (a periodic WorkManager job
 * plays the role the desktop's timer does), and a bounded body prefetch so an
 * account with years of mail does not try to download all of it on the first
 * sync. Reuses {@link MailSender}'s endpoint ladder and error classification
 * rather than re-deriving them — a misconfigured port or a slow DNS server is
 * the same failure on either protocol.
 */
final class MailFetcher {

    private static final String TAG = "MailFetcher";
    private static final int LIST_LIMIT = 50;
    private static final long ATTACHMENT_MAX_BYTES = 10L * 1024 * 1024;

    private MailFetcher() {
    }

    // -----------------------------------------------------------------------
    // Prefetch budget
    // -----------------------------------------------------------------------

    /**
     * What one sync is willing to spend pulling down bodies nobody has asked
     * for yet.
     *
     * Five numbers rather than one, because the prefetch has costs that are not
     * bounded by the same thing, and because it now happens in two stages that
     * the user experiences completely differently:
     *
     *   - the *foreground* stage is what {@link #sync} itself waits for before
     *     it can return a message list, so every byte in it is a byte the
     *     inbox screen is blocked on;
     *   - the *tail* is everything after that, fetched once the list is already
     *     on screen, so its only cost is the user's data allowance.
     *
     * The per-message ceiling is shared by both because the batched fetch below
     * asks for *whole* messages: one mail with a photo attached could otherwise
     * eat an entire budget on a file nobody opened.
     */
    private static final class PrefetchBudget {
        /** How many messages the sync itself waits for. */
        final int foreground;
        /** And how many bytes those may cost — the number the list paint waits on. */
        final long foregroundBytes;
        /** How many messages are worth having on disk in total, foreground included. */
        final int messages;
        /** What the background stage may spend on the rest of them. */
        final long tailBytes;
        final long perMessageBytes;

        PrefetchBudget(int foreground, long foregroundBytes, int messages, long tailBytes,
                       long perMessageBytes) {
            this.foreground = foreground;
            this.foregroundBytes = foregroundBytes;
            this.messages = messages;
            this.tailBytes = tailBytes;
            this.perMessageBytes = perMessageBytes;
        }
    }

    /**
     * Fifteen messages, 512 KB, 64 KB each, and no tail — what shipped,
     * unchanged, for a phone on mobile data.
     *
     * The count is the number this class has always used and the byte ceilings
     * are the ones it has always declared. Keeping the metered figures at the
     * shipped values is the whole point: with the default setting, this release
     * cannot spend a byte of anybody's data allowance that the previous build
     * did not already spend. Someone who wants the rest of the list on mobile
     * data has to say so — see {@link #METERED_OPTED_IN}.
     *
     * The 64 KB per-message ceiling is tighter here than on Wi-Fi for the one
     * way whole-message fetching *can* cost more than the old part-by-part
     * path: an HTML mail with an inline image. Under 64 KB there is no room
     * for one large enough to matter.
     */
    private static final PrefetchBudget METERED =
            new PrefetchBudget(15, 512L * 1024, 15, 0L, 64L * 1024);

    /**
     * The same foreground, plus a tail, for someone who asked for it.
     *
     * Reached only when {@code Settings.inboxPrefetchFull} is {@code 'always'},
     * which is a switch the user has to find and turn on. The foreground half
     * is byte-for-byte {@link #METERED}, so the part of a sync anybody waits on
     * costs exactly what it did before; what the setting buys is the remaining
     * 35 messages of the list arriving in the background afterwards.
     *
     * 4 MB and 128 KB rather than the Wi-Fi figures because this is still
     * somebody's mobile plan. 128 KB is above a long HTML newsletter and below
     * anything with a photo in it; 4 MB over 35 messages is roughly a
     * newsletter each and stops well short of a number worth noticing on a bill.
     * The budget is raised rather than removed on purpose: an account with a
     * decade of mail and a phone plan is not a combination worth handing an
     * unbounded download to.
     */
    private static final PrefetchBudget METERED_OPTED_IN =
            new PrefetchBudget(15, 512L * 1024, LIST_LIMIT, 4L * 1024 * 1024, 128L * 1024);

    /**
     * Thirty messages in front, the rest of the list behind, on an unmetered
     * connection.
     *
     * The foreground half is what shipped — thirty messages and 2 MB — and it
     * stays that way because it is the half a person is waiting on. What is
     * new is the tail: messages 31 to {@link #LIST_LIMIT}, which before this
     * release were *never* prefetched at all, so opening any of them paid a
     * full IMAP ladder (six to eight sequential round trips at 50-150 ms each)
     * before a single byte of text moved. Covering the whole list is the point
     * of the change; doing it after the list is on screen is what stops it
     * costing anything the user can feel.
     *
     * 256 KB per message is comfortably above a long HTML newsletter and
     * comfortably below anything with a real attachment on it, so a message
     * that would cost more than its text is worth falls out of the batch and
     * back onto the on-demand path. 8 MB of tail is 20 messages at that ceiling
     * or 160 at the ~50 KB a plain message actually weighs — a real ceiling
     * that the ordinary case never comes near.
     */
    private static final PrefetchBudget UNMETERED =
            new PrefetchBudget(30, 2L * 1024 * 1024, LIST_LIMIT, 8L * 1024 * 1024, 256L * 1024);

    /**
     * Which of the three applies right now.
     *
     * Two questions, and only the first one costs anything: is this connection
     * metered, and — if it is — has the user said to prefetch anyway.
     * "Could not tell" is treated as metered, because guessing wrong the other
     * way spends somebody's data allowance on mail they may never open.
     */
    private static PrefetchBudget prefetchBudget(Context context) {
        if (!metered(context)) return UNMETERED;
        return "always".equals(prefetchSetting(context)) ? METERED_OPTED_IN : METERED;
    }

    /**
     * Is this connection one the user pays for by the megabyte?
     *
     * "Could not tell" answers yes, everywhere this is used. Guessing wrong in
     * that direction costs a slower first open; guessing wrong in the other
     * spends somebody's data allowance on mail they may never read.
     */
    private static boolean metered(Context context) {
        try {
            android.net.ConnectivityManager manager = (android.net.ConnectivityManager)
                    context.getSystemService(Context.CONNECTIVITY_SERVICE);
            return manager == null || manager.isActiveNetworkMetered();
        } catch (Exception e) {
            Log.w(TAG, "metered: could not read the network's metered state; assuming metered", e);
            return true;
        }
    }

    /**
     * The app's own `Settings` object, or null if there is not one yet.
     *
     * Read straight out of the same {@link android.content.SharedPreferences}
     * file {@link AppSettingsSignal} reads, for the same reason that class
     * exists: {@link InboxSyncWorker} runs on WorkManager's schedule with no
     * WebView in the process, so there is nobody to ask. The two constants are
     * duplicated here rather than shared because {@code AppSettingsSignal}'s
     * own reader is private; that file is the source of truth for what they
     * mean, and this is a read — nothing here ever writes to that file.
     *
     * Null on a first launch with nothing saved, and null on a parse failure.
     * Every caller answers null with the same default `src/core/types.ts`
     * declares, so an install that predates a setting behaves like a fresh one.
     */
    private static JSONObject appSettings(Context context) {
        try {
            android.content.SharedPreferences prefs = context.getApplicationContext()
                    // `PreferencesConfiguration.DEFAULTS.group` in @capacitor/preferences.
                    .getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
            // `STATE_KEY` in `src/core/bridge-android.ts`.
            String raw = prefs.getString("aevistle.state.v1", null);
            if (raw == null) return null;
            return new JSONObject(raw).optJSONObject("settings");
        } catch (Exception e) {
            Log.w(TAG, "appSettings: could not read the app's own settings", e);
            return null;
        }
    }

    /** {@code Settings.inboxPrefetchFull} — {@code "wifi"} (the default) or {@code "always"}. */
    private static String prefetchSetting(Context context) {
        JSONObject settings = appSettings(context);
        return settings == null ? "wifi" : settings.optString("inboxPrefetchFull", "wifi");
    }

    // -----------------------------------------------------------------------
    // Session
    // -----------------------------------------------------------------------

    private static Session buildSession(JSONObject config, MailSender.Endpoint endpoint,
                                        String accessToken, boolean compress) {
        int timeout = 15000;
        Properties props = new Properties();
        props.put("mail.imap.host", config.optString("imapHost", ""));
        props.put("mail.imap.port", String.valueOf(endpoint.port));
        props.put("mail.imap.connectiontimeout", String.valueOf(timeout));
        props.put("mail.imap.timeout", String.valueOf(timeout));
        props.put("mail.imap.writetimeout", String.valueOf(timeout));
        props.put("mail.imap.ssl.protocols", "TLSv1.2 TLSv1.3");

        /*
         * How much of a body one FETCH asks for.
         *
         * JavaMail reads bodies through IMAPInputStream, which issues
         * `FETCH n BODY.PEEK[…]<offset.blksize>` once per block and waits for
         * the reply before asking for the next — `blksize` is this property,
         * and android-mail 1.6.7 defaults it to 16384 (the literal sits next
         * to the ".fetchsize" string in IMAPStore's bytecode). So a 300 KB
         * message costs ceil(307200 / 16384) = 19 sequential round trips.
         * At 256 KB it costs 2. On a phone at 80 ms round trip that is 1.5 s
         * of pure waiting turned into 160 ms, and not one byte of it is
         * bandwidth — the same content arrives either way.
         *
         * 256 KB rather than the whole message: `mail.imap.partialfetch=false`
         * would make it a single round trip, but that mode buffers the entire
         * message in one array, and this class accepts attachments up to
         * ATTACHMENT_MAX_BYTES — a 10 MB byte[] on whatever phone is reading.
         * IMAPInputStream holds one block at a time instead, so this number
         * *is* the peak allocation per body being read, and 256 KB against an
         * Android heap measured in hundreds of megabytes is not a trade.
         */
        props.put("mail.imap.fetchsize", String.valueOf(256 * 1024));

        /*
         * Two connections, kept for longer than JavaMail's 45-second default.
         *
         * The handshakes are saved by the parking below keeping the Store
         * alive between operations; this property is what stops JavaMail
         * quietly closing the authenticated connection underneath it.
         * IMAPStore.timeoutConnections() prunes a pooled connection once it
         * has sat unused for `connectionpooltimeout`, so anything shorter than
         * REUSE_IDLE_MS would leave a live Store holding nothing and the next
         * operation would pay a full LOGIN anyway.
         *
         * The size is 2 rather than 1 for one specific cliff, and it is not
         * claimed to save a round trip on its own: opening INBOX takes the
         * connection *out* of the pool, so a store-level command issued while
         * it is open finds the pool empty — and getStoreProtocol() answers an
         * empty pool by opening and authenticating a second connection rather
         * than waiting. One spare slot means that connection is kept on
         * release instead of being logged out and paid for again.
         */
        props.put("mail.imap.connectionpoolsize", "2");
        props.put("mail.imap.connectionpooltimeout", String.valueOf(REUSE_IDLE_MS + 30000L));

        if (compress) {
            /*
             * COMPRESS=DEFLATE (RFC 4978). Mail is text — headers, HTML
             * bodies, quoted replies — and deflate takes most of it off before
             * it goes anywhere near a mobile link. Bytes not sent.
             *
             * Safe to ask for unconditionally, and that was checked rather
             * than assumed, because it is exactly the kind of property a 2021
             * release might not have. In the shipped android-mail 1.6.7 jar,
             * IMAPStore reads `mail.imap.compress.enable` (default false) into
             * a field, and its post-login sequence is
             * `if (enableCompress && p.hasCapability("COMPRESS=DEFLATE")) p.compress();`
             * — the bytecode's branch for a server that does not advertise it
             * jumps straight past the call to the next step, so nothing is
             * sent and nothing throws. The plumbing behind it is real too:
             * com.sun.mail.iap.Protocol.startCompression wires a
             * java.util.zip Inflater and Deflater onto the socket.
             *
             * What that check does *not* cover is a server that advertises the
             * capability and then refuses the command — see the ladder in
             * `withInbox`, which retries once without this.
             */
            props.put("mail.imap.compress.enable", "true");
        }

        if ("ssl".equals(endpoint.security)) {
            props.put("mail.imap.ssl.enable", "true");
        } else if ("starttls".equals(endpoint.security)) {
            props.put("mail.imap.starttls.enable", "true");
            props.put("mail.imap.starttls.required", "true");
        }

        if (config.optBoolean("imapAllowInvalidCert", false)) {
            props.put("mail.imap.ssl.trust", "*");
            props.put("mail.imap.ssl.checkserveridentity", "false");
        } else {
            props.put("mail.imap.ssl.checkserveridentity", "true");
        }

        if (!TextUtils.isEmpty(accessToken)) {
            /*
             * XOAUTH2, and only XOAUTH2 — see the matching block in
             * {@link MailSender}. JavaMail sends
             * `AUTHENTICATE XOAUTH2 <base64 of "user=…\1auth=Bearer …\1\1">`,
             * which is the same payload the SMTP side sends and is what both
             * vendors document for IMAP.
             *
             * Naming the mechanism explicitly also removes the fallback that
             * would otherwise be the worst outcome here: LOGIN with a bearer
             * token in the password field, which sends a live credential in
             * plaintext form to a server that is going to reject it, and
             * reports the result as a wrong password on an account that has
             * none.
             */
            props.put("mail.imap.auth.mechanisms", "XOAUTH2");
        }

        return Session.getInstance(props);
    }

    private static List<MailSender.Endpoint> ladderFor(JSONObject config) {
        return MailSender.ladder(
                config.optInt("imapPort", 993),
                config.optString("imapSecurity", "ssl"),
                true);
    }

    private interface WithStore<T> {
        T run(Store store, Folder inbox) throws Exception;
    }

    // -----------------------------------------------------------------------
    // Connection reuse
    //
    // Every method here used to open a connection, do one thing and log out.
    // Opening a message the sync had not prefetched therefore cost a TCP
    // handshake, a TLS handshake, the server greeting, CAPABILITY, LOGIN and
    // the post-login CAPABILITY before the first byte of that message moved —
    // six to eight sequential round trips, on a link where each is 50-150 ms.
    // Reading five messages paid for it five times.
    //
    // So a finished operation parks its authenticated connection instead of
    // logging out, and the next one picks it up. What the next one still pays
    // is the SELECT, one round trip, because the folder is closed in between:
    // that keeps READ_ONLY and READ_WRITE callers from having to negotiate
    // over a shared folder handle, and it means a stale mailbox view cannot
    // outlive a single operation. Seven-ish round trips saved, one kept.
    // -----------------------------------------------------------------------

    /**
     * How long an authenticated connection is kept after the operation that
     * opened it finishes.
     *
     * Two minutes, sized to one person reading mail: sync, open a message,
     * mark it read, open the next, save an attachment. Five operations that
     * cost five full handshakes before this and now cost one.
     *
     * Deliberately nowhere near long enough to count as holding a connection
     * open. RFC 3501 lets a server drop an idle client after thirty minutes
     * and carrier NAT tables are measured in minutes too, so this expires long
     * before anything else would notice; a TCP socket with nothing on it sends
     * no packets, so the radio follows its own idle timers rather than this
     * one. The case this must never cover is the fifteen-minute gap between
     * background syncs — {@link InboxSyncWorker} closes everything before it
     * returns rather than leaving that to the timer, because once doWork()
     * returns the process can be killed at any moment and a timer that never
     * fires is not a timer.
     */
    private static final long REUSE_IDLE_MS = 2L * 60L * 1000L;

    /** One parked connection and when it was parked. */
    private static final class Parked {
        final Store store;
        final long since;

        Parked(Store store, long since) {
            this.store = store;
            this.since = since;
        }
    }

    private static final Map<String, Parked> PARKED = new HashMap<>();

    /**
     * Closes connections that nobody came back for.
     *
     * Created on first use and daemon, so it can never be the reason a
     * WorkManager process stays alive after its worker has finished.
     */
    private static ScheduledExecutorService reaper;

    /**
     * What makes two operations "the same account" for reuse.
     *
     * The account's *configured* endpoint rather than whichever rung of the
     * ladder actually answered, so that editing a port, a username or the
     * invalid-certificate switch cannot be answered by a connection made under
     * the old setting. The secret is deliberately not part of this: a
     * connection is authenticated once, at LOGIN, and re-checking a password
     * that the server already accepted for this session would mean keeping the
     * password around to compare against.
     */
    private static String reuseKey(JSONObject config) {
        return config.optString("imapHost", "")
                + '\n' + config.optInt("imapPort", 993)
                + '\n' + config.optString("imapSecurity", "ssl")
                + '\n' + config.optString("imapUsername", "")
                + '\n' + config.optBoolean("imapAllowInvalidCert", false);
    }

    /**
     * Take the parked connection for this account, if there is a live one.
     *
     * Removed rather than lent out. JavaMail's Store is thread-safe, but the
     * open-INBOX / use / close-INBOX sequence wrapped around it here is not,
     * and two callers really can overlap: the Capacitor plugin runs on its own
     * thread pool while {@link InboxSyncWorker} runs on WorkManager's. A caller
     * that finds nothing parked just connects, which is what every caller did
     * before any of this existed.
     */
    private static Store takeParked(String key) {
        Store stale = null;
        Store live = null;
        synchronized (PARKED) {
            Parked parked = PARKED.remove(key);
            if (parked != null) {
                if (System.currentTimeMillis() - parked.since > REUSE_IDLE_MS) {
                    stale = parked.store;
                } else {
                    live = parked.store;
                }
            }
        }
        // Outside the lock: LOGOUT talks to the network.
        closeQuietly(stale);
        return live;
    }

    private static void park(String key, Store store) {
        Store replaced = null;
        synchronized (PARKED) {
            Parked previous = PARKED.put(key, new Parked(store, System.currentTimeMillis()));
            if (previous != null) replaced = previous.store;
            if (reaper == null) {
                reaper = Executors.newSingleThreadScheduledExecutor(runnable -> {
                    Thread thread = new Thread(runnable, "aevistle-imap-idle");
                    thread.setDaemon(true);
                    return thread;
                });
            }
            // One sweep per park. They are cheap, they only ever close what has
            // actually expired, and scheduling unconditionally is what makes the
            // last operation before the app is put down still get swept.
            reaper.schedule(MailFetcher::sweepParked, REUSE_IDLE_MS + 1000L, TimeUnit.MILLISECONDS);
        }
        closeQuietly(replaced);
    }

    private static void sweepParked() {
        List<Store> expired = new ArrayList<>();
        synchronized (PARKED) {
            long now = System.currentTimeMillis();
            Iterator<Map.Entry<String, Parked>> entries = PARKED.entrySet().iterator();
            while (entries.hasNext()) {
                Parked parked = entries.next().getValue();
                if (now - parked.since >= REUSE_IDLE_MS) {
                    expired.add(parked.store);
                    entries.remove();
                }
            }
        }
        for (Store store : expired) closeQuietly(store);
    }

    /**
     * Close every parked connection now.
     *
     * The clean-shutdown half of the bargain, and the reason a background sync
     * cannot leave a socket behind it: {@link InboxSyncWorker} calls this
     * before {@code doWork()} returns, which is the last moment this process is
     * guaranteed to still be running. The idle timer covers the foreground
     * case, where nothing announces that the user has stopped reading; this
     * covers the case where something does.
     */
    static void closeIdleConnections() {
        List<Store> all = new ArrayList<>();
        synchronized (PARKED) {
            for (Parked parked : PARKED.values()) all.add(parked.store);
            PARKED.clear();
        }
        for (Store store : all) closeQuietly(store);
    }

    private static void closeQuietly(Store store) {
        if (store == null) return;
        try {
            store.close();
        } catch (Exception ignored) {
            // The connection is going either way; LOGOUT is a courtesy to the
            // server, not something with a caller waiting on the answer.
        }
    }

    private static void closeQuietly(Folder folder) {
        if (folder == null) return;
        try {
            if (folder.isOpen()) folder.close(false);
        } catch (Exception ignored) {
            // Same as above.
        }
    }

    /**
     * Whether this failure means the reused connection is gone, as opposed to
     * the operation having failed on a perfectly good one.
     *
     * The two want opposite handling. A dead connection is worth paying for a
     * fresh one and running the operation again — every operation that reuses
     * is a read or a flag set to a fixed value, which is exactly why {@link
     * #purge} does not reuse. "The server does not have that message" is not,
     * and would fail identically a handshake later.
     *
     * Decided by exception type rather than by asking the Store, because
     * {@code isConnected()} takes a protocol out of the pool and an empty pool
     * is refilled by opening and authenticating a new connection — the answer
     * would cost the very handshake this whole mechanism exists to avoid.
     */
    private static boolean connectionLost(Throwable error) {
        // Bounded rather than while(cause != null): a cause chain that loops
        // back on itself would otherwise hang here rather than fail.
        Throwable current = error;
        for (int depth = 0; current != null && depth < 8; depth++) {
            if (current instanceof FolderClosedException) return true;
            if (current instanceof StoreClosedException) return true;
            if (current instanceof java.io.IOException) return true;
            if (current instanceof com.sun.mail.iap.ConnectionException) return true;
            current = current.getCause();
        }
        return false;
    }

    /** Walk the same port/security ladder `MailSender` uses, open INBOX, run, close. */
    private static <T> T withInbox(Context context, JSONObject config, String secret, int folderMode,
                                   WithStore<T> body) throws Exception {
        return withInbox(context, config, secret, folderMode, true, body);
    }

    /**
     * @param reusable whether this operation may run on a connection an earlier
     *        one parked, and park its own when it finishes. False for the two
     *        callers where a connection made from nothing is the point rather
     *        than the overhead: {@link #test}, whose whole job is to prove the
     *        stored settings can still reach the server, and {@link #purge},
     *        which is the one operation here that is not safe to run twice.
     */
    private static <T> T withInbox(Context context, JSONObject config, String secret, int folderMode,
                                   boolean reusable, WithStore<T> body) throws Exception {
        String host = config.optString("imapHost", "");
        String username = config.optString("imapUsername", "");
        if (TextUtils.isEmpty(host)) throw new IllegalArgumentException("Invalid IMAP host");

        /*
         * A bearer token, when this account has a grant.
         *
         * Resolved from the account id alone, exactly as `electron/imap.ts`
         * does it, because the inbox config carries no `authMethod` and no
         * `providerId` — it never needed either while a password was the only
         * mechanism, and widening `InboxAccountState` to add them would be a
         * cross-platform type change for something the keystore can already
         * answer. `accessToken` returns null for every account that has never
         * completed a consent, which is what keeps this a no-op on the password
         * path rather than a branch that path has to survive.
         */
        String accessToken = OAuthTokens.accessToken(context, config.optString("accountId", ""));

        // The check that used to read `if (!secret)`. That was exactly right
        // while a password was the only answer and is exactly wrong now: an
        // account that signed in with OAuth2 has no password by design, and
        // refusing it here would be the app describing its own feature as the
        // user's missing credential.
        if (TextUtils.isEmpty(secret) && TextUtils.isEmpty(accessToken)) {
            throw new IllegalArgumentException("No IMAP password stored for this account");
        }
        String credential = TextUtils.isEmpty(accessToken) ? secret : accessToken;

        String key = reuseKey(config);

        if (reusable) {
            Store parked = takeParked(key);
            if (parked != null) {
                Folder inbox = null;
                // Set the instant before the operation itself starts, so the
                // catch below can tell "the parked connection would not even
                // open INBOX" — always worth a fresh one — from "the operation
                // ran and failed", which usually is not.
                boolean started = false;
                try {
                    inbox = parked.getFolder("INBOX");
                    inbox.open(folderMode);
                    started = true;
                    T result = body.run(parked, inbox);
                    closeQuietly(inbox);
                    park(key, parked);
                    return result;
                } catch (Exception e) {
                    closeQuietly(inbox);
                    if (started && !connectionLost(e)) {
                        // The connection is fine; the operation is what failed.
                        // Park it again rather than logging out over somebody
                        // else's error — otherwise one "that message is gone"
                        // would make the next operation pay for a handshake.
                        park(key, parked);
                        throw e;
                    }
                    closeQuietly(parked);
                    // Fall through and connect from nothing, which is what this
                    // method did for every call before parking existed.
                }
            }
        }

        List<MailSender.Endpoint> rungs = ladderFor(config);
        Exception last = null;
        boolean compress = true;

        // Indexed rather than for-each because one failure re-runs the *same*
        // rung — see the COMPRESS branch below.
        for (int rung = 0; rung < rungs.size(); rung++) {
            MailSender.Endpoint endpoint = rungs.get(rung);
            Store store = null;
            Folder inbox = null;
            boolean handedOff = false;
            // True once the connection is up and INBOX is open — which is to
            // say, once everything compression could have broken has already
            // worked. See the COMPRESS branch below.
            boolean connected = false;
            try {
                Session session = buildSession(config, endpoint, accessToken, compress);
                store = session.getStore("imap");
                store.connect(host, endpoint.port, username, credential);

                inbox = store.getFolder("INBOX");
                inbox.open(folderMode);
                connected = true;

                T result = body.run(store, inbox);
                if (reusable) {
                    closeQuietly(inbox);
                    inbox = null;
                    park(key, store);
                    handedOff = true;
                }
                return result;
            } catch (Exception e) {
                last = e;
                String message = e.getMessage() == null ? e.toString() : e.getMessage();
                String kind = MailSender.classify(message);
                // A refused bearer token must not be re-offered on the next
                // rung or the next sync — same reasoning as the SMTP ladder's.
                if ("auth".equals(kind) && !TextUtils.isEmpty(accessToken)) {
                    OAuthTokens.invalidate(config.optString("accountId", ""));
                }
                /*
                 * Give this same endpoint one more try with COMPRESS off.
                 *
                 * Asking for compression adds exactly one new way to fail: a
                 * server that advertises COMPRESS=DEFLATE and then refuses or
                 * mishandles the command. JavaMail rethrows the server's own
                 * NO/BAD text in that case, so the failure arrives wearing the
                 * server's wording and cannot be recognised by matching on it —
                 * which is why this keys off the classification instead. A
                 * refusal lands in `unknown` (no other rule matches "COMPRESS
                 * not available"), and a deflate stream that will not start
                 * tears the connection down, which lands in `handshake`.
                 *
                 * What is left out is the point of doing it this way. Timeout,
                 * network, tls and auth cannot be caused by compression, so a
                 * phone with no signal still walks the ladder exactly as many
                 * times as it did before; and `connected` rules out everything
                 * after the mailbox opened, because COMPRESS is negotiated at
                 * login and a failure from `body` cannot be its doing. What is
                 * left is one extra attempt per operation at most — `compress`
                 * stays off for the rest of the ladder — on a path that had
                 * already failed.
                 */
                if (compress && !connected && ("unknown".equals(kind) || "handshake".equals(kind))) {
                    compress = false;
                    rung--;
                    continue;
                }
                if (!MailSender.negotiable(kind)) break;
            } finally {
                if (!handedOff) {
                    // Best-effort close of a connection this method is done
                    // with either way — the ladder above already has the
                    // real outcome, and there is nothing left to do with a
                    // close failure but move on.
                    closeQuietly(inbox);
                    closeQuietly(store);
                }
            }
        }

        throw last != null ? last : new IllegalStateException("Could not connect to the IMAP server");
    }

    // -----------------------------------------------------------------------
    // Connection test
    // -----------------------------------------------------------------------

    /**
     * Open INBOX read-only and report what the server says about it.
     *
     * The counterpart of {@link MailSender#test}, and shaped identically so
     * the same UI renders both. It reports message counts as well as "it
     * connected", because a mailbox that opens but shows zero messages is a
     * different problem from one that will not open at all, and on screen the
     * two are otherwise indistinguishable.
     */
    static MailSender.Result test(Context context, JSONObject config, String secret) {
        long started = System.currentTimeMillis();
        MailSender.Result result = new MailSender.Result();

        if (TextUtils.isEmpty(config.optString("imapHost", ""))) {
            result.ok = false;
            result.error = "No IMAP server set";
            result.errorKind = "config";
            return result;
        }
        // A grant counts as a credential. Asking the keystore whether one
        // exists is cheap and local — unlike {@link OAuthTokens#accessToken},
        // which would go to the network — and it is the difference between
        // "connect and find out" and refusing an OAuth2 mailbox up front with
        // a message about a password it will never have.
        if (TextUtils.isEmpty(secret)
                && !OAuthTokens.hasGrant(context, config.optString("accountId", ""))) {
            result.ok = false;
            result.error = "No password stored for receiving";
            result.errorKind = "auth";
            return result;
        }

        try {
            // Never on a parked connection. This is the button that answers
            // "can this device still reach your mail with these settings", and
            // a connection somebody else already authenticated would answer a
            // different question — one it would keep answering yes to for two
            // minutes after the settings stopped working.
            JSONObject counts = withInbox(context, config, secret, Folder.READ_ONLY, false, (store, inbox) -> {
                JSONObject o = new JSONObject();
                o.put("total", inbox.getMessageCount());
                o.put("unseen", inbox.getUnreadMessageCount());
                return o;
            });

            result.ok = true;
            result.durationMs = System.currentTimeMillis() - started;
            result.mailbox = counts;

            JSONObject diagnostics = new JSONObject();
            diagnostics.put("host", config.optString("imapHost", ""));
            diagnostics.put("port", config.optInt("imapPort", 993));
            diagnostics.put("securityUsed", config.optString("imapSecurity", "ssl"));
            diagnostics.put("stage", "done");
            diagnostics.put("attempts", 1);
            result.diagnostics = diagnostics;
        } catch (Exception e) {
            String message = e.getMessage() == null ? e.toString() : e.getMessage();
            result.ok = false;
            result.durationMs = System.currentTimeMillis() - started;
            result.error = message;
            result.errorKind = MailSender.classify(message);
        }
        return result;
    }

    // -----------------------------------------------------------------------
    // Sync — headers for the most recent messages
    // -----------------------------------------------------------------------

    /**
     * Fetch envelope data for the most recent {@link #LIST_LIMIT} messages and
     * merge it into whatever the caller already had cached, then prefetch a
     * bounded number of bodies for messages that do not have one yet.
     *
     * Returns the updated `InboxAccountState` JSON — same shape `syncInbox`
     * returns on the desktop, so `bridge-android.ts` needs no translation.
     *
     * The three-argument form runs the background stage — the rest of the
     * bodies, and the cache trim — inline, before it returns. That is the right
     * answer for {@link InboxSyncWorker}, which calls this one: once its {@code
     * doWork()} returns, WorkManager is free to let the process be killed, so
     * work handed to a background thread there is work that may simply never
     * happen, on a connection {@code closeIdleConnections()} is about to take
     * away. Nobody is looking at a screen during a background sync, so blocking
     * costs nothing there.
     */
    static JSONObject sync(android.content.Context context, JSONObject config, String secret) throws Exception {
        return sync(context, config, secret, false);
    }

    /**
     * @param deferAfterSync true to hand the tail prefetch and the cache trim to
     *        a background thread and return as soon as the message list is
     *        ready. What the foreground caller — the Inbox screen pulling to
     *        refresh — actually wants: the list paints off the first tranche of
     *        bodies, and the other twenty arrive while it is being read.
     */
    static JSONObject sync(android.content.Context context, JSONObject config, String secret,
                           boolean deferAfterSync) throws Exception {
        final String accountId = config.optString("accountId", "");
        JSONArray previousMessagesRaw = config.optJSONArray("messages");
        final JSONArray previousMessages = previousMessagesRaw == null ? new JSONArray() : previousMessagesRaw;
        final PrefetchBudget budget = prefetchBudget(context);
        /*
         * Messages this pass wants a body for but is not going to wait around
         * for. Filled inside the lambda and drained after it returns, which is
         * why it is declared out here — and why it holds UIDs rather than
         * `Message` objects: those belong to the Folder handle this operation
         * is about to close, and reading one afterwards would either throw or
         * silently reopen the mailbox.
         */
        final List<Long> tailUids = new ArrayList<>();

        JSONObject synced = withInbox(context, config, secret, Folder.READ_ONLY, (store, inbox) -> {
            UIDFolder uidFolder = (UIDFolder) inbox;
            long uidValidity = uidFolder.getUIDValidity();

            // A changed UIDVALIDITY means every cached UID for this folder is
            // stale — the server is free to reuse UIDs after that point, so a
            // cached body could silently belong to a different message.
            JSONArray priorForThisFolder = uidValidity == config.optLong("imapUidValidity", -1)
                    ? previousMessages
                    : new JSONArray();

            int total = inbox.getMessageCount();

            // "The mailbox is empty" is the one answer worth confirming before
            // acting on, because acting on it discards every cached message.
            // Observed on the desktop against Gmail: a mailbox that had just
            // reported 35 messages came back empty, with no error at all.
            //
            // getMessageCount() returns the EXISTS from SELECT; the unread
            // count is answered separately by the server, so the two
            // disagreeing means one of them is wrong and neither is worth
            // deleting mail over. Both agreeing on zero is a mailbox the user
            // really did empty. Showing briefly stale mail costs nothing;
            // losing it costs the feature.
            if (total == 0 && previousMessages.length() > 0 && inbox.getUnreadMessageCount() > 0) {
                JSONObject unchanged = new JSONObject(config.toString());
                unchanged.put("lastSyncAt", System.currentTimeMillis());
                unchanged.remove("lastSyncError");
                return unchanged;
            }

            int start = Math.max(1, total - LIST_LIMIT + 1);
            Message[] range = total > 0 ? inbox.getMessages(start, total) : new Message[0];

            javax.mail.FetchProfile profile = new javax.mail.FetchProfile();
            profile.add(javax.mail.FetchProfile.Item.ENVELOPE);
            profile.add(javax.mail.FetchProfile.Item.FLAGS);
            profile.add(UIDFolder.FetchProfileItem.UID);
            /*
             * CONTENT_INFO is BODYSTRUCTURE, and it is here because the loop
             * below asks every row whether it has an attachment.
             *
             * `hasAttachments` cannot answer that without the message's part
             * list, and without this line JavaMail goes and gets one per
             * message, on demand, one command at a time: fifty messages, fifty
             * sequential round trips, every single sync. Folded into the batch
             * they cost nothing extra — the same FETCH that already asks for
             * ENVELOPE and FLAGS for the whole page asks for BODYSTRUCTURE
             * too, and the reply arrives in the same stream.
             *
             * Fifty round trips at 80 ms is four seconds of a sync spent
             * waiting, on a page of mail whose text has not started
             * downloading yet.
             */
            profile.add(javax.mail.FetchProfile.Item.CONTENT_INFO);
            if (range.length > 0) inbox.fetch(range, profile);

            JSONArray messages = new JSONArray();
            int unread = 0;

            // Bodies this pass wants, alongside the row each one has to write
            // its snippet back into. Collected first and fetched together
            // below, rather than one message at a time inside the loop.
            List<Message> wanted = new ArrayList<>();
            List<JSONObject> wantedRows = new ArrayList<>();
            List<Long> wantedUids = new ArrayList<>();

            // Newest first, matching how the inbox view lists them.
            for (int i = range.length - 1; i >= 0; i--) {
                Message m = range[i];
                long uid = uidFolder.getUID(m);
                boolean seen = m.isSet(Flags.Flag.SEEN);
                if (!seen) unread++;

                JSONObject prior = findByUid(priorForThisFolder, uid);
                JSONObject row = prior != null ? prior : new JSONObject();
                row.put("id", accountId + ":INBOX:" + uid);
                row.put("accountId", accountId);
                row.put("folderPath", "INBOX");
                row.put("uid", uid);
                row.put("uidValidity", uidValidity);
                row.put("from", formatAddresses(m.getFrom()));
                row.put("to", formatAddresses(m.getRecipients(Message.RecipientType.TO)));
                row.put("subject", nullToEmpty(m.getSubject()));
                row.put("date", m.getSentDate() != null ? m.getSentDate().getTime() : System.currentTimeMillis());
                row.put("sizeBytes", Math.max(0, m.getSize()));
                row.put("hasAttachments", hasAttachments(m));
                row.put("seen", seen);
                if (!row.has("tag")) row.put("tag", "none");
                if (!row.has("snippet")) row.put("snippet", "");
                boolean alreadyCached = row.optBoolean("bodyCached", false)
                        || InboxBodyStore.hasBody(context, accountId, "INBOX", uid);
                row.put("bodyCached", alreadyCached);

                /*
                 * A body the background tail wrote after the previous sync
                 * arrives here with a row that has no snippet on it.
                 *
                 * The tail deliberately writes to disk and nowhere else — see
                 * {@link #prefetchTail} for why touching {@link InboxCache}
                 * from a thread that outlives the sync is not worth the race —
                 * so this is where the list row catches up. Without it the
                 * snippet would stay empty forever: `alreadyCached` keeps the
                 * message out of every future prefetch batch, so nothing would
                 * ever parse it again.
                 *
                 * A local file read, not a round trip, and only for a row that
                 * has a cached body and still no snippet — so it costs one read
                 * per message ever, not one per sync.
                 */
                if (alreadyCached && row.optString("snippet", "").isEmpty()) {
                    JSONObject cachedBody = InboxBodyStore.readBody(context, accountId, "INBOX", uid);
                    if (cachedBody != null) row.put("snippet", snippetOf(cachedBody));
                }

                messages.put(row);

                if (!alreadyCached) {
                    if (wanted.size() < budget.foreground) {
                        wanted.add(m);
                        wantedRows.add(row);
                        wantedUids.add(uid);
                    } else if (wanted.size() + tailUids.size() < budget.messages) {
                        // Past the tranche the list paint waits for. Noted by
                        // UID and picked up after this connection is done with.
                        tailUids.add(uid);
                    }
                }
            }

            prefetchBodies(context, accountId, inbox, budget, wanted, wantedRows, wantedUids);

            JSONObject folder = new JSONObject();
            folder.put("id", accountId + ":INBOX");
            folder.put("accountId", accountId);
            folder.put("path", "INBOX");
            folder.put("displayName", "INBOX");
            folder.put("uidValidity", uidValidity);
            folder.put("unreadCount", unread);
            folder.put("totalCount", total);

            JSONObject result = new JSONObject(config.toString());
            result.put("messages", messages);
            result.put("folders", new JSONArray().put(folder));
            result.put("imapUidValidity", uidValidity);
            result.put("lastSyncAt", System.currentTimeMillis());
            result.remove("lastSyncError");
            return result;
        });

        afterSync(context, config, secret, accountId, tailUids, budget, deferAfterSync);
        return synced;
    }

    // -----------------------------------------------------------------------
    // The background half of a sync
    //
    // Two jobs that have no business making anyone wait for a message list:
    // downloading the rest of the page's bodies, and trimming the cache back
    // to the size and age the user set. Both are pure "do it when there is
    // time" work — if the process dies first, the next sync picks up exactly
    // where this one stopped, because both decide what to do by looking at
    // what is already on disk rather than by remembering.
    // -----------------------------------------------------------------------

    /**
     * How many bodies one batched FETCH asks for in the tail.
     *
     * The command count is not what this bounds — one FETCH for fifty messages
     * is one round trip, which is the whole reason the tail is affordable at
     * all. What it bounds is memory: a fetched `IMAPMessage` keeps its parsed
     * body until the folder closes, so ten at the 256 KB per-message ceiling is
     * about 2.5 MB in flight at once rather than the twelve the whole tail
     * could reach.
     */
    private static final int TAIL_CHUNK = 10;

    /** One background thread for every account, created on first use and daemon. */
    private static ExecutorService background;

    /**
     * Accounts whose tail is running right now.
     *
     * A guard, not a queue. Two syncs a minute apart on a slow link would
     * otherwise stack their tails up behind each other, each re-deciding what
     * to fetch from a disk state the one in front of it is still changing. A
     * skipped tail costs nothing: whatever it would have fetched is still
     * missing at the next sync, and the next sync will list it again.
     */
    private static final java.util.Set<String> TAIL_RUNNING = new java.util.HashSet<>();

    private static void afterSync(Context context, JSONObject config, String secret,
                                  String accountId, List<Long> tailUids, PrefetchBudget budget,
                                  boolean deferred) {
        Runnable work = () -> {
            try {
                prefetchTail(context, config, secret, accountId, tailUids, budget);
            } catch (Exception e) {
                // Never fatal to a sync that has already produced its list. The
                // messages this would have cached simply load on demand, which
                // is what every build before this one did for all of them.
                Log.w(TAG, "afterSync: background body prefetch failed", e);
            }
            try {
                pruneCache(context);
            } catch (Exception e) {
                Log.w(TAG, "afterSync: could not trim the message cache", e);
            }
        };

        if (!deferred) {
            work.run();
            return;
        }

        synchronized (TAIL_RUNNING) {
            if (!TAIL_RUNNING.add(accountId)) return;
            if (background == null) {
                background = Executors.newSingleThreadExecutor(runnable -> {
                    Thread thread = new Thread(runnable, "aevistle-imap-prefetch");
                    thread.setDaemon(true);
                    return thread;
                });
            }
        }
        background.execute(() -> {
            try {
                work.run();
            } finally {
                synchronized (TAIL_RUNNING) {
                    TAIL_RUNNING.remove(accountId);
                }
            }
        });
    }

    /**
     * Download the bodies the sync did not wait for, in batches.
     *
     * These are messages 31 to {@link #LIST_LIMIT} of the list — the ones that
     * before this release were never prefetched at all, so opening one paid the
     * full ladder this file's "Connection reuse" section measures: six to eight
     * sequential round trips before the first byte of text moved. There is
     * nothing special about them other than being further down the page, and a
     * page of fifty is one scroll.
     *
     * Runs on its own pass rather than inside the sync so that the message list
     * is already on screen while this happens. It reuses the connection the
     * sync parked, so the cost of a separate pass is a SELECT — one round trip —
     * rather than another handshake.
     *
     * Writes to {@link InboxBodyStore} and to nothing else. Not to {@link
     * InboxCache}: that store is a read-modify-write over one SharedPreferences
     * blob, and a thread that outlives the sync updating it would be racing
     * every later sync for the right to describe the same account. The list row
     * catches up on the next sync instead, from disk, for free — see the
     * snippet backfill in {@link #sync}. The one thing that must be true for
     * that to be safe is that a body on disk is authoritative regardless of what
     * a row says, and it already is: {@link #fetchBody} reads the cache before
     * it opens anything.
     */
    private static void prefetchTail(Context context, JSONObject config, String secret,
                                     String accountId, List<Long> uids, PrefetchBudget budget)
            throws Exception {
        if (uids.isEmpty() || budget.tailBytes <= 0) return;

        final long[] want = new long[uids.size()];
        for (int i = 0; i < want.length; i++) want[i] = uids.get(i);

        withInbox(context, config, secret, Folder.READ_ONLY, (store, inbox) -> {
            UIDFolder uidFolder = (UIDFolder) inbox;
            // One `UID FETCH <set> (UID)` for the whole tail, not one lookup per
            // message. `getMessagesByUID(long[])` answers positionally and puts
            // a null where the server no longer has that UID — a message deleted
            // from another client between the list fetch and now.
            Message[] found = uidFolder.getMessagesByUID(want);

            List<Message> live = new ArrayList<>();
            List<Long> liveUids = new ArrayList<>();
            for (int i = 0; i < found.length && i < want.length; i++) {
                if (found[i] == null) continue;
                // Re-checked rather than trusted from the sync's pass: an
                // adjacent prefetch, or the on-demand open of a message the user
                // scrolled to, may have cached this one in between.
                if (InboxBodyStore.hasBody(context, accountId, "INBOX", want[i])) continue;
                live.add(found[i]);
                liveUids.add(want[i]);
            }
            if (live.isEmpty()) return null;

            // Sizes for the whole tail in one command. Without this, the
            // per-message ceiling below would cost a round trip per message to
            // enforce — `FetchProfile.Item.ENVELOPE` is
            // `ENVELOPE INTERNALDATE RFC822.SIZE`, so asking for it is how
            // RFC822.SIZE arrives in bulk.
            javax.mail.FetchProfile sizes = new javax.mail.FetchProfile();
            sizes.add(javax.mail.FetchProfile.Item.ENVELOPE);
            inbox.fetch(live.toArray(new Message[0]), sizes);

            List<Message> batch = new ArrayList<>();
            List<Long> batchUids = new ArrayList<>();
            long remaining = budget.tailBytes;
            for (int i = 0; i < live.size(); i++) {
                int size;
                try {
                    size = live.get(i).getSize();
                } catch (Exception e) {
                    // A field read that threw means this message's metadata did
                    // not arrive; without a size there is no way to hold it to
                    // the ceiling, so it stays on the on-demand path.
                    continue;
                }
                if (size <= 0 || size > budget.perMessageBytes) continue;
                if (size > remaining) break;
                remaining -= size;
                batch.add(live.get(i));
                batchUids.add(liveUids.get(i));
            }

            for (int from = 0; from < batch.size(); from += TAIL_CHUNK) {
                int to = Math.min(from + TAIL_CHUNK, batch.size());
                List<Message> chunk = batch.subList(from, to);
                try {
                    javax.mail.FetchProfile bodies = new javax.mail.FetchProfile();
                    bodies.add(com.sun.mail.imap.IMAPFolder.FetchProfileItem.MESSAGE);
                    inbox.fetch(chunk.toArray(new Message[0]), bodies);
                } catch (Exception e) {
                    // Same bargain as the foreground batch: the per-message loop
                    // below still works, it is just slow again. Logged because a
                    // batch that fails every time is the difference between this
                    // being free and this being the most expensive thing the app
                    // does, with nothing on screen to say which.
                    Log.w(TAG, "prefetchTail: batched body fetch failed, falling back per message", e);
                }
                for (int i = from; i < to; i++) {
                    try {
                        Parsed parsed = extract(batch.get(i));
                        InboxBodyStore.writeBody(context, accountId, "INBOX", batchUids.get(i),
                                parsed.toBodyJson());
                    } catch (Exception ignored) {
                        // One body that will not parse is not worth abandoning
                        // the rest of the tail over — it loads on demand later
                        // exactly like an unprefetched one.
                    }
                }
            }
            return null;
        });
    }

    /**
     * Pull down the bodies this sync wants, in one conversation instead of
     * one per message, and write them to the on-disk cache.
     *
     * The round trips this removes are the bulk of a sync. Reading a body the
     * old way is a negotiation: JavaMail asks for the message's structure,
     * then asks for the text part, then asks for the alternative HTML part,
     * waiting for each reply before sending the next request. Three or more
     * round trips per message, fifteen messages, so roughly fifty times
     * 50-150 ms spent doing nothing but waiting — while the bytes themselves
     * would have taken a fraction of that.
     *
     * `IMAPFolder.FetchProfileItem.MESSAGE` collapses it into one
     * `FETCH <set> (BODY.PEEK[])` covering every message in the batch. Once
     * that returns, `extract` below reads each one out of memory: verified in
     * the shipped 1.6.7 bytecode rather than assumed, because it is the whole
     * claim — IMAPMessage.getDataHandler() returns early on `bodyLoaded`
     * instead of building the lazy per-part data source, and
     * getContentStream() branches on the same field to read from the parsed
     * message rather than opening an IMAPInputStream. It is BODY.PEEK, not
     * BODY, so nothing here marks mail as read (the folder is open READ_ONLY
     * as well, so the server would refuse to anyway).
     *
     * Two things bound what goes in. A message larger than the per-message
     * ceiling is left out entirely and read the old way if it is ever opened —
     * whole-message fetching is only cheap while the whole message is the part
     * you wanted, and a mail with a photo attached is the case where it is
     * not. And the batch stops at the total budget, so one sync cannot decide
     * to download ten megabytes on its own.
     *
     * A batch that fails costs nothing but the batch: every message still gets
     * its individual pass below, which is exactly what this code did before.
     *
     * Bounded by the *foreground* half of the budget, which is unchanged from
     * what shipped — fifteen messages and 512 KB on mobile data, thirty and
     * 2 MB on Wi-Fi. Everything this release added to the coverage lives in
     * {@link #prefetchTail} instead, precisely so that the part of a sync
     * somebody is waiting on did not get slower in exchange.
     */
    private static void prefetchBodies(Context context, String accountId, Folder inbox,
                                       PrefetchBudget budget, List<Message> wanted,
                                       List<JSONObject> rows, List<Long> uids) {
        if (wanted.isEmpty()) return;

        List<Message> batch = new ArrayList<>();
        long remaining = budget.foregroundBytes;
        for (Message m : wanted) {
            int size;
            try {
                // RFC822.SIZE, already in hand from the ENVELOPE fetch — this
                // is a field read, not a round trip.
                size = m.getSize();
            } catch (Exception e) {
                continue;
            }
            if (size <= 0 || size > budget.perMessageBytes) continue;
            if (size > remaining) break;
            remaining -= size;
            batch.add(m);
        }

        if (!batch.isEmpty()) {
            try {
                javax.mail.FetchProfile bodies = new javax.mail.FetchProfile();
                bodies.add(com.sun.mail.imap.IMAPFolder.FetchProfileItem.MESSAGE);
                inbox.fetch(batch.toArray(new Message[0]), bodies);
            } catch (Exception e) {
                // Not fatal, and not silent either: every message below still
                // loads on its own, so the sync produces the same result at the
                // old speed. Worth a log line, because a batch that fails every
                // time is the difference between this being the fastest part of
                // a sync and the slowest, with nothing on screen to say which.
                Log.w(TAG, "prefetchBodies: batched body fetch failed, falling back per message", e);
            }
        }

        for (int i = 0; i < wanted.size(); i++) {
            try {
                Parsed parsed = extract(wanted.get(i));
                InboxBodyStore.writeBody(context, accountId, "INBOX", uids.get(i), parsed.toBodyJson());
                rows.get(i).put("snippet", snippetOf(parsed));
                rows.get(i).put("bodyCached", true);
            } catch (Exception ignored) {
                // A body that fails to parse is not fatal to the sync —
                // it just loads on demand later like an unprefetched one.
            }
        }
    }

    // -----------------------------------------------------------------------
    // Cache trim
    //
    // `Settings.inboxCacheMaxMb` and `Settings.inboxCacheRetentionDays` have
    // existed, been shown on the settings screen, and been saved to disk since
    // the inbox shipped. On Android nothing had ever read either of them: the
    // switches worked, the numbers persisted, and the cache grew until the user
    // cleared the app's storage. This is the code that makes them mean
    // something.
    //
    // What it deletes is *only* downloaded message bodies and downloaded
    // attachments — the two directories named below and nothing else. That
    // matters more than it looks: `DataRoot.dir()` also holds `attachments/`,
    // which is the compose side's snapshots of files a *scheduled send* still
    // needs, and deleting one of those would silently break a reminder that has
    // not fired yet. The server still has every message this touches, so
    // eviction here costs a re-download and never a loss.
    // -----------------------------------------------------------------------

    /** Written by `InboxBodyStore`: `inbox/<account>/<folder>/<uid>.json`. */
    private static final String BODY_CACHE_DIR = "inbox";
    /** Written by {@link #downloadAttachment}: `inbox-attachments/<account>/<folder>/<uid>/…`. */
    private static final String ATTACHMENT_CACHE_DIR = "inbox-attachments";

    /**
     * How often the trim is worth running.
     *
     * It walks the whole cache to decide anything, so running it after every
     * sync would mean a full directory scan every five minutes to discover, in
     * the overwhelming majority of cases, that nothing is over budget. Half an
     * hour is far more often than a cache measured in hundreds of megabytes can
     * fill up and far less often than the disk cost of asking.
     *
     * Process-scoped rather than persisted: a fresh process trims once on its
     * first sync, which is exactly when a phone that has been off for a week
     * most wants it.
     */
    private static final long PRUNE_MIN_INTERVAL_MS = 30L * 60L * 1000L;

    private static final Object PRUNE_LOCK = new Object();
    private static long lastPruneAt;

    /**
     * Delete cached bodies and attachments that are over the age or size the
     * user set. Never throws; a cache that could not be trimmed is not a
     * reason to fail anything.
     *
     * Age first, then size, matching `pruneInboxCache` in
     * `electron/inboxStore.ts` so the same two numbers mean the same thing on
     * both platforms. Oldest-written first once the age pass is done, because
     * the newest mail is the mail somebody is about to open.
     */
    static void pruneCache(Context context) {
        synchronized (PRUNE_LOCK) {
            long now = System.currentTimeMillis();
            if (lastPruneAt != 0 && now - lastPruneAt < PRUNE_MIN_INTERVAL_MS) return;
            lastPruneAt = now;
        }

        JSONObject settings = appSettings(context);
        // The same defaults `DEFAULT_SETTINGS` declares in `src/core/types.ts`.
        int maxMb = settings == null ? 500 : settings.optInt("inboxCacheMaxMb", 500);
        int retentionDays = settings == null ? 90 : settings.optInt("inboxCacheRetentionDays", 90);
        // A nonsensical number typed into the settings screen must not become a
        // command to delete the whole cache. Both are clamped to something the
        // user could plausibly have meant.
        if (maxMb < 1) maxMb = 1;
        if (retentionDays < 1) retentionDays = 1;

        File root = DataRoot.dir(context);
        List<File> files = new ArrayList<>();
        collectFiles(new File(root, BODY_CACHE_DIR), files);
        collectFiles(new File(root, ATTACHMENT_CACHE_DIR), files);
        if (files.isEmpty()) return;

        long cutoff = System.currentTimeMillis() - retentionDays * 24L * 60L * 60L * 1000L;
        long total = 0L;
        List<File> kept = new ArrayList<>(files.size());
        for (File file : files) {
            if (file.lastModified() < cutoff) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
                continue;
            }
            total += file.length();
            kept.add(file);
        }

        long maxBytes = maxMb * 1024L * 1024L;
        if (total <= maxBytes) return;

        java.util.Collections.sort(kept, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        for (File file : kept) {
            if (total <= maxBytes) break;
            long size = file.length();
            //noinspection ResultOfMethodCallIgnored
            if (file.delete()) total -= size;
        }
    }

    /** Every regular file under `dir`, depth first. Missing directories contribute nothing. */
    private static void collectFiles(File dir, List<File> out) {
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File child : children) {
            if (child.isDirectory()) collectFiles(child, out);
            else if (child.isFile()) out.add(child);
        }
    }

    // -----------------------------------------------------------------------
    // Body fetch (on demand, for a message that was not prefetched)
    // -----------------------------------------------------------------------

    static JSONObject fetchBody(android.content.Context context, JSONObject config, String secret,
                                 String folderPath, long uid) throws Exception {
        JSONObject cached = InboxBodyStore.readBody(context, config.optString("accountId", ""), folderPath, uid);
        if (cached != null) return cached;

        return withInbox(context, config, secret, Folder.READ_ONLY, (store, inbox) -> {
            UIDFolder uidFolder = (UIDFolder) inbox;
            Message m = uidFolder.getMessageByUID(uid);
            if (m == null) throw new IllegalStateException("Message not found");
            Parsed parsed = extract(m);
            JSONObject body = parsed.toBodyJson();
            InboxBodyStore.writeBody(context, config.optString("accountId", ""), folderPath, uid, body);
            return body;
        });
    }

    /**
     * Cache the bodies of the messages either side of the one just opened.
     *
     * Reading mail is a sequence, not a set of independent taps: the message
     * after this one is the single most likely thing to be opened next, and the
     * one before it is second. Both are known the instant the reader opens
     * anything, and both take a bounded, batched fetch on a connection this app
     * is already holding — so the choice is between paying for them now, while
     * somebody is reading, or paying a full ladder for one of them in a moment
     * while somebody is waiting.
     *
     * Deliberately narrow:
     *
     *   - Wi-Fi only, with no setting to widen it. {@code inboxPrefetchFull}
     *     governs how much of the *list* a sync downloads, which is a decision
     *     about a background job; this fires on a tap, so on mobile data it
     *     would be spending an allowance in response to something the user did
     *     for a different reason. A metered link gets nothing here.
     *   - at most two UIDs, whatever the caller passes. The renderer decides
     *     what "adjacent" means — its list may be filtered or sorted in ways
     *     this side cannot see — but it does not get to turn this into a
     *     bulk downloader.
     *   - anything already on disk, or over the per-message ceiling, is skipped.
     *
     * Best effort throughout: never throws, and the caller is expected to fire
     * and forget. Nothing on screen depends on it — every one of these messages
     * still opens exactly the way it did before, just slower.
     *
     * @return how many bodies this call actually wrote.
     */
    static int prefetchAdjacent(Context context, JSONObject config, String secret,
                                String folderPath, long[] uids) {
        if (uids == null || uids.length == 0) return 0;
        if (metered(context)) return 0;

        // Only the per-message ceiling is borrowed from the sync's budget — the
        // foreground/tail counts describe a sync's two stages and mean nothing
        // here. The ceiling is the same judgement in both places: a message
        // heavy enough to cost more than its text is worth is not a message to
        // download on a guess.
        final long perMessageBytes = UNMETERED.perMessageBytes;

        final String accountId = config.optString("accountId", "");
        final List<Long> want = new ArrayList<>(2);
        for (long uid : uids) {
            if (want.size() >= 2) break;
            if (uid <= 0 || want.contains(uid)) continue;
            if (InboxBodyStore.hasBody(context, accountId, folderPath, uid)) continue;
            want.add(uid);
        }
        if (want.isEmpty()) return 0;

        try {
            Integer written = withInbox(context, config, secret, Folder.READ_ONLY, (store, inbox) -> {
                UIDFolder uidFolder = (UIDFolder) inbox;
                long[] set = new long[want.size()];
                for (int i = 0; i < set.length; i++) set[i] = want.get(i);

                Message[] found = uidFolder.getMessagesByUID(set);
                List<Message> live = new ArrayList<>(2);
                List<Long> liveUids = new ArrayList<>(2);
                for (int i = 0; i < found.length && i < set.length; i++) {
                    if (found[i] != null) {
                        live.add(found[i]);
                        liveUids.add(set[i]);
                    }
                }
                if (live.isEmpty()) return 0;

                javax.mail.FetchProfile sizes = new javax.mail.FetchProfile();
                sizes.add(javax.mail.FetchProfile.Item.ENVELOPE);
                inbox.fetch(live.toArray(new Message[0]), sizes);

                List<Message> batch = new ArrayList<>(2);
                List<Long> batchUids = new ArrayList<>(2);
                for (int i = 0; i < live.size(); i++) {
                    int size;
                    try {
                        size = live.get(i).getSize();
                    } catch (Exception e) {
                        // No size means no way to hold it to the ceiling. It
                        // stays on the on-demand path, which is where it was.
                        continue;
                    }
                    if (size <= 0 || size > perMessageBytes) continue;
                    batch.add(live.get(i));
                    batchUids.add(liveUids.get(i));
                }
                if (batch.isEmpty()) return 0;

                javax.mail.FetchProfile bodies = new javax.mail.FetchProfile();
                bodies.add(com.sun.mail.imap.IMAPFolder.FetchProfileItem.MESSAGE);
                inbox.fetch(batch.toArray(new Message[0]), bodies);

                int count = 0;
                for (int i = 0; i < batch.size(); i++) {
                    try {
                        Parsed parsed = extract(batch.get(i));
                        InboxBodyStore.writeBody(context, accountId, folderPath, batchUids.get(i),
                                parsed.toBodyJson());
                        count++;
                    } catch (Exception ignored) {
                        // One neighbour that will not parse is not worth
                        // failing the other one over.
                    }
                }
                return count;
            });
            return written == null ? 0 : written;
        } catch (Exception e) {
            // A guess about what gets opened next is not worth a single line on
            // screen when it goes wrong. Logged so a device where this fails
            // every time is diagnosable from logcat rather than only visible as
            // "opening the next mail is still slow".
            Log.w(TAG, "prefetchAdjacent: could not cache the neighbouring messages", e);
            return 0;
        }
    }

    static void setSeen(Context context, JSONObject config, String secret, String folderPath,
                        long uid, boolean seen) throws Exception {
        withInbox(context, config, secret, Folder.READ_WRITE, (store, inbox) -> {
            UIDFolder uidFolder = (UIDFolder) inbox;
            Message m = uidFolder.getMessageByUID(uid);
            if (m != null) inbox.setFlags(new Message[]{m}, new Flags(Flags.Flag.SEEN), seen);
            return null;
        });
    }

    /**
     * Delete messages on the server: flag {@code \Deleted}, then expunge.
     *
     * The desktop reaches this through ImapFlow's {@code messageDelete}, which
     * prefers a MOVE to the Trash folder. JavaMail has no equivalent
     * convenience, and a hand-written MOVE would need the Trash folder's name
     * — which is per-provider, localised, and discovered through an extension
     * half the servers here do not advertise. Flag-and-expunge is what every
     * IMAP server implements, and most of them file the result in Trash on
     * their own anyway.
     *
     * Throws when nothing was matched. "Deleted zero of the three you asked
     * for" reported as success is how the app would end up claiming a mailbox
     * had been cleared while every message was still in it.
     */
    static void purge(Context context, JSONObject config, String secret, JSONArray items)
            throws Exception {
        if (items == null || items.length() == 0) return;
        // Its own connection, and not parked afterwards. Every other operation
        // here can safely be run a second time on a fresh connection if the
        // first one turns out to have died — that is what makes reuse
        // trustworthy — and this is the one that cannot: a retry after an
        // expunge the app never saw the answer to would find nothing left to
        // match and report a failure for work that succeeded. The folder is
        // also closed with `true` inside the body, so there is nothing here
        // worth parking.
        withInbox(context, config, secret, Folder.READ_WRITE, false, (store, inbox) -> {
            UIDFolder uidFolder = (UIDFolder) inbox;
            List<Message> found = new ArrayList<>();
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.optJSONObject(i);
                if (item == null) continue;
                Message m = uidFolder.getMessageByUID(item.optLong("uid", -1L));
                if (m != null) found.add(m);
            }
            if (found.isEmpty()) {
                throw new IllegalStateException("The server did not recognise any of those messages");
            }
            Message[] batch = found.toArray(new Message[0]);
            inbox.setFlags(batch, new Flags(Flags.Flag.DELETED), true);
            // `expunge` is what actually removes them; closing with true is the
            // documented way to force it and works on servers whose expunge()
            // is a no-op outside a close.
            inbox.close(true);
            return null;
        });
    }

    // -----------------------------------------------------------------------
    // MIME parsing — deliberately narrow: text/plain, text/html, and one level
    // of multipart/alternative or multipart/mixed. Real verification and
    // login-link mail is almost never anything more exotic than this, and a
    // part this code does not understand is skipped rather than crashing the
    // whole sync.
    // -----------------------------------------------------------------------

    private static final class Parsed {
        String text;
        String html;
        final List<JSONObject> attachments = new ArrayList<>();

        JSONObject toBodyJson() throws Exception {
            JSONObject o = new JSONObject();
            if (text != null) o.put("text", text);
            if (html != null) {
                JSONObject sanitized = InboxSanitizer.sanitize(html);
                o.put("sanitizedHtml", sanitized.getString("html"));
                o.put("remoteImages", sanitized.getJSONArray("remoteImages"));
            }
            JSONArray atts = new JSONArray();
            for (JSONObject a : attachments) atts.put(a);
            o.put("attachments", atts);
            return o;
        }
    }

    private static Parsed extract(Message message) throws Exception {
        Parsed parsed = new Parsed();
        Object content = message.getContent();
        if (content instanceof String) {
            if (message.isMimeType("text/html")) {
                parsed.html = (String) content;
            } else {
                parsed.text = (String) content;
            }
        } else if (content instanceof Multipart) {
            walk((Multipart) content, parsed);
        }
        return parsed;
    }

    private static void walk(Multipart multipart, Parsed parsed) throws Exception {
        for (int i = 0; i < multipart.getCount(); i++) {
            BodyPart part = multipart.getBodyPart(i);
            String disposition = part.getDisposition();
            boolean attachment = Part.ATTACHMENT.equalsIgnoreCase(disposition)
                    || (!TextUtils.isEmpty(part.getFileName()) && !part.isMimeType("text/*"));

            if (attachment) {
                addAttachment(part, parsed.attachments);
                continue;
            }
            if (part.isMimeType("text/plain") && parsed.text == null) {
                parsed.text = (String) part.getContent();
            } else if (part.isMimeType("text/html") && parsed.html == null) {
                parsed.html = (String) part.getContent();
            } else if (part.isMimeType("multipart/*")) {
                Object nested = part.getContent();
                if (nested instanceof Multipart) walk((Multipart) nested, parsed);
            }
        }
    }

    private static void addAttachment(BodyPart part, List<JSONObject> attachments) {
        try {
            long size = part.getSize();
            if (size > ATTACHMENT_MAX_BYTES) return;

            String name = part.getFileName();
            if (name != null) name = MimeUtility.decodeText(name);
            JSONObject a = new JSONObject();
            a.put("id", "att_" + System.nanoTime());
            a.put("name", name == null ? "attachment" : name);
            a.put("size", Math.max(0, size));
            a.put("mime", part.getContentType());
            a.put("inline", false);
            // Content is not persisted here — the message body cache stores
            // metadata only; attachments download on demand the same way a
            // prefetch-skipped message body does, matching the desktop's
            // PREFETCH_MAX_BYTES philosophy of bounding what a sync pays for
            // up front.
            a.put("source", "imap");
            // Empty until downloaded. Present rather than absent so the JS
            // `Attachment` shape is the same on both platforms and the reader
            // does not need to know which one it is running on.
            a.put("path", "");
            // The stable handle a later download works from — an ordinal over
            // *attachments only*, in document order. `id` cannot serve: it is
            // minted per parse, so a body read back from the on-disk cache
            // would carry an id that names nothing on the server.
            a.put("partIndex", attachments.size());
            attachments.add(a);
        } catch (Exception e) {
            // A single malformed part must not fail the whole message parse —
            // the rest of the body is still worth showing. But dropping it
            // silently means the attachment simply never existed as far as
            // the JS layer can tell, with nothing anywhere to explain why a
            // message the user knows had a file attached shows none. Log it
            // so that's at least diagnosable from logcat.
            Log.e(TAG, "addAttachment: could not parse an attachment part", e);
        }
    }

    // -----------------------------------------------------------------------
    // Attachment download (on demand)
    // -----------------------------------------------------------------------

    /**
     * Fetch one attachment's bytes and put them on disk.
     *
     * Deliberately separate from {@link #fetchBody}: a sync that eagerly
     * downloaded every attachment on every message would spend a phone's data
     * allowance on files nobody opened. The body cache lists what is there;
     * this is what happens when somebody actually taps one.
     *
     * Idempotent — an attachment already on disk is returned without opening a
     * connection at all, which is what makes "preview, then save, then open"
     * three taps rather than three downloads.
     *
     * @return {@code {name, size, mime, path}} for the file that now exists.
     */
    static JSONObject downloadAttachment(android.content.Context context, JSONObject config,
                                         String secret, String folderPath, long uid,
                                         int partIndex, String fallbackName) throws Exception {
        File dir = new File(DataRoot.dir(context), "inbox-attachments" + File.separator
                + safeSegment(config.optString("accountId", "")) + File.separator
                + safeSegment(folderPath) + File.separator + uid);
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("Could not create the attachment directory");
        }

        File existing = findExisting(dir, partIndex);
        if (existing != null) return describe(existing, fallbackName);

        return withInbox(context, config, secret, Folder.READ_ONLY, (store, inbox) -> {
            UIDFolder uidFolder = (UIDFolder) inbox;
            Message m = uidFolder.getMessageByUID(uid);
            if (m == null) throw new IllegalStateException("Message not found");

            List<BodyPart> parts = new ArrayList<>();
            Object content = m.getContent();
            if (content instanceof Multipart) collectAttachmentParts((Multipart) content, parts);
            if (partIndex < 0 || partIndex >= parts.size()) {
                throw new IllegalStateException("That attachment is no longer on the message");
            }

            BodyPart part = parts.get(partIndex);
            String name = part.getFileName();
            if (name != null) name = MimeUtility.decodeText(name);
            if (name == null || name.isEmpty()) name = fallbackName;

            File target = new File(dir, partIndex + "_" + safeSegment(name));
            try (InputStream in = part.getInputStream();
                 OutputStream out = new FileOutputStream(target)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                long total = 0;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                    total += read;
                    if (total > ATTACHMENT_MAX_BYTES) {
                        throw new IllegalStateException("That attachment is too large to download");
                    }
                }
            } catch (Exception e) {
                // Never leave a half-written file behind: it would be treated
                // as a completed download by the `findExisting` check above,
                // and every later tap would open a truncated file rather than
                // retrying.
                //noinspection ResultOfMethodCallIgnored
                target.delete();
                throw e;
            }
            return describe(target, name);
        });
    }

    /** Attachment parts of a message, in the same order {@link #walk} counts them. */
    private static void collectAttachmentParts(Multipart multipart, List<BodyPart> out)
            throws Exception {
        for (int i = 0; i < multipart.getCount(); i++) {
            BodyPart part = multipart.getBodyPart(i);
            String disposition = part.getDisposition();
            boolean attachment = Part.ATTACHMENT.equalsIgnoreCase(disposition)
                    || (!TextUtils.isEmpty(part.getFileName()) && !part.isMimeType("text/*"));
            if (attachment) {
                out.add(part);
                continue;
            }
            if (part.isMimeType("multipart/*")) {
                Object nested = part.getContent();
                if (nested instanceof Multipart) collectAttachmentParts((Multipart) nested, out);
            }
        }
    }

    private static File findExisting(File dir, int partIndex) {
        File[] children = dir.listFiles();
        if (children == null) return null;
        String prefix = partIndex + "_";
        for (File child : children) {
            if (child.isFile() && child.getName().startsWith(prefix)) return child;
        }
        return null;
    }

    private static JSONObject describe(File file, String name) throws Exception {
        JSONObject o = new JSONObject();
        o.put("name", name);
        o.put("size", file.length());
        o.put("path", file.getAbsolutePath());
        o.put("mime", guessMime(file.getName()));
        return o;
    }

    /** Strip anything that could escape the directory we intend to write into. */
    private static String safeSegment(String value) {
        String base = new File(value == null ? "" : value).getName();
        String cleaned = base.replaceAll("[^A-Za-z0-9._\\-]", "_");
        return cleaned.isEmpty() ? "_" : cleaned;
    }

    private static String guessMime(String name) {
        int dot = name.lastIndexOf('.');
        String ext = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
        switch (ext) {
            case "png": return "image/png";
            case "jpg": case "jpeg": return "image/jpeg";
            case "gif": return "image/gif";
            case "webp": return "image/webp";
            case "bmp": return "image/bmp";
            case "avif": return "image/avif";
            case "pdf": return "application/pdf";
            case "txt": case "log": case "md": return "text/plain";
            case "csv": return "text/csv";
            case "zip": return "application/zip";
            default: return "application/octet-stream";
        }
    }

    private static String formatAddresses(Address[] addresses) {
        if (addresses == null || addresses.length == 0) return "";
        StringBuilder sb = new StringBuilder();
        for (Address a : addresses) {
            if (sb.length() > 0) sb.append(", ");
            if (a instanceof InternetAddress) {
                InternetAddress ia = (InternetAddress) a;
                sb.append(TextUtils.isEmpty(ia.getPersonal()) ? ia.getAddress() : ia.getPersonal());
            } else {
                sb.append(a.toString());
            }
        }
        return sb.toString();
    }

    /**
     * Whether a listed message has anything attached.
     *
     * The mime-type check first is not tidiness — it is the difference between
     * this reading a field and this downloading the mail. `isMimeType` is
     * answered from BODYSTRUCTURE, which the list fetch in {@link #sync} now
     * pulls for the whole page in one command. `getContent()` is only free
     * once that says multipart, because JavaMail answers it for a multipart
     * message with a lazy view over the part list it already has. On anything
     * else — a plain-text message, which is most automated mail — it falls
     * through to fetching the body, and the answer it comes back with is
     * "false", which this method could have said without asking. A page of
     * fifty such messages was downloading fifty bodies per sync and throwing
     * every one of them away.
     */
    private static boolean hasAttachments(Message message) {
        try {
            if (!message.isMimeType("multipart/*")) return false;
            Object content = message.getContent();
            if (!(content instanceof Multipart)) return false;
            return countAttachments((Multipart) content) > 0;
        } catch (Exception e) {
            return false;
        }
    }

    private static int countAttachments(Multipart multipart) throws Exception {
        int count = 0;
        for (int i = 0; i < multipart.getCount(); i++) {
            BodyPart part = multipart.getBodyPart(i);
            String disposition = part.getDisposition();
            if (Part.ATTACHMENT.equalsIgnoreCase(disposition)
                    || (!TextUtils.isEmpty(part.getFileName()) && !part.isMimeType("text/*"))) {
                count++;
            } else if (part.isMimeType("multipart/*")) {
                Object nested = part.getContent();
                if (nested instanceof Multipart) count += countAttachments((Multipart) nested);
            }
        }
        return count;
    }

    private static String snippetOf(Parsed parsed) {
        return trimSnippet(parsed.text != null ? parsed.text
                : parsed.html != null ? parsed.html.replaceAll("<[^>]+>", " ") : "");
    }

    /**
     * The same snippet, from a body already on disk rather than one just
     * parsed.
     *
     * Exists for the rows the background tail filled in — see the backfill in
     * {@link #sync}. Reads `sanitizedHtml` rather than the original HTML
     * because that is what the cache holds; the tag strip is the same either
     * way, and stripping tags out of already-sanitized markup cannot reintroduce
     * anything the sanitizer removed.
     */
    private static String snippetOf(JSONObject body) {
        String text = body.optString("text", "");
        if (!text.isEmpty()) return trimSnippet(text);
        return trimSnippet(body.optString("sanitizedHtml", "").replaceAll("<[^>]+>", " "));
    }

    private static String trimSnippet(String source) {
        String collapsed = source.replaceAll("\\s+", " ").trim();
        return collapsed.length() > 180 ? collapsed.substring(0, 180) : collapsed;
    }

    private static JSONObject findByUid(JSONArray messages, long uid) {
        for (int i = 0; i < messages.length(); i++) {
            JSONObject m = messages.optJSONObject(i);
            if (m != null && m.optLong("uid", -1) == uid) return m;
        }
        return null;
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }
}
