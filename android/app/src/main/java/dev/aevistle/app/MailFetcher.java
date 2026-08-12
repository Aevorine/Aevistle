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
     * Three numbers rather than one, because the prefetch has two separate
     * costs and they are not bounded by the same thing: how many messages it
     * opens (round trips, now shared across one batched FETCH), and how many
     * bytes it pulls (the user's data allowance). The per-message ceiling is
     * the third because the batched fetch below asks for *whole* messages, so
     * one mail with a photo attached could otherwise eat the entire byte
     * budget on a file nobody opened.
     */
    private static final class PrefetchBudget {
        final int messages;
        final long totalBytes;
        final long perMessageBytes;

        PrefetchBudget(int messages, long totalBytes, long perMessageBytes) {
            this.messages = messages;
            this.totalBytes = totalBytes;
            this.perMessageBytes = perMessageBytes;
        }
    }

    /**
     * Fifteen messages, 2 MB, 256 KB each — what shipped, unchanged, for a
     * phone on mobile data.
     *
     * The count is the number this class has always used, and the byte
     * ceilings are the ones it declared for years and never actually applied
     * to anything. Keeping the metered figures at the shipped values is the
     * whole point: the batched fetch below cannot spend a byte of anybody's
     * data allowance that the previous build did not already spend.
     *
     * The 64 KB per-message ceiling is tighter here than on Wi-Fi for the one
     * way whole-message fetching *can* cost more than the old part-by-part
     * path: an HTML mail with an inline image. Under 64 KB there is no room
     * for one large enough to matter.
     */
    private static final PrefetchBudget METERED = new PrefetchBudget(15, 512L * 1024, 64L * 1024);

    /**
     * Thirty messages, 2 MB, 256 KB each, on an unmetered connection.
     *
     * Thirty is about three phone screens of the inbox list — as far ahead as
     * a scroll realistically gets before the next sync runs, which is the
     * whole claim being made for prefetching further. 256 KB per message is
     * comfortably above a long HTML newsletter and comfortably below anything
     * with a real attachment on it, so a message that would cost more than its
     * text is worth falls out of the batch and back onto the on-demand path.
     */
    private static final PrefetchBudget UNMETERED = new PrefetchBudget(30, 2L * 1024 * 1024, 256L * 1024);

    /**
     * Which of the two applies right now.
     *
     * There is no "download mail on mobile data" consent switch to consult:
     * this app has no metered-network policy anywhere — {@link
     * InboxSyncScheduler}'s only constraint is {@code NetworkType.CONNECTED},
     * and nothing else asks. So the conservative reading is the only one
     * available: never spend more on a metered link than the build before this
     * one already did, and treat "could not tell" as metered, because guessing
     * wrong the other way spends somebody's data allowance on mail they may
     * never open.
     */
    private static PrefetchBudget prefetchBudget(Context context) {
        try {
            android.net.ConnectivityManager manager = (android.net.ConnectivityManager)
                    context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (manager == null || manager.isActiveNetworkMetered()) return METERED;
            return UNMETERED;
        } catch (Exception e) {
            Log.w(TAG, "prefetchBudget: could not read the network's metered state", e);
            return METERED;
        }
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
     */
    static JSONObject sync(android.content.Context context, JSONObject config, String secret) throws Exception {
        final String accountId = config.optString("accountId", "");
        JSONArray previousMessagesRaw = config.optJSONArray("messages");
        final JSONArray previousMessages = previousMessagesRaw == null ? new JSONArray() : previousMessagesRaw;

        return withInbox(context, config, secret, Folder.READ_ONLY, (store, inbox) -> {
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
            PrefetchBudget budget = prefetchBudget(context);
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

                messages.put(row);

                if (!alreadyCached && wanted.size() < budget.messages) {
                    wanted.add(m);
                    wantedRows.add(row);
                    wantedUids.add(uid);
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
     */
    private static void prefetchBodies(Context context, String accountId, Folder inbox,
                                       PrefetchBudget budget, List<Message> wanted,
                                       List<JSONObject> rows, List<Long> uids) {
        if (wanted.isEmpty()) return;

        List<Message> batch = new ArrayList<>();
        long remaining = budget.totalBytes;
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
        String source = parsed.text != null ? parsed.text
                : parsed.html != null ? parsed.html.replaceAll("<[^>]+>", " ") : "";
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
