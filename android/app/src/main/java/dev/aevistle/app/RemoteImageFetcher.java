package dev.aevistle.app;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.URL;

/**
 * Fetches a remote image referenced from a received message body, so the
 * WebView never makes that request itself — see `electron/remoteImage.ts` for
 * why (a tracking pixel loaded from inside the sandboxed body would still
 * leak the reader's IP and confirm the message was opened).
 *
 * Same SSRF intent as the desktop version — resolve the host, reject a
 * private/loopback/link-local address before connecting — with one honest gap
 * against it: Node's `http(s).request` takes a `lookup` hook that makes the
 * resolution used for the *check* the same one used for the *connection*,
 * closing the DNS-rebinding race entirely. `java.net.HttpURLConnection` has no
 * equivalent hook, so this resolves and checks first, then lets the
 * connection re-resolve the hostname itself a moment later — a small window
 * for a rebinding attacker to answer differently. Pinning the connection to
 * the literal IP address instead (closing that window) was tried and
 * rejected: it breaks TLS SNI for any image host behind SNI-based virtual
 * hosting, which is most real CDNs, trading a narrow attack window for
 * reliably broken HTTPS on a large fraction of real senders.
 */
final class RemoteImageFetcher {

    private static final int TIMEOUT_MS = 8000;
    private static final long MAX_BYTES = 5L * 1024 * 1024;
    /**
     * How many redirect hops {@link #fetch} will follow before giving up.
     *
     * Real senders route open-tracking and CDN-hosted images through one or
     * two redirects routinely (Mailchimp, SendGrid, Substack, plain
     * http-&gt;https upgrades); refusing every 3xx outright made "the image
     * failed to load" the common case rather than the rare one. Mirrors
     * {@code electron/remoteImage.ts}'s MAX_REDIRECTS.
     */
    private static final int MAX_REDIRECTS = 3;

    private RemoteImageFetcher() {
    }

    /**
     * Throws unless {@code parsed} is a scheme and address this proxy is
     * willing to connect to — the same check every hop needs, not just the
     * first. A redirect target is exactly as attacker-influenced as the
     * original URL (more so: the sender's server chose it), so skipping this
     * on hop 2 would make following redirects at all a private-network
     * bypass.
     */
    private static void assertFetchable(URL parsed) throws Exception {
        String protocol = parsed.getProtocol();
        if (!"http".equals(protocol) && !"https".equals(protocol)) {
            throw new IllegalArgumentException("Unsupported URL scheme");
        }
        for (InetAddress addr : InetAddress.getAllByName(parsed.getHost())) {
            if (isDisallowed(addr)) {
                throw new SecurityException(
                        "Refusing to connect to a private address (" + addr.getHostAddress() + ")");
            }
        }
    }

    /** Raw bytes plus the type the server claimed for them. */
    static final class Fetched {
        final byte[] bytes;
        final String mime;

        Fetched(byte[] bytes, String mime) {
            this.bytes = bytes;
            this.mime = mime;
        }
    }

    /**
     * Get the bytes. Deciding whether they are an image — and turning them into
     * bytes this app wrote rather than bytes a stranger wrote — is
     * {@link ImageProxy}'s job, not this one's. This function deliberately no
     * longer builds a data URI: that used to mean a stranger's bytes went from
     * the socket into already-sanitized HTML with only a Content-Type check
     * between them.
     */
    static Fetched fetch(String url) throws Exception {
        URL parsed = new URL(url);
        assertFetchable(parsed);

        for (int redirects = 0; ; redirects++) {
            HttpURLConnection conn = (HttpURLConnection) parsed.openConnection();
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            // Followed manually below, one validated hop at a time, rather
            // than left to HttpURLConnection: a redirect target needs the
            // same private-address check as the original URL, and the
            // built-in follower has no hook to run it before connecting.
            conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("User-Agent", "Aevistle");

            try {
                int status = conn.getResponseCode();
                if (status >= 300 && status < 400) {
                    String location = conn.getHeaderField("Location");
                    if (location == null) throw new IllegalStateException("HTTP " + status);
                    if (redirects >= MAX_REDIRECTS) throw new IllegalStateException("Too many redirects");
                    // Resolves a relative Location against the URL that sent
                    // it, same as a browser would; an absolute one (the
                    // common case) ignores the base.
                    URL target = new URL(parsed, location);
                    assertFetchable(target);
                    parsed = target;
                    continue;
                }
                if (status < 200 || status >= 300) throw new IllegalStateException("HTTP " + status);

                String contentType = conn.getContentType();
                if (contentType == null || !contentType.startsWith("image/")) {
                    throw new IllegalStateException("Not an image");
                }

                long declared = conn.getContentLengthLong();
                if (declared > MAX_BYTES) throw new IllegalStateException("Image too large");

                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                try (InputStream in = conn.getInputStream()) {
                    byte[] chunk = new byte[16 * 1024];
                    int read;
                    long total = 0;
                    while ((read = in.read(chunk)) != -1) {
                        total += read;
                        if (total > MAX_BYTES) throw new IllegalStateException("Image too large");
                        buffer.write(chunk, 0, read);
                    }
                }

                String mime = contentType.split(";")[0].trim();
                return new Fetched(buffer.toByteArray(), mime);
            } finally {
                conn.disconnect();
            }
        }
    }

    private static boolean isDisallowed(InetAddress addr) {
        if (addr.isLoopbackAddress() || addr.isLinkLocalAddress() || addr.isSiteLocalAddress()
                || addr.isAnyLocalAddress() || addr.isMulticastAddress()) {
            return true;
        }
        if (addr instanceof Inet6Address) {
            // fc00::/7 — Unique Local Addresses, IPv6's RFC1918 analogue.
            // isSiteLocalAddress() above only recognises the deprecated
            // fec0::/10 range, not this one, so it needs an explicit check.
            int first = addr.getAddress()[0] & 0xff;
            if ((first & 0xfe) == 0xfc) return true;
        }
        return false;
    }
}
