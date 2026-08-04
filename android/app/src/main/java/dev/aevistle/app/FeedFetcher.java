package dev.aevistle.app;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.regex.Pattern;

/**
 * The trusted side of the two allow-listed public feeds, for Android.
 *
 * The WebView cannot make these requests. `index.html` ships
 * `connect-src 'self'` and Capacitor serves the bundle from `https://localhost`,
 * so a `fetch()` to api.github.com or raw.githubusercontent.com is refused by
 * the document's own policy before it reaches the network. That is why the
 * in-app update check has never worked in a shipped Android build: the desktop
 * copy of the same shared code happens to run in the main process, where no CSP
 * applies, and the Android copy did not.
 *
 * The allow-list is duplicated from `src/core/feeds.ts` on purpose. The
 * JavaScript check is a courtesy; this one owns the socket, so this one is the
 * check that counts. `scripts/check-feed-fetch.mjs` asserts the two lists still
 * agree, because two copies of a rule is exactly the shape that drifts.
 *
 * Unlike {@link RemoteImageFetcher} there is no private-address guard here, and
 * that is deliberate rather than an omission: that class defends against hosts
 * chosen by whoever sent you a message. Here the host and the path are both
 * fixed below, so there is no attacker-chosen destination to defend against.
 */
final class FeedFetcher {

    private static final int TIMEOUT_MS = 10000;
    private static final long MAX_BYTES = 1000000L;

    /** holiday-cn republishes one State Council notice per year as `<year>.json`. */
    private static final Pattern HOLIDAY_PATH =
            Pattern.compile("^/NateScarlet/holiday-cn/master/\\d{4}\\.json$");

    private static final String RELEASES_PATH = "/repos/Aevorine/Aevistle/releases/latest";

    private FeedFetcher() {
    }

    /** Host and path, not host alone. See the class comment. */
    static boolean isAllowed(URL url) {
        if (!"https".equals(url.getProtocol())) return false;
        if (url.getUserInfo() != null) return false;
        int port = url.getPort();
        if (port != -1 && port != 443) return false;
        if (url.getQuery() != null || url.getRef() != null) return false;

        String host = url.getHost();
        String path = url.getPath();
        if ("raw.githubusercontent.com".equals(host)) {
            return HOLIDAY_PATH.matcher(path).matches();
        }
        if ("api.github.com".equals(host)) {
            return RELEASES_PATH.equals(path);
        }
        return false;
    }

    /**
     * The result of one GET. A non-2xx is returned rather than thrown: a 404
     * from the holiday feed means "that year has not been published yet", which
     * is a true answer and only the caller knows it.
     */
    static final class Result {
        final int status;
        final String body;

        Result(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    static Result fetch(String rawUrl) throws Exception {
        URL parsed = new URL(rawUrl);
        if (!isAllowed(parsed)) {
            throw new SecurityException("Refusing to fetch " + rawUrl + " — not an allow-listed feed");
        }
        return get(parsed, 0);
    }

    /**
     * One hop of redirect is followed, and the destination is re-checked
     * against the same allow-list. GitHub does not currently redirect either
     * URL; following one costs ten lines and removes a way for this feature to
     * break silently later.
     */
    private static Result get(URL url, int depth) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(TIMEOUT_MS);
        conn.setReadTimeout(TIMEOUT_MS);
        conn.setInstanceFollowRedirects(false);
        conn.setRequestProperty("Accept", "application/json");
        conn.setRequestProperty("User-Agent", "Aevistle");
        conn.setRequestProperty("X-GitHub-Api-Version", "2022-11-28");

        try {
            int status = conn.getResponseCode();

            if (status == 301 || status == 302 || status == 307 || status == 308) {
                String location = conn.getHeaderField("Location");
                if (depth >= 1 || location == null) {
                    throw new IllegalStateException("Too many redirects");
                }
                URL next = new URL(url, location);
                if (!isAllowed(next)) {
                    throw new SecurityException("Redirected off the allow-list, to " + next);
                }
                return get(next, depth + 1);
            }

            long declared = conn.getContentLengthLong();
            if (declared > MAX_BYTES) {
                throw new IllegalStateException("The feed is larger than this app will read");
            }

            // A non-2xx puts the body on the error stream, and that body is
            // still worth reading — GitHub explains rate limiting there.
            InputStream in = status >= 200 && status < 400
                    ? conn.getInputStream()
                    : conn.getErrorStream();
            String body = in == null ? "" : readAll(in);
            return new Result(status, body);
        } finally {
            conn.disconnect();
        }
    }

    private static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        long total = 0;
        int read;
        while ((read = in.read(buffer)) != -1) {
            total += read;
            if (total > MAX_BYTES) {
                throw new IllegalStateException("The feed is larger than this app will read");
            }
            out.write(buffer, 0, read);
        }
        return out.toString("UTF-8");
    }
}
