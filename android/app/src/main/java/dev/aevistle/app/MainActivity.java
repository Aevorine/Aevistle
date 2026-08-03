package dev.aevistle.app;

import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must happen before super.onCreate() — the bridge builds its plugin
        // registry there, and anything registered afterwards is invisible to
        // the WebView.
        registerPlugin(AevistleNativePlugin.class);
        super.onCreate(savedInstanceState);
        applyWindowInsets();
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
