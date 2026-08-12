/**
 * Run `ui-consistency.mjs` for real, unattended — `npm run check:ui`.
 *
 * The probe measures the properties that make a set of screens read as one
 * product, and it has to do that in a real engine: "the card radius is
 * `--r-lg`" is a claim about what the cascade resolved to on a live element,
 * which no amount of reading the stylesheet answers.
 *
 * Until now nothing started that engine. The probe's header said to launch the
 * app by hand with `--remote-debugging-port=9445` first, and no `check:*`
 * script pointed at it — so the one gate in this repository whose stated
 * subject is 界面不统一 was never part of `npm run check`. Same launcher as
 * `check-layout.mjs`, from the same library, for the same reason.
 */

import { runProbeAgainstApp } from './lib/headless.mjs'

process.exit(await runProbeAgainstApp('scripts/ui-consistency.mjs'))
