/**
 * The regression suite for the five defects fixed on 2026-08-06.
 *
 * ## Why this lives in its own dependency island
 *
 * `tests/package.json` carries `@playwright/test` instead of the repository
 * root doing so, and that is deliberate rather than tidy-minded. Adding a
 * devDependency at the root rewrites `package-lock.json`, and the root lockfile
 * is the one file every other worktree in this repository is also holding open.
 * A browser test suite is not worth a merge conflict in the file that decides
 * what the *product* is built from — so it gets `tests/node_modules`, which
 * `.gitignore`'s blanket `node_modules/` already covers at any depth, and the
 * root tree is untouched.
 *
 * The version pin (1.61.1) is not arbitrary either: it is the release whose
 * Chromium revision (1228) is already in the machine's `ms-playwright` cache,
 * so `npm install` here downloads three small packages and no browser.
 *
 * ## Why there is normally no `webServer`
 *
 * These tests drive the *dev* server, because that is the only place the web
 * bridge's `localStorage` persistence — which is how every fixture below is
 * seeded — is reachable without packaging an Electron or Android build. During
 * development a dev server is already running and starting a second one on the
 * same port fails; under CI nothing is running, so one is started. Hence the
 * conditional: local runs attach to whatever is on 5199, CI brings its own.
 *
 * `127.0.0.1` and not `localhost`: Vite binds IPv6 first on this machine, and
 * `localhost` resolves to `::1` for Node and `127.0.0.1` for Chromium often
 * enough to make "works for me" a coin toss.
 */

import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.AEVISTLE_E2E_PORT ?? 5199)
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './e2e',
  // Every spec seeds its own `localStorage` and reloads, so nothing here shares
  // state. Full parallelism is safe and the whole suite is a few seconds.
  fullyParallel: true,
  // A failing regression test is the point of this suite; retrying one until it
  // passes would hide exactly the flake-shaped bug it exists to catch.
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    // The app writes to `localStorage` on a 350 ms debounce; a trace on failure
    // is the only way to tell "never written" from "written and then swept".
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  ...(process.env.CI
    ? {
        webServer: {
          command: `npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
          cwd: '..',
          url: BASE_URL,
          reuseExistingServer: false,
          timeout: 120_000,
        },
      }
    : {}),
})
