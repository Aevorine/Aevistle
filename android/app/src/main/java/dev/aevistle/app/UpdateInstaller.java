package dev.aevistle.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

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
     * One GET, following cross-host redirects by hand.
     *
     * {@code setInstanceFollowRedirects} stops at a scheme or host change, which
     * is exactly the hop GitHub always makes, so left to itself the connection
     * returns a 302 body of zero bytes and the download "succeeds" empty. Each
     * hop goes back through {@link #assertTrusted} because the redirect target
     * is chosen by the server, not by this app.
     */
    private static HttpURLConnection openFollowing(String rawUrl) throws Exception {
        String current = rawUrl;
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            URL url = assertTrusted(current);
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestProperty("Accept", "*/*");
            connection.setRequestProperty("User-Agent", "Aevistle");
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
            return connection;
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
                connection = openFollowing(sumsUrl);
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

        HttpURLConnection connection = openFollowing(assetUrl);
        long declared = connection.getContentLengthLong();
        long totalBytes = declared > 0 ? declared : declaredSize;
        long receivedBytes = 0;
        long lastReport = 0;

        MessageDigest digest = MessageDigest.getInstance("SHA-256");

        try (InputStream in = connection.getInputStream();
             OutputStream out = new FileOutputStream(partFile)) {
            byte[] chunk = new byte[64 * 1024];
            int read;
            while ((read = in.read(chunk)) != -1) {
                receivedBytes += read;
                if (receivedBytes > MAX_BYTES) {
                    throw new Exception("The download is larger than this app will accept");
                }
                digest.update(chunk, 0, read);
                out.write(chunk, 0, read);

                // Throttled: an unthrottled callback pushes tens of thousands of
                // messages across the Capacitor bridge and makes the progress bar
                // the slowest part of the download.
                long now = System.currentTimeMillis();
                if (now - lastReport > 120) {
                    lastReport = now;
                    onProgress.onProgress(receivedBytes, totalBytes);
                }
            }
        } catch (Exception e) {
            // noinspection ResultOfMethodCallIgnored
            partFile.delete();
            throw e;
        } finally {
            connection.disconnect();
        }

        StringBuilder hex = new StringBuilder();
        for (byte b : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", b));

        Checksum checksum = lookupChecksum(safeName);
        if (checksum.status == CHECKSUM_UNREACHABLE) {
            // Not downgraded to a warning. The APK right next to it just
            // downloaded fine, so "the sums file alone is unreachable" is a
            // selective failure, not an offline phone.
            // noinspection ResultOfMethodCallIgnored
            partFile.delete();
            throw new Exception("Could not verify the download: the checksum file could not be fetched");
        }
        if (checksum.status == CHECKSUM_MATCHED && !checksum.hash.contentEquals(hex)) {
            // noinspection ResultOfMethodCallIgnored
            partFile.delete();
            throw new Exception("The downloaded file did not match the published checksum");
        }

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
