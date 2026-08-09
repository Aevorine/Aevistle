import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'dev.aevistle.app',
  appName: 'Aevistle',
  webDir: 'dist',

  android: {
    // The WebView loads from the app bundle over the capacitor:// scheme;
    // nothing is fetched over the network at runtime.
    allowMixedContent: false,
    /**
     * Off, and it must stay off. This was `true`, and it is the whole of the
     * "typing in one box empties the others" report.
     *
     * `captureInput` is Capacitor's hook for hardware keyboards and barcode
     * scanners, and the way it works is to hand the IME a
     * `BaseInputConnection(webView, false)` instead of the WebView's real one
     * (`CapacitorWebView.onCreateInputConnection`). `false` there means "not a
     * full editor": there is no editable buffer for the keyboard to compose
     * into, so Android falls back to delivering text as key events — and for
     * anything it cannot map to a keycode (a predicted word, any CJK
     * composition, an emoji) it sends `KeyEvent.ACTION_MULTIPLE`, which
     * Capacitor handles by running
     * `document.activeElement.value = document.activeElement.value + '…'`.
     *
     * That assignment writes straight into the DOM node. It fires no `input`
     * event, so React never learns the value exists. The box looks filled, the
     * component's state is still `''`, and the next render of *any* other field
     * — one keystroke in the password, a switch, the elapsed-seconds counter —
     * makes React reconcile every controlled input back to the state it holds
     * and the text vanishes. Hence the symmetry in the report: whichever field
     * you touch, the others empty, and it is the same for all of them.
     *
     * It also explains the second half of the report, that typing an address
     * filled nothing in: `AccountDialog`'s auto-configuration runs from
     * `onChange`, which under this setting never fires, so the provider, the
     * servers, the ports and the username were never derived at all.
     *
     * Nothing in `android/app/src/main/java` reads key events, so this option
     * was buying nothing and costing every text field in the app. Capacitor's
     * own default is `false`.
     */
    captureInput: false,
    webContentsDebuggingEnabled: false,
  },

  server: {
    androidScheme: 'https',
  },
}

export default config
