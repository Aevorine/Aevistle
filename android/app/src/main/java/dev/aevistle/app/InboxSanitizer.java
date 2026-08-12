package dev.aevistle.app;

import org.json.JSONArray;
import org.json.JSONObject;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.safety.Safelist;
import org.jsoup.select.Elements;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Received-mail HTML, sanitized before it ever reaches a WebView.
 *
 * Mirrors `electron/sanitizeHtml.ts` in intent — same tag allowlist, same
 * `javascript:`/`vbscript:` rejection via protocol restriction, same
 * blank-pixel-placeholder treatment for remote `<img>` sources, and — as of
 * the property-level {@link #filterStyle} pass below — the same seven-property
 * `style` allowlist (color, background-color, font-weight, font-style,
 * font-size, text-align, text-decoration). Jsoup's {@link Safelist} can only
 * allow or reject the whole `style` attribute, not individual CSS
 * *properties*, so `SAFELIST` allows it and {@link #filterStyle} does the
 * per-property filtering by hand afterwards — the same precision the desktop
 * sanitizer gets from the `sanitize-html` library's `allowedStyles`, applied
 * here so Android stops losing all inline color/alignment on every message
 * that uses it. `background-image` and every other `url(...)`-carrying
 * property stay excluded (same read-receipt/IP-leak reason as desktop), and a
 * same-element `color`/`background-color` match (the "hide this paragraph"
 * trick) is stripped rather than kept.
 */
final class InboxSanitizer {

    private static final String BLANK_PIXEL =
            "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

    /** Mirrors `INLINE_MARK` in `src/core/mail/remoteImagePlaceholder.ts`. */
    private static final String INLINE_MARK = "#cid=";

    private static final Pattern HTTP_URL = Pattern.compile("^https?://", Pattern.CASE_INSENSITIVE);
    private static final Pattern CID_URL = Pattern.compile("^cid:", Pattern.CASE_INSENSITIVE);

    /**
     * `encodeURIComponent`, character for character.
     *
     * Not {@code URLEncoder.encode}: that one is written for
     * `application/x-www-form-urlencoded` and turns a space into `+` while
     * leaving `*` alone — two differences that are invisible in a test with a
     * well-behaved Content-ID and produce a placeholder the renderer's
     * `decodeURIComponent` reads back as a different string the moment a
     * sender writes either character. The unreserved set below is the one
     * `encodeURIComponent` is specified to leave untouched.
     */
    private static String encodeComponent(String value) {
        StringBuilder out = new StringBuilder(value.length() + 8);
        byte[] bytes = value.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        for (byte raw : bytes) {
            int b = raw & 0xff;
            boolean unreserved =
                    (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9')
                            || b == '-' || b == '_' || b == '.' || b == '!' || b == '~'
                            || b == '*' || b == '\'' || b == '(' || b == ')';
            if (unreserved) {
                out.append((char) b);
            } else {
                out.append('%');
                out.append(Character.toUpperCase(Character.forDigit((b >> 4) & 0xf, 16)));
                out.append(Character.toUpperCase(Character.forDigit(b & 0xf, 16)));
            }
        }
        return out.toString();
    }

    /** Mirrors `normalizeCid` in `src/core/mail/remoteImagePlaceholder.ts`. */
    private static String normalizeCid(String raw) {
        String cid = raw.trim();
        if (cid.startsWith("<")) cid = cid.substring(1);
        if (cid.endsWith(">")) cid = cid.substring(0, cid.length() - 1);
        return cid.toLowerCase(java.util.Locale.ROOT);
    }

    /** Mirrors `ALLOWED_STYLES` in `electron/sanitizeHtml.ts` — same properties, same value patterns. */
    private static final Pattern COLOR_VALUE = Pattern.compile("^[a-zA-Z#][a-zA-Z0-9(),.%\\s#]*$");
    private static final Pattern FONT_WEIGHT_VALUE = Pattern.compile("^[a-zA-Z0-9]+$");
    private static final Pattern FONT_STYLE_VALUE = Pattern.compile("^[a-zA-Z]+$");
    private static final Pattern FONT_SIZE_VALUE = Pattern.compile("^[0-9.]+(px|pt|em|rem|%)$");
    private static final Pattern TEXT_ALIGN_VALUE = Pattern.compile("^(left|right|center|justify)$");
    private static final Pattern TEXT_DECORATION_VALUE = Pattern.compile("^[a-zA-Z\\s]+$");

    private static final Safelist SAFELIST = new Safelist()
            .addTags("a", "b", "strong", "i", "em", "u", "s", "strike", "p", "br", "hr",
                    "ul", "ol", "li", "dl", "dt", "dd",
                    "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption",
                    "div", "span", "blockquote", "pre", "code",
                    "h1", "h2", "h3", "h4", "h5", "h6",
                    "img", "font", "center", "small", "sub", "sup", "wbr")
            .addAttributes("a", "href", "title", "target")
            .addAttributes("img", "src", "alt", "width", "height")
            .addAttributes("font", "color", "size", "face")
            .addAttributes("table", "border", "cellpadding", "cellspacing", "width")
            .addAttributes("td", "colspan", "rowspan", "align", "valign", "width")
            .addAttributes("th", "colspan", "rowspan", "align", "valign", "width")
            .addAttributes(":all", "style")
            .addProtocols("a", "href", "http", "https", "mailto")
            .addProtocols("img", "src", "http", "https", "data");

    private InboxSanitizer() {
    }

    /**
     * Per-property `style` filtering Jsoup's {@link Safelist} cannot express —
     * see the class header. Returns the filtered declaration list (possibly
     * empty), joined back into a single `style` value.
     */
    private static String filterStyle(String rawStyle) {
        if (rawStyle == null || rawStyle.isEmpty()) return "";

        List<String> kept = new ArrayList<>();
        String colorValue = null;
        String bgValue = null;

        for (String decl : rawStyle.split(";")) {
            int colon = decl.indexOf(':');
            if (colon < 0) continue;
            String prop = decl.substring(0, colon).trim().toLowerCase();
            String value = decl.substring(colon + 1).trim();
            if (value.isEmpty()) continue;

            boolean allowed;
            switch (prop) {
                case "color":
                case "background-color":
                    allowed = COLOR_VALUE.matcher(value).matches();
                    break;
                case "font-weight":
                    allowed = FONT_WEIGHT_VALUE.matcher(value).matches();
                    break;
                case "font-style":
                    allowed = FONT_STYLE_VALUE.matcher(value).matches();
                    break;
                case "font-size":
                    allowed = FONT_SIZE_VALUE.matcher(value).matches();
                    break;
                case "text-align":
                    allowed = TEXT_ALIGN_VALUE.matcher(value).matches();
                    break;
                case "text-decoration":
                    allowed = TEXT_DECORATION_VALUE.matcher(value).matches();
                    break;
                default:
                    allowed = false;
            }
            if (!allowed) continue;

            String normalized = value.toLowerCase().replaceAll("\\s+", "");
            if (prop.equals("color")) colorValue = normalized;
            if (prop.equals("background-color")) bgValue = normalized;
            kept.add(prop + ": " + value);
        }

        // Same-element "hide this paragraph" trick: color and background-color
        // resolve to the same value. Only the same-element case — an inherited
        // background from a parent isn't visible to this per-element pass.
        if (colorValue != null && colorValue.equals(bgValue)) {
            kept.removeIf(d -> d.startsWith("color:") || d.startsWith("background-color:"));
        }

        return String.join("; ", kept);
    }

    /**
     * Returns `{ html, remoteImages }` — `remoteImages[i]` is the original URL
     * behind the placeholder `BLANK_PIXEL#i` in `html`, resolved later by the
     * shared `resolveRemoteImages()` in `src/core/remoteImagePlaceholder.ts`
     * once the user explicitly asks to load images for this message.
     */
    static JSONObject sanitize(String rawHtml) throws Exception {
        String cleaned = Jsoup.clean(rawHtml == null ? "" : rawHtml, "", SAFELIST);

        Document doc = Jsoup.parseBodyFragment(cleaned);
        List<String> remoteImages = new ArrayList<>();

        // SAFELIST let the raw `style` attribute through wholesale; narrow it
        // down to the seven-property allowlist (and strip the same-color
        // hiding trick) before this ever reaches a WebView.
        Elements styled = doc.select("[style]");
        for (Element el : styled) {
            String filtered = filterStyle(el.attr("style"));
            if (filtered.isEmpty()) {
                el.removeAttr("style");
            } else {
                el.attr("style", filtered);
            }
        }

        Elements images = doc.select("img[src]");
        for (Element img : images) {
            String src = img.attr("src");
            if (src.startsWith("data:image/")) continue;
            if (HTTP_URL.matcher(src).find()) {
                int index = remoteImages.size();
                remoteImages.add(src);
                img.attr("src", BLANK_PIXEL + "#" + index);
            } else if (CID_URL.matcher(src).find()) {
                // One of this message's own MIME parts. Parked on the same
                // blank pixel a blocked remote image gets, with a `#cid=`
                // fragment naming the part, and resolved by the renderer from
                // the attachment list — no network, no new scheme, and the
                // CSP and WebView settings untouched. See the long note in
                // `electron/sanitizeHtml.ts`, which this mirrors.
                //
                // A reference the renderer cannot match keeps the pixel, i.e.
                // it stays invisible — the same thing removing the `src` did
                // before this, rather than a broken-image icon.
                String cid = normalizeCid(src.substring(4));
                if (cid.isEmpty()) {
                    img.removeAttr("src");
                } else {
                    img.attr("src", BLANK_PIXEL + INLINE_MARK + encodeComponent(cid));
                }
            } else {
                // Anything else unrecognised: dropped, not resolved — same as
                // the desktop sanitizer.
                img.removeAttr("src");
            }
        }

        JSONObject result = new JSONObject();
        result.put("html", doc.body().html());
        result.put("remoteImages", new JSONArray(remoteImages));
        return result;
    }
}
