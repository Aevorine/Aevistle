package dev.aevistle.app;

import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

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

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must happen before super.onCreate() — the bridge builds its plugin
        // registry there, and anything registered afterwards is invisible to
        // the WebView.
        registerPlugin(AevistleNativePlugin.class);
        super.onCreate(savedInstanceState);
        recordPendingOpen(getIntent());
        applyWindowInsets();
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
    }

    private static void recordPendingOpen(Intent intent) {
        if (intent == null) return;
        String id = intent.getStringExtra(Notifier.EXTRA_MESSAGE_ID);
        if (id != null && !id.isEmpty()) pendingOpenMessageId = id;
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
     */
    private void applyWindowInsets() {
        View root = findViewById(android.R.id.content);
        if (root == null) return;
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            // Consumed: nothing below this view needs to inset itself again,
            // and letting the insets through would double the padding on the
            // WebView's own scrolling container.
            return WindowInsetsCompat.CONSUMED;
        });
        // The listener only fires on the next insets pass, which has usually
        // already happened by the time onCreate returns.
        ViewCompat.requestApplyInsets(root);
    }
}
