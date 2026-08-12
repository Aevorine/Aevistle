package dev.aevistle.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Scan and re-encode a fetched image before the WebView ever sees it — the
 * Android half of the privacy image proxy.
 *
 * The contract, the vocabulary of block reasons and the tracking rules are
 * defined once in `src/core/mail/imageProxy.ts`; this file implements the same
 * ones against Android's own decoders, and the JSON it emits is exactly the
 * `ProxiedImage` shape the bridge expects. When the rules here and the rules
 * there disagree, they are a bug — `scripts/check-image-proxy.mjs` compares the
 * two lists so the disagreement fails the build instead of shipping as "the
 * phone blocks different pictures than the desktop".
 *
 * ## Why a re-encode
 *
 * Decoding to a bitmap and compressing a fresh file from those pixels is a
 * whitelist by construction: whatever survives is the picture, and everything
 * that is not the picture — EXIF (which carries GPS), ICC, XMP, comments,
 * embedded thumbnails and any payload appended past the format's end marker —
 * is simply not part of the output. Nobody had to enumerate it.
 *
 * `BitmapFactory` returning null is Android's way of saying it could not decode
 * the bytes, and that is the single most valuable signal here: a malformed or
 * hostile file fails before anything renders it.
 *
 * ## Why animated files take a different path
 *
 * `BitmapFactory` decodes one frame, so re-encoding an animated GIF silently
 * turns it into a still. Those get a structural scrub instead — the file is
 * walked block by block and rebuilt from only the blocks carrying pixels or
 * timing, dropping comments, unknown application extensions, and everything
 * after the trailer. That last one matters most: appending a payload after the
 * GIF trailer is the standard polyglot trick, ignored by every decoder, which
 * is exactly why it is a good place to hide something for a different program.
 */
final class ImageProxy {

    /** Refuse anything whose pixel count could exhaust memory on decode. */
    private static final long MAX_PIXELS = 40_000_000L;
    /** Refuse anything whose processed form would be absurd to inline as a data URI. */
    private static final int MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
    /** Above this, a JPEG source is re-encoded as JPEG rather than PNG. */
    private static final int JPEG_REENCODE_THRESHOLD = 64 * 1024;
    private static final int JPEG_QUALITY = 82;
    /** Anything this small on both axes was not meant to be looked at. */
    private static final int PIXEL_MAX_EDGE = 4;

    private ImageProxy() {
    }

    // -----------------------------------------------------------------------
    //  Format sniffing
    // -----------------------------------------------------------------------

    static final int KIND_UNKNOWN = 0;
    static final int KIND_PNG = 1;
    static final int KIND_JPEG = 2;
    static final int KIND_GIF = 3;
    static final int KIND_WEBP = 4;
    static final int KIND_BMP = 5;
    static final int KIND_SVG = 6;

    /**
     * What the <em>bytes</em> say they are, which is the only claim worth acting
     * on. The server's Content-Type is compared against this and then never used.
     */
    static int sniff(byte[] b) {
        if (b == null || b.length < 12) return KIND_UNKNOWN;
        if ((b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return KIND_PNG;
        if ((b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8 && (b[2] & 0xff) == 0xff) return KIND_JPEG;
        if (b[0] == 'G' && b[1] == 'I' && b[2] == 'F' && b[3] == '8') return KIND_GIF;
        if (b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F'
                && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') return KIND_WEBP;
        if (b[0] == 'B' && b[1] == 'M') return KIND_BMP;
        // SVG is XML and may start with a comment, a declaration or whitespace.
        // Sniffed only in order to refuse it, so a loose test is the right kind
        // of loose: a false positive costs one picture, a false negative admits
        // a format that can carry script and fetch its own subresources.
        int end = Math.min(b.length, 1024);
        String head = new String(b, 0, end, java.nio.charset.StandardCharsets.ISO_8859_1)
                .trim().toLowerCase(Locale.ROOT);
        if (head.startsWith("<?xml") || head.startsWith("<!doctype svg") || head.startsWith("<svg")) {
            return KIND_SVG;
        }
        return KIND_UNKNOWN;
    }

    /**
     * Does the server's declared type agree with what the bytes are?
     *
     * A disagreement is not automatically an attack — servers mislabel JPEGs as
     * `image/jpg` constantly. It is treated as one anyway: being wrong in the
     * permissive direction means handing an attacker's chosen decoder some
     * bytes, and being wrong in the strict direction means one missing picture
     * with a stated reason. The synonyms real servers use are accepted by name.
     */
    private static boolean typeAgrees(String declared, int kind) {
        if (declared == null) return false;
        String got = declared.toLowerCase(Locale.ROOT).trim();
        switch (kind) {
            case KIND_PNG:
                return got.equals("image/png") || got.equals("image/x-png");
            case KIND_JPEG:
                return got.equals("image/jpeg") || got.equals("image/jpg") || got.equals("image/pjpeg");
            case KIND_GIF:
                return got.equals("image/gif");
            case KIND_WEBP:
                return got.equals("image/webp");
            case KIND_BMP:
                return got.equals("image/bmp") || got.equals("image/x-ms-bmp") || got.equals("image/x-bmp");
            default:
                return false;
        }
    }

    // -----------------------------------------------------------------------
    //  GIF structural walk
    // -----------------------------------------------------------------------

    /** What a GIF walk found: the rebuilt file, its frame count and its size. */
    private static final class GifWalk {
        byte[] rebuilt;
        int frames;
        int width;
        int height;
    }

    /**
     * Walk a GIF block by block and rebuild it from the blocks that matter.
     *
     * Kept: header, logical screen descriptor, global colour table, every
     * Graphic Control Extension (frame timing and transparency), every Image
     * Descriptor with its data, and the Netscape application extension carrying
     * the loop count — without which an animation plays once and stops.
     *
     * Dropped: Comment Extensions, Plain Text Extensions, all other Application
     * Extensions, and every byte after the trailer.
     *
     * Returns null when the structure does not parse, which is itself a
     * verdict: a GIF this cannot walk is a GIF this will not serve.
     */
    private static GifWalk walkGif(byte[] b) {
        if (b.length < 13) return null;
        if (!(b[0] == 'G' && b[1] == 'I' && b[2] == 'F' && b[3] == '8')) return null;

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        GifWalk result = new GifWalk();
        result.width = (b[6] & 0xff) | ((b[7] & 0xff) << 8);
        result.height = (b[8] & 0xff) | ((b[9] & 0xff) << 8);
        int packed = b[10] & 0xff;
        out.write(b, 0, 13);
        int p = 13;

        if ((packed & 0x80) != 0) {
            int size = 3 * (1 << ((packed & 0x07) + 1));
            if (p + size > b.length) return null;
            out.write(b, p, size);
            p += size;
        }

        int frames = 0;
        while (p < b.length) {
            int marker = b[p] & 0xff;

            if (marker == 0x3b) {
                out.write(0x3b);
                result.rebuilt = out.toByteArray();
                result.frames = frames;
                return result;
            }

            if (marker == 0x21) {
                if (p + 2 > b.length) return null;
                int label = b[p + 1] & 0xff;
                int end = skipSubBlocks(b, p + 2);
                if (end < 0) return null;
                boolean graphicControl = label == 0xf9;
                boolean netscapeLoop = label == 0xff && p + 14 <= b.length
                        && new String(b, p + 3, 8, java.nio.charset.StandardCharsets.ISO_8859_1)
                        .equals("NETSCAPE");
                if (graphicControl || netscapeLoop) out.write(b, p, end - p);
                p = end;
                continue;
            }

            if (marker == 0x2c) {
                if (p + 10 > b.length) return null;
                int localPacked = b[p + 9] & 0xff;
                int q = p + 10;
                if ((localPacked & 0x80) != 0) q += 3 * (1 << ((localPacked & 0x07) + 1));
                if (q + 1 > b.length) return null;
                q += 1; // LZW minimum code size
                int end = skipSubBlocks(b, q);
                if (end < 0) return null;
                out.write(b, p, end - p);
                frames++;
                p = end;
                continue;
            }

            return null; // not a block level this understands
        }

        // Ran off the end without a trailer. Salvageable: a truncated animation
        // is common and the frames that did parse are real.
        if (frames == 0) return null;
        out.write(0x3b);
        result.rebuilt = out.toByteArray();
        result.frames = frames;
        return result;
    }

    /** End offset of a chain of length-prefixed sub-blocks, or -1 if it runs off. */
    private static int skipSubBlocks(byte[] b, int from) {
        int q = from;
        while (q < b.length) {
            int len = b[q] & 0xff;
            if (len == 0) return q + 1;
            q += 1 + len;
        }
        return -1;
    }

    private static boolean isAnimated(byte[] b, int kind) {
        if (kind == KIND_GIF) {
            GifWalk walked = walkGif(b);
            return walked != null && walked.frames > 1;
        }
        if (kind == KIND_WEBP) {
            String head = new String(b, 0, Math.min(b.length, 64),
                    java.nio.charset.StandardCharsets.ISO_8859_1);
            return head.contains("ANIM");
        }
        if (kind == KIND_PNG) {
            String head = new String(b, 0, Math.min(b.length, 4096),
                    java.nio.charset.StandardCharsets.ISO_8859_1);
            int actl = head.indexOf("acTL");
            int idat = head.indexOf("IDAT");
            return actl >= 0 && (idat < 0 || actl < idat);
        }
        return false;
    }

    // -----------------------------------------------------------------------
    //  The pipeline
    // -----------------------------------------------------------------------

    /**
     * Everything between "bytes arrived" and "safe to render", as the JSON the
     * bridge hands the WebView. Never throws — every caller wants a verdict,
     * and an exception is a verdict nobody can put on the screen.
     */
    static JSONObject process(String url, byte[] bytes, String declaredMime) {
        try {
            if (bytes == null || bytes.length == 0) return blocked("notAnImage", null);

            int kind = sniff(bytes);
            if (kind == KIND_SVG) return blocked("scriptableFormat", "SVG");
            if (kind == KIND_UNKNOWN) return blocked("notAnImage", null);
            if (!typeAgrees(declaredMime, kind)) {
                return blocked("typeMismatch", "declared " + declaredMime);
            }

            if (isAnimated(bytes, kind) && kind == KIND_GIF) {
                GifWalk walked = walkGif(bytes);
                if (walked == null) return blocked("undecodable", "GIF structure");
                if (walked.rebuilt.length > MAX_OUTPUT_BYTES) return blocked("tooLarge", null);
                return ok(url, "image/gif", walked.rebuilt, walked.width, walked.height, false);
            }

            // Measure before decoding: a decode-then-check would have to
            // allocate the bitmap in order to find out it was too big, which is
            // the allocation the check exists to prevent.
            BitmapFactory.Options probe = new BitmapFactory.Options();
            probe.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, probe);
            if (probe.outWidth <= 0 || probe.outHeight <= 0) return blocked("undecodable", null);
            if ((long) probe.outWidth * (long) probe.outHeight > MAX_PIXELS) {
                return blocked("tooLarge", probe.outWidth + "x" + probe.outHeight);
            }

            Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (bitmap == null) return blocked("undecodable", null);

            try {
                boolean asJpeg = kind == KIND_JPEG && bytes.length > JPEG_REENCODE_THRESHOLD;
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                boolean wrote = bitmap.compress(
                        asJpeg ? Bitmap.CompressFormat.JPEG : Bitmap.CompressFormat.PNG,
                        asJpeg ? JPEG_QUALITY : 100,
                        out);
                if (!wrote || out.size() == 0) return blocked("undecodable", "re-encode produced nothing");
                if (out.size() > MAX_OUTPUT_BYTES) return blocked("tooLarge", null);

                boolean transparent = isFullyTransparent(bitmap);
                return ok(url, asJpeg ? "image/jpeg" : "image/png", out.toByteArray(),
                        bitmap.getWidth(), bitmap.getHeight(), transparent);
            } finally {
                bitmap.recycle();
            }
        } catch (Throwable t) {
            // Including OutOfMemoryError: a picture nobody asked for must never
            // be a reason the app dies.
            return blocked("undecodable", String.valueOf(t.getMessage()));
        }
    }

    /**
     * Is every pixel transparent? One of the two conclusive tracking signals,
     * and only answerable where the raw bitmap exists.
     *
     * Only for small images. Walking a 12-megapixel photo to answer a question
     * about newsletters is not a trade worth making, and tracking pixels are
     * tiny — so the case that matters is exact and the rest is skipped.
     */
    private static boolean isFullyTransparent(Bitmap bitmap) {
        int w = bitmap.getWidth();
        int h = bitmap.getHeight();
        if ((long) w * (long) h > 4096) return false;
        if (!bitmap.hasAlpha()) return false;
        int[] pixels = new int[w * h];
        bitmap.getPixels(pixels, 0, w, 0, 0, w, h);
        for (int pixel : pixels) {
            if ((pixel >>> 24) != 0) return false;
        }
        return true;
    }

    // -----------------------------------------------------------------------
    //  Tracking analysis — the same rules as core/mail/imageProxy.ts
    // -----------------------------------------------------------------------

    /**
     * Path and host fragments from the open-tracking vocabulary. Deliberately
     * not a domain blocklist: a list of tracking companies is stale the week it
     * ships and says nothing about the sender who rolled their own. These are
     * the words the technique itself needs.
     *
     * Kept byte-identical to `TRACKING_PATH_WORDS` in the TypeScript twin;
     * `scripts/check-image-proxy.mjs` fails the build if they drift.
     */
    private static final String[] TRACKING_PATH_WORDS = {
            "open", "opened", "track", "tracking", "tracker", "beacon", "pixel",
            "impression", "stat", "stats", "analytic", "analytics", "telemetry",
            "collect", "count", "seen", "read", "receipt", "wf/open", "ea/open",
    };

    private static List<String> trackerRules(String url, int width, int height, boolean transparent) {
        List<String> rules = new ArrayList<>();
        if (width > 0 && height > 0 && width <= PIXEL_MAX_EDGE && height <= PIXEL_MAX_EDGE) {
            rules.add("pixelSized");
        }
        if (transparent) rules.add("invisible");

        String host;
        String path;
        String query;
        try {
            java.net.URI u = java.net.URI.create(url);
            host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.ROOT);
            path = u.getRawPath() == null ? "" : u.getRawPath().toLowerCase(Locale.ROOT);
            query = u.getRawQuery() == null ? "" : u.getRawQuery();
        } catch (Throwable t) {
            return rules;
        }

        // Segment matching, never `contains`: `contains("stat")` fires on
        // `/static/logo.png`, the most common image path on the web, which
        // would make the whole count meaningless.
        java.util.Set<String> segments = new java.util.HashSet<>();
        for (String seg : (host + "/" + path).split("[/._-]+")) {
            if (!seg.isEmpty()) segments.add(seg);
        }
        for (String word : TRACKING_PATH_WORDS) {
            boolean hit = word.contains("/") ? path.contains("/" + word) : segments.contains(word);
            if (hit) {
                rules.add("trackingPath");
                break;
            }
        }

        if (hasOpaqueToken(path) || hasOpaqueToken(query)) rules.add("recipientToken");
        if (query.matches("(?s).*(^|[?&=])[^?&=]*(%40|@)[A-Za-z0-9.-]+\\.[A-Za-z]{2,}.*")
                || query.matches("(?si).*(^|[?&/=])(email|e|addr|address|recipient|rcpt|to|u|uid|eid|mid|sid)=[A-Fa-f0-9]{32,64}($|[&/]).*")) {
            rules.add("addressInUrl");
        }
        return rules;
    }

    /**
     * 22 characters of continuous base64/hex is the floor for "this is a
     * per-recipient serial number". Shorter is plausibly a content hash or a
     * CDN cache key and is not evidence of anything.
     */
    private static boolean hasOpaqueToken(String s) {
        return s != null && s.matches("(?s).*(^|[/=_-])[A-Za-z0-9+/_-]{22,}={0,2}($|[/=_.&-]).*");
    }

    /**
     * One rule is a suspicion; agreement is what is worth reporting.
     * `pixelSized` and `invisible` are each conclusive alone — nothing
     * legitimate is 1x1 or fully transparent. The three URL-shaped rules are
     * circumstantial and are only called tracking when two of them agree.
     */
    private static boolean isTracker(List<String> rules) {
        if (rules.contains("pixelSized") || rules.contains("invisible")) return true;
        int circumstantial = 0;
        if (rules.contains("trackingPath")) circumstantial++;
        if (rules.contains("recipientToken")) circumstantial++;
        if (rules.contains("addressInUrl")) circumstantial++;
        return circumstantial >= 2;
    }

    // -----------------------------------------------------------------------
    //  Verdict JSON — the `ProxiedImage` shape
    // -----------------------------------------------------------------------

    private static JSONObject ok(String url, String mime, byte[] data,
                                 int width, int height, boolean transparent) throws Exception {
        List<String> rules = trackerRules(url, width, height, transparent);
        JSONObject o = new JSONObject();
        o.put("dataUri", "data:" + mime + ";base64,"
                + Base64.encodeToString(data, Base64.NO_WRAP));
        o.put("status", "ok");
        o.put("tracker", isTracker(rules));
        o.put("trackerRules", new JSONArray(rules));
        o.put("width", width);
        o.put("height", height);
        o.put("bytes", data.length);
        o.put("fromCache", false);
        return o;
    }

    static JSONObject blocked(String reason, String detail) {
        JSONObject o = new JSONObject();
        try {
            o.put("dataUri", JSONObject.NULL);
            // `refusedTarget` and `fetchFailed` mean the bytes never arrived,
            // which the reader is entitled to see as a different fact from
            // "arrived and was refused" — the same split the TypeScript
            // `failedImage` makes.
            boolean neverArrived = "refusedTarget".equals(reason) || "fetchFailed".equals(reason);
            o.put("status", neverArrived ? "failed" : "blocked");
            o.put("reason", reason);
            if (detail != null) o.put("detail", detail);
            o.put("tracker", false);
            o.put("trackerRules", new JSONArray());
            o.put("width", 0);
            o.put("height", 0);
            o.put("bytes", 0);
            o.put("fromCache", false);
        } catch (Throwable ignored) {
            // JSONObject.put only throws on a null key, which none of these are.
        }
        return o;
    }
}
