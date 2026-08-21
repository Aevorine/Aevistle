/**
 * Run `inbox-reader-probe.mjs` unattended — `npm run check:inbox-reader`.
 *
 * Same launcher as the other live gates. The probe needs a real engine for a
 * reason it states at length: the claim is "this region is not empty on
 * screen", which is a fact about a rendered box and about nothing else.
 */

import { runProbeAgainstApp } from './lib/headless.mjs'

process.exit(await runProbeAgainstApp('scripts/inbox-reader-probe.mjs'))
