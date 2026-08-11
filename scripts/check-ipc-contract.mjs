/**
 * Do `electron/main.ts` and `electron/preload.ts` actually honour `IPC`?
 *
 * `src/core/platform/ipc-contract.ts` looks like it is enforced by the compiler, and
 * half of it is: preload declares `const api: DesktopApi`, so a missing method
 * or a wrong parameter type is a build error. The half TypeScript cannot see is
 * the part that carries the call. A channel name is a string on both sides —
 * `ipcMain.handle(IPC.getSyncSecret, …)` and `ipcRenderer.invoke(IPC.getSyncSecret)`
 * are two unrelated expressions that happen to read the same constant, and
 * nothing checks that both exist. So:
 *
 *   - a method on `DesktopApi`, implemented in preload, with no `ipcMain.handle`
 *     behind it typechecks perfectly and rejects at runtime with "No handler
 *     registered for 'aevistle:…'", surfacing as whichever button was pressed
 *     quietly failing;
 *   - the event direction is worse, because it does not even reject. A
 *     `webContents.send` on a channel no `ipcRenderer.on` listens to returns
 *     `undefined` and drops the message. That is how a pairing screen sits on
 *     "waiting for the other device" forever while the handshake behind it has
 *     already finished;
 *   - and the two directions are silently incompatible. `invoke` on a channel
 *     main only `send`s never resolves; `on` for a channel main only `handle`s
 *     never fires. Both look like the feature is merely slow.
 *
 * Arity is checked for the same reason. `ipcMain.handle(IPC.x, (_e, a) => …)`
 * against a preload that sends three arguments is legal TypeScript — the extra
 * two are simply dropped on the floor by the handler, which then acts on
 * defaults it was never given.
 *
 * Exit code 1 if anything needs attention.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACT = 'src/core/platform/ipc-contract.ts'
const MAIN = 'electron/main.ts'
const PRELOAD = 'electron/preload.ts'

const failures = []
let checked = 0
const check = (what, ok) => {
  checked++
  if (!ok) failures.push(what)
}

/**
 * Blank out comments, keeping every newline.
 *
 * Line numbers are reported, and all three of these files carry long prose
 * blocks that name channels and even show call shapes — `IPC.setUiLocale` and
 * `postJson(url, body)` both appear in comments here. Matching those would
 * invent registrations that do not exist.
 */
const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"\w])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length))

const read = (rel) => stripComments(readFileSync(path.join(ROOT, rel), 'utf8'))
const lineAt = (text, index) => text.slice(0, index).split('\n').length

const OPEN = { '(': ')', '[': ']', '{': '}' }
const CLOSE = new Set([')', ']', '}'])

/** Index of the bracket closing the one at `from`, or -1. String-aware. */
function matchBracket(text, from) {
  let depth = 0
  let quote = null
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') quote = c
    else if (OPEN[c]) depth++
    else if (CLOSE.has(c)) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Split an argument or parameter list on its top-level commas.
 *
 * Angle brackets are tracked as well as the ordinary three, because a
 * parameter can be `Map<string, number>` — but `>` preceded by `=` is an arrow
 * and must not close anything, or `(handler: (e: X) => void, other)` splits in
 * the wrong place.
 */
function splitTopLevel(src) {
  const parts = []
  let depth = 0
  let angle = 0
  let quote = null
  let buf = ''
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      buf += c
      if (c === '\\') buf += src[++i] ?? ''
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') quote = c
    else if (OPEN[c]) depth++
    else if (CLOSE.has(c)) depth--
    else if (c === '<') angle++
    else if (c === '>' && src[i - 1] !== '=') angle = Math.max(0, angle - 1)
    if (c === ',' && depth === 0 && angle === 0) {
      parts.push(buf)
      buf = ''
      continue
    }
    buf += c
  }
  parts.push(buf)
  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

// --- the contract ------------------------------------------------------------

const contract = read(CONTRACT)

/** Channel key → wire string, from the `export const IPC = {…}` literal. */
const channels = new Map()
{
  const start = contract.indexOf('export const IPC = {')
  check(`${CONTRACT} must export an IPC channel table`, start >= 0)
  if (start >= 0) {
    const open = contract.indexOf('{', start)
    const body = contract.slice(open + 1, matchBracket(contract, open))
    for (const m of body.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:\s*'([^']+)'/gm)) {
      channels.set(m[1], m[2])
    }
  }
}
check('the IPC table must have channels in it', channels.size > 10)

const byWire = new Map()
for (const [key, wire] of channels) {
  const clash = byWire.get(wire)
  check(`IPC.${key} and IPC.${clash} must not share the wire name '${wire}'`, clash === undefined)
  if (clash === undefined) byWire.set(wire, key)
  check(`IPC.${key} must be namespaced ('${wire}')`, wire.startsWith('aevistle:'))
}

/** Method name → declared parameter count, from `interface DesktopApi`. */
const methods = new Map()
{
  const start = contract.indexOf('export interface DesktopApi {')
  check(`${CONTRACT} must declare the DesktopApi interface`, start >= 0)
  if (start >= 0) {
    const open = contract.indexOf('{', start)
    const body = contract.slice(open + 1, matchBracket(contract, open))
    for (const m of body.matchAll(/^ {2}([A-Za-z_$][\w$]*)\(/gm)) {
      const paren = m.index + m[0].length - 1
      const end = matchBracket(body, paren)
      if (end < 0) continue
      methods.set(m[1], splitTopLevel(body.slice(paren + 1, end)).length)
    }
  }
}
check('DesktopApi must declare methods', methods.size > 10)

/**
 * Which channel a method rides on.
 *
 * Nearly all of them share a name with their channel key. The `on*`
 * subscriptions are named for the listener rather than the message, and the
 * two `respondTo*` methods are named for what the renderer is doing rather
 * than for the channel — those are spelled out here so an unmapped method is a
 * failure rather than a silently skipped check.
 */
const ALIASES = { respondToControl: 'controlResponse', respondToSyncServer: 'syncServerResponse' }
/** Renderer-local: `webUtils` resolves the path in-process, no IPC involved. */
const NO_CHANNEL = new Set(['pathForFile'])

const methodChannel = new Map()
for (const method of methods.keys()) {
  if (NO_CHANNEL.has(method)) continue
  const candidates = [
    ALIASES[method],
    method,
    /^on[A-Z]/.test(method) ? method[2].toLowerCase() + method.slice(3) : null,
  ].filter(Boolean)
  const key = candidates.find((c) => channels.has(c))
  check(`DesktopApi.${method} must map to a declared channel`, key !== undefined)
  if (key) methodChannel.set(method, key)
}

const channelMethod = new Map()
for (const [method, key] of methodChannel) channelMethod.set(key, method)
for (const key of channels.keys()) {
  check(`IPC.${key} must be reachable from a DesktopApi method`, channelMethod.has(key))
}

// --- what main registers -----------------------------------------------------

const main = read(MAIN)

/** Channel key → { kind, line, arity }. `arity` excludes the IpcMainEvent. */
const registered = new Map()

for (const m of main.matchAll(/ipcMain\.(handle|handleOnce|on|once)\(\s*([^\s,)]+)\s*,/g)) {
  const line = lineAt(main, m.index)
  const target = m[2]
  const key = target.startsWith('IPC.') ? target.slice(4) : null
  check(
    `${MAIN}:${line} must register a channel from the IPC table, not ${target}`,
    key !== null,
  )
  if (!key) continue
  check(`${MAIN}:${line} registers IPC.${key}, which the contract does not declare`, channels.has(key))
  if (!channels.has(key)) continue
  const already = registered.get(key)
  check(
    `IPC.${key} must be registered once (again at ${MAIN}:${line}, first at ${MAIN}:${already?.line})`,
    already === undefined,
  )

  // The handler is the argument after the channel: `async (…) =>` or `(…) =>`.
  // Anything else (a bare identifier, a single unparenthesised parameter) is
  // left unmeasured rather than guessed at.
  const rest = main.slice(m.index + m[0].length)
  const handler = rest.match(/^\s*(?:async\s*)?\(/)
  let arity = null
  if (handler) {
    const paren = m.index + m[0].length + handler[0].length - 1
    const end = matchBracket(main, paren)
    if (end > 0) {
      const params = splitTopLevel(main.slice(paren + 1, end))
      // A handler that takes nothing at all takes no payload either; otherwise
      // the first parameter is the event and does not come from the caller.
      arity = params.length === 0 ? 0 : params.length - 1
    }
  }
  registered.set(key, { kind: m[1] === 'on' || m[1] === 'once' ? 'listen' : 'handle', line, arity })
}

for (const m of main.matchAll(/webContents\.send\(\s*([^\s,)]+)/g)) {
  const line = lineAt(main, m.index)
  const target = m[1]
  const key = target.startsWith('IPC.') ? target.slice(4) : null
  check(`${MAIN}:${line} must send on a channel from the IPC table, not ${target}`, key !== null)
  if (!key) continue
  check(`${MAIN}:${line} sends IPC.${key}, which the contract does not declare`, channels.has(key))
  if (!channels.has(key)) continue
  const already = registered.get(key)
  check(
    `IPC.${key} must not be both handled (${MAIN}:${already?.line}) and sent (${MAIN}:${line})`,
    already === undefined || already.kind === 'send',
  )
  if (!already) registered.set(key, { kind: 'send', line, arity: null })
}

// --- what preload bridges ----------------------------------------------------

const preload = read(PRELOAD)

/** Channel key → { kind, line, args }. `args` excludes the channel itself. */
const bridged = new Map()

for (const m of preload.matchAll(/ipcRenderer\.(invoke|send|sendSync|on|once)\(\s*/g)) {
  const line = lineAt(preload, m.index)
  const open = preload.lastIndexOf('(', m.index + m[0].length)
  const end = matchBracket(preload, open)
  if (end < 0) continue
  const args = splitTopLevel(preload.slice(open + 1, end))
  const target = args[0] ?? ''
  const key = target.startsWith('IPC.') ? target.slice(4) : null
  check(`${PRELOAD}:${line} must use a channel from the IPC table, not ${target}`, key !== null)
  if (!key) continue
  check(
    `${PRELOAD}:${line} bridges IPC.${key}, which the contract does not declare`,
    channels.has(key),
  )
  if (!channels.has(key)) continue
  const kind = m[1] === 'on' || m[1] === 'once' ? 'listen' : 'call'
  // `removeListener` pairs with `on` on the same channel, and a channel may be
  // invoked from more than one method, so repeats are expected — only the
  // first sighting of each direction is measured.
  const already = bridged.get(key)
  if (!already || (already.kind === 'listen' && kind === 'call')) {
    bridged.set(key, { kind, line, args: args.length - 1 })
  }
}

// --- the cross-check ---------------------------------------------------------

for (const [key, wire] of channels) {
  const method = channelMethod.get(key) ?? key
  const inMain = registered.get(key)
  const inPreload = bridged.get(key)

  check(`IPC.${key} ('${wire}') is declared but ${MAIN} never registers it`, inMain !== undefined)
  check(
    `IPC.${key} ('${wire}') is declared but ${PRELOAD} never bridges it to DesktopApi.${method}`,
    inPreload !== undefined,
  )
  if (!inMain || !inPreload) continue

  // Direction. A `handle` answers an `invoke`; a `send` is answered by an `on`.
  // Crossing them is the failure that produces a promise which never settles.
  if (inMain.kind === 'send') {
    check(
      `IPC.${key} is sent from main, so ${PRELOAD} must listen for it, not call it`,
      inPreload.kind === 'listen',
    )
  } else {
    check(
      `IPC.${key} is handled in main, so ${PRELOAD} must invoke it, not listen for it`,
      inPreload.kind === 'call',
    )
  }
  if (inMain.kind === 'send' || inPreload.kind === 'listen') continue

  // Signatures. The contract is the authority: preload must forward every
  // argument the method takes, and main must accept every one of them.
  const declared = methods.get(method)
  if (declared !== undefined) {
    check(
      `DesktopApi.${method} takes ${declared} argument(s) but ${PRELOAD}:${inPreload.line} forwards ${inPreload.args}`,
      inPreload.args === declared,
    )
  }
  if (inMain.arity !== null) {
    check(
      `${PRELOAD}:${inPreload.line} sends ${inPreload.args} argument(s) on IPC.${key} but ${MAIN}:${inMain.line} accepts ${inMain.arity}`,
      inMain.arity === inPreload.args,
    )
  }
}

// ---------------------------------------------------------------------------

const label = 'main and preload honour the IPC contract'
if (failures.length === 0) {
  console.log(
    `\n  ${label}\n  ${checked} checks across ${channels.size} channels, ${methods.size} DesktopApi methods\n\n  All clear.\n`,
  )
  process.exit(0)
}
console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log('')
process.exit(1)
