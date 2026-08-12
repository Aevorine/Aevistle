package dev.aevistle.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Downloading and installing a new version, on Android.
 *
 * The mirror of `electron/updater.ts`, and deliberately the same shape: stream
 * to a `.part` file, hash while streaming, check the digest against the
 * release's published `SHA256SUMS`, and only then rename into place. What
 * differs is the last step. The desktop can launch an installer; Android
 * cannot install anything itself, so the finished APK is handed to the system
 * package installer through a {@code content://} URI and the user confirms it
 * there. That confirmation is not a formality to route around — it is the only
 * thing standing between "the app updates itself" and "the app installs
 * software", and those are different powers.
 *
 * Why this exists at all: the update check has always worked on Android
 * (`FeedFetcher` relays it past the WebView's CSP) but `downloadUpdate` and
 * `installUpdate` were desktop-only, so the phone could tell you a new version
 * existed and then offer nothing but a link to a web page. Downloading an APK
 * through the browser drops it in a shared Downloads folder, unverified, for
 * the user to find and tap — which is both worse security and worse to use
 * than doing it here.
 *
 * Three constraints Android puts on this that the desktop does not have:
 *
 *   - The APK must live somewhere the package installer can read it. It cannot
 *     be handed a raw path from `filesDir` (that is private to this app), so it
 *     goes through the FileProvider already declared in the manifest, with a
 *     dedicated `updates/` root added to `res/xml/file_paths.xml` so that
 *     grant covers this and nothing else.
 *   - `REQUEST_INSTALL_PACKAGES` is not a runtime permission with a dialog. It
 *     is a special app access, granted per-app in system settings, and from
 *     Android 8 the installer intent simply fails without it. So it is checked
 *     first and the settings screen is offered — see {@link #canInstall} and
 *     {@link #unknownSourcesIntent}.
 *   - There is no `fetch` here to inherit the desktop's redirect handling.
 *     GitHub answers an asset URL with a 302 to `objects.githubusercontent.com`,
 *     and `HttpURLConnection` will not follow a redirect across hosts by
 *     itself, so redirects are followed manually — each hop re-checked against
 *     the same allowlist, because a redirect is a destination chosen by the
 *     server rather than by us.
 */
final class UpdateInstaller {

    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 30000;
    /** An APK this project publishes is a few tens of MB; this is a sanity ceiling, not a target. */
    private static final long MAX_BYTES = 300L * 1024 * 1024;
    /** GitHub uses one hop to its asset host; a handful allows for that plus slack. */
    private static final int MAX_REDIRECTS = 5;

    /**
     * How a download is split on a phone, and when it is worth splitting.
     *
     * The reason to split is the same one that applies on the desktop: a
     * single TCP stream is bounded by its congestion window rather than by the
     * link, so a sender can only keep one bandwidth-delay product in flight
     * before it has to stop and wait for acknowledgements. On a mobile path to
     * a CDN edge, where the round trip is routinely 60-150 ms, that leaves most
     * of the available bandwidth unused however fast the connection is. Three
     * streams have three windows and cover each other's stalls.
     *
     * Three rather than the desktop's four, deliberately. The first two extra
     * streams recover most of the gap; past that the curve flattens, while
     * every additional concurrent TCP connection on a cellular radio is real
     * power and real state in the carrier's NAT. A phone is not a workstation
     * and this is the one place in the file where that changes a number.
     *
     * Six megabytes is the smallest piece worth its own connection and its own
     * thread, which puts the threshold at 18 MB — comfortably below the APK
     * this project actually publishes, so a real update gets three segments,
     * while anything small stays the single stream it has always been.
     */
    private static final int SEGMENTS = 3;
    private static final long MIN_SEGMENT_BYTES = 6L * 1024 * 1024;
    /** Attempts per segment. Only a connection that dies mid-range consumes one. */
    private static final int SEGMENT_ATTEMPTS = 4;

    /**
     * The read buffer each stream owns, and therefore the whole memory cost of
     * doing this in parallel.
     *
     * 64 KB is what the single-stream version already used. Nothing here
     * buffers a segment, a block or the file: every stream writes what it just
     * read straight into the part file at an absolute offset, so peak
     * additional heap for the segmented path is SEGMENTS x this — 192 KB —
     * against an APK measured in tens of megabytes. That is the number that
     * makes running three of these at once on a phone uninteresting.
     */
    private static final int STREAM_BUFFER_BYTES = 64 * 1024;

    /** `Content-Range: bytes 0-0/12345` — only the total is wanted. */
    private static final Pattern CONTENT_RANGE_TOTAL =
            Pattern.compile("^bytes\\s+\\d+-\\d+/(\\d+)$", Pattern.CASE_INSENSITIVE);

    /**
     * Both spellings, in the same order and for the same reason as the desktop:
     * the checksum file has shipped under each, and a name mismatch here would
     * fail *open* — it would look exactly like a release that never published
     * one.
     */
    private static final String[] SUMS_URLS = {
            "https://github.com/Aevorine/Aevistle/releases/latest/download/SHA256SUMS.txt",
            "https://github.com/Aevorine/Aevistle/releases/latest/download/SHA256SUMS",
    };

    private static final String REPO_PATH = "/Aevorine/Aevistle/";

    private UpdateInstaller() {
    }

    interface ProgressCallback {
        void onProgress(long receivedBytes, long totalBytes);
    }

    /** What a finished download produced — mirrors `DownloadProgress` in `src/core/update.ts`. */
    static final class Downloaded {
        final String path;
        final long receivedBytes;
        final long totalBytes;
        /**
         * True only when a published checksum was found *and* matched. False
         * means the release published no line for this file, which is
         * installable but unverified — the UI says so and asks. A checksum file
         * that could not be fetched at all throws instead; see {@link #download}.
         */
        final boolean checksumVerified;

        Downloaded(String path, long receivedBytes, long totalBytes, boolean checksumVerified) {
            this.path = path;
            this.receivedBytes = receivedBytes;
            this.totalBytes = totalBytes;
            this.checksumVerified = checksumVerified;
        }
    }

    // -----------------------------------------------------------------------
    // Destination allowlist
    // -----------------------------------------------------------------------

    /**
     * Only ever fetch from this project's releases.
     *
     * The asset URL arrives from the WebView, and `github.com` is a host anyone
     * can publish a release on — so a host check alone would accept
     * `github.com/someone-else/their-repo/releases/…`, find no checksum line for
     * it (that file belongs to this repo), and offer the result as
     * installable-but-unverified. An APK is the one download where that
     * distinction is the whole ballgame.
     *
     * `objects.githubusercontent.com` carries an opaque path and is checked on
     * host alone; the human-facing hosts must additionally be under this repo.
     * Kept identical to `assertTrustedUrl` in `electron/updater.ts`.
     */
    private static URL assertTrusted(String rawUrl) throws Exception {
        URL url = new URL(rawUrl);
        if (!"https".equals(url.getProtocol())) {
            throw new SecurityException("Refusing to download over " + url.getProtocol());
        }
        if (url.getUserInfo() != null) {
            throw new SecurityException("Refusing a URL carrying credentials");
        }
        int port = url.getPort();
        if (port != -1 && port != 443) {
            throw new SecurityException("Refusing to download from port " + port);
        }
        String host = url.getHost().toLowerCase(Locale.ROOT);
        boolean redirectTarget = host.equals("objects.githubusercontent.com")
                || host.endsWith(".githubusercontent.com");
        boolean repoHost = host.equals("github.com") || host.equals("api.github.com");
        if (!repoHost && !redirectTarget) {
            throw new SecurityException("Refusing to download from " + host);
        }
        if (repoHost && !url.getPath().startsWith(REPO_PATH)) {
            throw new SecurityException("Refusing to download from outside " + REPO_PATH);
        }
        return url;
    }

    /**
     * A live response and the URL it was finally served from.
     *
     * The URL matters because the segmented download below resolves the
     * redirect once and then starts every segment from the destination
     * directly, rather than making each of them repeat the same hop. It has
     * already been through {@link #assertTrusted} — every hop is.
     */
    private static final class Hop {
        final HttpURLConnection connection;
        final String url;

        Hop(HttpURLConnection connection, String url) {
            this.connection = connection;
            this.url = url;
        }
    }

    /**
     * One GET, following cross-host redirects by hand.
     *
     * {@code setInstanceFollowRedirects} stops at a scheme or host change, which
     * is exactly the hop GitHub always makes, so left to itself the connection
     * returns a 302 body of zero bytes and the download "succeeds" empty. Each
     * hop goes back through {@link #assertTrusted} because the redirect target
     * is chosen by the server, not by this app.
     *
     * @param range a {@code Range} header value such as {@code bytes=0-8191},
     *        or null for the whole thing. Carried across redirects, because the
     *        request that matters is the one the final host answers.
     */
    private static Hop openFollowing(String rawUrl, String range) throws Exception {
        String current = rawUrl;
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            URL url = assertTrusted(current);
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestProperty("Accept", "*/*");
            connection.setRequestProperty("User-Agent", "Aevistle");
            if (range != null) connection.setRequestProperty("Range", range);
            int status = connection.getResponseCode();
            if (status == HttpURLConnection.HTTP_MOVED_PERM
                    || status == HttpURLConnection.HTTP_MOVED_TEMP
                    || status == HttpURLConnection.HTTP_SEE_OTHER
                    || status == 307
                    || status == 308) {
                String location = connection.getHeaderField("Location");
                connection.disconnect();
                if (location == null || location.isEmpty()) {
                    throw new Exception("Download failed: redirect without a destination");
                }
                // Resolved against the previous URL so a relative Location works.
                current = new URL(new URL(current), location).toString();
                continue;
            }
            if (status < 200 || status > 299) {
                connection.disconnect();
                throw new Exception("Download failed: HTTP " + status);
            }
            return new Hop(connection, current);
        }
        throw new Exception("Download failed: too many redirects");
    }

    // -----------------------------------------------------------------------
    // Checksums
    // -----------------------------------------------------------------------

    private static final int CHECKSUM_MATCHED = 0;
    /** A checksum file was fetched but had no line for this file. */
    private static final int CHECKSUM_NOT_LISTED = 1;
    /** Neither spelling could be fetched at all — see {@link #download}. */
    private static final int CHECKSUM_UNREACHABLE = 2;

    private static final class Checksum {
        final int status;
        final String hash;

        Checksum(int status, String hash) {
            this.status = status;
            this.hash = hash;
        }
    }

    private static Checksum lookupChecksum(String fileName) {
        boolean reached = false;
        for (String sumsUrl : SUMS_URLS) {
            HttpURLConnection connection = null;
            try {
                connection = openFollowing(sumsUrl, null).connection;
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                try (InputStream in = connection.getInputStream()) {
                    byte[] chunk = new byte[8192];
                    int read;
                    // A sums file is a few hundred bytes; the cap is only here so
                    // a wrong URL cannot stream forever into memory.
                    while ((read = in.read(chunk)) != -1 && buffer.size() < 1024 * 1024) {
                        buffer.write(chunk, 0, read);
                    }
                }
                reached = true;
                for (String line : new String(buffer.toByteArray(), StandardCharsets.UTF_8)
                        .split("\r?\n")) {
                    String trimmed = line.trim();
                    // "<64 hex>  <name>" or "<64 hex> *<name>" — the binary-mode
                    // asterisk that `sha256sum -b` writes.
                    int gap = trimmed.indexOf(' ');
                    if (gap != 64) continue;
                    String hash = trimmed.substring(0, 64).toLowerCase(Locale.ROOT);
                    if (!hash.matches("[0-9a-f]{64}")) continue;
                    String named = trimmed.substring(gap).trim();
                    if (named.startsWith("*")) named = named.substring(1);
                    named = new File(named).getName();
                    if (named.equals(fileName)) return new Checksum(CHECKSUM_MATCHED, hash);
                }
            } catch (Exception ignored) {
                // try the next spelling
            } finally {
                if (connection != null) connection.disconnect();
            }
        }
        return new Checksum(reached ? CHECKSUM_NOT_LISTED : CHECKSUM_UNREACHABLE, null);
    }

    // -----------------------------------------------------------------------
    // Download
    // -----------------------------------------------------------------------

    /** Where finished and in-flight downloads live. Private to the app; exposed to the installer through the FileProvider alone. */
    static File updatesDir(Context context) {
        return new File(context.getFilesDir(), "updates");
    }

    /**
     * Received-bytes tally shared by every stream, throttled exactly as the
     * single-stream version was.
     *
     * The callback's contract is not this file's to change — a progress bar in
     * the WebView is on the other end of it — so it still fires at most once
     * every 120 ms with a running total and the same declared total. What is
     * new is that three threads feed it, so the running total is an AtomicLong
     * and the throttle window is claimed with a compare-and-set: whichever
     * stream wins the CAS reports, the other two return immediately rather
     * than piling three callbacks into the same millisecond.
     */
    private static final class Progress {
        private final AtomicLong received = new AtomicLong();
        private final AtomicLong lastReport = new AtomicLong();
        private final long total;
        private final ProgressCallback sink;

        Progress(long total, ProgressCallback sink) {
            this.total = total;
            this.sink = sink;
        }

        void add(int delta) {
            long got = received.addAndGet(delta);
            long now = System.currentTimeMillis();
            long last = lastReport.get();
            if (now - last > 120 && lastReport.compareAndSet(last, now)) {
                sink.onProgress(got, total);
            }
        }

        long received() {
            return received.get();
        }
    }

    /** What one pass at filling the `.part` file produced. */
    private static final class Fetched {
        final long receivedBytes;
        final long totalBytes;
        /** True when the file was assembled from more than one ranged request. */
        final boolean segmented;

        Fetched(long receivedBytes, long totalBytes, boolean segmented) {
            this.receivedBytes = receivedBytes;
            this.totalBytes = totalBytes;
            this.segmented = segmented;
        }
    }

    /** The total length out of a `Content-Range` header, or -1. */
    private static long contentRangeTotal(String header) {
        if (header == null) return -1L;
        Matcher matcher = CONTENT_RANGE_TOTAL.matcher(header.trim());
        if (!matcher.matches()) return -1L;
        try {
            long total = Long.parseLong(matcher.group(1));
            return total > 0 ? total : -1L;
        } catch (NumberFormatException e) {
            return -1L;
        }
    }

    /**
     * Positional write, drained.
     *
     * {@link FileChannel#write(ByteBuffer, long)} is the reason the segments
     * can share one open file: it writes at an absolute offset and leaves the
     * channel's own position alone, which makes concurrent writes from
     * different threads safe. {@link RandomAccessFile#seek} would not be —
     * seek-then-write is two operations against one shared file pointer, and
     * three threads doing that would interleave into a scrambled APK. It can
     * also write short, hence the loop.
     */
    private static void writeAt(FileChannel channel, byte[] data, int length, long position)
            throws Exception {
        ByteBuffer buffer = ByteBuffer.wrap(data, 0, length);
        long at = position;
        while (buffer.hasRemaining()) {
            at += channel.write(buffer, at);
        }
    }

    /**
     * One segment, byte-exact, restarted from wherever it got to.
     *
     * This is what "resume" means here. A connection that dies eight megabytes
     * into a range does not restart the range — the next attempt asks for
     * `bytes=<start + what landed>-<end>`, so a download on a train converges
     * instead of looping. What it deliberately does not do is resume across a
     * restart of the app: that needs a manifest of completed ranges written and
     * flushed as they land, to save re-fetching a download the user is watching
     * a progress bar for.
     */
    private static void fetchSegment(String url, long start, long endInclusive,
                                     FileChannel channel, Progress progress,
                                     AtomicBoolean cancelled) throws Exception {
        long position = start;
        int attempt = 0;

        for (;;) {
            HttpURLConnection connection = null;
            try {
                if (cancelled.get()) throw new InterruptedException("Download cancelled");
                Hop hop = openFollowing(url, "bytes=" + position + "-" + endInclusive);
                connection = hop.connection;
                if (connection.getResponseCode() != 206) {
                    // A server that answered the probe with 206 and this with
                    // anything else has changed its mind mid-download. Retrying
                    // the range is right; treating a 200 as usable here is not,
                    // because a 200 is the *whole* file and would be written at
                    // this segment's offset.
                    throw new Exception("Download failed: HTTP " + connection.getResponseCode()
                            + " on a ranged request");
                }

                byte[] buffer = new byte[STREAM_BUFFER_BYTES];
                try (InputStream in = connection.getInputStream()) {
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        if (cancelled.get()) throw new InterruptedException("Download cancelled");
                        // Clamped rather than trusted: a server that sends past
                        // the end of the range it was given must not be able to
                        // write over the next segment's bytes.
                        long room = endInclusive + 1 - position;
                        if (room <= 0) break;
                        int take = (int) Math.min(read, room);
                        writeAt(channel, buffer, take, position);
                        position += take;
                        progress.add(take);
                    }
                }

                if (position > endInclusive) return;
                throw new Exception("The server closed a ranged request before the range was finished");
            } catch (Exception e) {
                // A cancellation is a sibling segment having failed, or the
                // download being torn down. Neither is a network blip.
                if (cancelled.get()) throw e;
                attempt++;
                if (attempt >= SEGMENT_ATTEMPTS) throw e;
                // …and round again from `position`, which is exactly how far
                // this segment actually got. Nothing written is fetched twice.
            } finally {
                if (connection != null) connection.disconnect();
            }
        }
    }

    /** The single stream, from a response already in hand. */
    private static Fetched streamWhole(HttpURLConnection connection, File partFile,
                                       long declaredSize, ProgressCallback onProgress)
            throws Exception {
        long declared = connection.getContentLengthLong();
        long totalBytes = declared > 0 ? declared : declaredSize;
        Progress progress = new Progress(totalBytes, onProgress);

        try (InputStream in = connection.getInputStream();
             OutputStream out = new FileOutputStream(partFile)) {
            byte[] chunk = new byte[STREAM_BUFFER_BYTES];
            int read;
            while ((read = in.read(chunk)) != -1) {
                if (progress.received() + read > MAX_BYTES) {
                    throw new Exception("The download is larger than this app will accept");
                }
                out.write(chunk, 0, read);
                progress.add(read);
            }
        } catch (Exception e) {
            // noinspection ResultOfMethodCallIgnored
            partFile.delete();
            throw e;
        } finally {
            connection.disconnect();
        }

        long got = progress.received();
        return new Fetched(got, totalBytes > 0 ? totalBytes : got, false);
    }

    /**
     * Fill the `.part` file, in as many pieces as the server allows.
     *
     * Range support is detected, never assumed — and detected by asking for one
     * byte, which answers two questions for one round trip: whether this server
     * honours `Range` at all, and how long the file really is, which
     * `Content-Range` states authoritatively and the GitHub API's `size` field
     * only reports. The same reply resolves the `github.com` redirect to the
     * asset host, so the segments start from the final URL instead of each
     * repeating that hop — which is most of the probe's cost back.
     *
     * Every fallback lands on the single stream this method used to be.
     */
    private static Fetched writePart(String assetUrl, long declaredSize, File partFile,
                                     ProgressCallback onProgress, boolean allowSegments)
            throws Exception {
        // noinspection ResultOfMethodCallIgnored
        partFile.delete();

        if (!allowSegments || declaredSize < SEGMENTS * MIN_SEGMENT_BYTES) {
            return streamWhole(openFollowing(assetUrl, null).connection, partFile,
                    declaredSize, onProgress);
        }

        Hop probe = openFollowing(assetUrl, "bytes=0-0");
        int status = probe.connection.getResponseCode();
        if (status == HttpURLConnection.HTTP_OK) {
            // The server ignored the Range header and is sending the whole
            // file. Take it: throwing this response away to ask again would
            // cost a round trip and re-request everything already on the wire.
            return streamWhole(probe.connection, partFile, declaredSize, onProgress);
        }

        long total = status == 206 ? contentRangeTotal(probe.connection.getHeaderField("Content-Range")) : -1L;
        String resolved = probe.url;
        // One byte either way from here, and nothing left to read from it.
        probe.connection.disconnect();

        if (total < 0) {
            // A 206 whose Content-Range this cannot read, or some other answer
            // entirely. Not worth guessing at — take the plain stream.
            return writePart(assetUrl, declaredSize, partFile, onProgress, false);
        }
        if (total > MAX_BYTES) {
            throw new Exception("The download is larger than this app will accept");
        }

        int count = (int) Math.min(SEGMENTS, total / MIN_SEGMENT_BYTES);
        if (count < 2) return writePart(assetUrl, declaredSize, partFile, onProgress, false);

        long span = (total + count - 1) / count;
        List<long[]> ranges = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            long start = i * span;
            if (start >= total) break;
            ranges.add(new long[]{start, Math.min(start + span, total) - 1});
        }

        Progress progress = new Progress(total, onProgress);
        AtomicBoolean cancelled = new AtomicBoolean(false);
        ExecutorService pool = Executors.newFixedThreadPool(ranges.size(), runnable -> {
            Thread thread = new Thread(runnable, "aevistle-update-segment");
            thread.setDaemon(true);
            return thread;
        });

        Exception failure = null;
        try (RandomAccessFile file = new RandomAccessFile(partFile, "rw");
             FileChannel channel = file.getChannel()) {
            List<Future<Void>> running = new ArrayList<>();
            try {
                for (long[] range : ranges) {
                    final long start = range[0];
                    final long end = range[1];
                    running.add(pool.submit((Callable<Void>) () -> {
                        try {
                            fetchSegment(resolved, start, end, channel, progress, cancelled);
                        } catch (Exception e) {
                            // Stop the siblings rather than leave them
                            // downloading into a file about to be deleted.
                            cancelled.set(true);
                            throw e;
                        }
                        return null;
                    }));
                }
            } finally {
                /*
                 * Every future that was actually submitted is waited on —
                 * including after one has failed, and including when the
                 * submit loop itself threw partway through. This is the
                 * load-bearing part rather than tidiness: the channel is closed
                 * by the try-with-resources the moment this block is left, and
                 * a segment still inside a write at that point would be writing
                 * into a closed channel. Worse, this method would return and
                 * the caller would begin hashing and renaming a file another
                 * thread was still touching. Nothing outlives this loop.
                 */
                // A submit loop that did not get all the way through means the
                // segments already running have no siblings coming; stop them.
                if (running.size() < ranges.size()) cancelled.set(true);
                for (Future<Void> future : running) {
                    try {
                        future.get();
                    } catch (Exception e) {
                        if (failure == null) {
                            failure = e.getCause() instanceof Exception ? (Exception) e.getCause() : e;
                        }
                    }
                }
            }
        } finally {
            cancelled.set(true);
            pool.shutdownNow();
            try {
                // Bounded, and swallowed. The threads have already been joined
                // above, so this only reclaims the pool itself — and an
                // exception thrown out of a finally would replace whatever real
                // failure this method was in the middle of reporting.
                pool.awaitTermination(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }

        if (failure != null) {
            // noinspection ResultOfMethodCallIgnored
            partFile.delete();
            throw failure;
        }

        /*
         * The reassembly's own check, before the checksum gets a look in.
         *
         * The segments write at absolute offsets, so a boundary off by one
         * produces a file of the wrong length rather than one that merely
         * hashes wrong. Saying so in those words is worth the two lines: the
         * hash below would catch it too — that guarantee has not moved — but
         * "the file is four bytes short" is a fault this code can name, and a
         * checksum mismatch is not.
         */
        long written = partFile.length();
        if (written != total) {
            // noinspection ResultOfMethodCallIgnored
            partFile.delete();
            throw new Exception("The reassembled download is " + written + " bytes, not the "
                    + total + " the server declared");
        }

        return new Fetched(progress.received(), total, true);
    }

    /**
     * SHA-256 of what is actually on disk.
     *
     * Hashing moved off the socket and onto the file when the download stopped
     * arriving in order, and that is a strengthening rather than a compromise.
     * The old version digested bytes as they streamed past, which would have
     * agreed with the published checksum even if those bytes were subsequently
     * written to the wrong offset. This digests the APK that would be handed to
     * the package installer. It costs one extra read of the finished file from
     * internal storage, which on any phone that can run this app is a fraction
     * of a second against a download measured in tens of seconds.
     */
    private static String hashFile(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[STREAM_BUFFER_BYTES];
        try (InputStream in = new FileInputStream(file)) {
            int read;
            while ((read = in.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", b));
        return hex.toString();
    }

    /**
     * Stream the APK to private storage, verify it, and return where it landed.
     *
     * Written to `.part` and renamed only after the digest is accepted, so an
     * interrupted download can never be mistaken for a finished one — an
     * especially bad mistake to make with something the user is about to be
     * asked to install.
     */
    static Downloaded download(Context context, String assetUrl, String assetName,
                               long declaredSize, ProgressCallback onProgress) throws Exception {
        // Reduced to a bare name and scrubbed, so a crafted asset name cannot
        // escape the directory or arrive with separators in it.
        String safeName = new File(assetName).getName().replaceAll("[^A-Za-z0-9._-]", "_");
        if (safeName.isEmpty()) safeName = "update.apk";

        File dir = updatesDir(context);
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new Exception("Could not create the download folder");
        }
        // Previous attempts, finished or not. Keeping them would mean the phone
        // accumulating a copy of every version it ever updated through, in
        // storage the user cannot see or clear from a file manager.
        File[] stale = dir.listFiles();
        if (stale != null) {
            for (File file : stale) {
                // noinspection ResultOfMethodCallIgnored
                file.delete();
            }
        }

        File finalFile = new File(dir, safeName);
        File partFile = new File(dir, safeName + ".part");

        Fetched fetched = writePart(assetUrl, declaredSize, partFile, onProgress, true);
        String hex = hashFile(partFile);

        Checksum checksum = lookupChecksum(safeName);
        if (checksum.status == CHECKSUM_UNREACHABLE) {
            // Not downgraded to a warning. The APK right next to it just
            // downloaded fine, so "the sums file alone is unreachable" is a
            // selective failure, not an offline phone.
            // noinspection ResultOfMethodCallIgnored
            partFile.delete();
            throw new Exception("Could not verify the download: the checksum file could not be fetched");
        }

        /*
         * A published hash that does not match, on a file assembled from three
         * ranged requests, has two possible causes and only one of them is the
         * APK's fault. The other is the transport: a carrier proxy that rewrites
         * ranged responses, a CDN edge serving a stale object for one range and
         * a fresh one for another. Those are worth one more attempt down the
         * single stream this method used before segments existed.
         *
         * It is not a second chance at passing. The retry goes through exactly
         * the same comparison against exactly the same published hash, and a
         * second mismatch throws below. Nothing reaches the package installer
         * that has not matched a checksum the release published — the
         * verification has not been softened, only given one chance to rule out
         * the mechanism this change introduced.
         */
        if (checksum.status == CHECKSUM_MATCHED && !checksum.hash.contentEquals(hex)
                && fetched.segmented) {
            fetched = writePart(assetUrl, declaredSize, partFile, onProgress, false);
            hex = hashFile(partFile);
        }

        if (checksum.status == CHECKSUM_MATCHED && !checksum.hash.contentEquals(hex)) {
            // noinspection ResultOfMethodCallIgnored
            partFile.delete();
            throw new Exception("The downloaded file did not match the published checksum");
        }

        long receivedBytes = fetched.receivedBytes;
        long totalBytes = fetched.totalBytes;

        // noinspection ResultOfMethodCallIgnored
        finalFile.delete();
        if (!partFile.renameTo(finalFile)) {
            // noinspection ResultOfMethodCallIgnored
            partFile.delete();
            throw new Exception("Could not finish writing the download");
        }

        onProgress.onProgress(receivedBytes, totalBytes > 0 ? totalBytes : receivedBytes);
        return new Downloaded(finalFile.getAbsolutePath(), receivedBytes,
                totalBytes > 0 ? totalBytes : receivedBytes,
                checksum.status == CHECKSUM_MATCHED);
    }

    // -----------------------------------------------------------------------
    // Install
    // -----------------------------------------------------------------------

    /**
     * Whether the system would let this app hand over an APK at all.
     *
     * From Android 8 this is a per-app toggle in settings rather than something
     * that can be requested with a dialog, and without it the installer intent
     * fails in a way that looks to the user like the button did nothing. Below
     * Android 8 the manifest permission is enough.
     */
    static boolean canInstall(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        return context.getPackageManager().canRequestPackageInstalls();
    }

    /** The settings screen that grants the above, scoped to this app. */
    static Intent unknownSourcesIntent(Context context) {
        Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                .setData(Uri.parse("package:" + context.getPackageName()));
        return intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    /**
     * Hand a downloaded APK to the system package installer.
     *
     * The path is not taken on trust: it must be a real file inside this app's
     * own `updates/` directory, canonicalised first so that neither a `..`
     * segment nor a symlink can point the FileProvider grant somewhere else.
     * The caller is the WebView, so "the path came from our own code" is an
     * assumption rather than a fact.
     */
    static void install(Context context, String path) throws Exception {
        File file = new File(path).getCanonicalFile();
        File root = updatesDir(context).getCanonicalFile();
        if (!file.getPath().startsWith(root.getPath() + File.separator) || !file.isFile()) {
            throw new SecurityException("That file is not an update this app downloaded");
        }
        if (!canInstall(context)) {
            throw new IllegalStateException("unknown-sources");
        }

        Uri uri = androidx.core.content.FileProvider.getUriForFile(
                context, context.getPackageName() + ".fileprovider", file);
        Intent install = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(install);
    }
}
