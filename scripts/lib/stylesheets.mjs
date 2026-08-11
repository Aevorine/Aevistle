/**
 * Where the stylesheets are, for every script that reads them.
 *
 * This exists because splitting `app.css` into `app/*.css` silently blinded two
 * gates that had the old path spelled into them. Both kept passing — one
 * reported "187 tokens defined, all clear" against a file that by then held
 * twenty `@import` lines and nothing else. A check that cannot fail is worse
 * than no check, because it is quoted as evidence.
 *
 * So the paths are computed, once, here. A twentieth part file is picked up by
 * every consumer the moment it is written, and nothing has to remember to be
 * updated.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const STYLE_DIR = 'src/styles'
const APP_DIR = join(STYLE_DIR, 'app')
const INDEX = join(STYLE_DIR, 'app.css')

/**
 * The application stylesheet parts, in cascade order.
 *
 * Order is taken from the `@import` list in `app.css` rather than from the
 * filenames, because the cascade is what the imports say it is — a part renamed
 * out of numeric order would still load where the index puts it, and a checker
 * that sorted by name would then be reading a different stylesheet than the
 * browser does.
 */
export function appParts() {
  const index = readFileSync(INDEX, 'utf8')
  const imported = [...index.matchAll(/@import\s+['"]\.\/app\/([^'"]+)['"]/g)].map((m) => m[1])
  const onDisk = new Set(readdirSync(APP_DIR).filter((f) => f.endsWith('.css')))

  const missing = imported.filter((f) => !onDisk.has(f))
  if (missing.length) {
    throw new Error(`app.css imports files that do not exist: ${missing.join(', ')}`)
  }
  const orphans = [...onDisk].filter((f) => !imported.includes(f))
  if (orphans.length) {
    throw new Error(
      `src/styles/app/ holds files nothing imports: ${orphans.join(', ')}\n` +
        'An unimported part is dead weight that still reads as live code — add it ' +
        'to the @import list in app.css at the position its cascade needs, or delete it.',
    )
  }
  return imported.map((f) => join(APP_DIR, f))
}

/** theme.css, the app.css index, and every part — everything a browser loads. */
export function allStylesheets() {
  return [join(STYLE_DIR, 'theme.css'), INDEX, ...appParts()]
}

/** `[{ file, text }]`, in the order the browser sees them. */
export function readStylesheets(paths = allStylesheets()) {
  return paths.map((file) => ({ file, text: readFileSync(file, 'utf8') }))
}

/**
 * The application stylesheet as one string, exactly as the cascade resolves it.
 *
 * For checks that reason about "which rule wins" rather than about one file —
 * `check-visual-styles.mjs` reads it this way, because a `[data-style]` block in
 * part 19 overriding a base rule in part 3 is the whole point of that check and
 * neither part shows it alone.
 */
export function concatenatedAppCss() {
  return appParts().map((f) => readFileSync(f, 'utf8')).join('\n')
}
