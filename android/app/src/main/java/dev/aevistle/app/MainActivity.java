package dev.aevistle.app;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.content.IntentCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "MainActivity";

    /**
     * The inbox message a tapped notification asked for, waiting to be
     * collected.
     *
     * Static because it has to outlive this activity's relationship with the
     * WebView in both directions. On a cold start the intent arrives in
     * {@code onCreate}, long before the page has loaded a line of JavaScript;
     * the page asks for it later through
     * {@code AevistleNativePlugin.takePendingOpen}. Deliberately *not* pushed
     * to the WebView as an event: the tap is frequently what starts the
     * process, and an event fired at a bridge that does not exist yet is the
     * silent no-op this codebase keeps finding.
     *
     * Only the newest is kept. Two taps before the page is ready still means
     * one message to open, and it is the one tapped last.
     */
    private static volatile String pendingOpenMessageId = null;

    /** Read and clear — the id is a one-shot request, not a state to poll. */
    static String takePendingOpenMessageId() {
        String id = pendingOpenMessageId;
        pendingOpenMessageId = null;
        return id;
    }

    /**
     * What another app shared with us, waiting to be collected.
     *
     * Same shape and same reasoning as {@code pendingOpenMessageId} directly
     * above, and for an even more clear-cut reason: a share is almost always a
     * cold start. The user is in a browser or a gallery, taps Share, picks
     * Aevistle, and the process does not exist yet — there is no WebView to
     * fire an event at, so the intent is parked here and
     * {@code AevistleNativePlugin.takePendingShare} hands it over when the page
     * asks.
     *
     * A {@link JSONObject} rather than the {@link Intent} itself. The framework
     * recycles and reuses Intent instances, and this reference can outlive the
     * dispatch that produced it by the whole of a cold start — reading extras
     * back out of it later is reading whatever the object holds by then.
     * Parsing at arrival makes the snapshot immutable.
     *
     * The one thing not resolved here is the attachment bytes: those need a
     * Context and disk I/O, so this carries the content URIs (under `uris`) and
     * the plugin copies them out. The read grant that came with the intent
     * belongs to this task and lasts as long as it does, so the copy has to
     * happen while the app is still up — which it always is by the time the
     * page polls.
     *
     * Only the newest is kept: two shares before the page is ready still means
     * one message to write, and it is the one shared last.
     */
    private static volatile JSONObject pendingShare = null;

    /** Read and clear — see {@link #takePendingOpenMessageId()}. */
    static JSONObject takePendingShare() {
        JSONObject share = pendingShare;
        pendingShare = null;
        return share;
    }

    /** The intent extra `res/xml/shortcuts.xml` attaches to each shortcut's launch intent. */
    private static final String EXTRA_SHORTCUT_ROUTE = "shortcutRoute";

    /**
     * Which long-press-icon shortcut was tapped, waiting to be collected.
     *
     * Same shape and same reasoning as {@link #pendingOpenMessageId}: a
     * shortcut tap routinely *is* the cold start — there is no WebView yet to
     * fire an event at, so the route is parked here and {@code
     * AevistleNativePlugin.takePendingShortcut} hands it over once the page
     * asks. Only the newest is kept, for the same reason as the other two:
     * two taps before the page is ready still means one place to land, and it
     * is wherever was tapped last.
     */
    private static volatile String pendingShortcutRoute = null;

    /** Read and clear — see {@link #takePendingOpenMessageId()}. */
    static String takePendingShortcutRoute() {
        String route = pendingShortcutRoute;
        pendingShortcutRoute = null;
        return route;
    }

    private static void recordPendingShortcut(Intent intent) {
        if (intent == null) return;
        String route = intent.getStringExtra(EXTRA_SHORTCUT_ROUTE);
        if (route != null && !route.isEmpty()) pendingShortcutRoute = route;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must happen before super.onCreate() — the bridge builds its plugin
        // registry there, and anything registered afterwards is invisible to
        // the WebView.
        registerPlugin(AevistleNativePlugin.class);
        super.onCreate(savedInstanceState);
        applyStartupBackground();
        recordPendingOpen(getIntent());
        recordPendingShare(getIntent());
        recordPendingShortcut(getIntent());
        applyWindowInsets();
        installBackGesture();
    }

    // -----------------------------------------------------------------------
    // The back gesture
    // -----------------------------------------------------------------------

    /**
     * Ask the page what a back press means before assuming it means "quit".
     *
     * ## What it did before
     *
     * Nothing claimed the gesture at all. Capacitor 8's {@code BridgeActivity}
     * registers no back callback of its own — there is no {@code onBackPressed}
     * anywhere in {@code @capacitor/android} — and this project deliberately
     * does not depend on {@code @capacitor/app}, which is where the
     * {@code backButton} event other Capacitor apps subscribe to comes from. So
     * an edge swipe fell through to the platform default for a root activity,
     * which is to finish it: one stray thumb on the edge of the screen closed
     * the application from any screen, over any dialog, mid-message.
     *
     * ## The contract
     *
     * {@code window.__aevistleBack()} (see {@code src/core/backStack.ts}) is
     * offered the press and answers whether it took it. {@code true} means the
     * page closed a dialog or stepped back a screen and this activity does
     * nothing; {@code false} means the user is on Home with nothing open, and
     * only then is the app allowed to close.
     *
     * ## Why an OnBackPressedCallback and not an onBackPressed() override
     *
     * {@code targetSdkVersion} is 36. Predictive back is on by default for
     * apps targeting 33+ and the manifest opt-out stops being honoured at 36,
     * which means the deprecated {@code onBackPressed()} override is not
     * reliably called at all on a current device. The dispatcher is the API
     * that is called in both worlds, and it is what makes the back *animation*
     * on Android 14+ show the right thing behind the gesture.
     *
     * ## Why the decision is asynchronous, and what happens if it never arrives
     *
     * {@code evaluateJavascript} hops to the WebView thread and answers through
     * a callback, so by the time the answer comes back the gesture is over.
     * That is fine — nothing was going to animate either way — but it does mean
     * this has to be total about failure: a null result (a WebView that is
     * tearing down), a bridge that has not loaded yet, an exception out of the
     * call itself. Every one of those paths exits, which is the behaviour the
     * app had before this method existed, so a broken bridge degrades to the
     * old bug rather than to an app that cannot be closed at all.
     */
    private void installBackGesture() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                askPageToGoBack(this);
            }
        });
    }

    /**
     * Put the question to the page, and close the app if the answer is no.
     *
     * The JavaScript is written so that *every* failure mode inside the page
     * produces {@code false} rather than an exception crossing the bridge: an
     * absent bridge (startup), a handler that threw (already caught on the
     * other side, but belt and braces), a non-boolean return. `String(...)`
     * rather than trusting the value's own serialisation, so the comparison
     * below is against a shape this expression guarantees.
     */
    private void askPageToGoBack(OnBackPressedCallback callback) {
        com.getcapacitor.Bridge bridge = getBridge();
        final WebView webView = bridge == null ? null : bridge.getWebView();
        if (webView == null) {
            leave(callback);
            return;
        }
        final String js =
                "(function(){try{"
                        + "return String(!!(window.__aevistleBack && window.__aevistleBack()))"
                        + "}catch(e){return 'false'}})()";
        try {
            webView.evaluateJavascript(js, value -> {
                // The value arrives JSON-encoded, so the string `true` is the
                // five characters "true" *including* the quotes.
                boolean handled = value != null && value.contains("true");
                if (!handled) leave(callback);
            });
        } catch (Exception e) {
            Log.w(TAG, "could not ask the page about the back gesture", e);
            leave(callback);
        }
    }

    /**
     * Let the press through to the platform, which closes the app.
     *
     * Disabling this activity's callback and re-dispatching, rather than
     * calling {@code finish()} directly: that hands the press back to whatever
     * the platform would have done with it, which is the right thing on a task
     * this activity may not be the only member of, and it keeps the exit
     * animation the system's rather than an abrupt teardown.
     *
     * The callback is left disabled. It is only ever reached when the app is
     * on its way out, and {@code onResume} re-arms it for the case where the
     * exit does not happen — a task the system chose to keep, or a launch
     * straight back into a still-live activity.
     */
    private void leave(OnBackPressedCallback callback) {
        callback.setEnabled(false);
        backCallback = callback;
        getOnBackPressedDispatcher().onBackPressed();
    }

    /** The callback {@link #leave} disarmed, so {@code onResume} can re-arm it. */
    private OnBackPressedCallback backCallback = null;

    /**
     * Paint the window and the WebView the app's own background before either
     * has anything else to draw.
     *
     * A WebView with no background set defaults to white, and the splash
     * theme (`AppTheme.NoActionBarLaunch`) only covers the gap up to this
     * activity's first frame — not the moment after that where the WebView
     * exists but has not yet loaded enough CSS to paint `--bg` itself. A dark
     * theme or a dark visual style loading into an unset white background is
     * exactly the flash `electron/main.ts` avoids by giving `BrowserWindow` a
     * `backgroundColor` before it ever shows a frame; this is the same fix
     * for the surface Android controls instead.
     *
     * The two colours are that same pair, not a colour read off `--bg` —
     * there is no page loaded yet to compute a CSS custom property from, and
     * six visual styles reduce to the same two families (light backgrounds,
     * dark backgrounds) for the one frame this covers. {@link
     * AppSettingsSignal} reads the same persisted theme choice the settings
     * screen writes, falling back to the device's own night mode for
     * `'system'` — the same fallback the CSS itself uses once it loads.
     */
    private void applyStartupBackground() {
        int color = AppSettingsSignal.isDarkTheme(this)
                ? android.graphics.Color.parseColor("#14161b")
                : android.graphics.Color.parseColor("#eceef1");
        getWindow().getDecorView().setBackgroundColor(color);
        com.getcapacitor.Bridge bridge = getBridge();
        android.webkit.WebView webView = bridge == null ? null : bridge.getWebView();
        if (webView != null) webView.setBackgroundColor(color);
    }

    /**
     * The warm path.
     *
     * `launchMode="singleTask"` (see the manifest) means a notification tap on
     * an already-running app arrives here rather than as a second
     * {@code onCreate}. Without this override the extra would be dropped and
     * the notification would merely raise the app — which is what it did
     * before, and is what "tapping it doesn't take me to the mail" meant.
     */
    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        recordPendingOpen(intent);
        recordPendingShare(intent);
        recordPendingShortcut(intent);
    }

    private static void recordPendingOpen(Intent intent) {
        if (intent == null) return;
        String id = intent.getStringExtra(Notifier.EXTRA_MESSAGE_ID);
        if (id != null && !id.isEmpty()) pendingOpenMessageId = id;
    }

    // -----------------------------------------------------------------------
    // Sharing in
    //
    // Everything below turns an incoming Intent into the `SharePayload` shape
    // declared in `src/core/types.ts`. It is deliberately total: an intent this
    // activity was started with that is not a share simply produces nothing,
    // because the same two entry points also carry the launcher tap, the OAuth
    // redirect and the notification tap.
    // -----------------------------------------------------------------------

    private static void recordPendingShare(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (action == null) return;

        JSONObject share = null;
        if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            share = fromSend(intent);
        } else if (Intent.ACTION_SENDTO.equals(action) || Intent.ACTION_VIEW.equals(action)) {
            // ACTION_VIEW also carries the OAuth redirect (`dev.aevistle.app://
            // oauth`), which Capacitor's own bridge handles. Only mailto is
            // ours, so the scheme is checked rather than the action alone.
            Uri data = intent.getData();
            if (data != null && "mailto".equalsIgnoreCase(data.getScheme())) share = fromMailto(data);
        }
        // A share that parsed to nothing at all — no address, no text, no file
        // — is not recorded. Otherwise a malformed `mailto:` would still yank
        // the user onto an empty compose screen on the next launch.
        if (share != null && share.length() > 0) pendingShare = share;
    }

    /**
     * ACTION_SEND / ACTION_SEND_MULTIPLE.
     *
     * The extras are conventions rather than a specification — `EXTRA_SUBJECT`
     * and `EXTRA_TEXT` are what every sharing app fills in, `EXTRA_EMAIL` and
     * friends only appear when the sender specifically meant mail — so every
     * one of them is optional and read defensively.
     *
     * {@code getCharSequenceExtra} rather than {@code getStringExtra} for the
     * two text fields: both are documented as CharSequence, and an app that
     * shares styled text puts a {@code Spanned} there. {@code getStringExtra}
     * returns null for that — the share would arrive with an empty body and no
     * hint why.
     */
    private static JSONObject fromSend(Intent intent) {
        JSONObject share = new JSONObject();
        try {
            putText(share, "subject", intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT));
            putText(share, "body", intent.getCharSequenceExtra(Intent.EXTRA_TEXT));
            putAddresses(share, "to", intent.getStringArrayExtra(Intent.EXTRA_EMAIL));
            putAddresses(share, "cc", intent.getStringArrayExtra(Intent.EXTRA_CC));
            putAddresses(share, "bcc", intent.getStringArrayExtra(Intent.EXTRA_BCC));

            /*
             * Attachments arrive by two routes and both have to be read.
             *
             * EXTRA_STREAM is the documented one — a single Uri for
             * ACTION_SEND, an ArrayList for ACTION_SEND_MULTIPLE. ClipData is
             * the one that actually carries the *grant*: `ShareCompat` and the
             * system share sheet mirror the streams into it so that
             * FLAG_GRANT_READ_URI_PERMISSION covers them, and some senders
             * populate only that. A LinkedHashSet merges the two without
             * attaching the same photo twice, and keeps the sender's order.
             */
            Set<String> uris = new LinkedHashSet<>();
            Uri single = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (single != null) uris.add(single.toString());
            ArrayList<Uri> many = IntentCompat.getParcelableArrayListExtra(
                    intent, Intent.EXTRA_STREAM, Uri.class);
            if (many != null) {
                for (Uri uri : many) if (uri != null) uris.add(uri.toString());
            }
            ClipData clip = intent.getClipData();
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) {
                    Uri uri = clip.getItemAt(i).getUri();
                    if (uri != null) uris.add(uri.toString());
                }
            }
            if (!uris.isEmpty()) share.put("uris", new JSONArray(new ArrayList<>(uris)));
        } catch (Exception e) {
            // Whatever parsed before the throw is kept and handed over. Half a
            // share — the subject without the attachment — is still better than
            // a compose screen that came up blank, and the alternative here is
            // to lose the lot over one hostile extra.
            Log.e(TAG, "fromSend: could not read the shared intent", e);
        }
        return share;
    }

    /**
     * A `mailto:` URI, per RFC 6068.
     *
     * `mailto:` is an *opaque* URI, so none of {@code Uri}'s path or query
     * accessors answer — {@code getQueryParameter} returns null on every one of
     * these. The scheme-specific part has to be split by hand: everything
     * before the first `?` is a comma-separated recipient list, everything
     * after it is `hfield=value` pairs.
     *
     * Percent-decoding, and only percent-decoding: RFC 6068 §2 requires a space
     * to be written `%20`, and a `+` in an address is a real character that
     * Gmail and others use for tagged addresses. Treating `+` as a space here —
     * the way an HTML form body would be decoded — would quietly rewrite
     * `me+news@example.com` into an address that does not exist.
     */
    private static JSONObject fromMailto(Uri data) {
        JSONObject share = new JSONObject();
        try {
            String rest = data.getSchemeSpecificPart();
            if (rest == null) return share;

            int mark = rest.indexOf('?');
            String recipients = mark < 0 ? rest : rest.substring(0, mark);
            String query = mark < 0 ? "" : rest.substring(mark + 1);

            putAddresses(share, "to", splitAddresses(Uri.decode(recipients)));

            for (String pair : query.split("&")) {
                if (pair.isEmpty()) continue;
                int equals = pair.indexOf('=');
                if (equals < 0) continue;
                // The field name is case-insensitive in RFC 6068; the value is
                // decoded, the name is not — a percent-escaped header name is
                // not something this app is going to honour.
                String field = pair.substring(0, equals).toLowerCase(java.util.Locale.ROOT);
                String value = Uri.decode(pair.substring(equals + 1));
                switch (field) {
                    case "subject":
                        putText(share, "subject", value);
                        break;
                    case "body":
                        putText(share, "body", value);
                        break;
                    case "to":
                        // A second `to=` adds to the address list rather than
                        // replacing it — RFC 6068 §5 allows both spellings in
                        // the same URI, and browsers emit them both.
                        mergeAddresses(share, "to", splitAddresses(value));
                        break;
                    case "cc":
                        mergeAddresses(share, "cc", splitAddresses(value));
                        break;
                    case "bcc":
                        mergeAddresses(share, "bcc", splitAddresses(value));
                        break;
                    default:
                        // Any other hfield — `in-reply-to`, or an arbitrary
                        // header a link author invented. Ignored on purpose: a
                        // link on a web page must not be able to set headers on
                        // mail this user has not written yet.
                        break;
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "fromMailto: could not read " + data, e);
        }
        return share;
    }

    /** Split a comma-separated address list, dropping empties and whitespace. */
    private static String[] splitAddresses(String list) {
        if (list == null || list.trim().isEmpty()) return null;
        List<String> out = new ArrayList<>();
        for (String part : list.split(",")) {
            String trimmed = part.trim();
            if (!trimmed.isEmpty()) out.add(trimmed);
        }
        return out.isEmpty() ? null : out.toArray(new String[0]);
    }

    /** Write a non-empty string, or leave the key absent. */
    private static void putText(JSONObject into, String key, CharSequence value) throws Exception {
        if (value == null) return;
        String text = value.toString();
        if (text.isEmpty()) return;
        into.put(key, text);
    }

    /** Write a non-empty address array, or leave the key absent. */
    private static void putAddresses(JSONObject into, String key, String[] values) throws Exception {
        if (values == null || values.length == 0) return;
        JSONArray array = new JSONArray();
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) array.put(value.trim());
        }
        if (array.length() > 0) into.put(key, array);
    }

    /** As {@link #putAddresses}, but appends to whatever is already under `key`. */
    private static void mergeAddresses(JSONObject into, String key, String[] values) throws Exception {
        if (values == null || values.length == 0) return;
        JSONArray array = into.optJSONArray(key);
        if (array == null) array = new JSONArray();
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) array.put(value.trim());
        }
        if (array.length() > 0) into.put(key, array);
    }

    /**
     * Keep the page out from under the status bar and the gesture handle.
     *
     * Android 15 made every app edge-to-edge whether it asked or not, so the
     * WebView is laid out behind the system bars. The page heading was being
     * drawn on top of the clock — verified on a device, not guessed.
     *
     * The obvious fix is `env(safe-area-inset-top)` in CSS, and the viewport
     * meta tag already carries `viewport-fit=cover` so it *ought* to work. It
     * resolved to zero: the WebView is only told about the cutout, not about
     * the system bars, so the CSS variable is there and empty. Padding the
     * view from here is the part Android will actually answer.
     *
     * Left and right insets are applied too, for a landscape phone with a
     * display cutout down one side.
     *
     * **The keyboard is deliberately NOT in this padding any more.**
     *
     * It was, for two releases, and that is what produced the bug this comment
     * now exists to prevent a fourth attempt at. The chain was: fold `ime()`
     * into the bottom padding, so the content view shrinks, so the WebView
     * shrinks, so `100dvh` shrinks, so `.shell` shrinks — and `.shell` is what
     * the phone's bottom tab bar is laid out inside. A keyboard-sized bottom
     * padding therefore lifts the five tabs a keyboard's height off the bottom
     * of the screen, and paints the strip below them in the app's own
     * background colour (see {@link #applyStartupBackground}), so the result
     * reads as a design rather than as a fault.
     *
     * That would be survivable if the padding always came back down. It does
     * not. `setPadding` is only ever reached from inside this listener, and
     * the listener only runs when Android chooses to deliver an insets pass.
     * Some OEM keyboards skip the final settle pass on close. When that
     * happens there is no second chance: the padding is permanent for the rest
     * of the session, on every screen, until the app is force-stopped.
     *
     * Two previous fixes both attacked the arithmetic — first clamping the
     * value to the system-bar floor, then guarding it behind `isVisible(ime())`
     * so a stale in-flight height could not be trusted. Neither could work,
     * because both still require a pass to arrive in order to lower anything.
     *
     * So the keyboard is now handled where it can be observed continuously
     * rather than only when the system volunteers: the height is *published*
     * to the page (see {@link #publishKeyboardInset}) and the web layer sizes
     * itself against it, cross-checked there against whether a text field is
     * actually focused. If this value ever sticks, the page can still tell that
     * nothing is focused and ignore it. The native window, meanwhile, stays the
     * full height of the screen at all times, so the tab bar cannot be lifted
     * off the bottom no matter what any of this gets wrong.
     *
     * The bottom padding is additionally capped at a quarter of the window.
     * Nothing legitimate — gesture handle, three-button bar, cutout — comes
     * close to that. It is a backstop against exactly the failure above ever
     * returning through some other route: a bug can now cost at most a strip,
     * never half the screen.
     */
    private void applyWindowInsets() {
        View root = findViewById(android.R.id.content);
        if (root == null) return;
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, windowInsets) -> {
            applyInsets(view, windowInsets);
            // Consumed: nothing below this view needs to inset itself again,
            // and letting the insets through would double the padding on the
            // WebView's own scrolling container.
            return WindowInsetsCompat.CONSUMED;
        });
        // The listener only fires on the next insets pass, which has usually
        // already happened by the time onCreate returns.
        ViewCompat.requestApplyInsets(root);
    }

    /**
     * The body of the insets listener, split out so the recovery path below can
     * run exactly the same arithmetic without waiting to be called.
     */
    private void applyInsets(View view, WindowInsetsCompat windowInsets) {
        Insets bars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
        int height = view.getHeight();
        int bottom = height > 0 ? Math.min(bars.bottom, height / 4) : bars.bottom;
        view.setPadding(bars.left, bars.top, bars.right, bottom);

        boolean imeVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime());
        int imeBottom = imeVisible ? windowInsets.getInsets(WindowInsetsCompat.Type.ime()).bottom : 0;
        // The window is already padded past the navigation bar, so the page
        // only needs the part of the keyboard that rises above it.
        publishKeyboardInset(Math.max(0, imeBottom - bottom));
    }

    /**
     * Re-read the insets from the window itself and re-apply them.
     *
     * {@link ViewCompat#getRootWindowInsets} reports what the window currently
     * holds, independently of the dispatch chain that {@code applyWindowInsets}
     * consumes — so this works even when the listener has not fired and would
     * not fire. That is the whole point: the padding now has a way back down
     * that does not depend on the system's cooperation.
     *
     * Called on every return to the foreground and on every focus gain, which
     * between them cover the cases the insets pass is known to miss: the app
     * backgrounded with the keyboard up, a gesture-back dismissal, and a warm
     * start through {@code onNewIntent} from a notification or a shortcut.
     */
    private void refreshWindowInsets() {
        View root = findViewById(android.R.id.content);
        if (root == null) return;
        WindowInsetsCompat current = ViewCompat.getRootWindowInsets(root);
        if (current != null) applyInsets(root, current);
        ViewCompat.requestApplyInsets(root);
    }

    /* `public`, not the `protected` that `Activity` declares: Capacitor's
       `BridgeActivity` widens it, and Java forbids an override from narrowing
       the visibility it inherits. */
    @Override
    public void onResume() {
        super.onResume();
        refreshWindowInsets();
        // Re-arm the back gesture if an exit was started and did not happen —
        // see {@link #leave}. Without this the *second* back press on a task
        // the system kept alive would fall through to the platform default,
        // which is the bug this whole section exists to end.
        if (backCallback != null) {
            backCallback.setEnabled(true);
            backCallback = null;
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Only on gain. A focus *loss* is the app going behind a dialog or the
        // recents screen, where the insets it would read are not the ones it
        // will come back to.
        if (hasFocus) refreshWindowInsets();
    }

    /**
     * The last keyboard height handed to the page, in CSS pixels.
     *
     * Kept so an unchanged value costs nothing: insets passes arrive in bursts
     * during a keyboard animation, and each one would otherwise be a separate
     * hop across the JavaScript bridge.
     *
     * {@code -1} rather than {@code 0}, so the first pass always publishes —
     * including the common one that publishes zero.
     */
    private int lastKeyboardCssPx = -1;

    /**
     * Tell the page how much of it the keyboard is covering.
     *
     * Converted to CSS pixels here rather than in the page: the density is
     * known on this side, and handing across a device-pixel figure that the
     * page would have to divide by a number it has to guess is how the two
     * sides drift apart.
     *
     * The receiving end is `window.__aevistleKeyboardInset` in
     * `src/core/keyboardInset.ts`. The `&&` guard covers the window between
     * the WebView existing and the bundle having run — an insets pass during
     * startup is normal, and an undefined function is not an error worth
     * logging.
     */
    private void publishKeyboardInset(int deviceBottom) {
        float density = getResources().getDisplayMetrics().density;
        int css = density > 0 ? Math.round(deviceBottom / density) : deviceBottom;
        if (css == lastKeyboardCssPx) return;
        lastKeyboardCssPx = css;
        com.getcapacitor.Bridge bridge = getBridge();
        final WebView webView = bridge == null ? null : bridge.getWebView();
        if (webView == null) return;
        final String js = "window.__aevistleKeyboardInset && window.__aevistleKeyboardInset(" + css + ")";
        webView.post(() -> {
            try {
                webView.evaluateJavascript(js, null);
            } catch (Exception e) {
                // Not fatal — the page has its own `visualViewport` fallback
                // and its own focus check. Logged rather than swallowed so a
                // bridge that is failing every time is visible in logcat.
                Log.w(TAG, "could not publish keyboard inset to the page", e);
            }
        });
    }
}
