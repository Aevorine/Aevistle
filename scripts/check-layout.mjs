/**
 * Run `layout-probe.mjs` for real, unattended — `npm run check:layout`.
 *
 * The probe itself only talks CDP to a window that is already open (see its
 * own header for why: it has to measure a real engine's layout, not a
 * simulation of one). Nothing in `npm run check` used to start that window,
 * so the 85% requirement it asserts was only ever checked when a developer
 * remembered to run it by hand — which is exactly the failure mode that left
 * the requirement undocumented-and-unenforced for as long as it was.
 *
 * The launcher — Vite, headless Chrome, and the teardown of both — moved to
 * `lib/headless.mjs` when two more probes needed exactly the same thing.
 * Everything that used to be in this file, including every comment explaining
 * why a step is the shape it is, is there. One difference in behaviour: the
 * 5000ms settle this file used to sleep after Chrome's CDP port answered is now
 * 3000ms in the library, because `layout-probe.mjs` already polls for the app
 * with `waitForApp()` and the extra two seconds were a second belt on the same
 * pair of braces.
 */

import { runProbeAgainstApp } from './lib/headless.mjs'

process.exit(await runProbeAgainstApp('scripts/layout-probe.mjs'))
