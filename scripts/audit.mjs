/**
 * Aevistle self-audit — `npm run audit:self`
 *
 * A short, opinionated security check aimed at the things that actually go
 * wrong in an app like this one, in rough order of how much damage they do:
 *
 *   1. a credential committed to git
 *   2. an Electron renderer with Node access
 *   3. header injection reaching the SMTP socket
 *   4. an Android component any other app can trigger
 *   5. plaintext transport quietly becoming the default
 *
 * It is deliberately not a generic linter. Every check below corresponds to a
 * concrete way this program could hurt the person running it, and every
 * failure message says what to do about it.
 *
 * Exit code 0 = clean or advisories only, 1 = at least one real finding.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const findings = []
let checksRun = 0

function check(id, title, fn) {
  checksRun++
  try {
    const result = fn()
    if (result) findings.push({ id, title, ...result })
  } catch (e) {
    findings.push({
      id,
      title,
      severity: 'error',
      detail: `The check itself failed: ${e instanceof Error ? e.message : String(e)}`,
      fix: 'This is a bug in the audit script, not necessarily in the app.',
    })
  }
}

function read(relative) {
  const full = path.join(ROOT, relative)
  return existsSync(full) ? readFileSync(full, 'utf8') : null
}

function walk(dir, extensions, out = []) {
  const full = path.join(ROOT, dir)
  if (!existsSync(full)) return out
  for (const entry of readdirSync(full)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'build') continue
    const rel = path.join(dir, entry)
    const abs = path.join(ROOT, rel)
    if (statSync(abs).isDirectory()) walk(rel, extensions, out)
    else if (extensions.some((e) => entry.endsWith(e))) out.push(rel)
  }
  return out
}

// ---------------------------------------------------------------------------
// 1. Secrets
// ---------------------------------------------------------------------------

/**
 * Patterns that mean "this is a live credential", not "this string mentions a
 * password". Deliberately narrow: an audit that cries wolf gets ignored, and
 * an ignored audit is worth nothing.
 */
const SECRET_PATTERNS = [
  { name: 'private key block', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
]

/**
 * `password = "..."` style assignments, checked separately because the naive
 * version of this rule is the single biggest source of false positives in
 * every secret scanner. An IPC channel named `setSecret: 'aevistle:set-secret'`
 * is not a credential, and a scanner that says it is trains you to ignore it.
 *
 * So the literal is only reported when it does *not* look like an identifier
 * (`some.thing`, `kebab-case`, `snake_case`, `a/b`) and does carry enough
 * character variety to plausibly be a real secret.
 */
const ASSIGNMENT_RE = /\b(password|passwd|secret|token|apikey|api_key)\w*\s*[:=]\s*(['"])([^'"\s]{10,})\2/gi
const IDENTIFIER_SHAPE = /^[a-z][a-z0-9]*([:._/\-][a-z0-9]+)*$/

function looksLikeRealSecret(value) {
  if (IDENTIFIER_SHAPE.test(value)) return false

  // Shannon entropy per character; anything under ~3 bits reads as a word or
  // a dotted identifier rather than a generated credential.
  const counts = new Map()
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let entropy = 0
  for (const n of counts.values()) {
    const p = n / value.length
    entropy -= p * Math.log2(p)
  }

  const mixedCase = /[a-z]/.test(value) && /[A-Z]/.test(value)
  const hasDigit = /[0-9]/.test(value)

  return entropy >= 3.4 || (mixedCase && hasDigit && value.length >= 12)
}

const SECRET_ALLOWLIST = [
  // The code that *handles* passwords necessarily names them.
  'src/core/types.ts',
  'src/core/mail/validate.ts',
  'src/core/platform/bridge.ts',
  'scripts/audit.mjs',
]

check('SEC-01', 'No credentials in tracked source', () => {
  const files = [
    ...walk('src', ['.ts', '.tsx']),
    ...walk('electron', ['.ts']),
    ...walk('scripts', ['.mjs', '.py', '.ps1']),
    ...walk('android/app/src', ['.java', '.xml', '.gradle']),
    'package.json',
    'capacitor.config.ts',
    'electron-builder.yml',
  ].filter((f) => existsSync(path.join(ROOT, f)))

  const hits = []
  for (const file of files) {
    if (SECRET_ALLOWLIST.includes(file.replace(/\\/g, '/'))) continue
    const text = readFileSync(path.join(ROOT, file), 'utf8')
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(text)) hits.push(`${file} — ${name}`)
    }
    for (const match of text.matchAll(ASSIGNMENT_RE)) {
      const value = match[3]
      if (looksLikeRealSecret(value)) {
        hits.push(`${file} — hard-coded ${match[1].toLowerCase()} (${value.length} chars)`)
      }
    }
  }

  if (hits.length === 0) return null
  return {
    severity: 'critical',
    detail: hits.join('\n           '),
    fix: 'Remove the value, rotate it, and load it from the OS keystore or an environment variable instead.',
  }
})

check('SEC-02', 'Signing keys and local config are git-ignored', () => {
  const ignore = read('.gitignore') ?? ''
  // `gpg.properties` and `*.asc` joined this list when release signing did.
  // They live outside the working tree, so git cannot reach them anyway — this
  // is the second line, for a key copied in by hand or exported into the repo
  // during a debugging session.
  const required = [
    '*.jks',
    '*.keystore',
    'keystore.properties',
    'gpg.properties',
    '*.asc',
    'local.properties',
    '.env',
  ]
  const missing = required.filter((pattern) => !ignore.includes(pattern))
  if (missing.length === 0) return null
  return {
    severity: 'critical',
    detail: `.gitignore does not cover: ${missing.join(', ')}`,
    fix: 'Add those patterns before the next commit — a leaked signing key cannot be un-leaked.',
  }
})

check('SEC-03', 'Nothing sensitive is currently staged in git', () => {
  let tracked = ''
  try {
    tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return { severity: 'info', detail: 'Not a git repository yet — nothing to check.', fix: '' }
  }
  const dangerous = tracked
    .split('\n')
    .map((f) => f.trim())
    .filter((f) =>
      /(^|\/)(\.env|local\.properties|keystore\.properties|secrets\.json|state\.json)$/.test(f) ||
      /\.(jks|keystore|p12|pfx|pem|key)$/.test(f),
    )
  if (dangerous.length === 0) return null
  return {
    severity: 'critical',
    detail: dangerous.join('\n           '),
    fix: 'git rm --cached those files, add them to .gitignore, then rotate whatever they contained.',
  }
})

// ---------------------------------------------------------------------------
// 2. Electron hardening
// ---------------------------------------------------------------------------

check('ELE-01', 'Renderer has no Node access', () => {
  const main = read('electron/main.ts')
  if (!main) return { severity: 'error', detail: 'electron/main.ts is missing.', fix: '' }

  const problems = []
  if (!/contextIsolation:\s*true/.test(main)) problems.push('contextIsolation is not explicitly true')
  if (!/nodeIntegration:\s*false/.test(main)) problems.push('nodeIntegration is not explicitly false')
  if (!/sandbox:\s*true/.test(main)) problems.push('sandbox is not enabled')
  if (/webSecurity:\s*false/.test(main)) problems.push('webSecurity is disabled')
  if (/webviewTag:\s*true/.test(main)) problems.push('the <webview> tag is enabled')

  if (problems.length === 0) return null
  return {
    severity: 'critical',
    detail: problems.join('\n           '),
    fix: 'Any one of these lets a cross-site scripting bug in the UI become full code execution on the machine.',
  }
})

check('ELE-02', 'External navigation is refused', () => {
  const main = read('electron/main.ts') ?? ''
  const hasWindowOpenHandler = /setWindowOpenHandler/.test(main)
  const hasNavigationGuard = /will-navigate/.test(main)
  const validatesProtocol = /protocol\s*!==\s*'https:'|protocol\s*!==\s*'http:'/.test(main)

  const problems = []
  if (!hasWindowOpenHandler) problems.push('window.open is not intercepted')
  if (!hasNavigationGuard) problems.push('will-navigate is not guarded')
  if (!validatesProtocol) problems.push('openExternal does not restrict the URL scheme')

  if (problems.length === 0) return null
  return {
    severity: 'high',
    detail: problems.join('\n           '),
    fix: 'Without these a crafted link can open a privileged window or hand a file:// URL to the OS.',
  }
})

check('ELE-03', 'Content Security Policy is present and strict', () => {
  const raw = read('index.html')
  if (!raw) return { severity: 'error', detail: 'index.html is missing.', fix: '' }
  /*
   * Comments stripped before anything is matched. The policy is documented in
   * an HTML comment directly above itself, and that comment names the same
   * directives it explains — so a scan of the raw file reads the *prose* first
   * and reports on a sentence rather than on the policy. Which it did: a
   * paragraph describing `frame-src` was flagged as allowing remote frames.
   */
  const html = raw.replace(/<!--[\s\S]*?-->/g, '')
  if (!/Content-Security-Policy/i.test(html)) {
    return {
      severity: 'high',
      detail: 'No CSP meta tag.',
      fix: 'Add one; it is the cheapest defence against injected markup in a message body.',
    }
  }
  const problems = []
  if (/script-src[^;]*'unsafe-inline'/.test(html)) problems.push("script-src allows 'unsafe-inline'")
  if (/script-src[^;]*'unsafe-eval'/.test(html)) problems.push("script-src allows 'unsafe-eval'")
  if (!/object-src\s+'none'/.test(html)) problems.push("object-src is not 'none'")

  /*
   * `frame-ancestors` used to be required here. It is *ignored* when the
   * policy arrives in a <meta> tag — the browser logs a warning saying so on
   * every single load — so the assertion was demanding a directive that could
   * never do anything, and passing it proved nothing. A check that cannot
   * fail for the right reason is worse than no check: it spends the reader's
   * confidence without buying any.
   *
   * What is worth asserting is that frames cannot come from the network. The
   * attachment preview needs `data:` (a sandboxed, opaque-origin frame with no
   * script), and that is the whole of the legitimate use.
   */
  const frameSrc = /frame-src([^;]*);/.exec(html)?.[1]?.trim()
  if (!frameSrc) {
    problems.push('frame-src is not set')
  } else if (/\*|https?:/.test(frameSrc)) {
    problems.push(`frame-src allows remote frames: ${frameSrc}`)
  }

  if (problems.length === 0) return null
  return { severity: 'medium', detail: problems.join('\n           '), fix: 'Tighten the policy in index.html.' }
})

check('ELE-04', 'No eval or raw HTML injection in the renderer', () => {
  const files = [...walk('src', ['.ts', '.tsx']), ...walk('electron', ['.ts'])]
  const hits = []
  for (const file of files) {
    const text = readFileSync(path.join(ROOT, file), 'utf8')
    if (/\beval\s*\(/.test(text)) hits.push(`${file} — eval()`)
    if (/dangerouslySetInnerHTML/.test(text)) hits.push(`${file} — dangerouslySetInnerHTML`)
    if (/\.innerHTML\s*=/.test(text)) hits.push(`${file} — innerHTML assignment`)
    if (/new Function\s*\(/.test(text)) hits.push(`${file} — new Function()`)
  }
  if (hits.length === 0) return null
  return {
    severity: 'high',
    detail: hits.join('\n           '),
    fix: 'A subject line or template body reaching any of these becomes script execution.',
  }
})

// ---------------------------------------------------------------------------
// 3. Mail-specific
// ---------------------------------------------------------------------------

check('MAIL-01', 'Header injection is blocked on both platforms', () => {
  const validate = read('src/core/mail/validate.ts') ?? ''
  const mailer = read('electron/mailer.ts') ?? ''
  const android = read('android/app/src/main/java/dev/aevistle/app/MailSender.java') ?? ''

  const problems = []
  if (!/\\r\\n/.test(validate) && !/\\u000b/.test(validate)) {
    problems.push('src/core/mail/validate.ts does not reject CR/LF in header fields')
  }
  if (!/isHeaderSafe|assertSafeDraft/.test(mailer)) {
    problems.push('electron/mailer.ts does not re-validate headers before sending')
  }
  if (android && !/CONTROL_CHARS|headerSafe/.test(android)) {
    problems.push('the Android sender does not reject control characters')
  }
  if (problems.length === 0) return null
  return {
    severity: 'critical',
    detail: problems.join('\n           '),
    fix: 'A newline inside a subject or address lets an attacker append their own headers and relay mail through this app.',
  }
})

check('MAIL-02', 'TLS verification is on unless explicitly disabled', () => {
  const mailer = read('electron/mailer.ts') ?? ''
  const problems = []
  if (/rejectUnauthorized:\s*false/.test(mailer)) {
    problems.push('rejectUnauthorized is hard-coded to false')
  }
  if (!/rejectUnauthorized:\s*!/.test(mailer)) {
    problems.push('certificate verification is not tied to the per-account setting')
  }
  if (!/minVersion:\s*'TLSv1\.2'/.test(mailer)) {
    problems.push('no minimum TLS version is pinned')
  }
  if (problems.length === 0) return null
  return {
    severity: 'high',
    detail: problems.join('\n           '),
    fix: 'Without verification anyone on the same network can read the SMTP password.',
  }
})

check('MAIL-03', 'Attachment paths are resolved and bounded', () => {
  const mailer = read('electron/mailer.ts') ?? ''
  const problems = []
  if (!/path\.resolve/.test(mailer)) problems.push('attachment paths are not resolved before use')
  if (!/basename/.test(mailer)) problems.push('the declared filename is not stripped of directory parts')
  if (!/ABSOLUTE_MAX_BYTES|maximum total size/.test(mailer)) problems.push('no total size ceiling')
  if (problems.length === 0) return null
  return {
    severity: 'medium',
    detail: problems.join('\n           '),
    fix: 'A saved job is just JSON; if it ever comes from elsewhere its paths are attacker-controlled.',
  }
})

// ---------------------------------------------------------------------------
// 3b. Inbox (IMAP receiving)
// ---------------------------------------------------------------------------

check('INBOX-01', 'Received-mail HTML is sanitized to a strict allowlist', () => {
  const sanitizer = read('electron/sanitizeHtml.ts')
  if (!sanitizer) return { severity: 'info', detail: 'No inbox pipeline yet.', fix: '' }

  const problems = []
  if (!/from ['"]sanitize-html['"]/.test(sanitizer)) {
    problems.push('sanitize-html is not imported — is HTML actually being sanitized?')
  }
  const allowedTagsLiteral = sanitizer.match(/ALLOWED_TAGS\s*=\s*\[([\s\S]*?)\]/)
  if (!allowedTagsLiteral) {
    problems.push('no ALLOWED_TAGS array literal found — verify the tag allowlist by hand')
  } else {
    for (const tag of ['script', 'iframe', 'object', 'embed', 'form', 'style', 'link', 'meta']) {
      if (new RegExp(`['"]${tag}['"]`).test(allowedTagsLiteral[1])) {
        problems.push(`'${tag}' appears inside the allowlist — it must never be allowed in received mail`)
      }
    }
  }
  if (!/allowedSchemes|javascript:|vbscript:/.test(sanitizer)) {
    problems.push('no scheme restriction found — a javascript: href could survive sanitization')
  }
  const inboxView = read('src/views/InboxView.tsx') ?? ''
  if (/dangerouslySetInnerHTML|\.innerHTML\s*=/.test(inboxView)) {
    problems.push('InboxView.tsx renders raw HTML directly instead of through the sandboxed iframe')
  }
  if (problems.length === 0) return null
  return {
    severity: 'critical',
    detail: problems.join('\n           '),
    fix: 'A message body is attacker-controlled by definition — the allowlist is the only thing standing between a crafted email and script execution.',
  }
})

check('INBOX-02', 'CSP img-src still blocks silent remote image loads', () => {
  const html = read('index.html')
  if (!html) return { severity: 'error', detail: 'index.html is missing.', fix: '' }
  const match = html.match(/img-src\s+([^;]+);/)
  if (!match) {
    return {
      severity: 'high',
      detail: 'No img-src directive in the CSP — it inherits default-src, which may be permissive.',
      fix: "Pin img-src explicitly to 'self' data: blob: so a remote <img> can only ever be the resolved data: URI the inbox code produces on demand.",
    }
  }
  const sources = match[1].trim()
  if (/https?:|\*/.test(sources)) {
    return {
      severity: 'high',
      detail: `img-src allows remote loading: ${sources}`,
      fix: 'This would let a received message load a tracking pixel directly, bypassing the placeholder-and-explicit-fetch design entirely.',
    }
  }
  return null
})

check('INBOX-03', 'IMAP credentials use a separate keystore namespace from SMTP', () => {
  const store = read('electron/store.ts')
  if (!store) return { severity: 'info', detail: 'No inbox pipeline yet.', fix: '' }
  if (!/function secretKey/.test(store)) {
    return {
      severity: 'high',
      detail: 'No secretKey() namespacing helper found in electron/store.ts.',
      fix: "An account's IMAP password would overwrite its SMTP password (or vice versa) under the same keystore entry.",
    }
  }
  if (!/kind === 'smtp'[\s\S]{0,40}:\s*`\$\{accountId\}:\$\{kind\}`|accountId\s*:\s*`\$\{accountId\}:\$\{kind\}`/.test(store)) {
    return {
      severity: 'medium',
      detail: 'secretKey() exists but its imap-vs-smtp branching looks different than expected — verify by hand.',
      fix: '',
    }
  }
  return null
})

check('INBOX-04', 'revealPath cannot escape the data folder', () => {
  const main = read('electron/main.ts')
  if (!main) return { severity: 'error', detail: 'electron/main.ts is missing.', fix: '' }
  const handler = main.match(/ipcMain\.handle\(IPC\.revealPath[\s\S]*?\}\)/)
  if (!handler) {
    return { severity: 'info', detail: 'revealPath is not registered.', fix: '' }
  }
  if (!/isInside/.test(handler[0])) {
    return {
      severity: 'high',
      detail: 'The revealPath handler does not call isInside() before shell.showItemInFolder.',
      fix: 'A renderer-supplied path like "../../../Windows" would otherwise be opened directly — confine it to dataLocation() first.',
    }
  }
  return null
})

check('INBOX-05', 'Remote-image fetch blocks private addresses given as literal IPs', () => {
  const remote = read('electron/remoteImage.ts')
  if (!remote) return { severity: 'info', detail: 'No inbox pipeline yet.', fix: '' }

  const problems = []

  // The lookup hook only fires for hosts that need resolving. A URL that
  // already contains an IP goes straight to connect(), so it needs its own
  // check — measured: a loopback URL returned 200 with the hook in place.
  if (!/net\.isIP\(/.test(remote) || !/isDisallowedAddress\(host\)/.test(remote)) {
    problems.push(
      'no literal-IP check before the request — <img src="http://127.0.0.1/..."> bypasses safeLookup entirely',
    )
  }

  // Happy-eyeballs calls the hook with {all:true} and reads addresses[0].address.
  // Answering with a bare string there fails every fetch with
  // ERR_INVALID_IP_ADDRESS, which reads as "the network is broken".
  if (!/options\?\.all/.test(remote)) {
    problems.push(
      'safeLookup ignores the `all` option — autoSelectFamily expects an array and will get undefined',
    )
  }

  if (problems.length > 0) {
    return {
      severity: 'high',
      detail: problems.join('; '),
      fix: 'Reject literal private/loopback hosts up front, and answer safeLookup in whichever shape the caller asked for.',
    }
  }
  return null
})

check('INBOX-06', 'Remote-image private-address filter covers CGNAT, benchmarking, multicast and reserved ranges', () => {
  const remote = read('electron/remoteImage.ts')
  if (!remote) return { severity: 'info', detail: 'No inbox pipeline yet.', fix: '' }
  const problems = []
  if (!/a === 100 && b >= 64 && b <= 127/.test(remote)) problems.push('100.64.0.0/10 (CGNAT) is not blocked')
  if (!/a === 198 && \(b === 18/.test(remote)) problems.push('198.18.0.0/15 (benchmarking) is not blocked')
  if (!/a >= 224 && a <= 239/.test(remote)) problems.push('224.0.0.0/4 (multicast) is not blocked')
  if (!/a >= 240/.test(remote)) problems.push('240.0.0.0/4 (reserved) is not blocked')
  if (problems.length === 0) return null
  return {
    severity: 'medium',
    detail: problems.join('; '),
    fix: 'Add the missing range(s) to isDisallowedAddress() in electron/remoteImage.ts.',
  }
})

check('INBOX-07', "Remote-image fetch validates the server's Content-Type against a strict allowlist", () => {
  const remote = read('electron/remoteImage.ts')
  if (!remote) return { severity: 'info', detail: 'No inbox pipeline yet.', fix: '' }
  if (/contentType\.startsWith\('image\/'\)/.test(remote)) {
    return {
      severity: 'high',
      detail:
        'the raw Content-Type header is trusted with a prefix check and embedded verbatim in the data: URI — a hostile server can put arbitrary characters after "image/"',
      fix: 'Strip parameters, lowercase, and test against /^image\\/[a-z0-9][a-z0-9.+-]{0,127}$/ before using the value.',
    }
  }
  if (!/\^image\\\/\[a-z0-9\]/.test(remote)) {
    return {
      severity: 'high',
      detail: 'no strict MIME-type allowlist regex found guarding the fetched Content-Type.',
      fix: 'Validate the Content-Type against a strict image/<token> regex before building the data: URI.',
    }
  }
  return null
})

check('INBOX-08', 'resolveRemoteImages re-validates the data URI before splicing into sanitized HTML', () => {
  const placeholder = read('src/core/mail/remoteImagePlaceholder.ts')
  if (!placeholder) return { severity: 'info', detail: 'No inbox pipeline yet.', fix: '' }
  /*
   * Two conditions, and both are about what the code *does*.
   *
   * This used to require the literal `dataUri && …test(dataUri)`, which is a
   * test of a variable's name. The round that gave the in-place image swap its
   * own path factored the same check into an exported `safeImageDataUri(value)`
   * so both paths could not drift apart — strictly better, and it failed this
   * rule, which then reported HTML injection against code that validates. A
   * gate that fails on a rename and passes on a rewrite is not guarding the
   * thing it names.
   *
   * So: the pattern has to exist, and every splice has to go through it —
   * either inline or through the shared helper. Verified to still fail by
   * deleting the guard from `resolveRemoteImages` and re-running.
   */
  const guards = /DATA_IMAGE_URI\s*=/.test(placeholder)
  /*
   * Just this function's body, and that bound is the whole check.
   *
   * Slicing from the declaration to end-of-file passed with the guard deleted:
   * `safeImageDataUri(` also appears in the `cid:` splice further down, so the
   * pattern matched a *different* function and the rule could not fail. Caught
   * by deleting the guard and re-running, which is the only way this kind of
   * mistake ever shows up.
   */
  const from = placeholder.indexOf('function resolveRemoteImages')
  const after = placeholder.indexOf('\n}', from)
  const body = from < 0 ? '' : placeholder.slice(from, after < 0 ? undefined : after)
  const validated = /safeImageDataUri\(|DATA_IMAGE_URI\.test\(/.test(body)
  if (!guards || !validated) {
    return {
      severity: 'high',
      detail:
        'resolveRemoteImages() splices a fetched value straight back into already-sanitized HTML with no format check of its own — a bug anywhere upstream (or a future change to the fetch path) becomes HTML injection with no second gate to catch it.',
      fix: 'Validate each resolved[i] against /^data:image\\/[a-z0-9][a-z0-9.+-]{0,127};base64,[A-Za-z0-9+/=]+$/ and fall back otherwise.',
    }
  }
  return null
})

// ---------------------------------------------------------------------------
// 4. Android
// ---------------------------------------------------------------------------

check('AND-01', 'No component is needlessly exported', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml')
  if (!manifest) return { severity: 'info', detail: 'No Android project yet.', fix: '' }

  const problems = []
  // The alarm receiver must not be reachable by other apps.
  const alarmBlock = manifest.match(/<receiver[^>]*AlarmReceiver[\s\S]*?<\/receiver>/)
  if (alarmBlock && /android:exported="true"/.test(alarmBlock[0])) {
    problems.push('AlarmReceiver is exported — any app could trigger a send')
  }
  if (/android:usesCleartextTraffic="true"/.test(manifest)) {
    problems.push('cleartext traffic is allowed app-wide')
  }
  if (/android:allowBackup="true"/.test(manifest)) {
    problems.push('allowBackup is true — schedules and settings would be copied off the device by adb backup')
  }
  // CAMERA is not in this list: `PairingScanner.tsx` uses it to scan a
  // pairing QR code, purely local `getUserMedia` frames decoded on-device
  // (`core/sync/qrDecode.ts`) — nothing is uploaded, recorded, or stored, and the
  // manifest declares `uses-feature android:required="false"` so a
  // camera-less device can still install the app. Pasting the code by hand
  // works without this permission at all; it is a shortcut, never load-bearing.
  if (/android\.permission\.(READ_CONTACTS|ACCESS_FINE_LOCATION|READ_EXTERNAL_STORAGE|RECORD_AUDIO)/.test(manifest)) {
    problems.push('the manifest requests a permission this app has no reason to need')
  }
  if (problems.length === 0) return null
  return { severity: 'high', detail: problems.join('\n           '), fix: 'Fix in AndroidManifest.xml.' }
})

check('AND-02', 'Passwords use the platform keystore', () => {
  const store = read('android/app/src/main/java/dev/aevistle/app/SecretStore.java')
  if (!store) return { severity: 'info', detail: 'No Android project yet.', fix: '' }
  const problems = []
  if (!/AndroidKeyStore/.test(store)) problems.push('the key is not held in the Android Keystore')
  if (!/AES\/GCM/.test(store)) problems.push('an authenticated cipher mode is not used')
  if (problems.length === 0) return null
  return {
    severity: 'critical',
    detail: problems.join('\n           '),
    fix: 'SMTP passwords must never be recoverable from a copied data directory.',
  }
})

check('AND-03', 'The web layer cannot be remotely loaded', () => {
  const config = read('capacitor.config.ts') ?? ''
  if (/url:\s*['"]http/.test(config)) {
    return {
      severity: 'critical',
      detail: 'capacitor.config.ts points the WebView at a remote URL.',
      fix: 'That makes every release depend on a server you would then have to secure. Ship the assets in the bundle.',
    }
  }
  if (/webContentsDebuggingEnabled:\s*true/.test(config)) {
    return {
      severity: 'medium',
      detail: 'WebView debugging is enabled.',
      fix: 'Turn it off for release builds; it lets anyone with USB access inspect the running app.',
    }
  }
  return null
})

// ---------------------------------------------------------------------------
// 4b. Auto-update
// ---------------------------------------------------------------------------

check('UPD-02', 'A checksum fetch failure blocks the install rather than skipping verification', () => {
  const updater = read('electron/updater.ts')
  if (!updater) return { severity: 'info', detail: 'No updater present.', fix: '' }

  const problems = []
  if (!/status\s*===\s*['"]unreachable['"]/.test(updater)) {
    problems.push('no branch distinguishes "checksum file unreachable" from "this build not listed in it"')
  } else {
    const unreachableBlock = updater.match(
      /manifest\.status\s*===\s*['"]unreachable['"][\s\S]{0,200}/,
    )
    if (!unreachableBlock || !/throw/.test(unreachableBlock[0])) {
      problems.push('the unreachable case does not throw — a network blip on SHA256SUMS would silently install an unverified build')
    }
  }
  if (problems.length === 0) return null
  return {
    severity: 'critical',
    detail: problems.join('\n           '),
    fix: '"Could not check the hash" and "the hash did not match" must both stop the install — only a same-filename-not-listed case may proceed, and only behind an explicit user confirmation.',
  }
})

// ---------------------------------------------------------------------------
// 5. Supply chain
// ---------------------------------------------------------------------------

check('DEP-01', 'The runtime dependency surface stays small', () => {
  const pkg = JSON.parse(read('package.json') ?? '{}')
  const runtime = Object.keys(pkg.dependencies ?? {})
  if (runtime.length <= 8) return null
  return {
    severity: 'info',
    detail: `${runtime.length} runtime dependencies: ${runtime.join(', ')}`,
    fix: 'Every one of these ships to users. Worth a look if the list keeps growing.',
  }
})

check('DEP-02', 'Lockfile is present', () => {
  if (existsSync(path.join(ROOT, 'package-lock.json'))) return null
  return {
    severity: 'medium',
    detail: 'No package-lock.json.',
    fix: 'Without it, two builds of the same tag can ship different code.',
  }
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const ORDER = { critical: 0, high: 1, medium: 2, error: 3, info: 4 }
const LABEL = {
  critical: 'CRITICAL',
  high: 'HIGH    ',
  medium: 'MEDIUM  ',
  error: 'ERROR   ',
  info: 'NOTE    ',
}

findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity])

console.log('')
console.log('  Aevistle security self-audit')
console.log(`  ${checksRun} checks\n`)

if (findings.length === 0) {
  console.log('  All clear.\n')
  process.exit(0)
}

for (const f of findings) {
  console.log(`  [${LABEL[f.severity]}] ${f.id}  ${f.title}`)
  if (f.detail) console.log(`           ${f.detail}`)
  if (f.fix) console.log(`           → ${f.fix}`)
  console.log('')
}

const real = findings.filter((f) => f.severity !== 'info')
console.log(`  ${real.length} finding(s) needing attention, ${findings.length - real.length} note(s).\n`)
process.exit(real.length > 0 ? 1 : 0)
