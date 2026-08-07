package dev.aevistle.app;

import android.content.Context;
import android.util.Base64;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The grant an OAuth2 mailbox is signed in with, and the bearer tokens minted
 * from it.
 *
 * The counterpart of `electron/oauth.ts`'s storage half, and it keeps that
 * file's decisions rather than re-deciding them — including the one that is
 * easiest to get backwards (see {@link #store}: write the refresh token only
 * when the provider sent one). {@link OAuthConsent} owns the consent flow;
 * this class owns everything that happens afterwards, which is the part that
 * runs at 03:00 from a WorkManager job with no WebView and no user present.
 *
 * ---------------------------------------------------------------------------
 * What is held where, and why the split is not arbitrary
 * ---------------------------------------------------------------------------
 * The **refresh token** goes into {@link SecretStore} under the `oauth` kind,
 * so it is AES-GCM encrypted with a key that never leaves the Android Keystore
 * — the same protection an SMTP password gets, which is the right comparison
 * because a refresh token is strictly more valuable than one: it is minted by
 * the provider, survives a password change, and grants mailbox access until it
 * is revoked. It never crosses the Capacitor bridge in either direction, and
 * `sealAccountSecrets` deliberately does not enumerate this kind, so pairing a
 * second device does not carry the grant to it — that device runs its own
 * consent against its own redirect, exactly as the desktop file describes.
 *
 * **Access tokens** live in the static map below and nowhere else. They last
 * about an hour; persisting them would buy nothing and would widen what a
 * copied `secrets.xml` is worth. The map dies with the process, which is the
 * correct lifetime for a bearer token.
 *
 * **Everything else about the grant** — which provider issued it, which client
 * id and token endpoint it must be renewed at, which mailbox it turned out to
 * be for, and whether the provider has since refused it — is written as a small
 * JSON blob under the `oauth-grant` kind, i.e. into the keystore as well. That
 * needs justifying, because none of it is secret. Two reasons, both load
 * bearing:
 *
 *  1. A refresh token can only be renewed at the endpoint that issued it.
 *     Microsoft's `consumers` and `organizations` authorities are two different
 *     token endpoints and a token from one is refused by the other, so the
 *     token and the endpoint are useless apart and must not be able to drift.
 *     Storing them under two kinds of the same account id means one delete
 *     removes both — see {@link #forget}.
 *  2. The alternative was the WebView's own state, and that is the wrong store
 *     for exactly the moment this matters. {@link InboxSyncWorker} and
 *     {@link SendWorker} run hours after the last WebView existed and cannot
 *     ask JavaScript anything; the keystore is the one place both they and the
 *     plugin can read without one. It is also why the provider table stays on
 *     the TypeScript side and arrives as call arguments — this file records
 *     what a *completed* consent decided, and never re-derives it.
 *
 * Encrypting a client id costs nothing. Keeping the pair inseparable is worth
 * something.
 */
final class OAuthTokens {

    /**
     * {@link SecretStore} kinds. `oauth` produces the key `<accountId>:oauth`,
     * which is the same shape `:imap` already produces — nothing in the store
     * has to learn anything new, and an account moving from a password to
     * OAuth2 keeps its old password entry until something deletes it, so
     * switching back is a dropdown rather than a re-typed password.
     */
    private static final String KIND_REFRESH = "oauth";
    private static final String KIND_GRANT = "oauth-grant";

    /**
     * Renew this many milliseconds before the provider's own expiry — the
     * mirror of `OAUTH_EXPIRY_SKEW_MS`.
     *
     * An access token valid for four more seconds is not usable: an SMTP
     * session spends a DNS lookup, a TCP handshake, a TLS handshake and an EHLO
     * before it authenticates, and a token that dies in the middle of that
     * produces an authentication failure indistinguishable from a wrong
     * password.
     */
    private static final long EXPIRY_SKEW_MS = 120_000L;

    /** Long enough for a slow mobile link, short enough that a send does not hang on it. */
    private static final int TOKEN_TIMEOUT_MS = 20_000;

    /** A token response is a few hundred bytes. Nothing legitimate is near this. */
    private static final long MAX_RESPONSE_BYTES = 256L * 1024L;

    /**
     * The sentence a dead grant produces, everywhere it is produced.
     *
     * It contains the word "authorization" on purpose: {@link
     * MailSender#classify} files anything matching `auth` as an authentication
     * failure, which is what puts this on screen as a credential problem rather
     * than the "unknown" bucket. The wording still has to send the user to
     * *sign in again* rather than to their password, because a password is not
     * involved and re-typing one would waste an afternoon.
     */
    static final String NEEDS_CONSENT_MESSAGE =
            "The mail provider has withdrawn this account's authorization. Open the account "
                    + "and sign in again.";

    private OAuthTokens() {
    }

    // -----------------------------------------------------------------------
    // Failures worth telling apart
    // -----------------------------------------------------------------------

    /**
     * The token endpoint answered with a machine-readable error rather than a
     * token. {@code code} is the RFC 6749 `error` field, which is the single
     * fact every layer above needs: `invalid_grant` means re-consent, anything
     * else means retry later.
     */
    static final class TokenEndpointException extends Exception {
        final String code;

        TokenEndpointException(String code, String description) {
            super(description);
            this.code = code;
        }
    }

    /**
     * The grant is gone — revoked from the provider's dashboard, expired after
     * a long idle period, or invalidated by a password change. Distinct from
     * every other failure because retrying cannot help and only the user can
     * fix it.
     */
    static final class NeedsConsentException extends Exception {
        NeedsConsentException() {
            super(NEEDS_CONSENT_MESSAGE);
        }
    }

    // -----------------------------------------------------------------------
    // The stored grant
    // -----------------------------------------------------------------------

    /** Everything about a completed consent except the refresh token itself. */
    static final class Grant {
        final String providerId;
        final String clientId;
        final String tokenUrl;
        /** The mailbox the provider said was signed in, or null when it did not say. */
        final String address;
        /** True once a refresh came back `invalid_grant`. Cleared by a fresh consent. */
        final boolean rejected;

        Grant(String providerId, String clientId, String tokenUrl, String address, boolean rejected) {
            this.providerId = providerId;
            this.clientId = clientId;
            this.tokenUrl = tokenUrl;
            this.address = address;
            this.rejected = rejected;
        }
    }

    /** The recorded grant for an account, or null when there has never been one. */
    static Grant grant(Context context, String accountId) {
        String raw = new SecretStore(context).get(accountId, KIND_GRANT);
        if (raw == null) return null;
        try {
            JSONObject o = new JSONObject(raw);
            String address = o.optString("address", "");
            return new Grant(
                    o.optString("providerId", ""),
                    o.optString("clientId", ""),
                    o.optString("tokenUrl", ""),
                    address.isEmpty() ? null : address,
                    o.optBoolean("rejected", false));
        } catch (Exception e) {
            // A grant record that will not parse is a grant this build cannot
            // renew — a rotated keystore key, or app data restored onto another
            // device. Reporting null puts the account back into "disconnected",
            // which offers the one action that actually fixes it (sign in
            // again); anything louder would be an error message about a JSON
            // blob the user has never heard of.
            return null;
        }
    }

    /** Whether the keystore holds a refresh token for this account. The cheap question. */
    static boolean hasGrant(Context context, String accountId) {
        return new SecretStore(context).has(accountId, KIND_REFRESH);
    }

    /** True when the provider has refused this account's refresh token since it was stored. */
    static boolean rejected(Context context, String accountId) {
        Grant grant = grant(context, accountId);
        return grant != null && grant.rejected;
    }

    /** The mailbox this account's grant is for, as the provider named it, or null. */
    static String address(Context context, String accountId) {
        Grant grant = grant(context, accountId);
        return grant == null ? null : grant.address;
    }

    /**
     * Write whatever the provider handed back, keeping the refresh token that
     * is already stored when it handed back none.
     *
     * This is the single most damaging thing to get wrong in a refresh flow,
     * and the desktop file says why at length: Microsoft *rotates* — every
     * refresh returns a new refresh token and retires the one just used, so
     * failing to write it back leaves the account working until the old token's
     * grace period lapses and then dead. Google does not rotate — it returns no
     * `refresh_token` on a refresh at all, so blindly writing what came back
     * would erase a perfectly good grant on the first renewal. Both behaviours
     * are correct for their vendor and both are handled by one rule: write when
     * there is something to write, keep otherwise.
     *
     * The grant record is rewritten on every success, not only on first
     * consent, so an account moved between the two Microsoft presets cannot end
     * up with a `consumers` token filed under `organizations`. Writing it also
     * clears {@code rejected}: a token that just worked is not refused.
     */
    private static void store(Context context, String accountId, String providerId, String clientId,
                              String tokenUrl, TokenSet tokens, String address) throws Exception {
        SecretStore secrets = new SecretStore(context);
        if (tokens.refreshToken != null && !tokens.refreshToken.isEmpty()) {
            secrets.put(accountId, KIND_REFRESH, tokens.refreshToken);
        }

        Grant previous = grant(context, accountId);
        String resolvedAddress = address != null && !address.isEmpty()
                ? address
                : (previous == null ? null : previous.address);

        JSONObject record = new JSONObject();
        record.put("providerId", providerId);
        record.put("clientId", clientId);
        record.put("tokenUrl", tokenUrl);
        if (resolvedAddress != null) record.put("address", resolvedAddress);
        record.put("rejected", false);
        secrets.put(accountId, KIND_GRANT, record.toString());

        synchronized (CACHE) {
            CACHE.put(accountId, new Cached(tokens.accessToken, tokens.expiresAt));
        }
    }

    /**
     * What a completed consent calls. Split from {@link #store} only so the
     * consent flow does not have to build a {@link TokenSet} twice.
     */
    static void adopt(Context context, String accountId, String providerId, String clientId,
                      String tokenUrl, TokenSet tokens, String address) throws Exception {
        store(context, accountId, providerId, clientId, tokenUrl, tokens, address);
    }

    /**
     * Record that the provider has refused this grant.
     *
     * Durable rather than in-memory, which is where this parts company with
     * `electron/oauth.ts`. On the desktop a rejection is a `Set` in the main
     * process, because that process outlives every window. Android has no such
     * process: the plugin instance is gone the moment the app is swiped away,
     * and the very next thing to touch this account is usually a WorkManager
     * job in a freshly created process. A rejection kept in memory there would
     * be forgotten between the failed 03:00 send and the user opening the app
     * at breakfast — which is precisely the moment `oauthStatus` exists to be
     * able to say "this needs reconnecting".
     *
     * The cost of persisting it is a stale flag on an account that has since
     * started working again, and that cost is paid back immediately: any
     * successful token response clears it (see {@link #store}).
     */
    static void markRejected(Context context, String accountId) {
        Grant previous = grant(context, accountId);
        if (previous == null) return;
        try {
            JSONObject record = new JSONObject();
            record.put("providerId", previous.providerId);
            record.put("clientId", previous.clientId);
            record.put("tokenUrl", previous.tokenUrl);
            if (previous.address != null) record.put("address", previous.address);
            record.put("rejected", true);
            new SecretStore(context).put(accountId, KIND_GRANT, record.toString());
        } catch (Exception e) {
            // Losing this flag costs one wasted token request the next time
            // something touches the account — that request fails the same way
            // and tries to record it again. It must not be allowed to turn a
            // failed send into a *crashed* send, which is what propagating from
            // inside a transport's error path would do.
            android.util.Log.e("OAuthTokens", "markRejected: could not record the refusal", e);
        }
        invalidate(accountId);
    }

    /** Drop everything held for an account — the refresh token, the record, the cached token. */
    static void forget(Context context, String accountId) {
        SecretStore secrets = new SecretStore(context);
        secrets.remove(accountId, KIND_REFRESH);
        secrets.remove(accountId, KIND_GRANT);
        invalidate(accountId);
    }

    // -----------------------------------------------------------------------
    // Access tokens, in memory only
    // -----------------------------------------------------------------------

    private static final class Cached {
        final String accessToken;
        /** Absolute epoch ms as the provider stated it; the skew is applied on read. */
        final long expiresAt;

        Cached(String accessToken, long expiresAt) {
            this.accessToken = accessToken;
            this.expiresAt = expiresAt;
        }
    }

    private static final Map<String, Cached> CACHE = new HashMap<>();

    /**
     * One lock per account, so a burst of work against one mailbox does not
     * fire a token request per item.
     *
     * A phone can easily have the inbox worker and a scheduled send wake within
     * the same second. Without this both would find an expired token and both
     * would race to replace it — spending the provider's rate limit and, on a
     * vendor that rotates refresh tokens, invalidating each other's brand new
     * one. Locks are per account rather than global because a stalled token
     * request for one mailbox has no business blocking another's.
     */
    private static final Map<String, Object> LOCKS = new HashMap<>();

    private static Object lockFor(String accountId) {
        synchronized (LOCKS) {
            Object lock = LOCKS.get(accountId);
            if (lock == null) {
                lock = new Object();
                LOCKS.put(accountId, lock);
            }
            return lock;
        }
    }

    /** Forget an account's cached token — after a re-consent, a disconnect, or a refused AUTH. */
    static void invalidate(String accountId) {
        synchronized (CACHE) {
            CACHE.remove(accountId);
        }
    }

    /**
     * A usable bearer token for this account, minted from the stored refresh
     * token when the cached one is gone or nearly gone.
     *
     * Returns {@code null} — rather than throwing — for every "this is not an
     * OAuth2 account" case: no stored refresh token, no grant record, no client
     * id. Both transports call this unconditionally, exactly as `imap.ts` does,
     * and an account that was never connected must fall through to the same "no
     * credential" path a password account takes rather than blow up with a
     * stack trace about OAuth.
     *
     * It *does* throw when there is a grant and it could not be turned into a
     * token. That is a real failure with a real fix, and swallowing it would
     * produce an SMTP AUTH with an empty credential and a server error about
     * the password.
     */
    static String accessToken(Context context, String accountId) throws Exception {
        if (accountId == null || accountId.isEmpty()) return null;

        synchronized (CACHE) {
            Cached cached = CACHE.get(accountId);
            if (cached != null && cached.expiresAt - System.currentTimeMillis() > EXPIRY_SKEW_MS) {
                return cached.accessToken;
            }
        }

        synchronized (lockFor(accountId)) {
            // Re-checked inside the lock: whoever held it before us has very
            // likely just put a fresh token in the cache, and refreshing again
            // would retire the refresh token they just stored.
            synchronized (CACHE) {
                Cached cached = CACHE.get(accountId);
                if (cached != null && cached.expiresAt - System.currentTimeMillis() > EXPIRY_SKEW_MS) {
                    return cached.accessToken;
                }
            }

            Grant grant = grant(context, accountId);
            String refreshToken = new SecretStore(context).get(accountId, KIND_REFRESH);
            if (grant == null || refreshToken == null || refreshToken.isEmpty()) return null;
            if (grant.clientId.isEmpty() || grant.tokenUrl.isEmpty()) return null;

            Map<String, String> form = new LinkedHashMap<>();
            form.put("client_id", grant.clientId);
            form.put("grant_type", "refresh_token");
            form.put("refresh_token", refreshToken);
            // `scope` is deliberately not repeated. Both vendors return the
            // originally granted scopes, and re-sending a list that has drifted
            // since the grant was made is how a refresh turns into
            // `invalid_scope` on an account that worked yesterday.

            try {
                TokenSet tokens = post(grant.tokenUrl, form);
                store(context, accountId, grant.providerId, grant.clientId, grant.tokenUrl,
                        tokens, addressFromIdToken(tokens.idToken));
                return tokens.accessToken;
            } catch (TokenEndpointException e) {
                if (isInvalidGrant(e.code)) {
                    markRejected(context, accountId);
                    throw new NeedsConsentException();
                }
                throw e;
            }
        }
    }

    /**
     * True when the provider said the refresh token is dead rather than that it
     * is busy. Mirrors `isInvalidGrant` in `src/core/oauth.ts`, including its
     * slightly generous list: `invalid_request` and `unauthorized_client` are
     * both answers a revoked or re-registered client gives, and treating either
     * as "retry later" would leave an account failing silently forever.
     */
    private static boolean isInvalidGrant(String code) {
        if (code == null) return false;
        String c = code.toLowerCase(java.util.Locale.ROOT);
        return "invalid_grant".equals(c)
                || "invalid_request".equals(c)
                || "unauthorized_client".equals(c);
    }

    // -----------------------------------------------------------------------
    // The token endpoint
    // -----------------------------------------------------------------------

    /** What a token endpoint said, once it has been read. */
    static final class TokenSet {
        final String accessToken;
        /** Present on the first exchange, and on every refresh for vendors that rotate. */
        final String refreshToken;
        /** Absolute epoch ms, already resolved from the relative `expires_in`. */
        final long expiresAt;
        /** Read locally and only to name the mailbox — see {@link #addressFromIdToken}. */
        final String idToken;

        TokenSet(String accessToken, String refreshToken, long expiresAt, String idToken) {
            this.accessToken = accessToken;
            this.refreshToken = refreshToken;
            this.expiresAt = expiresAt;
            this.idToken = idToken;
        }
    }

    /**
     * POST a form to a token endpoint and read the answer.
     *
     * Deliberately here and not in the WebView. `index.html` ships
     * `connect-src 'self'`, so the page could not reach a token endpoint even
     * if it wanted to — but the real reason is the one `bridge-android.ts`
     * gives: routing this through JavaScript would put the *refresh token*
     * through the WebView, which is exactly what sealing SMTP passwords in
     * native code exists to avoid.
     *
     * No `client_secret` is ever sent. A native app is a public client under
     * RFC 8252; there is nowhere in an APK to hide a secret, and sending an
     * empty one is worse than sending none — Google reads it as a malformed
     * confidential-client request and answers `invalid_client`.
     */
    static TokenSet post(String tokenUrl, Map<String, String> form) throws Exception {
        URL url = new URL(tokenUrl);
        if (!"https".equals(url.getProtocol())) {
            // The caller passes this in from the provider table, so a plaintext
            // endpoint would be a bug rather than an attack — but a refresh
            // token is going into this request body, and there is no version of
            // sending one over cleartext that is worth being lenient about.
            throw new SecurityException("Refusing to send a token request over " + url.getProtocol());
        }

        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(TOKEN_TIMEOUT_MS);
            conn.setReadTimeout(TOKEN_TIMEOUT_MS);
            // A redirect on a token POST would re-send the body — which holds
            // the refresh token, or the authorization code and its verifier —
            // to whatever host the Location header named. Neither vendor
            // redirects here; following one has no upside at all.
            conn.setInstanceFollowRedirects(false);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
            conn.setRequestProperty("Accept", "application/json");

            byte[] body = encodeForm(form).getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(body.length);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(body);
            }

            int status = conn.getResponseCode();
            // The body is read whether the status was 2xx or not, and that is
            // the whole point: both vendors return `{"error":"invalid_grant"}`
            // with a 400, so reading the status first would throw away the one
            // field that decides whether re-consent is needed.
            InputStream in = status >= 200 && status < 300
                    ? conn.getInputStream()
                    : conn.getErrorStream();
            String text = in == null ? "" : readAll(in);
            return parse(text, status);
        } finally {
            conn.disconnect();
        }
    }

    private static TokenSet parse(String text, int status) throws Exception {
        JSONObject body;
        try {
            body = new JSONObject(text);
        } catch (Exception e) {
            // The body is not echoed. It is not JSON, so it is most likely a
            // captive-portal login page or a proxy error, and pasting an
            // arbitrary HTML document into a dialog helps nobody.
            throw new IllegalStateException("The sign-in server answered " + status
                    + " with a reply Aevistle could not read");
        }

        String error = body.optString("error", "");
        if (!error.isEmpty()) {
            String description = body.optString("error_description", "");
            throw new TokenEndpointException(error, description.isEmpty() ? error : description);
        }

        String accessToken = body.optString("access_token", "");
        if (accessToken.isEmpty()) {
            throw new IllegalStateException("The sign-in server did not return an access token");
        }

        // `expires_in` is optional in RFC 6749 and both vendors send it. An
        // hour is what both use and the right guess when it is missing: too
        // short costs one extra refresh, too long costs a failed send.
        long expiresIn = body.optLong("expires_in", 3600L);
        String refreshToken = body.optString("refresh_token", "");
        String idToken = body.optString("id_token", "");

        return new TokenSet(
                accessToken,
                refreshToken.isEmpty() ? null : refreshToken,
                System.currentTimeMillis() + expiresIn * 1000L,
                idToken.isEmpty() ? null : idToken);
    }

    private static String encodeForm(Map<String, String> form) throws Exception {
        StringBuilder out = new StringBuilder();
        for (Map.Entry<String, String> entry : form.entrySet()) {
            if (out.length() > 0) out.append('&');
            out.append(URLEncoder.encode(entry.getKey(), "UTF-8"));
            out.append('=');
            out.append(URLEncoder.encode(entry.getValue(), "UTF-8"));
        }
        return out.toString();
    }

    private static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        long total = 0;
        int read;
        while ((read = in.read(buffer)) != -1) {
            total += read;
            if (total > MAX_RESPONSE_BYTES) {
                throw new IllegalStateException("The sign-in server's reply was implausibly large");
            }
            out.write(buffer, 0, read);
        }
        return out.toString("UTF-8");
    }

    // -----------------------------------------------------------------------
    // Naming the mailbox
    // -----------------------------------------------------------------------

    /**
     * The mailbox address out of an OpenID Connect id token.
     *
     * **This is not treated as a security token and it is not verified.** No
     * signature check, no issuer check, no audience check — and none is needed
     * for what it is used for, which is putting "connected as name@example.com"
     * on a label. The token arrived over TLS as the direct response to a request
     * this process made to the provider's own token endpoint; there is no third
     * party in that exchange to have forged it. If it is ever used for anything
     * that grants access, that stops being true and this comment stops being
     * an explanation.
     *
     * Returns null rather than throwing on anything unexpected. A label is not
     * worth failing a completed sign-in over.
     *
     * There is no userinfo-endpoint fallback here, and that is a deliberate
     * omission rather than a missing branch. A userinfo URL is part of the
     * provider table, which lives in `src/core/oauth.ts` so that the phone and
     * the desktop cannot drift into disagreeing about a vendor — and it is not
     * among the fields `oauthConsent` is handed. The only ways to get one from
     * inside Java would be to hard-code the two vendors' endpoints here, which
     * is the duplication that table exists to prevent, or to guess a discovery
     * document from the token endpoint's URL, which is a guess. Both presets
     * that offer OAuth2 request `openid` and `email`, so an id_token is present
     * in practice; when it is not, no address is returned and the dialog falls
     * back to the address the user typed, which is what it had before.
     */
    static String addressFromIdToken(String idToken) {
        if (idToken == null) return null;
        String[] segments = idToken.split("\\.");
        if (segments.length < 2) return null;
        try {
            byte[] json = Base64.decode(segments[1],
                    Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
            JSONObject claims = new JSONObject(new String(json, StandardCharsets.UTF_8));
            // Google puts it in `email`. Microsoft puts a personal account's
            // address in `email` too, but a work account's in
            // `preferred_username` — and only sometimes in both, which is why
            // the order matters rather than the choice.
            for (String claim : new String[]{"email", "preferred_username", "upn"}) {
                String value = claims.optString(claim, "");
                if (value.contains("@")) return value;
            }
        } catch (Exception e) {
            // An unparseable label is not a failure worth reporting, and the
            // one thing that must not happen here is logging the exception:
            // some JSON parsers put the offending input in the message, and the
            // offending input is half of a token.
            return null;
        }
        return null;
    }
}
