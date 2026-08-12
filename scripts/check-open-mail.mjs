/**
 * Run `open-mail-probe.mjs` for real, unattended — `npm run check:open-mail`.
 *
 * Same shape, and the same reason, as `check-layout.mjs`: the probe talks CDP
 * to a window that is already open, because the number it measures only exists
 * in a real engine. Nothing starts that window on its own, so a probe without
 * this wrapper is a probe that runs when somebody remembers — which is how the
 * 85% compose floor went unenforced for as long as it did, and how
 * `ui-consistency.mjs` sat outside the chain for six rounds.
 *
 * Wiring it into `npm run check` is the point of the file. A gate script that
 * exists but is never invoked is not a gate; it is a document.
 */

import { runProbeAgainstApp } from './lib/headless.mjs'

process.exit(await runProbeAgainstApp('scripts/open-mail-probe.mjs'))
