/**
 * Bundle the Electron main process and preload script.
 *
 * esbuild rather than tsc: one command, no emitted directory tree to keep in
 * sync with `package.json#main`, and the preload ends up as a single file,
 * which matters because `sandbox: true` means the preload cannot `require`
 * anything that is not already bundled into it.
 */

import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outdir = path.join(root, 'dist-electron')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

mkdirSync(outdir, { recursive: true })

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  minify: process.env.NODE_ENV !== 'development',
  sourcemap: false,
  logLevel: 'info',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // `electron` is provided by the runtime. `nodemailer`, `imapflow`,
  // `mailparser` and `sanitize-html` stay external so they are resolved from
  // node_modules inside the packaged app — bundling them would break their
  // internal dynamic requires (mailparser's `iconv-lite` dependency loads
  // charset tables the same dynamic way nodemailer resolves its transports).
  external: ['electron', 'nodemailer', 'imapflow', 'mailparser', 'sanitize-html'],
}

await build({
  ...common,
  entryPoints: [path.join(root, 'electron', 'main.ts')],
  outfile: path.join(outdir, 'main.cjs'),
})

await build({
  ...common,
  entryPoints: [path.join(root, 'electron', 'preload.ts')],
  outfile: path.join(outdir, 'preload.cjs'),
  // A sandboxed preload has no module system of its own, so everything it
  // touches must be inlined here.
  external: ['electron'],
})

// A tiny package.json marking this directory CommonJS. Without it, the root
// "type": "module" would make Node treat a stray .js here as ESM.
writeFileSync(
  path.join(outdir, 'package.json'),
  JSON.stringify({ type: 'commonjs' }, null, 2),
)

// Verify rather than assume: a zero-byte bundle still exits 0 from esbuild if
// the entry point resolved to nothing useful.
for (const file of ['main.cjs', 'preload.cjs']) {
  const full = path.join(outdir, file)
  const { size } = statSync(full)
  if (size < 1024) {
    throw new Error(`${file} is only ${size} bytes — the bundle did not build correctly`)
  }
  console.log(`  ${file}  ${(size / 1024).toFixed(1)} KB`)
}
