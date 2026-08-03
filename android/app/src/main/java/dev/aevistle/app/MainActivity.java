package dev.aevistle.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must happen before super.onCreate() — the bridge builds its plugin
        // registry there, and anything registered afterwards is invisible to
        // the WebView.
        registerPlugin(AevistleNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
