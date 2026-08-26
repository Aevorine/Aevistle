/**
 * Run `soak-probe.mjs` unattended — `npm run check:soak`.
 *
 * Minutes-long by design and therefore, like `check:perf`, not part of
 * `npm run check`: a soak that ran on every commit would be a soak nobody
 * waits for. `SOAK_MINUTES` stretches it when a longer look is wanted.
 */

import { runProbeAgainstApp } from './lib/headless.mjs'

process.exit(await runProbeAgainstApp('scripts/soak-probe.mjs'))
