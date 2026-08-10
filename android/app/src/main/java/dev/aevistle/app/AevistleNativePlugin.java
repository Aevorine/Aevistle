package dev.aevistle.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.util.Log;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The Android half of `PlatformBridge`.
 *
 * Method names and payload shapes match `src/core/bridge-android.ts` exactly;
 * that file is the contract. Anything touching the network runs on a worker
 * thread — Android throws NetworkOnMainThreadException, and rightly so.
 */
@CapacitorPlugin(
        name = "AevistleNative",
        permissions = {
                /*
                 * POST_NOTIFICATIONS was in the manifest and was never once
                 * requested, which on Android 13+ means it was never held —
                 * see Permissions.java. Declaring it here is what gives this
                 * plugin Capacitor's request plumbing: the alias below is the
                 * handle for `requestPermissionForAlias`, and Capacitor's own
                 * cache of a permanent refusal (the only place Android exposes
                 * that distinction) is keyed off it too.
                 *
                 * SCHEDULE_EXACT_ALARM is deliberately NOT listed. It is a
                 * special app access, not a runtime permission: there is no
                 * dialog to request, and pretending otherwise here would make
                 * `checkPermissions` report a state no request could ever
                 * change. It is handled through the settings intent instead.
                 */
                @Permission(
                        strings = {Permissions.POST_NOTIFICATIONS},
                        alias = Permissions.ALIAS_NOTIFICATIONS)
        })
public class AevistleNativePlugin extends Plugin {

    private static final String TAG = "AevistleNativePlugin";

    /**
     * A pool, not a single thread.
     *
     * With one worker, a connection attempt that sits on an unresponsive
     * server blocks every later call behind it — so pressing "Test connection"
     * while a send was stuck left the button on "Testing…" without a single
     * packet having been sent for it. Four threads is more than this app will
     * ever need concurrently and removes the queue entirely.
     */
    private final ExecutorService io = Executors.newFixedThreadPool(4);

    // -----------------------------------------------------------------------
    // The live event bridge
    //
    // `bridge-android.ts` declares `onJobEvent` and `onInboxEvent`, and both
    // subscribed to event names nothing in this file ever emitted:
    // `notifyListeners` was called for `lanRequest` and `updateProgress` and
    // for nothing else. So a scheduled send that completed while the app was
    // open in front of the user left its row saying "waiting to send", and
    // mail found by the background sync did not appear until the web layer's
    // own timer came round. Neither logged anything, because from the web
    // side nothing had happened: it had subscribed successfully to an event
    // that did not exist.
    //
    // The workers cannot reach a plugin instance on their own — they run from
    // WorkManager, frequently with no Activity at all — so the instance
    // publishes itself here while it is alive. Everything below is
    // null-tolerant on purpose: with the app closed there is no instance, the
    // emit is a no-op, and `pullJobRuns` still delivers the same report on the
    // next open. This makes the open-app case live; it does not make the
    // closed-app case depend on it.
    // -----------------------------------------------------------------------

    /** The instance currently attached to a WebView, if any. */
    private static volatile AevistleNativePlugin live;

    @Override
    public void load() {
        super.load();
        live = this;
    }

    /**
     * A scheduled send finished. Tell the open app, if one is open.
     *
     * The payload matches `JobEvent` in `src/core/bridge.ts` exactly, `result`
     * included — `MailSender.Result.toJson()` already produces the same shape
     * as a desktop `SendResult`, so the log line this raises carries the real
     * recipient count and duration rather than a plausible-looking zero.
     *
     * Delivered *in addition to* the queued report that {@code pullJobRuns}
     * drains, not instead of it. Applying the same run twice is harmless by
     * construction: `jobRan` writes absolute state, never a delta.
     */
    static void emitJobEvent(String jobId, long at, JSONObject result, JSONObject run) {
        AevistleNativePlugin plugin = live;
        if (plugin == null) return;
        try {
            JSObject event = new JSObject();
            event.put("jobId", jobId);
            event.put("at", at);
            event.put("result", result);
            if (run != null) event.put("run", run);
            plugin.notifyListeners("jobEvent", event);
        } catch (Exception e) {
            // A UI that cannot be told is the state this replaced, and the
            // queued report still covers it. Never at the cost of the send.
            Log.w(TAG, "emitJobEvent: could not deliver the run report", e);
        }
    }

    /**
     * A background inbox sync changed an account's cached mail.
     *
     * Same shape as the desktop's `InboxEvent`: the web layer treats it as
     * "something changed, re-read", not as the change itself, so an empty
     * `newMessageIds` is correct rather than lazy — see `watchInboxes` in
     * `electron/main.ts`, which sends exactly the same thing.
     */
    static void emitInboxEvent(String accountId) {
        AevistleNativePlugin plugin = live;
        if (plugin == null) return;
        try {
            JSObject event = new JSObject();
            event.put("accountId", accountId);
            event.put("folderPath", "INBOX");
            event.put("newMessageIds", new JSArray());
            plugin.notifyListeners("inboxEvent", event);
        } catch (Exception e) {
            Log.w(TAG, "emitInboxEvent: could not deliver the sync notice", e);
        }
    }

    // -----------------------------------------------------------------------
    // Secrets
    // -----------------------------------------------------------------------

    @PluginMethod
    public void setSecret(PluginCall call) {
        String accountId = call.getString("accountId");
        String secret = call.getString("secret");
        String kind = call.getString("kind", "smtp");
        if (accountId == null || secret == null) {
            call.reject("accountId and secret are required");
            return;
        }
        try {
            new SecretStore(getContext()).put(accountId, kind, secret);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not store the password securely: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void hasSecret(PluginCall call) {
        String accountId = call.getString("accountId", "");
        String kind = call.getString("kind", "smtp");
        JSObject result = new JSObject();
        result.put("value", new SecretStore(getContext()).has(accountId, kind));
        call.resolve(result);
    }

    /**
     * Read back only an 'ongoing' pairing's own long-lived key (see
     * `core/syncLoop.ts`). `kind` is hard-coded to `"sync"` rather than taken
     * from the call the way `setSecret`/`hasSecret`/`deleteSecret` above take
     * it — those three legitimately need the caller to name a kind; this one
     * deliberately does not, so it cannot become a general secret reader for
     * an SMTP or IMAP credential no matter what a caller passes.
     */
    @PluginMethod
    public void getSyncSecret(PluginCall call) {
        String accountId = call.getString("accountId", "");
        String value = new SecretStore(getContext()).get(accountId, "sync");
        JSObject result = new JSObject();
        // `org.json.JSONObject.put` silently *removes* a key whose value is a
        // plain Java `null` rather than serialising it — the caller would see
        // `r.value === undefined`, not `null`. `JSONObject.NULL` is what
        // actually round-trips as JSON `null`.
        result.put("value", value == null ? JSONObject.NULL : value);
        call.resolve(result);
    }

    /**
     * Seal this device's mailbox passwords for a paired device, and hand back
     * only the envelope.
     *
     * The counterpart to `getSyncSecret` above narrowing itself to `"sync"`.
     * That narrowing is what makes syncing an account worth anything hard: the
     * WebView cannot read an SMTP password, and it should not learn to, so the
     * sealing happens here instead. The keystore read, the HKDF and the AES-GCM
     * are all on this side; what crosses back is ciphertext and a list of
     * account ids. See `SecretTransport.java` and `src/core/secretTransport.ts`.
     *
     * `keyRef` is read as a `"sync"` secret only, for the same reason: a caller
     * that could name an arbitrary kind here would have turned this into the
     * general secret reader the boundary deliberately lacks.
     *
     * Resolves `{ envelope: null }` when the keystore holds nothing for any of
     * the named accounts, so the caller can tell "no passwords to send" from
     * "an envelope with nothing in it".
     */
    @PluginMethod
    public void sealAccountSecrets(PluginCall call) {
        String keyRef = call.getString("keyRef", "");
        JSArray requested = call.getArray("accountIds");
        JSObject result = new JSObject();
        try {
            SecretStore store = new SecretStore(getContext());
            String syncKey = store.get(keyRef, "sync");
            if (syncKey == null || requested == null || requested.length() == 0) {
                result.put("envelope", JSONObject.NULL);
                call.resolve(result);
                return;
            }

            List<SecretTransport.AccountSecret> secrets = new ArrayList<>();
            JSArray sealedIds = new JSArray();
            for (int i = 0; i < requested.length(); i++) {
                String accountId = requested.optString(i, "");
                if (accountId.isEmpty()) continue;
                String smtp = store.get(accountId, "smtp");
                String imap = store.get(accountId, "imap");
                if (smtp == null && imap == null) continue;
                secrets.add(new SecretTransport.AccountSecret(accountId, smtp, imap));
                sealedIds.put(accountId);
            }
            if (secrets.isEmpty()) {
                result.put("envelope", JSONObject.NULL);
                call.resolve(result);
                return;
            }

            result.put("envelope", SecretTransport.seal(syncKey, secrets));
            result.put("accountIds", sealedIds);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not seal the account passwords: " + e.getMessage(), e);
        }
    }

    /**
     * The receiving end: open one of those and write what is inside straight
     * into this device's keystore, answering with account ids only.
     *
     * Rejecting rather than resolving empty when the envelope will not open —
     * a revoked key, a tampered blob, a bundle from a newer build — because
     * the caller turns that into "the accounts arrived without their
     * passwords", which is a different thing from "there were none".
     */
    @PluginMethod
    public void openAccountSecrets(PluginCall call) {
        String keyRef = call.getString("keyRef", "");
        JSObject envelope = call.getObject("envelope");
        if (envelope == null) {
            call.reject("envelope is required");
            return;
        }
        try {
            SecretStore store = new SecretStore(getContext());
            String syncKey = store.get(keyRef, "sync");
            if (syncKey == null) {
                call.reject("no sync key for this pairing");
                return;
            }
            List<SecretTransport.AccountSecret> secrets = SecretTransport.open(
                    syncKey,
                    envelope.getString("iv"),
                    envelope.getString("ciphertext"));

            JSArray written = new JSArray();
            for (SecretTransport.AccountSecret secret : secrets) {
                if (secret.smtp != null) store.put(secret.accountId, "smtp", secret.smtp);
                if (secret.imap != null) store.put(secret.accountId, "imap", secret.imap);
                if (secret.smtp != null || secret.imap != null) written.put(secret.accountId);
            }
            // An IMAP credential arriving is the same signal a typed one is:
            // this account can be watched in the background now. Same rearm
            // `deleteSecret` runs for the opposite transition.
            InboxSyncScheduler.rearm(getContext());

            JSObject result = new JSObject();
            result.put("accountIds", written);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not read the account passwords: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void deleteSecret(PluginCall call) {
        String accountId = call.getString("accountId", "");
        String kind = call.getString("kind", "smtp");
        new SecretStore(getContext()).remove(accountId, kind);
        // Deleting the IMAP credential is also the signal that this account's
        // background sync should stop — see InboxCache.remove().
        if ("imap".equals(kind)) {
            new InboxCache(getContext()).remove(accountId);
            InboxSyncScheduler.rearm(getContext());
        }
        call.resolve();
    }

    // -----------------------------------------------------------------------
    // OAuth2 sign-in
    //
    // The whole flow is native, and `bridge-android.ts` explains why: the
    // WebView's own `connect-src 'self'` forbids it from POSTing to a token
    // endpoint at all, and routing around that would put the refresh token
    // through JavaScript — the exact thing `sealAccountSecrets` exists to avoid
    // for passwords. So this side owns the PKCE pair, the Custom Tab, the
    // redirect, the exchange and the keystore write, and what goes back across
    // the bridge is an address and a boolean.
    //
    // The provider table is not duplicated here. Endpoints, scopes and the
    // vendor extras all arrive as call arguments from `src/core/oauth.ts`,
    // which is what keeps the phone and the desktop from drifting into asking
    // for different scopes — a drift whose symptom is a mailbox that syncs on
    // one device and 401s on the other, with nothing on screen connecting the
    // two. {@link OAuthConsent} runs the flow; {@link OAuthTokens} owns
    // everything after it.
    // -----------------------------------------------------------------------

    /**
     * The consent waiting for a redirect, and the two facts needed to tell
     * "the user came back having finished" from "the user came back having
     * given up".
     *
     * Guarded by {@code consentLock} because they are genuinely touched from
     * two threads: {@code oauthConsent} runs on Capacitor's own plugin thread
     * (see {@code Bridge.callPluginMethod}, which posts to a HandlerThread),
     * while {@code handleOnNewIntent}, {@code handleOnPause} and
     * {@code handleOnResume} are delivered on the main thread. Without the
     * lock the redirect could arrive against a half-written {@code Pending}.
     */
    private final Object consentLock = new Object();
    private OAuthConsent.Pending pendingConsent;
    private boolean consentPaused;
    private boolean consentRedirected;

    /**
     * How long a resumed activity waits before deciding the user backed out.
     *
     * Android documents `onNewIntent` as arriving before `onResume` for a
     * `singleTask` activity, so in the ordinary completing case the flow is
     * already settled by the time resume runs and this timer never fires. The
     * grace period is insurance against the OEM that reorders them: without it,
     * a successful sign-in on such a device would be reported as "cancelled"
     * one instant before its own redirect arrived, which is a bug that would
     * only ever reproduce on somebody else's phone.
     */
    private static final long CONSENT_RETURN_GRACE_MS = 700L;

    /**
     * The client id registered against the certificate that signed *this* APK.
     *
     * Google issues one OAuth client per signing certificate, so a debug build
     * and a release build of the same app are, as far as Google is concerned,
     * two different applications. The JavaScript half cannot tell them apart —
     * one `vite build` output is packaged into both — so it sends every
     * registered id keyed by fingerprint and the choice is made here, where the
     * signature can actually be read.
     *
     * An empty answer is a normal, reportable outcome rather than a failure to
     * throw about: it means somebody is running a build whose key was never
     * registered, which is exactly what a fresh clone on a new machine does.
     */
    private String clientIdForThisBuild(JSObject clientIds) {
        if (clientIds == null) return "";
        String fingerprint = signingFingerprint();
        if (fingerprint.isEmpty()) return "";
        return clientIds.optString(fingerprint, "");
    }

    /**
     * This APK's signing certificate as an uppercase, colon-separated SHA-1 —
     * byte for byte what `keytool -list` prints and what the Cloud Console
     * shows, so the two can be compared by eye when they disagree.
     *
     * Two APIs because `minSdk` is 24. `GET_SIGNING_CERTIFICATES` arrived in
     * API 28 and is the one that understands key rotation; below that only the
     * deprecated `GET_SIGNATURES` exists. Using the modern call unconditionally
     * would return nothing on Android 7 and 8 and produce the "no client
     * registered" message on a device whose certificate is registered perfectly
     * well — a wrong answer being worse here than no answer.
     */
    private String signingFingerprint() {
        try {
            PackageManager pm = getContext().getPackageManager();
            String pkg = getContext().getPackageName();
            Signature[] signatures;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                PackageInfo info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES);
                SigningInfo signing = info.signingInfo;
                if (signing == null) return "";
                /*
                 * `getApkContentsSigners()` in both cases, and never the first
                 * element of `getSigningCertificateHistory()`.
                 *
                 * The usual snippet branches on `hasMultipleSigners()` and
                 * reads the history when there is one signer. That is wrong for
                 * a key that has been rotated with a lineage: the history is
                 * ordered oldest-first, so element zero is the *original*
                 * certificate — the one that is no longer used to sign
                 * anything, and the one Google will not accept as proof of this
                 * client. `getApkContentsSigners()` always answers with what
                 * actually signed these APK contents, which is precisely the
                 * certificate Google validates the OAuth client against.
                 *
                 * It matters here specifically because this project's signing
                 * key was rotated at v0.1.19. Reading the wrong end of that
                 * array would return a fingerprint that is not registered
                 * anywhere and report "no OAuth client for this build" on a
                 * correctly configured release — with nothing in any log to say
                 * the lookup key was the problem.
                 *
                 * The history is kept only as a fallback for the case where the
                 * contents signers come back empty, and then it is read from
                 * the end, where the current signer is.
                 */
                signatures = signing.getApkContentsSigners();
                if (signatures == null || signatures.length == 0) {
                    Signature[] history = signing.getSigningCertificateHistory();
                    if (history != null && history.length > 0) {
                        signatures = new Signature[] { history[history.length - 1] };
                    }
                }
            } else {
                @SuppressWarnings("deprecation")
                PackageInfo info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES);
                @SuppressWarnings("deprecation")
                Signature[] legacy = info.signatures;
                signatures = legacy;
            }
            if (signatures == null || signatures.length == 0) return "";
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            byte[] digest = sha1.digest(signatures[0].toByteArray());
            StringBuilder out = new StringBuilder(digest.length * 3);
            for (byte b : digest) {
                if (out.length() > 0) out.append(':');
                out.append(String.format("%02X", b));
            }
            return out.toString();
        } catch (Exception e) {
            // Reported as "unregistered" by the caller, which is the honest
            // reading: without a fingerprint there is no id to choose, and
            // guessing one would send the user to a provider error page.
            android.util.Log.e("Aevistle", "could not read this build's signing certificate", e);
            return "";
        }
    }

    @PluginMethod
    public void oauthConsent(final PluginCall call) {
        final String accountId = call.getString("accountId", "");
        final String providerId = call.getString("providerId", "");
        final JSObject clientIds = call.getObject("clientIds");
        final String clientId = clientIdForThisBuild(clientIds);
        final String authorizeUrl = call.getString("authorizeUrl", "");
        final String tokenUrl = call.getString("tokenUrl", "");
        final String scope = call.getString("scope", "");
        final String redirectUri = call.getString("redirectUri", "");
        final JSObject extraAuthParams = call.getObject("extraAuthParams");
        final String loginHint = call.getString("loginHint");

        // Resolved rather than rejected, all the way down. The caller is a
        // dialog: a rejection surfaces as the generic "unexpected problem"
        // banner over an app that is working fine, whereas `{ ok: false }` with
        // a sentence lands in the place the user is already looking.
        if (accountId.isEmpty() || authorizeUrl.isEmpty()
                || tokenUrl.isEmpty() || redirectUri.isEmpty()) {
            call.resolve(consentFailure("This sign-in was started without everything it needs."));
            return;
        }
        /*
         * Told apart from the check above on purpose. "No client id at all" and
         * "no client id for *this* build" look identical from the user's seat
         * and need completely different actions, and the second one is the case
         * a developer hits the moment they run a debug build against a release
         * registration. Naming the fingerprint means the fix is a copy and a
         * paste into the Cloud Console rather than an afternoon.
         */
        if (clientId.isEmpty()) {
            call.resolve(consentFailure(
                    "No OAuth client is registered for the certificate this build is signed with ("
                            + signingFingerprint() + "). Sign-in cannot start until one is added."));
            return;
        }

        final Activity activity = getActivity();
        if (activity == null) {
            call.resolve(consentFailure("Aevistle cannot open a browser right now."));
            return;
        }

        final OAuthConsent.Pending pending;
        final String url;
        try {
            pending = OAuthConsent.begin(call.getCallbackId(), accountId, providerId, clientId,
                    tokenUrl, redirectUri, scope);
            url = OAuthConsent.authorizeUrl(pending, authorizeUrl, extraAuthParams, loginHint);
        } catch (Exception e) {
            call.resolve(consentFailure("Aevistle could not prepare the sign-in: " + readable(e)));
            return;
        }

        OAuthConsent.Pending abandoned;
        synchronized (consentLock) {
            abandoned = pendingConsent;
            pendingConsent = pending;
            consentPaused = false;
            consentRedirected = false;
        }
        // A second sign-in started while one was still open — the dialog was
        // reopened, or the first Custom Tab was swiped away without ever coming
        // back. The old call has to be settled here or its promise never
        // resolves and its dialog spins for the life of the process.
        if (abandoned != null) settleConsentCall(abandoned, cancelledConsent());

        // Saved through the Custom Tab's lifetime. Opening one backgrounds this
        // activity, and a `PluginCall` that is not saved is released the moment
        // the method returns — so without this the redirect would come home to
        // a callback id the bridge no longer knows, and the promise would never
        // settle. That is the single most likely way this feature ships broken,
        // because it looks perfect right up until the browser opens.
        getBridge().saveCall(call);

        // On the UI thread: `launchUrl` is a `startActivity`, and starting one
        // from Capacitor's plugin HandlerThread is the kind of thing that works
        // on every device it is tested on.
        activity.runOnUiThread(() -> {
            try {
                OAuthConsent.launch(activity, url);
            } catch (Exception e) {
                settleConsent(pending, consentFailure(readable(e)));
            }
        });
    }

    @PluginMethod
    public void oauthStatus(PluginCall call) {
        String accountId = call.getString("accountId", "");
        boolean hasGrant = OAuthTokens.hasGrant(getContext(), accountId);

        JSObject result = new JSObject();
        result.put("hasGrant", hasGrant);
        // Only meaningful alongside a grant. Reporting `rejected` for an
        // account that has never signed in would put the dialog into
        // "needs re-consent" for a mailbox with nothing to re-consent to.
        result.put("rejected", hasGrant && OAuthTokens.rejected(getContext(), accountId));
        String address = hasGrant ? OAuthTokens.address(getContext(), accountId) : null;
        if (address != null) result.put("address", address);
        call.resolve(result);
    }

    @PluginMethod
    public void oauthDisconnect(PluginCall call) {
        String accountId = call.getString("accountId", "");
        OAuthTokens.forget(getContext(), accountId);
        call.resolve();
    }

    /**
     * The redirect coming home.
     *
     * `MainActivity` is `launchMode="singleTask"`, so the browser's navigation
     * to `dev.aevistle.app://oauth/callback` is delivered here rather than
     * starting a second copy of the app — which is why there is no second
     * activity in the manifest for this and why the WebView underneath is still
     * the one holding the dialog that started the flow.
     */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        Uri data = intent == null ? null : intent.getData();
        if (data == null) return;

        final OAuthConsent.Pending pending;
        synchronized (consentLock) {
            if (pendingConsent == null || !isRedirectFor(pendingConsent, data)) return;
            pending = pendingConsent;
            // Set before anything can settle the call, so the resume that
            // follows this intent cannot decide the user gave up while the
            // token exchange is still in flight on the io pool.
            consentRedirected = true;
        }

        final OAuthConsent.Redirect redirect = OAuthConsent.read(pending, data);
        if (redirect == null) {
            // `state` did not match. Refused outright rather than ignored: a
            // private-use scheme is claimable by any app on the device, and
            // ignoring a mismatch would leave this flow open for the *next*
            // redirect, which is exactly the window an attacker would want.
            settleConsent(pending, consentFailure(
                    "That sign-in did not match the one Aevistle started, so nothing was saved. "
                            + "Start the sign-in again."));
            return;
        }
        if (pending.expired()) {
            settleConsent(pending, cancelledConsent());
            return;
        }
        if (redirect.cancelled) {
            settleConsent(pending, cancelledConsent());
            return;
        }
        if (redirect.error != null) {
            settleConsent(pending, consentFailure(redirect.error));
            return;
        }

        // The exchange is a network round trip and this is the main thread.
        io.execute(() -> {
            try {
                String address = OAuthConsent.exchange(getContext(), pending, redirect.code);
                JSObject result = new JSObject();
                result.put("ok", true);
                if (address != null) result.put("address", address);
                settleConsent(pending, result);
            } catch (Exception e) {
                settleConsent(pending, consentFailure(readable(e)));
            }
        });
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        synchronized (consentLock) {
            if (pendingConsent != null) consentPaused = true;
        }
    }

    /**
     * Back from the browser — and if no redirect came with them, the user
     * pressed back or closed the tab.
     *
     * There is no callback for "the user dismissed the Custom Tab"; a resume
     * with nothing else to show for it is the only signal Android gives. The
     * `consentPaused` flag is what stops this from firing on the resume that
     * happens *before* the tab opens, and `consentRedirected` is what stops it
     * from cancelling a sign-in whose exchange is still running.
     */
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        final OAuthConsent.Pending pending;
        synchronized (consentLock) {
            if (pendingConsent == null || !consentPaused || consentRedirected) return;
            pending = pendingConsent;
        }
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
            synchronized (consentLock) {
                if (pendingConsent != pending || consentRedirected) return;
            }
            settleConsent(pending, cancelledConsent());
        }, CONSENT_RETURN_GRACE_MS);
    }

    /** Is this the redirect this flow asked the provider to send? */
    private static boolean isRedirectFor(OAuthConsent.Pending pending, Uri data) {
        Uri expected = Uri.parse(pending.redirectUri);
        return String.valueOf(expected.getScheme()).equalsIgnoreCase(String.valueOf(data.getScheme()))
                && String.valueOf(expected.getAuthority()).equalsIgnoreCase(String.valueOf(data.getAuthority()))
                && String.valueOf(expected.getPath()).equals(String.valueOf(data.getPath()));
    }

    /**
     * Settle a consent exactly once, whichever of the four routes out of it got
     * here first — the redirect, the resume, a launch failure, or a second
     * sign-in replacing this one.
     */
    private void settleConsent(OAuthConsent.Pending pending, JSObject result) {
        synchronized (consentLock) {
            if (pendingConsent != pending) return;
            pendingConsent = null;
            consentPaused = false;
            consentRedirected = false;
        }
        settleConsentCall(pending, result);
    }

    private void settleConsentCall(OAuthConsent.Pending pending, JSObject result) {
        PluginCall call = getBridge().getSavedCall(pending.callbackId);
        if (call == null) {
            // The bridge has already let go of it — the WebView reloaded, or
            // the activity was rebuilt while the browser was in front. There is
            // no promise left to settle, and the reloaded page has no dialog
            // waiting on one either, so this is a no-op rather than a loss.
            Log.i(TAG, "settleConsent: the sign-in call was already released");
            return;
        }
        call.resolve(result);
    }

    private static JSObject consentFailure(String message) {
        JSObject result = new JSObject();
        result.put("ok", false);
        result.put("error", message);
        return result;
    }

    private static JSObject cancelledConsent() {
        JSObject result = new JSObject();
        result.put("ok", false);
        result.put("cancelled", true);
        return result;
    }

    /**
     * A sentence out of an exception, and never anything else.
     *
     * Nothing that reaches here carries a token or a code — the code travels in
     * a POST body rather than in any URL this app builds, and {@link
     * OAuthTokens} never puts a token in a message — but this is the one
     * function whose output is handed to the WebView, so the rule is stated
     * where it is enforced rather than left to each throw site.
     */
    private static String readable(Exception e) {
        String message = e.getMessage();
        return message == null || message.isEmpty() ? e.getClass().getSimpleName() : message;
    }

    // -----------------------------------------------------------------------
    // Mail
    // -----------------------------------------------------------------------

    @PluginMethod
    public void sendNow(final PluginCall call) {
        final JSObject draft = call.getObject("draft");
        final JSObject account = call.getObject("account");
        if (draft == null || account == null) {
            call.reject("draft and account are required");
            return;
        }

        io.execute(() -> {
            String secret = new SecretStore(getContext()).get(account.optString("id", ""), "smtp");
            MailSender.Result result = MailSender.send(getContext(), draft, account, secret);
            resolveResult(call, result);
        });
    }

    @PluginMethod
    public void testConnection(final PluginCall call) {
        final JSObject account = call.getObject("account");
        if (account == null) {
            call.reject("account is required");
            return;
        }
        final String provided = call.getString("secret");

        io.execute(() -> {
            String secret = provided != null
                    ? provided
                    : new SecretStore(getContext()).get(account.optString("id", ""), "smtp");
            MailSender.Result result = MailSender.test(getContext(), account, secret);
            resolveResult(call, result);
        });
    }

    /**
     * Hand a {@link MailSender.Result} back to JavaScript.
     *
     * {@code JSObject.fromJSONObject} is declared to throw, and a send that
     * succeeded must not be reported as a failure just because re-serialising
     * the result tripped — so the fallback builds the response by hand.
     */
    private void resolveResult(PluginCall call, MailSender.Result result) {
        try {
            call.resolve(JSObject.fromJSONObject(result.toJson()));
        } catch (Exception e) {
            JSObject fallback = new JSObject();
            fallback.put("ok", result.ok);
            fallback.put("accepted", new JSArray());
            fallback.put("rejected", new JSArray());
            fallback.put("durationMs", result.durationMs);
            fallback.put("error", result.error != null ? result.error : e.getMessage());
            fallback.put("errorKind", result.errorKind != null ? result.errorKind : "unknown");
            call.resolve(fallback);
        }
    }

    // -----------------------------------------------------------------------
    // Inbox (receiving)
    //
    // Mirrors electron/imap.ts's IPC handlers — same method names and payload
    // shapes as `src/core/bridge.ts`'s optional inbox methods, so
    // `bridge-android.ts` is a thin pass-through, same as the SMTP methods
    // above. Every method here also doubles as how the native side learns
    // which accounts the periodic background sync (InboxSyncWorker) should
    // touch: there is no separate "push config" call, because `syncInbox` is
    // already called with the full account config on every enable, disable,
    // and manual refresh (see AppState.tsx's saveInboxAccount).
    // -----------------------------------------------------------------------

    /**
     * The receive password, falling back to the send password for the same
     * account.
     *
     * Matches the desktop's `getInboxSecret`: every provider this app presets
     * issues one app password that authenticates both SMTP and IMAP, so
     * demanding it a second time only creates a way to typo it.
     */
    private String inboxSecret(String accountId) {
        SecretStore store = new SecretStore(getContext());
        String imap = store.get(accountId, "imap");
        return imap != null ? imap : store.get(accountId, "smtp");
    }

    @PluginMethod
    public void testInbox(final PluginCall call) {
        final JSObject config = call.getObject("config");
        if (config == null) {
            call.reject("config is required");
            return;
        }
        final String provided = call.getString("secret");

        io.execute(() -> {
            try {
                JSONObject configJson = new JSONObject(config.toString());
                String secret = provided != null
                        ? provided
                        : inboxSecret(configJson.optString("accountId", ""));
                resolveResult(call, MailFetcher.test(getContext(), configJson, secret));
            } catch (Exception e) {
                call.reject("Could not test the inbox connection: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void syncInbox(final PluginCall call) {
        final JSObject config = call.getObject("config");
        if (config == null) {
            call.reject("config is required");
            return;
        }

        io.execute(() -> {
            InboxCache cache = new InboxCache(getContext());
            try {
                JSONObject configJson = new JSONObject(config.toString());
                String accountId = configJson.optString("accountId", "");
                boolean enabled = configJson.optBoolean("enabled", false);
                String secret = enabled ? inboxSecret(accountId) : null;

                // The other moment notifications become worth asking about:
                // receiving was just switched on, and the thing this app
                // notifies about most urgently — a verification code arriving —
                // only exists once an inbox does. Only on the transition, so a
                // routine refresh of an already-enabled account asks nothing.
                JSONObject known = cache.account(accountId);
                if (enabled && (known == null || !known.optBoolean("enabled", false))) {
                    Permissions.notePromptDue(getContext());
                }

                JSONObject updated = MailFetcher.sync(getContext(), configJson, secret);
                cache.upsert(updated);
                InboxSyncScheduler.rearm(getContext());
                call.resolve(JSObject.fromJSONObject(updated));
            } catch (Exception e) {
                call.reject("Could not sync the inbox: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void getMessageBody(final PluginCall call) {
        final JSObject config = call.getObject("config");
        final String folderPath = call.getString("folderPath", "INBOX");
        final Integer uidArg = call.getInt("uid");
        if (config == null || uidArg == null) {
            call.reject("config and uid are required");
            return;
        }

        io.execute(() -> {
            try {
                JSONObject configJson = new JSONObject(config.toString());
                String accountId = configJson.optString("accountId", "");
                String secret = inboxSecret(accountId);
                JSONObject body = MailFetcher.fetchBody(getContext(), configJson, secret, folderPath, uidArg);
                call.resolve(JSObject.fromJSONObject(body));
            } catch (Exception e) {
                call.reject("Could not fetch the message: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void setMessageFlags(final PluginCall call) {
        final JSObject config = call.getObject("config");
        final String folderPath = call.getString("folderPath", "INBOX");
        final Integer uidArg = call.getInt("uid");
        final JSObject patch = call.getObject("patch");
        if (config == null || uidArg == null) {
            call.reject("config and uid are required");
            return;
        }

        // `seen` is best-effort against the server; local state already
        // updated on the JS side regardless (see PlatformBridge.setMessageFlags'
        // doc comment) — so this always resolves rather than rejecting on a
        // network failure the user has no action to take on.
        io.execute(() -> {
            if (patch != null && patch.has("seen")) {
                try {
                    JSONObject configJson = new JSONObject(config.toString());
                    String secret = inboxSecret(configJson.optString("accountId", ""));
                    MailFetcher.setSeen(getContext(), configJson, secret, folderPath, uidArg,
                            patch.optBoolean("seen", true));
                } catch (Exception e) {
                    // Best-effort against the server, per the comment above —
                    // local state is already updated on the JS side either
                    // way, so this must not reject. Logged so a server that
                    // is silently rejecting every flag update is still
                    // diagnosable from logcat instead of just never syncing.
                    Log.e(TAG, "setInboxMessageFlags: server-side seen update failed", e);
                }
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void deleteInboxMessages(PluginCall call) {
        String accountId = call.getString("accountId", "");
        JSArray items = call.getArray("items");
        boolean ok = new InboxCache(getContext())
                .deleteMessages(accountId, items == null ? new JSONArray() : items);
        // See InboxCache#deleteMessages: a false here means the cache still
        // holds the messages the caller just asked to remove. Resolving
        // anyway would tell the JS layer a deletion happened that did not.
        if (ok) {
            call.resolve();
        } else {
            call.reject("Could not remove the messages from the local cache");
        }
    }

    /**
     * The other kind of delete: on the server, not just in the cache.
     *
     * Rejects when the server refuses. The web layer only drops the rows after
     * this resolves, so a failure leaves the mailbox and the app agreeing with
     * each other instead of the app claiming a deletion that never happened.
     */
    @PluginMethod
    public void purgeInboxMessages(final PluginCall call) {
        final JSObject config = call.getObject("config");
        final JSArray items = call.getArray("items");
        if (config == null) {
            call.reject("config is required");
            return;
        }
        io.execute(() -> {
            try {
                String accountId = config.optString("accountId", "");
                String secret = new SecretStore(getContext()).get(accountId, "imap");
                JSONArray list = items == null ? new JSONArray() : items;
                MailFetcher.purge(getContext(), config, secret, list);
                // Cache last: a cache entry for a message still on the server is
                // recoverable, a missing one for a message we failed to delete
                // is a hole the user cannot see.
                new InboxCache(getContext()).deleteMessages(accountId, list);
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            }
        });
    }

    @PluginMethod
    public void fetchRemoteImage(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null) {
            call.reject("url is required");
            return;
        }
        io.execute(() -> {
            try {
                String dataUri = RemoteImageFetcher.fetch(url);
                JSObject result = new JSObject();
                result.put("value", dataUri);
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Could not load the image: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Read one of the two allow-listed public feeds on the WebView's behalf.
     *
     * The WebView cannot: `connect-src 'self'` refuses it. See
     * {@link FeedFetcher} for why the policy was not simply widened.
     */
    @PluginMethod
    public void fetchFeed(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null) {
            call.reject("url is required");
            return;
        }
        io.execute(() -> {
            try {
                FeedFetcher.Result result = FeedFetcher.fetch(url);
                JSObject payload = new JSObject();
                payload.put("status", result.status);
                payload.put("body", result.body);
                call.resolve(payload);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage(), e);
            }
        });
    }

    // -----------------------------------------------------------------------
    // LAN relay
    //
    // The transport under both halves of cross-device pairing on Android:
    // `pairingJoinRequest` (one POST to /pair) and `syncRequest`
    // (`core/syncLoop.ts`'s repeated POSTs to /sync). The WebView cannot make
    // either request itself — `connect-src 'self'` refuses a LAN address as
    // flatly as it refuses the public feeds above.
    //
    // Two things here are not what the desktop's equivalent does:
    //
    //   - The socket is raw rather than HttpURLConnection. Cleartext is denied
    //     by default (`res/xml/network_security_config.xml`) and every HTTP
    //     stack on Android enforces that before it opens anything, while that
    //     file's carve-out cannot name a numeric LAN range — Android's
    //     `domain` rules have no CIDR form. So the decision about a peer's
    //     address is made here, on the address about to be dialled, which is
    //     where that file says it has to be. Plaintext at all because no
    //     certificate exists for an address a router handed out this morning;
    //     what crosses the socket is already sealed by `core/pairingCrypto.ts`
    //     — a public key and ciphertext, never a secret.
    //   - The destination is checked before it is dialled, because anything
    //     running in the WebView can reach this method and an unchecked relay
    //     is a fetch-anything primitive wearing the app's network identity.
    // -----------------------------------------------------------------------

    /** A device on the same Wi-Fi answers in milliseconds; a stale address should give up rather than hang the pairing screen. */
    private static final int RELAY_CONNECT_TIMEOUT_MS = 4000;
    /** The desktop relay's own ceiling — a full sync payload is sealed and hashed on the far side before a byte comes back. */
    private static final int RELAY_READ_TIMEOUT_MS = 15000;
    private static final long RELAY_MAX_BYTES = 8L * 1024 * 1024;

    @PluginMethod
    public void pairingRequest(final PluginCall call) {
        final String url = call.getString("url");
        final String body = call.getString("body", "{}");
        if (url == null) {
            call.reject("url is required");
            return;
        }
        io.execute(() -> {
            try {
                LanResponse response = relayPost(url, body);
                JSObject payload = new JSObject();
                payload.put("status", response.status);
                payload.put("body", response.body);
                call.resolve(payload);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage(), e);
            }
        });
    }

    /**
     * Status and body text, same shape as {@link FeedFetcher.Result} and for
     * the same reason: the other device answering 401 or 410 is an answer the
     * JS side reads and explains, not a transport failure.
     */
    private static final class LanResponse {
        final int status;
        final String body;

        LanResponse(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    private static LanResponse relayPost(String rawUrl, String body) throws Exception {
        URL url = new URL(rawUrl);
        if (!isLanRelayUrl(url)) {
            throw new SecurityException("Pairing only talks to a private LAN address.");
        }
        int port = url.getPort() == -1 ? 80 : url.getPort();
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);

        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(url.getHost(), port), RELAY_CONNECT_TIMEOUT_MS);
            socket.setSoTimeout(RELAY_READ_TIMEOUT_MS);

            OutputStream out = socket.getOutputStream();
            out.write(("POST " + url.getPath() + " HTTP/1.1\r\n"
                    + "Host: " + url.getHost() + ":" + port + "\r\n"
                    + "Content-Type: application/json\r\n"
                    + "Accept: application/json\r\n"
                    + "Content-Length: " + payload.length + "\r\n"
                    + "Connection: close\r\n"
                    + "\r\n").getBytes(StandardCharsets.US_ASCII));
            out.write(payload);
            out.flush();

            return readResponse(new BufferedInputStream(socket.getInputStream()));
        }
    }

    /**
     * Mirrors `isLanRelayUrl` in `electron/main.ts` — same scheme, same two
     * paths, same address ranges. A literal address only: a hostname would
     * hand the choice of destination to whatever answers DNS, and there is no
     * name for a machine on the far side of a QR code anyway.
     */
    private static boolean isLanRelayUrl(URL url) {
        if (!"http".equals(url.getProtocol())) return false;
        if (url.getUserInfo() != null || url.getQuery() != null || url.getRef() != null) return false;
        String path = url.getPath();
        if (!"/pair".equals(path) && !"/sync".equals(path)) return false;
        return isPrivateIPv4(url.getHost());
    }

    private static boolean isPrivateIPv4(String host) {
        if ("localhost".equals(host)) return true;

        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return false;
        int[] octets = new int[4];
        for (int i = 0; i < 4; i++) {
            String part = parts[i];
            if (part.isEmpty() || part.length() > 3) return false;
            // A leading zero is octal to the resolver and decimal to
            // Integer.parseInt: "010.0.0.1" would pass this check as 10.x and
            // then connect to 8.0.0.1, which is a public address.
            if (part.length() > 1 && part.charAt(0) == '0') return false;
            for (int c = 0; c < part.length(); c++) {
                if (part.charAt(c) < '0' || part.charAt(c) > '9') return false;
            }
            octets[i] = Integer.parseInt(part);
            if (octets[i] > 255) return false;
        }

        return octets[0] == 10
                || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
                || (octets[0] == 192 && octets[1] == 168)
                || (octets[0] == 169 && octets[1] == 254)
                || octets[0] == 127;
    }

    private static LanResponse readResponse(InputStream in) throws IOException {
        String[] statusLine = readLine(in).split(" ");
        int status = -1;
        if (statusLine.length >= 2 && statusLine[0].startsWith("HTTP/")) {
            try {
                status = Integer.parseInt(statusLine[1]);
            } catch (NumberFormatException ignored) {
                // `status` stays -1 on a malformed status code, and the check
                // right below turns that into the same IOException a missing
                // status line would produce — nothing here to add.
            }
        }
        if (status < 0) throw new IOException("The other device did not answer with HTTP");

        long declared = -1;
        boolean chunked = false;
        while (true) {
            String header = readLine(in);
            if (header.isEmpty()) break;
            int colon = header.indexOf(':');
            if (colon < 0) continue;
            String name = header.substring(0, colon).trim().toLowerCase(java.util.Locale.ROOT);
            String value = header.substring(colon + 1).trim();
            if ("content-length".equals(name)) {
                try {
                    declared = Long.parseLong(value);
                } catch (NumberFormatException ignored) {
                    // `declared` stays -1, which the body reader below treats
                    // the same as no Content-Length header at all.
                }
            } else if ("transfer-encoding".equals(name)) {
                chunked = value.toLowerCase(java.util.Locale.ROOT).contains("chunked");
            }
        }

        byte[] body;
        if (chunked) body = readChunked(in);
        else if (declared >= 0) body = readExactly(in, declared);
        else body = readUntilClose(in);
        return new LanResponse(status, new String(body, StandardCharsets.UTF_8));
    }

    /**
     * Node's http server never computes a Content-Length for `res.end(json)`,
     * so every reply from `electron/pairingServer.ts` and
     * `electron/syncServer.ts` arrives chunked. A client that only understood
     * Content-Length would hand the chunk sizes to `JSON.parse` as if they
     * were the body.
     */
    private static byte[] readChunked(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        while (true) {
            String line = readLine(in);
            int extension = line.indexOf(';');
            if (extension >= 0) line = line.substring(0, extension);
            int size;
            try {
                size = Integer.parseInt(line.trim(), 16);
            } catch (NumberFormatException e) {
                throw new IOException("The other device sent a malformed reply");
            }
            if (size <= 0) return out.toByteArray();
            if (out.size() + (long) size > RELAY_MAX_BYTES) {
                throw new IOException("The other device sent more than this app will read");
            }
            out.write(readExactly(in, size));
            readLine(in);
        }
    }

    private static byte[] readExactly(InputStream in, long count) throws IOException {
        if (count > RELAY_MAX_BYTES) {
            throw new IOException("The other device sent more than this app will read");
        }
        byte[] buffer = new byte[(int) count];
        int filled = 0;
        while (filled < buffer.length) {
            int read = in.read(buffer, filled, buffer.length - filled);
            if (read == -1) throw new IOException("The other device closed the connection early");
            filled += read;
        }
        return buffer;
    }

    private static byte[] readUntilClose(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int read;
        while ((read = in.read(chunk)) != -1) {
            if (out.size() + read > RELAY_MAX_BYTES) {
                throw new IOException("The other device sent more than this app will read");
            }
            out.write(chunk, 0, read);
        }
        return out.toByteArray();
    }

    /** A header or chunk-size line. EOF ends it, which is what stops both loops above. */
    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') line.write(c);
            if (line.size() > 8192) throw new IOException("The other device sent a malformed reply");
        }
        return line.toString("US-ASCII");
    }

    // -----------------------------------------------------------------------
    // LAN listeners — the accepting side of pairing and of ongoing sync
    //
    // The mirror image of the relay above. That one dials another device
    // because the WebView cannot; these accept a connection because the WebView
    // cannot do that either — and then hand the body straight back to it,
    // because everything that has to be *decided* about the body needs keys and
    // state that only the WebView holds. See `LanServer.java`'s header for why
    // the handshake is not reimplemented here, and `core/pairingHostLocal.ts`
    // for the side that actually answers.
    // -----------------------------------------------------------------------

    /**
     * How long a socket handler waits for the WebView to answer.
     *
     * Shorter than the 15s an Android peer allows for a reply, so a device that
     * cannot answer says 503 rather than letting the other end time out — the
     * two failures look identical on the far side and only one of them is
     * honest. The WebView being frozen because the app was backgrounded is the
     * ordinary case this covers, and it is exactly the limitation
     * `devices.ongoingHint` already states on screen: sync happens while both
     * apps are open, and nothing here wakes one that is not.
     */
    private static final long LAN_ANSWER_TIMEOUT_MS = 12_000L;

    /**
     * Requests waiting on the WebView, keyed by the id it will answer with.
     *
     * A single-slot queue per request rather than a shared lock: two devices can
     * be mid-sync at once, and an answer arriving for one must not wake the
     * handler for the other.
     */
    private final java.util.Map<String, java.util.concurrent.ArrayBlockingQueue<LanServer.Reply>> lanWaiting =
            new java.util.concurrent.ConcurrentHashMap<>();

    private final java.util.concurrent.atomic.AtomicLong lanRequestSeq = new java.util.concurrent.atomic.AtomicLong();

    private final LanServer.Relay lanRelay = new LanServer.Relay() {
        @Override
        public LanServer.Reply dispatch(String kind, String body) {
            String id = kind + "-" + lanRequestSeq.incrementAndGet();
            java.util.concurrent.ArrayBlockingQueue<LanServer.Reply> slot =
                    new java.util.concurrent.ArrayBlockingQueue<>(1);
            lanWaiting.put(id, slot);
            try {
                JSObject event = new JSObject();
                event.put("id", id);
                event.put("kind", kind);
                event.put("body", body);
                notifyListeners("lanRequest", event);
                return slot.poll(LAN_ANSWER_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return null;
            } finally {
                lanWaiting.remove(id);
            }
        }
    };

    /** Lives for one ~2-minute handshake, on an OS-assigned port published only in the QR code. */
    private final LanServer pairingServer = new LanServer("/pair", "pair", lanRelay);
    /** Lives for as long as this device has an 'ongoing' pairing, on the fixed port `core/syncLoop.ts` names. */
    private final LanServer syncServer = new LanServer("/sync", "sync", lanRelay);

    /** Must stay identical to `SYNC_SERVER_PORT` in `src/core/syncLoop.ts`. */
    private static final int SYNC_SERVER_PORT = 47821;

    /**
     * The pairing socket's own ceiling, as a backstop only.
     *
     * `PAIRING_SESSION_MS` in `core/pairing.ts` is 120s and the JS side closes
     * this listener itself — on a completed handshake, on its own expiry timer,
     * and when the user cancels. The slack on top is so those three normally win
     * the race; this deadline exists for the one case they cannot cover, which is
     * the WebView going away without having stopped anything.
     */
    private static final long PAIRING_SOCKET_MAX_MS = 150_000L;

    @PluginMethod
    public void lanAddresses(PluginCall call) {
        JSObject result = new JSObject();
        result.put("addresses", new JSArray(LanAddresses.list()));
        call.resolve(result);
    }

    @PluginMethod
    public void startPairingHost(PluginCall call) {
        final String requested = call.getString("host");
        io.execute(() -> {
            try {
                // An override is honoured only if this device actually holds
                // that address — the same allowlist rule, and the same reason,
                // as `PairingServer.start` on the desktop.
                String host = LanAddresses.holds(requested) ? requested : LanAddresses.best();
                if (host == null) {
                    call.reject("no-network");
                    return;
                }
                // Port 0: the OS assigns one, and it is published only inside
                // the QR code. A fixed port would be guessable without ever
                // scanning anything.
                int port = pairingServer.start(host, 0, PAIRING_SOCKET_MAX_MS);
                JSObject result = new JSObject();
                result.put("host", host);
                result.put("port", port);
                call.resolve(result);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void stopPairingHost(PluginCall call) {
        pairingServer.close();
        call.resolve();
    }

    /**
     * Bring the sync listener up or down to match whether this device has
     * anything to answer for — driven from the JS side, which is the side that
     * knows. Same contract as `SyncServer.apply` and same `SyncListenerStatus`
     * shape back, so `state/AppState.tsx` needs no Android branch.
     */
    @PluginMethod
    public void applySyncListener(PluginCall call) {
        final boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        io.execute(() -> {
            if (!enabled) {
                syncServer.close();
                JSObject off = new JSObject();
                off.put("listening", false);
                call.resolve(off);
                return;
            }

            if (syncServer.isListening()) {
                JSObject already = new JSObject();
                already.put("listening", true);
                String host = LanAddresses.best();
                if (host != null) already.put("address", host + ":" + SYNC_SERVER_PORT);
                call.resolve(already);
                return;
            }

            String host = LanAddresses.best();
            if (host == null) {
                JSObject none = new JSObject();
                none.put("listening", false);
                none.put("error", "noNetwork");
                call.resolve(none);
                return;
            }

            JSObject result = new JSObject();
            try {
                syncServer.start(host, SYNC_SERVER_PORT, 0L);
                result.put("listening", true);
                result.put("address", host + ":" + SYNC_SERVER_PORT);
            } catch (java.net.BindException e) {
                result.put("listening", false);
                result.put("error", "portInUse");
                result.put("detail", e.getMessage() == null ? e.toString() : e.getMessage());
            } catch (SecurityException e) {
                result.put("listening", false);
                result.put("error", "blocked");
                result.put("detail", e.getMessage() == null ? e.toString() : e.getMessage());
            } catch (Exception e) {
                result.put("listening", false);
                result.put("error", "failed");
                result.put("detail", e.getMessage() == null ? e.toString() : e.getMessage());
            }
            call.resolve(result);
        });
    }

    /**
     * The WebView's answer to a `lanRequest`.
     *
     * Resolves even when the id is unknown, which is the ordinary case for an
     * answer that lost the race against {@link #LAN_ANSWER_TIMEOUT_MS}: the
     * socket is gone, there is nothing to be done about it, and rejecting would
     * only surface a failure on a screen that has already moved on.
     */
    @PluginMethod
    public void respondToLanRequest(PluginCall call) {
        String id = call.getString("id");
        if (id == null) {
            call.reject("id is required");
            return;
        }
        java.util.concurrent.ArrayBlockingQueue<LanServer.Reply> slot = lanWaiting.get(id);
        if (slot != null) {
            slot.offer(new LanServer.Reply(
                    call.getInt("status", 200),
                    call.getString("body", "{}")));
        }
        call.resolve();
    }

    /**
     * Both listeners go down with the Activity, and so does the event bridge.
     *
     * Without this, a configuration change that recreates the Activity would
     * leave the old accept threads holding the ports, and the new instance's
     * `applySyncListener` would report `portInUse` against itself.
     */
    @Override
    protected void handleOnDestroy() {
        pairingServer.close();
        syncServer.close();
        // Cleared by identity, not unconditionally: an Activity recreated on
        // rotation runs the new instance's `load()` *before* destroying the old
        // one, so `live = null` here would throw away the reference to the
        // instance that is now the live one — and the events this exists to
        // deliver would go nowhere for the rest of the session, silently.
        if (live == this) live = null;
        super.handleOnDestroy();
    }

    // -----------------------------------------------------------------------
    // Files
    // -----------------------------------------------------------------------

    @PluginMethod
    public void pickFiles(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("*/*")
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivityForResult(call, Intent.createChooser(intent, "Add attachments"), "filesPicked");
    }

    @ActivityCallback
    private void filesPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;

        JSObject response = new JSObject();
        JSArray files = new JSArray();

        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            response.put("files", files);
            call.resolve(response);
            return;
        }

        Intent data = result.getData();
        List<Uri> uris = new ArrayList<>();
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }

        // Copy immediately into the app's own storage. A content:// URI is only
        // valid while the grant lasts, and a reminder scheduled for next week
        // would find it revoked. A real file always works.
        File dir = new File(DataRoot.attachments(getContext()), "inbox");
        if (!dir.exists() && !dir.mkdirs()) {
            call.reject("Could not create the attachment directory");
            return;
        }

        int index = 0;
        for (Uri uri : uris) {
            try {
                String name = displayName(uri, "attachment-" + index);
                File target = new File(dir, System.currentTimeMillis() + "_" + index + "_" + safeName(name));
                long size = copy(uri, target);

                JSObject file = new JSObject();
                file.put("id", "att_" + System.currentTimeMillis() + "_" + index);
                file.put("name", name);
                file.put("size", size);
                file.put("mime", mimeOf(uri));
                file.put("source", "copy");
                file.put("path", target.getAbsolutePath());
                file.put("addedAt", System.currentTimeMillis());
                file.put("inline", false);
                files.put(file);
                index++;
            } catch (Exception e) {
                // One unreadable file must not lose the others.
                index++;
            }
        }

        response.put("files", files);
        call.resolve(response);
    }

    // -----------------------------------------------------------------------
    // Received attachments
    //
    // Three separate capabilities, because they answer three different
    // questions and only the first of them needs the network:
    //
    //   downloadInboxAttachment — the bytes are still on the server; fetch them
    //   readAttachment          — show it inside the app, without leaving it
    //   saveAttachmentAs / To   — hand a copy to the user's own storage
    //
    // Desktop has had all three since the inbox landed; Android listed
    // attachments and could do nothing with any of them, which made a received
    // attachment on a phone a row of text.
    // -----------------------------------------------------------------------

    @PluginMethod
    public void downloadInboxAttachment(final PluginCall call) {
        final JSObject config = call.getObject("config");
        final String folderPath = call.getString("folderPath", "INBOX");
        final Integer uidArg = call.getInt("uid");
        final Integer partIndex = call.getInt("partIndex");
        final String name = call.getString("name", "attachment");
        if (config == null || uidArg == null || partIndex == null) {
            call.reject("config, uid and partIndex are required");
            return;
        }

        io.execute(() -> {
            try {
                JSONObject configJson = new JSONObject(config.toString());
                String secret = inboxSecret(configJson.optString("accountId", ""));
                JSONObject file = MailFetcher.downloadAttachment(
                        getContext(), configJson, secret, folderPath, uidArg, partIndex, name);
                call.resolve(JSObject.fromJSONObject(file));
            } catch (Exception e) {
                call.reject("Could not download the attachment: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Read a downloaded attachment back as a {@code data:} URL for previewing.
     *
     * The same three limits the desktop handler applies, for the same reasons:
     * confined to the app's own data folder, capped in size (the result crosses
     * the JS bridge as base64 and grows by a third doing it), and restricted to
     * types that render inertly. SVG is excluded despite being an image — it is
     * a document format that can carry script.
     *
     * Resolves {@code {value: null}} rather than rejecting when it will not
     * preview: the caller's fallback is to hand the file to another app, which
     * is a normal outcome and not an error worth showing.
     */
    @PluginMethod
    public void readAttachment(final PluginCall call) {
        final String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("path is required");
            return;
        }

        io.execute(() -> {
            JSObject result = new JSObject();
            try {
                File file = new File(path).getCanonicalFile();
                if (!insideDataRoot(file) || !file.isFile() || file.length() > PREVIEW_MAX_BYTES) {
                    call.resolve(result);
                    return;
                }
                String mime = mimeOfName(file.getName());
                if (!PREVIEWABLE.contains(mime)) {
                    call.resolve(result);
                    return;
                }
                byte[] bytes = readAll(file);
                result.put("dataUrl", "data:" + mime + ";base64,"
                        + android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP));
                result.put("mime", mime);
                call.resolve(result);
            } catch (Exception e) {
                // Unreadable is "cannot preview", not "something broke".
                call.resolve(result);
            }
        });
    }

    /**
     * Hand the file to whichever app the user has for that type.
     *
     * Through {@code FileProvider}: a {@code file://} URI has thrown
     * FileUriExposedException since Android 7, and the receiving app needs a
     * grant rather than a path it has no permission to open.
     */
    @PluginMethod
    public void openPath(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("path is required");
            return;
        }
        try {
            File file = new File(path).getCanonicalFile();
            if (!insideDataRoot(file) || !file.isFile()) {
                call.reject("That file is not available");
                return;
            }
            Uri uri = androidx.core.content.FileProvider.getUriForFile(
                    getContext(), getContext().getPackageName() + ".fileprovider", file);
            Intent view = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, mimeOfName(file.getName()))
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                            | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(Intent.createChooser(view, file.getName())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve();
        } catch (Exception e) {
            call.reject("No app on this device can open that file", e);
        }
    }

    /**
     * "Save a copy where I choose."
     *
     * Android has no writable path outside the app's own storage, so the
     * destination is a {@code content://} URI from the system's create-document
     * dialog. The source stays confined to the data folder exactly as it is for
     * reading; the destination is wherever the user just pointed at, which is
     * the entire point.
     */
    @PluginMethod
    public void saveAttachmentAs(PluginCall call) {
        String path = call.getString("path");
        String suggested = call.getString("suggestedName", "attachment");
        if (path == null || path.isEmpty()) {
            call.reject("path is required");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(mimeOfName(suggested))
                .putExtra(Intent.EXTRA_TITLE, new File(suggested).getName());
        startActivityForResult(call, intent, "attachmentSaveTargetPicked");
    }

    @ActivityCallback
    private void attachmentSaveTargetPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject response = new JSObject();
        Uri target = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || target == null) {
            call.resolve(response); // cancelled — `value` absent
            return;
        }
        try {
            File source = new File(call.getString("path", "")).getCanonicalFile();
            if (!insideDataRoot(source) || !source.isFile()) {
                call.reject("That file is not available");
                return;
            }
            copyToUri(source, target);
            response.put("value", displayName(target, source.getName()));
            call.resolve(response);
        } catch (Exception e) {
            call.reject("Could not save the file: " + e.getMessage(), e);
        }
    }

    /**
     * "Save this text where I choose" — the same dialog as
     * {@link #saveAttachmentAs}, for a file that does not exist on disk yet.
     *
     * Every generated export in this app (a backup, a reminder transfer file, an
     * encrypted pairing file, a working calendar as .ics) is built as a string in
     * the WebView and handed to `core/download.ts`, which triggers an
     * `<a download>`. That is a no-op in a Capacitor WebView, so `download.ts`
     * refused outright on Android and said so — honest, and it meant the phone
     * could import all four kinds of file and export none of them.
     *
     * The missing piece was only ever the SAF round trip, which
     * {@code saveAttachmentAs} already does for a file inside the data folder.
     * This is the same journey with the bytes coming from the call instead of
     * from disk, so nothing is written to app storage on the way — the text goes
     * straight to the {@code content://} URI the user just pointed at.
     */
    @PluginMethod
    public void saveTextFile(PluginCall call) {
        String name = call.getString("name");
        if (name == null || name.isEmpty()) {
            call.reject("name is required");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                // The caller's MIME, not `mimeOfName`: an .ics is `text/calendar`
                // and the extension table here is built for attachments.
                .setType(call.getString("mime", "application/octet-stream"))
                .putExtra(Intent.EXTRA_TITLE, new File(name).getName());
        startActivityForResult(call, intent, "textFileTargetPicked");
    }

    @ActivityCallback
    private void textFileTargetPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject response = new JSObject();
        Uri target = result.getData() == null ? null : result.getData().getData();
        String suggested = new File(call.getString("name", "export")).getName();

        if (result.getResultCode() != Activity.RESULT_OK || target == null) {
            // Cancelled is an answer, not a failure — `DownloadOutcome` has a
            // field for it and the toast on the other side is deliberately calm.
            response.put("ok", false);
            response.put("cancelled", true);
            response.put("name", suggested);
            call.resolve(response);
            return;
        }

        try {
            byte[] bytes = call.getString("text", "").getBytes(StandardCharsets.UTF_8);
            OutputStream out = getContext().getContentResolver().openOutputStream(target, "wt");
            if (out == null) throw new IOException("that location cannot be written to");
            try {
                out.write(bytes);
                out.flush();
            } finally {
                out.close();
            }
            response.put("ok", true);
            response.put("cancelled", false);
            response.put("name", displayName(target, suggested));
            call.resolve(response);
        } catch (Exception e) {
            call.reject("Could not save the file: " + e.getMessage(), e);
        }
    }

    /** The same, for every attachment on a message: one folder, one dialog. */
    @PluginMethod
    public void saveAttachmentsTo(PluginCall call) {
        JSArray paths = call.getArray("paths");
        if (paths == null || paths.length() == 0) {
            call.reject("paths is required");
            return;
        }
        startActivityForResult(call, new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE),
                "attachmentSaveFolderPicked");
    }

    @ActivityCallback
    private void attachmentSaveFolderPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject response = new JSObject();
        Uri tree = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || tree == null) {
            call.resolve(response); // cancelled — `saved` absent
            return;
        }

        try {
            androidx.documentfile.provider.DocumentFile folder =
                    androidx.documentfile.provider.DocumentFile.fromTreeUri(getContext(), tree);
            if (folder == null || !folder.canWrite()) {
                call.reject("That folder cannot be written to");
                return;
            }

            JSArray paths = call.getArray("paths");
            int saved = 0;
            for (int i = 0; i < paths.length(); i++) {
                try {
                    File source = new File(paths.getString(i)).getCanonicalFile();
                    if (!insideDataRoot(source) || !source.isFile()) continue;
                    // Never overwrite: two mails routinely attach `invoice.pdf`,
                    // and a silent overwrite would destroy the first one with no
                    // way to tell. `createFile` on SAF already de-duplicates by
                    // appending a counter, which is the behaviour we want.
                    androidx.documentfile.provider.DocumentFile target =
                            folder.createFile(mimeOfName(source.getName()), source.getName());
                    if (target == null) continue;
                    copyToUri(source, target.getUri());
                    saved++;
                } catch (Exception ignored) {
                    // One unwritable file must not abandon the rest of the batch.
                }
            }

            response.put("folder", displayName(tree, tree.getLastPathSegment()));
            response.put("saved", saved);
            call.resolve(response);
        } catch (Exception e) {
            call.reject("Could not save the attachments: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void snapshotAttachments(PluginCall call) {
        JSArray attachments = call.getArray("attachments");
        String jobId = call.getString("jobId", "job");
        JSObject response = new JSObject();
        JSArray out = new JSArray();

        if (attachments == null) {
            response.put("files", out);
            call.resolve(response);
            return;
        }

        File dir = new File(DataRoot.attachments(getContext()), safeName(jobId));
        if (!dir.exists() && !dir.mkdirs()) {
            call.reject("Could not create the snapshot directory");
            return;
        }

        try {
            for (int i = 0; i < attachments.length(); i++) {
                JSONObject a = attachments.getJSONObject(i);
                File source = new File(a.optString("path", ""));
                if (!source.isFile()) continue;

                File target = new File(dir, a.optString("id", String.valueOf(i))
                        + "_" + safeName(a.optString("name", "attachment")));
                copyFile(source, target);

                JSONObject copy = new JSONObject(a.toString());
                copy.put("source", "copy");
                copy.put("path", target.getAbsolutePath());
                out.put(copy);
            }
        } catch (Exception e) {
            call.reject("Could not copy the attachments: " + e.getMessage(), e);
            return;
        }

        response.put("files", out);
        call.resolve(response);
    }

    // -----------------------------------------------------------------------
    // Scheduling
    // -----------------------------------------------------------------------

    @PluginMethod
    public void syncJobs(PluginCall call) {
        JSArray jobs = call.getArray("jobs");
        JSArray accounts = call.getArray("accounts");

        JobStore store = new JobStore(getContext());
        // Which reminders were armed a moment ago, and which are armed now.
        // The difference is the only thing separating "the user just armed
        // their first reminder" — a moment where asking for notification
        // permission explains itself — from "the app just started and re-sent
        // the same list", which is the moment people deny by reflex.
        // `ensureNotificationPermission` acts on the flag this sets; see there.
        Set<String> before = jobIds(store.jobs());
        JSONArray incoming = jobs == null ? new JSONArray() : jobs;
        Permissions.noteNewlyArmed(getContext(), before, jobIds(incoming));

        /*
         * The two notification switches travel with the jobs.
         *
         * `SendWorker` used to read `notifyOnSuccess` off each individual job,
         * which no job has ever carried — see `ScheduledJob` in
         * `src/core/types.ts` — so the answer was always the `false` default
         * and a scheduled send that worked has never notified on Android. They
         * are application settings, so they are stored once, beside the jobs
         * the worker already reads from.
         *
         * `!= Boolean.FALSE` rather than `== Boolean.TRUE`: an older web layer
         * that does not send these keys must keep the documented default
         * (announce), not go silent.
         */
        store.save(
                incoming,
                accounts == null ? new JSONArray() : accounts,
                !Boolean.FALSE.equals(call.getBoolean("notifyOnSuccess", true)),
                !Boolean.FALSE.equals(call.getBoolean("notifyOnFailure", true)),
                call.getString("localDeviceId"));

        AevistleScheduler.rearmAll(getContext());
        call.resolve();
    }

    private static Set<String> jobIds(JSONArray jobs) {
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < jobs.length(); i++) {
            JSONObject job = jobs.optJSONObject(i);
            if (job == null) continue;
            // Only jobs that will actually fire count. The web layer already
            // filters to enabled before it calls, but a disabled one arriving
            // here must not be read as a reason to ask for permission.
            if (!job.optBoolean("enabled", false)) continue;
            String id = job.optString("id", "");
            if (!id.isEmpty()) ids.add(id);
        }
        return ids;
    }

    /**
     * Hand over every send that happened while the web layer was not running.
     *
     * The desktop learns about a run from a live event because its scheduler
     * and its window are in the same process. Android's is not: the alarm fires
     * into a worker with no WebView attached, so there is nobody to notify at
     * the moment it matters. {@link JobStore#recordRun} queues the report
     * instead and this drains it — which is why a schedule that fired overnight
     * now reads "sent" when the app is opened rather than still claiming to be
     * waiting.
     *
     * Absolute state, not deltas, so redelivering a report is harmless.
     */
    @PluginMethod
    public void pullJobRuns(PluginCall call) {
        JSObject result = new JSObject();
        result.put("runs", new JobStore(getContext()).drainRuns());
        call.resolve(result);
    }

    // -----------------------------------------------------------------------
    // Misc
    // -----------------------------------------------------------------------

    /**
     * Raise a system notification on behalf of the JavaScript side.
     *
     * This used to be an empty {@code call.resolve()} carrying a comment that
     * claimed the scheduled-send worker delivered it. Nothing did — it reported
     * success and produced nothing, so every notification the app asked for on
     * Android (a send confirmation, and later the arrival of a verification
     * code) silently went nowhere.
     *
     * A code goes to its own high-importance channel so it arrives as a
     * heads-up: the whole value of that notification is being readable without
     * switching apps. Everything else is a status message.
     */
    @PluginMethod
    public void notify(PluginCall call) {
        String title = call.getString("title", "Aevistle");
        String body = call.getString("body", "");
        boolean isCode = Boolean.TRUE.equals(call.getBoolean("code", false));
        /*
         * The code itself and the button's label both come from the caller
         * rather than being derived here.
         *
         * The value, because the title is a worded sentence ("Verification
         * code: 482 913") and a Copy button that pasted that sentence into a
         * verification field would be worse than no button at all. The label,
         * because this is the one notification with a control on it and the
         * JavaScript side is where all six translations live — a hardcoded
         * "Copy" would be the only untranslated word in the app.
         */
        String codeValue = call.getString("value", "");
        String copyLabel = call.getString("copyLabel", "Copy");
        /*
         * `messageId` makes the notification open the mail it is about.
         * Present for the new-mail notifications the renderer raises while the
         * app is in the foreground; absent for a send result, which is not
         * about a message that can be opened.
         */
        String messageId = call.getString("messageId", "");
        try {
            if (isCode) {
                Notifier.code(getContext(), title, title, body, codeValue, copyLabel);
            } else if (!messageId.isEmpty()) {
                Notifier.mail(getContext(), messageId, title, body, messageId);
            } else {
                Notifier.status(getContext(), title + body, title, body);
            }
        } catch (Exception ignored) {
            // A refused or unavailable notification must not fail the caller:
            // the code is already on the codes screen either way.
        }
        call.resolve();
    }

    /**
     * The inbox message a tapped notification asked for, if one is waiting.
     *
     * Polled by the web layer at startup rather than delivered as an event,
     * because the tap is routinely what *starts* the app: fifteen minutes after
     * a background sync, with the process long dead and no bridge to fire an
     * event at. {@link MainActivity} parks the id from the intent — on a cold
     * start in {@code onCreate}, on a warm one in {@code onNewIntent} — and
     * this hands it over exactly once.
     *
     * Resolves with an absent `messageId` rather than rejecting when there is
     * nothing waiting, which is the overwhelmingly common case: it is called on
     * every launch.
     */
    @PluginMethod
    public void takePendingOpen(PluginCall call) {
        JSObject result = new JSObject();
        String id = MainActivity.takePendingOpenMessageId();
        if (id != null && !id.isEmpty()) result.put("messageId", id);
        call.resolve(result);
    }

    /**
     * What another app shared with us, if anything is waiting.
     *
     * Polled at startup for exactly the reason {@link #takePendingOpen} is, only
     * more so: a share is nearly always a cold start. The user was in a browser
     * or a gallery, tapped Share and picked this app, and there was no process —
     * let alone a WebView — to fire an event at. {@link MainActivity} parses the
     * intent as it arrives and parks the result; this hands it over once.
     *
     * Resolves with an empty object rather than rejecting when there is nothing
     * waiting, which is the overwhelmingly common case: it runs on every launch.
     *
     * The attachment copy happens here rather than in the activity because it
     * needs a Context and touches the disk. It has to happen *now*, though: the
     * `content://` URIs a share carries are readable only under the grant that
     * came with the intent, which dies with this task. A reminder scheduled for
     * next week has to find a real file, so the bytes are taken out at the first
     * opportunity — which is this call.
     */
    @PluginMethod
    public void takePendingShare(PluginCall call) {
        JSObject result = new JSObject();
        JSONObject share = MainActivity.takePendingShare();
        if (share == null) {
            call.resolve(result);
            return;
        }

        String subject = share.optString("subject", "");
        if (!subject.isEmpty()) result.put("subject", subject);
        String body = share.optString("body", "");
        if (!body.isEmpty()) result.put("body", body);
        putAddressList(result, "to", share.optJSONArray("to"));
        putAddressList(result, "cc", share.optJSONArray("cc"));
        putAddressList(result, "bcc", share.optJSONArray("bcc"));

        JSArray files = copySharedFiles(share.optJSONArray("uris"));
        if (files.length() > 0) result.put("attachments", files);

        call.resolve(result);
    }

    /** Copy an address array straight across, or leave the key absent. */
    private static void putAddressList(JSObject into, String key, JSONArray addresses) {
        if (addresses == null || addresses.length() == 0) return;
        JSArray out = new JSArray();
        for (int i = 0; i < addresses.length(); i++) {
            String address = addresses.optString(i, "");
            if (!address.isEmpty()) out.put(address);
        }
        if (out.length() > 0) into.put(key, out);
    }

    /**
     * Turn the shared content URIs into real files on this app's own storage.
     *
     * Byte-for-byte the same treatment `filesPicked` gives a file the user
     * chose through the picker, down to the destination folder and the emitted
     * field set — an attachment that arrived through the share sheet is not a
     * different kind of attachment, and anything that made it one would show up
     * later as a scheduled send that could not find its file.
     */
    private JSArray copySharedFiles(JSONArray uris) {
        JSArray files = new JSArray();
        if (uris == null || uris.length() == 0) return files;

        File dir = new File(DataRoot.attachments(getContext()), "inbox");
        if (!dir.exists() && !dir.mkdirs()) {
            // Said out loud rather than swallowed: the text half of the share
            // still resolves, so the user gets their compose screen, and this
            // line is the only record of why the photo did not come with it.
            Log.e(TAG, "copySharedFiles: could not create " + dir);
            return files;
        }

        for (int i = 0; i < uris.length(); i++) {
            String raw = uris.optString(i, "");
            if (raw.isEmpty()) continue;
            try {
                Uri uri = Uri.parse(raw);
                String name = displayName(uri, "attachment-" + i);
                File target = new File(dir, System.currentTimeMillis() + "_" + i + "_" + safeName(name));
                long size = copy(uri, target);

                JSObject file = new JSObject();
                file.put("id", "att_" + System.currentTimeMillis() + "_" + i);
                file.put("name", name);
                file.put("size", size);
                file.put("mime", mimeOf(uri));
                file.put("source", "copy");
                file.put("path", target.getAbsolutePath());
                file.put("addedAt", System.currentTimeMillis());
                file.put("inline", false);
                files.put(file);
            } catch (Exception e) {
                // One unreadable share must not lose the others — the same
                // policy as the file picker, and the same reason: a revoked
                // grant on one of five photos is not a reason to drop four.
                Log.e(TAG, "copySharedFiles: could not take a copy of " + raw, e);
            }
        }
        return files;
    }

    /**
     * Put text on the clipboard, because the web API cannot do it here.
     *
     * `navigator.clipboard.writeText()` rejects inside an Android WebView with
     * a permission error, from a real tap, in a genuine secure context. The
     * async clipboard write goes through Chromium's permission service, and
     * WebView has no delegate for `clipboard-write` — `onPermissionRequest`
     * covers audio, video, MIDI and protected media and nothing else. Every
     * copy button in the app therefore reported failure on Android while
     * working on Windows and in the browser preview, and the verification-code
     * screen — whose entire purpose is one tap that copies a code — was the
     * place it hurt.
     *
     * {@code ClipboardManager} has no such gate: it is the API the platform
     * intends for this, and it needs no permission at all to write.
     *
     * The label is what Android shows in its own "copied" toast on 12 and
     * below, so it is the app's name rather than the value — a clipboard
     * preview reading out a verification code on the screen of a phone someone
     * else can see is not a feature.
     */
    @PluginMethod
    public void clipboardWrite(PluginCall call) {
        String text = call.getString("text", "");
        ClipboardManager clipboard = getContext().getSystemService(ClipboardManager.class);
        if (clipboard == null) {
            // No clipboard service at all — a stripped OEM build or a test
            // harness. Said out loud rather than resolved, so `core/clipboard`
            // falls through to its web paths instead of reporting a success
            // that put nothing anywhere.
            call.reject("No clipboard service on this device");
            return;
        }
        try {
            clipboard.setPrimaryClip(ClipData.newPlainText("Aevistle", text));
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            return;
        }
        call.resolve();
    }

    // -----------------------------------------------------------------------
    // Permissions
    //
    // Two of them, behaving nothing alike, and the UI has to be able to say
    // which is which — see Permissions.java for what each one costs when it is
    // missing. Everything below is a report or a response to a tap; nothing
    // here raises a dialog or opens a settings screen on its own.
    // -----------------------------------------------------------------------

    /**
     * What the app is actually allowed to do right now.
     *
     * The health strip used to infer this. It could see that arming had failed
     * and guessed at exact alarms as the likely reason, and it had no way at
     * all to know notifications were off — so the one failure that silences
     * every send report on a modern phone was invisible to the screen whose
     * job is to list what is wrong.
     */
    @PluginMethod
    public void permissionState(PluginCall call) {
        call.resolve(permissionSnapshot());
    }

    private String notificationState() {
        PermissionState state = getPermissionState(Permissions.ALIAS_NOTIFICATIONS);
        return Permissions.notifications(getContext(), state == null ? null : state.toString());
    }

    /**
     * Would {@code requestNotificationPermission} actually produce a dialog?
     *
     * False for granted, for blocked, and for every Android below 13. Blocked
     * is the one that matters: a button offering to ask again would do nothing
     * at all there, and {@code openNotificationSettings} is the only honest
     * offer left.
     */
    private boolean canAskNotifications() {
        return android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU
                && Permissions.PROMPT.equals(notificationState());
    }

    private JSObject permissionSnapshot() {
        JSObject result = new JSObject();
        result.put("notifications", notificationState());
        result.put("exactAlarms", Permissions.exactAlarms(getContext()));
        result.put("canAskNotifications", canAskNotifications());
        return result;
    }

    /**
     * Ask for notifications, now, because the user asked us to.
     *
     * The explicit route: a button in the app. Resolves with the state
     * afterwards either way, so a refusal updates the screen rather than
     * leaving it claiming the request is still in flight.
     */
    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (!canAskNotifications()) {
            // Granted, blocked, or a platform with no such permission. In all
            // three cases the dialog will not appear, and launching the request
            // anyway would resolve instantly with an unchanged state that looks
            // like the user declined.
            JSObject result = permissionSnapshot();
            result.put("prompted", false);
            call.resolve(result);
            return;
        }
        requestPermissionForAlias(Permissions.ALIAS_NOTIFICATIONS, call, "notificationPermissionResult");
    }

    /**
     * Ask only if this is a moment that earns it.
     *
     * The bridge calls this straight after arming a schedule or enabling an
     * inbox, and the native side decides whether anything actually changed —
     * {@link Permissions#takePromptDue}. Cold start re-sends the jobs that were
     * already armed, so without that check every launch would open with a
     * permission dialog and no visible reason for it, which is the pattern
     * people deny by reflex.
     */
    @PluginMethod
    public void ensureNotificationPermission(PluginCall call) {
        boolean askable = canAskNotifications();
        // Consumed only when it could have been used: a moment that earned a
        // prompt on an Android that cannot show one must not burn the flag,
        // or upgrading the phone would lose the prompt it was saving up.
        boolean due = askable && Permissions.takePromptDue(getContext());
        if (!due) {
            JSObject result = permissionSnapshot();
            result.put("prompted", false);
            call.resolve(result);
            return;
        }
        requestPermissionForAlias(Permissions.ALIAS_NOTIFICATIONS, call, "notificationPermissionResult");
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) {
        JSObject result = permissionSnapshot();
        result.put("prompted", true);
        call.resolve(result);
    }

    /**
     * The route out of a permanent refusal.
     *
     * Once Android has recorded "don't ask again" there is no dialog left; the
     * app's only remaining honest move is to say so and offer to open the
     * screen where it can be undone.
     */
    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        JSObject result = new JSObject();
        result.put("opened", Permissions.openNotificationSettings(getContext(), getActivity()));
        call.resolve(result);
    }

    /**
     * The equivalent for exact alarms — which is the *only* route, since this
     * one never had a dialog.
     *
     * Fired from a tap, never from launch. `ACTION_REQUEST_SCHEDULE_EXACT_ALARM`
     * on app start is exactly the behaviour Google's own guidance calls out,
     * and it is also useless: a user who has not yet been told why they are
     * looking at a settings screen backs out of it.
     */
    @PluginMethod
    public void openExactAlarmSettings(PluginCall call) {
        JSObject result = new JSObject();
        result.put("opened", Permissions.openExactAlarmSettings(getContext(), getActivity()));
        call.resolve(result);
    }

    @PluginMethod
    public void appInfo(PluginCall call) {
        JSObject info = new JSObject();
        info.put("version", BuildConfig.VERSION_NAME);
        info.put("platform", "android");
        info.put("os", "Android " + android.os.Build.VERSION.RELEASE + " · " + android.os.Build.MODEL);
        info.put("dataLocation", DataRoot.dir(getContext()).getAbsolutePath());
        call.resolve(info);
    }

    // -----------------------------------------------------------------------
    // In-app update
    //
    // The check itself has always worked here — `FeedFetcher` relays it past
    // the WebView's `connect-src 'self'` — but there was nothing to *do* with
    // the answer: `downloadUpdate` and `installUpdate` existed only on the
    // desktop bridge, so `canInstallHere` in `SettingsView` was false and the
    // phone offered a link to a web page. See `UpdateInstaller` for why doing
    // it here beats sending someone to the browser.
    // -----------------------------------------------------------------------

    @PluginMethod
    public void downloadUpdate(final PluginCall call) {
        final String url = call.getString("url");
        final String name = call.getString("name", "aevistle.apk");
        final long size = call.getLong("sizeBytes", 0L);
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        io.execute(() -> {
            try {
                UpdateInstaller.Downloaded result = UpdateInstaller.download(
                        getContext(), url, name, size,
                        (received, total) -> {
                            // Same channel and shape as the desktop's
                            // `IPC.updateProgress`, so `SettingsView`'s
                            // progress bar needs no platform branch.
                            JSObject progress = new JSObject();
                            progress.put("receivedBytes", received);
                            progress.put("totalBytes", total);
                            progress.put("done", false);
                            notifyListeners("updateProgress", progress);
                        });

                JSObject done = new JSObject();
                done.put("receivedBytes", result.receivedBytes);
                done.put("totalBytes", result.totalBytes);
                done.put("done", true);
                done.put("path", result.path);
                done.put("checksumVerified", result.checksumVerified);
                notifyListeners("updateProgress", done);
                call.resolve(done);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void installUpdate(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("path is required");
            return;
        }
        try {
            UpdateInstaller.install(getContext(), path);
            call.resolve();
        } catch (IllegalStateException e) {
            // The one failure with a route out of it. Android 8+ makes
            // "install from this app" a settings toggle with no dialog to
            // request, so the honest move is to open the exact screen that
            // grants it rather than reject with a message the user cannot act
            // on. The rejection code is what `bridge-android.ts` matches on.
            try {
                getContext().startActivity(UpdateInstaller.unknownSourcesIntent(getContext()));
            } catch (Exception ignored) {
                // An OEM build without that settings screen. Nothing further to
                // try; the rejection below still explains what is missing.
            }
            call.reject("unknown-sources");
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? e.toString() : e.getMessage(), e);
        }
    }

    // -----------------------------------------------------------------------
    // Data folder
    // -----------------------------------------------------------------------

    @PluginMethod
    public void dataFolder(PluginCall call) {
        JSObject info = new JSObject();
        info.put("path", DataRoot.dir(getContext()).getAbsolutePath());
        info.put("isDefault", DataRoot.ID_DEFAULT.equals(DataRoot.currentId(getContext())));
        info.put("sizeBytes", DataRoot.size(getContext()));
        // Android grants storage per volume, not per directory — see DataRoot.
        info.put("canPickAny", false);
        info.put("options", DataRoot.options(getContext()));

        JSArray stays = new JSArray();
        stays.put("secrets");
        stays.put("schedule");
        info.put("staysBehind", stays);

        call.resolve(info);
    }

    @PluginMethod
    public void useDataFolder(final PluginCall call) {
        final String optionId = call.getString("optionId", DataRoot.ID_DEFAULT);
        final boolean move = Boolean.TRUE.equals(call.getBoolean("move", true));
        final String before = DataRoot.dir(getContext()).getAbsolutePath();

        // Copying attachments can take a moment on a slow card; the UI thread
        // is not the place for it.
        io.execute(() -> {
            try {
                String warning = DataRoot.switchTo(getContext(), optionId, move);
                String after = DataRoot.dir(getContext()).getAbsolutePath();

                JSObject result = new JSObject();
                result.put("changed", !before.equals(after));
                result.put("path", after);
                result.put("moved", move && !before.equals(after));
                if (warning != null) result.put("warning", warning);
                call.resolve(result);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Could not switch storage location" : e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void openDataFolder(PluginCall call) {
        // No reliable "reveal this path" intent exists across OEM file
        // managers; the settings panel shows the full path instead, which is
        // what a user needs to find it over USB anyway.
        call.resolve();
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private String displayName(Uri uri, String fallback) {
        try (Cursor cursor = getContext().getContentResolver()
                .query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (column >= 0) {
                    String name = cursor.getString(column);
                    if (name != null && !name.isEmpty()) return name;
                }
            }
        } catch (Exception e) {
            // The fallback below is always a reasonable name to show, so this
            // stays fail-safe rather than propagating — but a query that
            // throws instead of just returning nothing is unusual enough to
            // be worth a trace when someone is chasing a "wrong file name"
            // report.
            Log.e(TAG, "displayName: could not query the content resolver for " + uri, e);
        }
        return fallback;
    }

    private String mimeOf(Uri uri) {
        String type = getContext().getContentResolver().getType(uri);
        return type == null ? "application/octet-stream" : type;
    }

    /** 24 MB of file becomes ~32 MB of base64 in transit; past that, offer another app instead. */
    private static final long PREVIEW_MAX_BYTES = 24L * 1024 * 1024;

    /**
     * What {@code readAttachment} is willing to hand back.
     *
     * SVG is excluded even though it is an image: it is a document that can
     * carry script, and the preview surface's job is to be boring.
     */
    private static final java.util.Set<String> PREVIEWABLE = new java.util.HashSet<>(
            java.util.Arrays.asList(
                    "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp",
                    "image/avif", "application/pdf", "text/plain", "text/csv"));

    private static String mimeOfName(String name) {
        int dot = name == null ? -1 : name.lastIndexOf('.');
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
            case "doc": return "application/msword";
            case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            case "xls": return "application/vnd.ms-excel";
            case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            default: return "application/octet-stream";
        }
    }

    /**
     * Is this file inside the folder this app owns?
     *
     * The same confinement the desktop's path handlers apply, and for the same
     * reason: every one of these methods takes a bare string from the WebView,
     * and without this a crafted path could read or copy out any file the
     * process can see. Canonicalised on both sides so {@code ../} cannot walk
     * out, and both roots are checked because the data folder can be moved to
     * external storage while older attachments remain internal.
     */
    private boolean insideDataRoot(File file) {
        try {
            String target = file.getCanonicalPath();
            for (File root : new File[]{DataRoot.dir(getContext()), getContext().getFilesDir()}) {
                if (root == null) continue;
                String prefix = root.getCanonicalPath() + File.separator;
                if (target.startsWith(prefix)) return true;
            }
        } catch (Exception e) {
            // Fails closed either way — the return below is `false` whether
            // this threw or the file was legitimately outside both roots —
            // but those are two different situations for anyone auditing
            // this path-confinement check, and only one of them is a
            // canonicalisation problem worth looking at. Log it rather than
            // erasing the distinction.
            Log.e(TAG, "insideDataRoot: could not canonicalise " + file, e);
        }
        return false;
    }

    private static byte[] readAll(File file) throws Exception {
        try (InputStream in = new java.io.FileInputStream(file);
             java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            return out.toByteArray();
        }
    }

    private void copyToUri(File source, Uri target) throws Exception {
        try (InputStream in = new java.io.FileInputStream(source);
             OutputStream out = getContext().getContentResolver().openOutputStream(target)) {
            if (out == null) throw new IllegalStateException("Cannot write to " + target);
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
        }
    }

    /** Strip anything that could escape the directory we intend to write into. */
    private static String safeName(String name) {
        String base = new File(name).getName();
        return base.replaceAll("[^A-Za-z0-9._\\-]", "_");
    }

    private long copy(Uri uri, File target) throws Exception {
        try (InputStream in = getContext().getContentResolver().openInputStream(uri);
             OutputStream out = new FileOutputStream(target)) {
            if (in == null) throw new IllegalStateException("Cannot read " + uri);
            byte[] buffer = new byte[64 * 1024];
            long total = 0;
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
                total += read;
            }
            return total;
        }
    }

    private static void copyFile(File source, File target) throws Exception {
        try (InputStream in = new java.io.FileInputStream(source);
             OutputStream out = new FileOutputStream(target)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
        }
    }
}
