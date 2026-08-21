/**
 * Run `screen-title-probe.mjs` unattended — `npm run check:screen-titles`.
 *
 * Same launcher as `check-layout.mjs` and `check-ui-consistency.mjs`, for the
 * same reason: the claim is about what the cascade resolved to on a live
 * element in a phone-sized window, which no amount of reading the stylesheet
 * answers. A gate nothing starts is a gate that never runs.
 */

import { runProbeAgainstApp } from './lib/headless.mjs'

process.exit(await runProbeAgainstApp('scripts/screen-title-probe.mjs'))
