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

    private static final Pattern HTTP_URL = Pattern.compile("^https?://", Pattern.CASE_INSENSITIVE);

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
            } else {
                // cid: inline images and anything else unrecognised: dropped,
                // not resolved — same as the desktop sanitizer.
                img.removeAttr("src");
            }
        }

        JSONObject result = new JSONObject();
        result.put("html", doc.body().html());
        result.put("remoteImages", new JSONArray(remoteImages));
        return result;
    }
}
