import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { detectPlatform } from './core/platform/bridge'
import { installBackBridge } from './core/backStack'
import { installKeyboardInset } from './core/platform/keyboardInset'
import {
  MOBILE_SHELL_ATTR,
  MOBILE_SHELL_VALUE,
  NARROW_QUERY,
  SIZE_CLASS_ATTR,
  sizeClassFor,
} from './components/useNarrow'
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
 * The size tier, before the first paint, for the same reason and at the same
 * cost: `innerWidth` is a number the browser is already holding.
 *
 * `useSizeClass` keeps it in step afterwards. Setting it here matters because
 * the tier decides *density* — how much padding a card gets, how many columns a
 * list takes — and a card that paints one frame at desktop padding and then
 * snaps to phone padding is the same flinch the shell attribute above exists to
 * prevent, on the same cold start.
 */
document.documentElement.setAttribute(SIZE_CLASS_ATTR, sizeClassFor(window.innerWidth))

/**
 * Before the first render, for the same reason as the block above: the compose
 * screen sizes its message box against `--kb`, and a cold start straight into a
 * focused field would otherwise paint one frame at the wrong height.
 */
installKeyboardInset()

/**
 * And the back gesture, before the first render, for a sharper version of the
 * same reason: this one is not about a frame painted at the wrong size, it is
 * about the window in which an edge swipe still closes the application.
 *
 * `MainActivity` calls into this the moment the user swipes, which can be
 * during startup. Publishing it here means the bridge exists as early as any
 * script of ours runs; the handlers register as their surfaces mount. See
 * `core/backStack.ts`.
 */
installBackBridge()

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
