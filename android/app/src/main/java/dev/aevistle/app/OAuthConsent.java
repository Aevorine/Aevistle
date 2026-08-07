package dev.aevistle.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;

import androidx.browser.customtabs.CustomTabsIntent;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One OAuth2 consent, from the button to the stored grant.
 *
 * The Android counterpart of `runConsent` in `electron/oauth.ts`, and it has to
 * produce a functionally identical result — same PKCE, same `state` check, same
 * exchange body, same storage rule — because the two platforms are talking to
 * the same providers about the same mailboxes. What differs is only how the
 * redirect gets home, and that difference is forced by the platform rather than
 * chosen: the desktop binds a loopback port and waits on it, which a phone
 * cannot do while the user is away in a browser and this process is a
 * background candidate for the low-memory killer. Android takes the other
 * option RFC 8252 §7.1 allows — a private-use URI scheme, claimed by the
 * intent-filter in `AndroidManifest.xml` and spelled out once in
 * `ANDROID_REDIRECT_URI`.
 *
 * ---------------------------------------------------------------------------
 * Why a Custom Tab and not a WebView
 * ---------------------------------------------------------------------------
 * A `WebView` would be easier: it is in-process, it has an `onPageStarted` this
 * class could watch for the redirect, and it would need no manifest entry at
 * all. It is also exactly what RFC 8252 §8.12 forbids, and the reasons are the
 * user's rather than the protocol's. In a WebView the host application can read
 * every keystroke and every cookie in the sign-in form, so the user has no way
 * to tell a real consent page from an app that drew one — and neither has their
 * password manager, which cannot fill a field it cannot see, nor their
 * passkey, nor whatever second factor their provider offers. A Custom Tab runs
 * in the browser's own process with the browser's own cookie jar, shows the
 * address bar the whole time, and this app cannot see inside it. Google and
 * Microsoft both refuse embedded-webview user agents outright for exactly this
 * reason, so the "easier" route does not even work.
 *
 * ---------------------------------------------------------------------------
 * What crosses the bridge
 * ---------------------------------------------------------------------------
 * An address and a boolean. The verifier, the code, the access token and the
 * refresh token all stay on this side; the WebView is never told any of them
 * and has no method to ask. See {@link OAuthTokens} for where the refresh token
 * ends up and why.
 */
final class OAuthConsent {

    /**
     * How long a started consent stays adoptable.
     *
     * A redirect arriving hours later, after the user has been round three
     * other apps, is not a sign-in this app should silently complete against
     * whatever account was selected when it began. Matches the desktop's
     * five-minute listener timeout.
     */
    static final long CONSENT_TIMEOUT_MS = 5 * 60_000L;

    /**
     * What to say when the provider signs the user in and issues nothing to
     * renew with.
     *
     * Refusing here rather than storing a token that expires in an hour is the
     * right trade even though it looks harsher: the account would work all
     * afternoon and then stop, and the failure would land on whatever schedule
     * fired next — which is the 03:00 silent failure this whole feature exists
     * to remove. Google is the vendor this happens to, and it is why the
     * provider table sends `prompt=consent`.
     */
    static final String NO_REFRESH_TOKEN_MESSAGE =
            "The provider signed you in but did not issue a long-lived token, so Aevistle could "
                    + "not keep the connection. Remove Aevistle from your account's connected apps "
                    + "and try again.";

    private OAuthConsent() {
    }

    // -----------------------------------------------------------------------
    // The flow in progress
    // -----------------------------------------------------------------------

    /**
     * Everything one consent needs to remember while the user is in the
     * browser.
     *
     * Held in memory on the plugin and nowhere else. Persisting it would mean
     * writing a `code_verifier` to disk, and the verifier is the only thing
     * standing between an intercepted authorization code and a working grant —
     * the entire value of PKCE for a public client is that it never leaves the
     * process that generated it. The cost of not persisting it is that a
     * consent does not survive the process being killed while the browser is in
     * front; the WebView's promise does not survive that either, so the two
     * fail together rather than leaving a dialog spinning against a flow that
     * no longer exists.
     */
    static final class Pending {
        /** The saved {@link com.getcapacitor.PluginCall} this flow will settle. */
        final String callbackId;
        final String accountId;
        final String providerId;
        final String clientId;
        final String tokenUrl;
        final String redirectUri;
        final String scope;
        final String verifier;
        final String state;
        final long startedAt;

        private Pending(String callbackId, String accountId, String providerId, String clientId,
                        String tokenUrl, String redirectUri, String scope,
                        String verifier, String state) {
            this.callbackId = callbackId;
            this.accountId = accountId;
            this.providerId = providerId;
            this.clientId = clientId;
            this.tokenUrl = tokenUrl;
            this.redirectUri = redirectUri;
            this.scope = scope;
            this.verifier = verifier;
            this.state = state;
            this.startedAt = System.currentTimeMillis();
        }

        boolean expired() {
            return System.currentTimeMillis() - startedAt > CONSENT_TIMEOUT_MS;
        }
    }

    /**
     * Mint a PKCE pair and a `state`, and remember them against this call.
     *
     * S256 only. RFC 7636 still defines `plain`, and it is worth nothing here —
     * it sends the verifier through the browser, which is the one thing the
     * challenge exists to avoid — so it is not offered even as a fallback for a
     * provider that dislikes S256. Both vendors require S256 anyway.
     */
    static Pending begin(String callbackId, String accountId, String providerId, String clientId,
                         String tokenUrl, String redirectUri, String scope) throws Exception {
        return new Pending(callbackId, accountId, providerId, clientId, tokenUrl, redirectUri,
                scope, randomToken(), randomToken());
    }

    /**
     * 32 random bytes as base64url, which is 43 characters.
     *
     * Sized in bytes rather than characters on purpose: RFC 7636 wants a
     * verifier of 43 to 128 characters from the unreserved set, and 256 bits
     * through base64url comes out at exactly 43 characters of `[A-Za-z0-9-_]`.
     * The length rule is satisfied by construction instead of by counting, and
     * the charset rule by the alphabet rather than by filtering.
     *
     * {@link SecureRandom} with no seeding. Seeding it from anything — the
     * clock, the account id, a hash of either — can only reduce the entropy the
     * platform's CSPRNG already provides, and this value is the whole security
     * of the exchange.
     */
    private static String randomToken() {
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        return base64Url(bytes);
    }

    private static String base64Url(byte[] bytes) {
        return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    private static String challengeFor(String verifier) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        return base64Url(digest.digest(verifier.getBytes(StandardCharsets.US_ASCII)));
    }

    // -----------------------------------------------------------------------
    // The authorize request
    // -----------------------------------------------------------------------

    /**
     * The consent page URL, from the endpoint and parameters the call supplied.
     *
     * Nothing about a vendor is decided here: the authorize endpoint, the
     * scopes and the vendor-specific extras (`access_type`, `prompt`) all
     * arrive from `OAUTH_PROVIDERS` in `src/core/oauth.ts`. Re-deriving any of
     * them in Java is the drift that produces a mailbox syncing on the desktop
     * and 401-ing on the phone, with nothing on either screen to connect the
     * two.
     *
     * `login_hint` is a convenience and nothing more — it pre-fills the account
     * picker with the address already typed into the dialog. The user is free
     * to sign in as somebody else, which is exactly why the completed flow reads
     * the address back out of the token response rather than assuming this one
     * was honoured.
     */
    static String authorizeUrl(Pending pending, String authorizeEndpoint,
                               JSONObject extraAuthParams, String loginHint) throws Exception {
        Uri.Builder url = Uri.parse(authorizeEndpoint).buildUpon();
        url.appendQueryParameter("client_id", pending.clientId);
        url.appendQueryParameter("response_type", "code");
        url.appendQueryParameter("redirect_uri", pending.redirectUri);
        url.appendQueryParameter("scope", pending.scope);
        url.appendQueryParameter("code_challenge", challengeFor(pending.verifier));
        url.appendQueryParameter("code_challenge_method", "S256");
        url.appendQueryParameter("state", pending.state);
        if (loginHint != null && !loginHint.isEmpty()) {
            url.appendQueryParameter("login_hint", loginHint);
        }
        if (extraAuthParams != null) {
            for (Iterator<String> keys = extraAuthParams.keys(); keys.hasNext(); ) {
                String key = keys.next();
                url.appendQueryParameter(key, extraAuthParams.optString(key, ""));
            }
        }
        return url.build().toString();
    }

    /**
     * Hand the consent page to the browser.
     *
     * A Custom Tab when one is available, and an ordinary `ACTION_VIEW` when
     * not. The two are the same intent — `CustomTabsIntent` is an
     * `ACTION_VIEW` carrying extras — so a device whose default browser has no
     * Custom Tabs service simply opens a normal tab and ignores them, which is
     * a fallback that needs no branch. The explicit branch below is for the
     * rarer case where launching throws because the extras named a package that
     * has since gone away; a device with no browser at all reaches the second
     * throw, and there is nothing further to try.
     */
    static void launch(Activity activity, String url) throws Exception {
        Uri uri = Uri.parse(url);
        try {
            CustomTabsIntent tab = new CustomTabsIntent.Builder()
                    // The page title next to the address is worth showing: it
                    // is one more thing distinguishing the real consent page
                    // from something drawn to look like it.
                    .setShowTitle(true)
                    .build();
            tab.launchUrl(activity, uri);
        } catch (ActivityNotFoundException e) {
            try {
                activity.startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException noBrowser) {
                throw new IllegalStateException(
                        "This device has no browser to open the sign-in page in.");
            }
        }
    }

    // -----------------------------------------------------------------------
    // The redirect back
    // -----------------------------------------------------------------------

    /** What a redirect turned out to be. Exactly one field is ever set. */
    static final class Redirect {
        /** The authorization code, when the user consented. */
        final String code;
        /** A sentence, when the provider said no. */
        final String error;
        /** True when the provider's `error` was the user declining rather than a fault. */
        final boolean cancelled;

        private Redirect(String code, String error, boolean cancelled) {
            this.code = code;
            this.error = error;
            this.cancelled = cancelled;
        }
    }

    /**
     * Read a redirect, refusing anything whose `state` is not the one this flow
     * sent.
     *
     * The `state` check comes first, before the code is so much as looked at,
     * and it is the CSRF defence rather than a sanity check. A private-use URI
     * scheme is claimed by manifest, and nothing stops another app on the device
     * from claiming the same one and starting this activity with a URL of its
     * choosing. Without this comparison such an app could hand the flow an
     * authorization code for *its* account, and Aevistle would exchange it,
     * store the resulting refresh token under the user's account id, and
     * quietly start delivering the user's mail into a mailbox somebody else
     * controls.
     *
     * Compared in constant time. The window is small and a remote attacker has
     * no clock good enough to walk it — but the comparison is four lines either
     * way, and "the timing leak is probably not exploitable" is not a sentence
     * worth having to defend in a file that decides who a mailbox belongs to.
     *
     * Returns null when there is no match, and the caller must treat that as
     * "reject this redirect", never as "wait for a better one".
     */
    static Redirect read(Pending pending, Uri uri) {
        String state = uri.getQueryParameter("state");
        if (state == null || !constantTimeEquals(state, pending.state)) return null;

        String error = uri.getQueryParameter("error");
        if (error != null && !error.isEmpty()) {
            String description = uri.getQueryParameter("error_description");
            boolean cancelled = "access_denied".equals(error)
                    || "user_cancelled_authorize".equals(error);
            return new Redirect(null, description == null || description.isEmpty()
                    ? "The provider refused the sign-in (" + error + ")."
                    : description, cancelled);
        }

        String code = uri.getQueryParameter("code");
        if (code == null || code.isEmpty()) {
            return new Redirect(null,
                    "The provider redirected back without an authorization code.", false);
        }
        return new Redirect(code, null, false);
    }

    private static boolean constantTimeEquals(String a, String b) {
        byte[] left = a.getBytes(StandardCharsets.UTF_8);
        byte[] right = b.getBytes(StandardCharsets.UTF_8);
        // MessageDigest.isEqual is the platform's own constant-time comparison
        // and has been length-safe since API 19 — it is not a digest-specific
        // helper despite the class it lives on.
        return MessageDigest.isEqual(left, right);
    }

    // -----------------------------------------------------------------------
    // The exchange
    // -----------------------------------------------------------------------

    /**
     * Turn the authorization code into a stored grant, and answer with the
     * mailbox it turned out to be for.
     *
     * The verifier goes up with the code and no client secret goes with either;
     * that pairing is what makes a public client safe, because an intercepted
     * code is worth nothing without the verifier that never left this process.
     *
     * Returns the address, or null when the provider did not name one — see
     * {@link OAuthTokens#addressFromIdToken}. A missing label is not a reason to
     * fail a sign-in that otherwise succeeded.
     */
    static String exchange(Context context, Pending pending, String code) throws Exception {
        Map<String, String> form = new LinkedHashMap<>();
        form.put("client_id", pending.clientId);
        form.put("grant_type", "authorization_code");
        form.put("code", code);
        form.put("code_verifier", pending.verifier);
        form.put("redirect_uri", pending.redirectUri);

        OAuthTokens.TokenSet tokens = OAuthTokens.post(pending.tokenUrl, form);
        if (tokens.refreshToken == null) {
            throw new IllegalStateException(NO_REFRESH_TOKEN_MESSAGE);
        }

        // Only asked for when the grant covers it. Reading a claim out of a
        // token the provider volunteered is free; the point of the check is
        // that a build whose scopes no longer include `openid` should return no
        // address rather than an empty string that reads as one.
        String address = pending.scope.contains("openid") || pending.scope.contains("email")
                ? OAuthTokens.addressFromIdToken(tokens.idToken)
                : null;

        OAuthTokens.adopt(context, pending.accountId, pending.providerId, pending.clientId,
                pending.tokenUrl, tokens, address);
        return address;
    }
}
