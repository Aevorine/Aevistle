/**
 * Run `reader-meta-probe.mjs` for real, unattended — `npm run check:reader-meta`.
 *
 * The probe measures a live engine's layout of the reader's sender line, which
 * is the only way to see the defect it guards: every rule involved is correct
 * on its own, and what is wrong is what they sum to at 360px. See the probe's
 * own header. The launcher — Vite, headless Chrome and the teardown of both —
 * is shared with `check-layout.mjs`.
 */

import { runProbeAgainstApp } from './lib/headless.mjs'

process.exit(await runProbeAgainstApp('scripts/reader-meta-probe.mjs'))
