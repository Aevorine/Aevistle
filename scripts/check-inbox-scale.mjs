/**
 * Run `inbox-scale-probe.mjs` unattended — `npm run check:inbox-scale`.
 *
 * Same launcher as the other live gates. The probe's claims are about painted
 * rectangles in a *windowed* list — a size no other inbox gate seeds — so it
 * needs a real engine and a mailbox past `VirtualList`'s threshold.
 */

import { runProbeAgainstApp } from './lib/headless.mjs'

process.exit(await runProbeAgainstApp('scripts/inbox-scale-probe.mjs'))
