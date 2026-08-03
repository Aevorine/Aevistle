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
 * blank-pixel-placeholder treatment for remote `<img>` sources — with one
 * deliberate narrowing: no `style` attribute at all. Jsoup's {@link Safelist}
 * can allow or reject an attribute wholesale but cannot filter individual CSS
 * *properties* the way the desktop's `allowedStyles` does (which keeps layout
 * properties but specifically omits `background-image` and anything else
 * that can carry a `url(...)`). Rather than hand-roll a CSS parser to get that
 * same precision here, dropping `style` outright is the safer trade — a
 * received message loses inline text color/alignment, not a security
 * boundary.
 */
final class InboxSanitizer {

    private static final String BLANK_PIXEL =
            "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

    private static final Pattern HTTP_URL = Pattern.compile("^https?://", Pattern.CASE_INSENSITIVE);

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
            .addProtocols("a", "href", "http", "https", "mailto")
            .addProtocols("img", "src", "http", "https", "data");

    private InboxSanitizer() {
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
