import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { detectPlatform } from './core/bridge'
import { installKeyboardInset } from './core/keyboardInset'
import { MOBILE_SHELL_ATTR, MOBILE_SHELL_VALUE, NARROW_QUERY } from './components/useNarrow'
import './styles/theme.css'
import './styles/app.css'

/**
 * Answer "is this a touch shell?" before anything paints.
 *
 * `useMobileShell` keeps this attribute in step for the rest of the run, and on
 * its own that would be enough for every dialog a person opens — a React effect
 * has long since run by the time anyone taps anything. It is not enough for a
 * dialog that is already on screen *at* first paint, which the data-folder
 * prompt and the PIN entry both are on a cold start: those would render one
 * frame as a floating card and then snap to full screen, on the platform where
 * the fix was asked for.
 *
 * Cheap enough to do twice. `detectPlatform` reads two properties off `window`
 * (Capacitor injects its bridge before app scripts run — the same assumption
 * `getBridge` already makes), and `matchMedia` is a value the browser already
 * holds.
 */
if (
  detectPlatform() === 'android' ||
  (typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches)
) {
  document.documentElement.setAttribute(MOBILE_SHELL_ATTR, MOBILE_SHELL_VALUE)
}

/**
 * Before the first render, for the same reason as the block above: the compose
 * screen sizes its message box against `--kb`, and a cold start straight into a
 * focused field would otherwise paint one frame at the wrong height.
 */
installKeyboardInset()

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
