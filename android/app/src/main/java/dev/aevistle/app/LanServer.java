package dev.aevistle.app;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * A LAN listener for one path, and nothing more.
 *
 * The accepting side of pairing and of ongoing sync — the two halves that until
 * now only `electron/pairingServer.ts` and `electron/syncServer.ts` had, which
 * is why an Android device could join a pairing but never host one, and could
 * ask for a sync but never answer one.
 *
 * ## Genuinely dumb, on purpose
 *
 * The same posture both desktop servers document about themselves, taken
 * further because here it is load-bearing: this class does not decrypt
 * anything, does not verify a pairing token, does not read application state
 * and does not know what a `pairId` is. It reads one request, hands the body to
 * the WebView through {@link Relay}, and writes back whatever answer comes.
 * `core/pairingHostLocal.ts` and `core/syncLoop.ts` hold the keys and make every
 * decision, exactly as the renderer does on desktop.
 *
 * That split is not a convenience. Writing the handshake in Java would mean a
 * second, independent implementation of an ECDH key exchange whose two copies
 * have to agree forever, and the one that is wrong is the one nobody is looking
 * at. `scripts/check-pairing-crypto.mjs` guards one implementation; there is
 * no second.
 *
 * ## Raw sockets, not an HTTP library
 *
 * The same choice `relayPost` in `AevistleNativePlugin` makes on the client
 * side, for a related reason: Android ships no server-side HTTP stack outside
 * the deprecated Apache bundle, and the wire format needed here is one method,
 * one path, one content type. Roughly forty lines of parsing against a
 * dependency, a dependency's CVEs, and a dependency's opinions about
 * everything else it also serves.
 *
 * Cleartext, and no `network_security_config` carve-out needed: that policy
 * governs outbound HTTP stacks, and an inbound socket is not one. What crosses
 * it is sealed by `core/pairingCrypto.ts` before it is written — a public key,
 * or AES-GCM ciphertext. Never a secret in the clear.
 *
 * ## Who decides a session is over
 *
 * Not this class, and that is deliberate. Pairing genuinely is one connection
 * ever — a screenshotted QR code must have no socket left to reach — but "one
 * connection" and "one *accepted* connection" are different rules, and only the
 * second one is checkable from here. Closing on the first connection of any kind
 * would let a single stray packet from a network scanner end a pairing the user
 * is halfway through, which is exactly what `pairingServer.ts` refuses to do:
 * "a wrong token does not tear the session down — a stray probe should not be
 * able to deny service to the device actually holding the code." Whether a
 * request carried the right token is known only where the token is, which is
 * `core/pairingHostLocal.ts`, and that is the side that closes the socket.
 *
 * `deadlineMs` is the backstop for the one case the JS side cannot cover: the
 * WebView going away without stopping its listener. Zero means no deadline,
 * which is what the sync listener wants — it stays up for as long as this device
 * has an 'ongoing' pairing to answer for.
 */
final class LanServer {

    /** Hands a request body to the WebView and returns its answer, or null if nothing could answer. */
    interface Relay {
        /**
         * Blocks until the WebView replies or gives up.
         *
         * @param kind {@code "pair"} or {@code "sync"} — which listener this came from.
         * @param body the request body as text, unparsed.
         * @return the reply, or null when no answer arrived in time.
         */
        Reply dispatch(String kind, String body);
    }

    /** What {@link Relay#dispatch} hands back. Written to the socket verbatim. */
    static final class Reply {
        final int status;
        final String body;

        Reply(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    /**
     * A sync payload is a whole scoped state, sealed; a pairing body is two
     * keys. The desktop's sync ceiling is 512KB and its pairing ceiling 64KB —
     * this is the larger of the two, and the JS side applies its own.
     */
    private static final int MAX_BODY = 512 * 1024;

    /**
     * How long a connection may sit half-written before it is dropped.
     *
     * A peer on the same Wi-Fi finishes sending in milliseconds. This is not a
     * generous allowance for a slow network; it is a ceiling on how long an
     * opened-and-abandoned socket can hold an accept thread.
     */
    private static final int SOCKET_TIMEOUT_MS = 10_000;

    /**
     * How often the accept loop wakes to re-check {@link #deadlineMs}.
     *
     * Only applied when there is a deadline at all, so the sync listener still
     * sits in a plain blocking `accept()` for its whole life rather than spinning
     * once a second for weeks.
     */
    private static final int DEADLINE_POLL_MS = 2_000;

    private final String path;
    private final String kind;
    private final Relay relay;

    private ServerSocket socket;
    private Thread acceptThread;
    /** Epoch ms after which this listener closes itself; 0 for "no deadline". */
    private volatile long deadlineMs;

    LanServer(String path, String kind, Relay relay) {
        this.path = path;
        this.kind = kind;
        this.relay = relay;
    }

    /**
     * Bind, and start accepting.
     *
     * @param host the interface to bind — a real address, never the wildcard.
     *             The whole point is for another device to reach this, but
     *             binding 0.0.0.0 would also expose it on the cellular
     *             interface, which is reachable by the carrier's network and by
     *             nothing the user owns.
     * @param port a fixed port, or 0 to let the OS assign one.
     * @param liveForMs how long this listener may stay up without being told to
     *                  stop, or 0 for indefinitely. See the class header.
     * @return the port actually bound.
     */
    synchronized int start(String host, int port, long liveForMs) throws IOException {
        close();
        deadlineMs = liveForMs > 0 ? System.currentTimeMillis() + liveForMs : 0;
        ServerSocket server = new ServerSocket();
        // Deliberately not `setReuseAddress(true)`: a bind that fails because
        // something else holds the port is a thing the user needs told about
        // (`devices.syncPortInUse`), not a thing to paper over.
        server.bind(new InetSocketAddress(InetAddress.getByName(host), port), 4);
        if (deadlineMs > 0) server.setSoTimeout(DEADLINE_POLL_MS);
        this.socket = server;

        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                acceptLoop(server);
            }
        }, "aevistle-lan-" + kind);
        thread.setDaemon(true);
        this.acceptThread = thread;
        thread.start();

        return server.getLocalPort();
    }

    /** Safe to call whether or not anything is listening, and safe to call twice. */
    synchronized void close() {
        ServerSocket server = this.socket;
        this.socket = null;
        if (server != null) {
            try {
                server.close();
            } catch (IOException ignored) {
            }
        }
        // Not joined. `accept()` throws the moment the socket closes and the
        // thread is a daemon, so waiting on it here would only add a way for
        // `stopPairingHost` to block the bridge thread.
        this.acceptThread = null;
    }

    /**
     * Close, but only if the caller's socket is still the current one.
     *
     * The accept thread cannot use {@link #close()}: it may reach the decision to
     * shut down at the moment a new session is being started, and by the time it
     * takes the monitor `this.socket` is the *new* listener. A plain `close()`
     * there would tear down the pairing the user had just begun — which happened
     * to be reachable by starting one exactly as the previous one expired. There
     * is no flag that fixes this; the identity of the socket is the only thing
     * that distinguishes "my session" from "the next one".
     */
    private synchronized void closeIfCurrent(ServerSocket own) {
        if (this.socket != own) return;
        close();
    }

    synchronized boolean isListening() {
        ServerSocket server = this.socket;
        return server != null && !server.isClosed();
    }

    /**
     * `server.isClosed()` and not a shared `closing` flag: this loop belongs to
     * one specific socket, and its own socket being shut is the only signal that
     * means "you are done" without also being true for a listener started after
     * it.
     */
    private void acceptLoop(ServerSocket server) {
        while (!server.isClosed()) {
            if (expired()) {
                closeIfCurrent(server);
                return;
            }
            Socket client = null;
            try {
                client = server.accept();
                client.setSoTimeout(SOCKET_TIMEOUT_MS);
                serve(client);
            } catch (java.net.SocketTimeoutException e) {
                // Nothing arrived within the deadline poll. Round the loop to
                // re-check `expired()`, which is the only reason the timeout is
                // set at all.
                continue;
            } catch (IOException e) {
                // A closed socket is how `close()` stops this loop; anything
                // else is one bad connection, and the next one is unaffected —
                // in particular a probe that sends rubbish must not be able to
                // end a pairing the user is halfway through.
                if (server.isClosed()) return;
            } finally {
                if (client != null) {
                    try {
                        client.close();
                    } catch (IOException ignored) {
                    }
                }
            }
        }
    }

    private boolean expired() {
        long deadline = deadlineMs;
        return deadline > 0 && System.currentTimeMillis() > deadline;
    }

    private void serve(Socket client) throws IOException {
        BufferedInputStream in = new BufferedInputStream(client.getInputStream());
        OutputStream out = client.getOutputStream();

        String requestLine = readLine(in);
        String[] parts = requestLine.split(" ");
        String method = parts.length > 0 ? parts[0] : "";
        String target = parts.length > 1 ? parts[1] : "";

        int declared = -1;
        boolean browser = false;
        boolean chunked = false;
        String header;
        while (!(header = readLine(in)).isEmpty()) {
            int colon = header.indexOf(':');
            if (colon <= 0) continue;
            String name = header.substring(0, colon).trim().toLowerCase(Locale.ROOT);
            String value = header.substring(colon + 1).trim();
            if ("content-length".equals(name)) {
                try {
                    declared = Integer.parseInt(value);
                } catch (NumberFormatException ignored) {
                }
            } else if ("transfer-encoding".equals(name)) {
                chunked = value.toLowerCase(Locale.ROOT).contains("chunked");
            } else if ("origin".equals(name) || "referer".equals(name)) {
                // Nothing here is meant for a browser tab to read — the same
                // refusal both desktop servers make, and the reason they make
                // it: a page on the LAN must not be able to drive a pairing.
                browser = true;
            }
        }

        if (browser) {
            send(out, 403, "{\"ok\":false,\"error\":\"browser origins are not accepted\"}");
            return;
        }
        if (!"POST".equals(method) || !path.equals(pathOf(target))) {
            send(out, 404, "{\"ok\":false,\"error\":\"POST " + path + "\"}");
            return;
        }
        if (chunked || declared < 0) {
            // A peer of ours always sends Content-Length — both `relayPost`
            // here and the desktop's `fetch` do. Refusing the alternative is
            // one fewer parser than accepting it.
            send(out, 411, "{\"ok\":false,\"error\":\"content-length is required\"}");
            return;
        }
        if (declared > MAX_BODY) {
            send(out, 413, "{\"ok\":false,\"error\":\"request body too large\"}");
            return;
        }

        byte[] body = readExactly(in, declared);
        Reply reply = relay.dispatch(kind, new String(body, StandardCharsets.UTF_8));
        if (reply == null) {
            send(out, 503, "{\"ok\":false,\"error\":\"Aevistle is not ready to answer right now\"}");
            return;
        }
        send(out, reply.status, reply.body);
    }

    /** The path with any query string cut off — the servers accept no parameters on either path. */
    private static String pathOf(String target) {
        int cut = target.indexOf('?');
        return cut == -1 ? target : target.substring(0, cut);
    }

    private static void send(OutputStream out, int status, String body) throws IOException {
        byte[] payload = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + status + " " + reason(status) + "\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Content-Length: " + payload.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                // Same headers the desktop servers set, and same intent: this
                // is not an API for a web page.
                + "Access-Control-Allow-Origin: null\r\n"
                + "X-Content-Type-Options: nosniff\r\n"
                + "Connection: close\r\n"
                + "\r\n";
        out.write(head.getBytes(StandardCharsets.US_ASCII));
        out.write(payload);
        out.flush();
    }

    private static String reason(int status) {
        switch (status) {
            case 200:
                return "OK";
            case 400:
                return "Bad Request";
            case 401:
                return "Unauthorized";
            case 403:
                return "Forbidden";
            case 404:
                return "Not Found";
            case 410:
                return "Gone";
            case 411:
                return "Length Required";
            case 413:
                return "Payload Too Large";
            case 503:
                return "Service Unavailable";
            default:
                return "Error";
        }
    }

    /**
     * One CRLF-terminated line, capped.
     *
     * The cap is what stops a peer that never sends a newline from growing this
     * buffer until the process dies — a request line or header longer than 8KB
     * is not something any client of ours produces.
     */
    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') buffer.write(c);
            if (buffer.size() > 8192) throw new IOException("header line too long");
        }
        if (c == -1 && buffer.size() == 0) throw new IOException("connection closed before a request arrived");
        return buffer.toString("UTF-8");
    }

    private static byte[] readExactly(InputStream in, int count) throws IOException {
        byte[] out = new byte[count];
        int read = 0;
        while (read < count) {
            int n = in.read(out, read, count - read);
            if (n < 0) throw new IOException("connection closed mid-body");
            read += n;
        }
        return out;
    }
}
