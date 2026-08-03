import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'dev.aevistle.app',
  appName: 'Aevistle',
  webDir: 'dist',

  android: {
    // The WebView loads from the app bundle over the capacitor:// scheme;
    // nothing is fetched over the network at runtime.
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },

  server: {
    androidScheme: 'https',
  },
}

export default config
