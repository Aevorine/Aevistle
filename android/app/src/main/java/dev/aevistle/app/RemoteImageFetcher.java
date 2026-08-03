package dev.aevistle.app;

import android.util.Base64;

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

    private RemoteImageFetcher() {
    }

    static String fetch(String url) throws Exception {
        URL parsed = new URL(url);
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

        HttpURLConnection conn = (HttpURLConnection) parsed.openConnection();
        conn.setConnectTimeout(TIMEOUT_MS);
        conn.setReadTimeout(TIMEOUT_MS);
        // A redirect target needs the same private-address check as the
        // original URL; not following one keeps that from being a bypass.
        conn.setInstanceFollowRedirects(false);
        conn.setRequestProperty("User-Agent", "Aevistle");

        try {
            int status = conn.getResponseCode();
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
            String base64 = Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP);
            return "data:" + mime + ";base64," + base64;
        } finally {
            conn.disconnect();
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
