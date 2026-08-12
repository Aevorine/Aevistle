package dev.aevistle.app;

import android.content.Context;

import org.json.JSONObject;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Fetch a message's remote pictures when the message arrives, not when it is
 * read — the Android twin of `electron/imagePrefetch.ts`.
 *
 * The whole privacy claim lives here rather than in the scanner. The scanner is
 * about what the bytes can do to you; this is about what the request tells the
 * sender about you:
 *
 *   without prefetch    14:27 open -> 12 requests to the sender's servers
 *                       14:31 open again -> 12 more
 *                       never opened -> 0, which is itself the answer
 *
 *   with prefetch       10:03 arrives -> 12 requests, from the sync worker
 *                       14:27 open -> 0
 *                       14:31 open again -> 0
 *                       never opened -> the same 12 as if it had been read
 *
 * The last row is the one that matters most and is the least obvious. Open
 * tracking works because "no request" and "request" are distinguishable; after
 * prefetch they are not. Every message that arrives produces exactly one round
 * of fetches whether it is read once, read forty times, or never opened.
 *
 * Runs on the sync worker's own background thread pool, bounded, and never
 * throws into its caller: this is speculative work for a message nobody has
 * asked for yet, so a failure has no one to tell and must not be able to fail a
 * sync. The open-time path retries and reports any error itself.
 */
final class ImagePrefetch {

    /** Sockets in flight. Small on purpose — nobody is waiting for these. */
    private static final int CONCURRENCY = 2;
    /** URLs that may be waiting at once. A first sync of a busy mailbox is large. */
    private static final int MAX_QUEUE = 2000;
    /**
     * Pause between fetches, per worker. Not politeness — it keeps the burst
     * from arriving as one identifiable clump the instant a sync finishes, and
     * keeps it off the milliseconds the UI is using to draw the new list.
     */
    private static final long SPACING_MS = 150;

    /** Waiting, oldest first. A LinkedHashSet so one pixel in thirty newsletters queues once. */
    private static final Set<String> QUEUE = new LinkedHashSet<>();
    /**
     * Handled this session. The on-disk cache is the real answer and is checked
     * before every fetch, but that is a file read per URL and one sync can offer
     * the same tracking pixel two hundred times.
     */
    private static final Set<String> SEEN = new LinkedHashSet<>();
    private static final int SEEN_MAX = 10000;

    /**
     * The application context the cache writes through.
     *
     * Held statically and taken from the first `offer` — every caller is a sync
     * worker on the same process and hands in the same application context, and
     * an application context has the process's own lifetime, so this leaks
     * nothing an Activity reference would.
     */
    private static Context appContext;

    private static ExecutorService pool;
    private static int workers = 0;
    private static boolean paused = false;

    private ImagePrefetch() {
    }

    /**
     * Offer a message's remote images to the queue. Returns immediately.
     *
     * Called from the one place a body is parsed and cached, so the eager sync
     * pass and the on-demand fetch both feed it without either having to
     * remember to.
     */
    static synchronized void offer(Context context, List<String> urls) {
        if (paused || urls == null || urls.isEmpty()) return;
        if (context != null) appContext = context.getApplicationContext();
        if (appContext == null) return;
        for (String url : urls) {
            if (url == null || url.isEmpty()) continue;
            if (SEEN.contains(url) || QUEUE.contains(url)) continue;
            if (QUEUE.size() >= MAX_QUEUE) {
                // Drop the oldest waiting entry rather than refusing the newest:
                // the newest message is the one most likely to be read next.
                java.util.Iterator<String> it = QUEUE.iterator();
                if (it.hasNext()) {
                    it.next();
                    it.remove();
                }
            }
            QUEUE.add(url);
        }
        pump();
    }

    private static synchronized void pump() {
        if (paused) return;
        if (pool == null) pool = Executors.newFixedThreadPool(CONCURRENCY);
        while (workers < CONCURRENCY && !QUEUE.isEmpty()) {
            workers++;
            pool.execute(ImagePrefetch::drain);
        }
    }

    private static synchronized String take() {
        java.util.Iterator<String> it = QUEUE.iterator();
        if (!it.hasNext()) return null;
        String url = it.next();
        it.remove();
        if (SEEN.size() >= SEEN_MAX) SEEN.clear();
        SEEN.add(url);
        return url;
    }

    private static void drain() {
        try {
            for (;;) {
                if (isPaused()) return;
                String url = take();
                if (url == null) return;
                try {
                    // Two guards, both earning their place: the cache check is
                    // what stops a restart re-fetching everything already on
                    // disk, and the catch is because a picture nobody has asked
                    // for must never crash a background worker.
                    Context ctx = context();
                    if (ctx != null && !ImageCacheStore.has(ctx, url)) {
                        RemoteImageFetcher.Fetched fetched = RemoteImageFetcher.fetch(url);
                        JSONObject verdict = ImageProxy.process(url, fetched.bytes, fetched.mime);
                        ImageCacheStore.write(ctx, url, verdict);
                    }
                } catch (Throwable ignored) {
                    // Speculative work for a message nobody has opened.
                }
                if (SPACING_MS > 0) {
                    try {
                        Thread.sleep(SPACING_MS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
            }
        } finally {
            finished();
        }
    }

    private static synchronized boolean isPaused() {
        return paused;
    }

    private static synchronized Context context() {
        return appContext;
    }

    private static synchronized void finished() {
        workers--;
        // A worker that ran out of queue while another thread was still adding
        // to it must not leave the remainder stranded.
        if (!paused && !QUEUE.isEmpty() && workers < CONCURRENCY) pump();
    }

    /**
     * Stop prefetching and forget what is queued.
     *
     * Called by "reset everything". A queue that survived the reset would keep
     * making exactly the requests the user just asked the app to stop making,
     * and would write entries back into the folder that was just emptied.
     */
    static synchronized void stop() {
        paused = true;
        QUEUE.clear();
        SEEN.clear();
    }

    /** Allow prefetching again — the reset clears a cache, it does not disable the feature. */
    static synchronized void resume() {
        paused = false;
    }

    /** How much is still waiting, for the self-check panel. */
    static synchronized int depth() {
        return QUEUE.size();
    }
}
