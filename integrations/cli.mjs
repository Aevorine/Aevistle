#!/usr/bin/env node
/**
 * Aevistle command line.
 *
 *     node cli.mjs status
 *     node cli.mjs list-reminders
 *     node cli.mjs remind --to a@b.com --subject "Renew the domain" --at "2026-09-01 09:00"
 *     node cli.mjs remind --to a@b.com --subject Standup --at "2026-08-04 09:30" --weekly 1,2,3,4,5
 *     node cli.mjs cancel --id job_...
 *     node cli.mjs send --to a@b.com --subject "Now" --body "..."
 *
 * Two transports, tried in that order:
 *
 *   1. The loopback control port, when Aevistle is running and the interface
 *      is switched on. Immediate, and you get the result.
 *   2. The drop folder, otherwise. The request is written as a file and runs
 *      the next time Aevistle starts.
 *
 * The fallback is the reason this exists rather than a curl one-liner. A shell
 * script that runs at 07:00 should not fail because the app had not been
 * opened yet that morning; queuing is almost always what was wanted, and
 * saying so is better than exiting 1.
 *
 * Exit codes: 0 done, 2 queued to the drop folder, 1 refused or failed.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const ENDPOINT = join(homedir(), '.aevistle', 'endpoint.json')

const COMMANDS = {
  status: 'status',
  'list-reminders': 'list_jobs',
  remind: 'create_reminder',
  cancel: 'cancel_job',
  pause: 'toggle_job',
  send: 'send_now',
  activity: 'list_logs',
  contacts: 'list_contacts',
  templates: 'list_templates',
  inbox: 'list_inbox',
}

/** Flags that may be given more than once, or comma-separated. */
const LISTS = new Set(['to', 'cc', 'bcc'])

function parseArgs(argv) {
  const command = argv[0]
  const params = {}
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    // A flag with no value is a boolean, so `--unreadOnly` works.
    const value = next === undefined || next.startsWith('--') ? true : argv[++i]

    if (LISTS.has(key)) {
      const parts = String(value)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      params[key] = (params[key] ?? []).concat(parts)
    } else if (key === 'weekly') {
      params.recurrence = {
        kind: 'weekly',
        weekdays: String(value)
          .split(',')
          .map((n) => Number(n.trim()))
          .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
      }
    } else if (key === 'daily') {
      params.recurrence = { kind: 'daily' }
    } else if (key === 'monthly') {
      params.recurrence = { kind: 'monthly', dayOfMonth: Number(value) }
    } else if (key === 'cron') {
      params.recurrence = { kind: 'cron', cron: String(value) }
    } else {
      params[key] = value === true ? true : value
    }
  }
  return { command, params }
}

async function tryHttp(op, params) {
  let config
  try {
    config = JSON.parse(await readFile(ENDPOINT, 'utf8'))
  } catch {
    return null // not running, or the interface is off
  }
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ op, params }),
    })
    return { body: await response.json().catch(() => ({})), status: response.status }
  } catch {
    return null // a stale endpoint file outliving the process that wrote it
  }
}

async function queue(op, params) {
  // The drop folder path is published in the endpoint file, but that file is
  // gone when the app is not running — so fall back to the default location,
  // which is right for everyone who has not moved their data folder.
  let dropDir
  try {
    dropDir = JSON.parse(await readFile(ENDPOINT, 'utf8')).dropDir
  } catch {
    dropDir = null
  }
  if (!dropDir) {
    const base =
      process.platform === 'win32'
        ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Aevistle')
        : process.platform === 'darwin'
          ? join(homedir(), 'Library', 'Application Support', 'Aevistle')
          : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Aevistle')
    dropDir = join(base, 'drop')
  }
  await mkdir(dropDir, { recursive: true })
  const file = join(dropDir, `${Date.now()}-${randomUUID().slice(0, 8)}.json`)
  await writeFile(file, JSON.stringify({ op, params }, null, 2), 'utf8')
  return file
}

async function main() {
  const argv = process.argv.slice(2)
  const { command, params } = parseArgs(argv)
  const op = COMMANDS[command]

  if (!op) {
    console.error(`Usage: aevistle <${Object.keys(COMMANDS).join('|')}> [--flag value ...]`)
    process.exit(1)
  }

  const direct = await tryHttp(op, params)
  if (direct) {
    if (direct.body.ok) {
      console.log(JSON.stringify(direct.body.result, null, 2))
      process.exit(0)
    }
    // A refusal is a real answer, not a reason to queue: writing the same
    // request to the drop folder would only get it refused again later, out of
    // sight.
    console.error(direct.body.error ?? `HTTP ${direct.status}`)
    process.exit(1)
  }

  // Reads are pointless to queue — by the time anyone saw the answer it would
  // be stale, and there is nowhere to print it to.
  if (op.startsWith('list_') || op === 'status') {
    console.error(
      'Aevistle is not running, or its control interface is off ' +
        '(Settings → Control interface).',
    )
    process.exit(1)
  }

  const file = await queue(op, params)
  console.error(`Aevistle is not running. Queued for its next launch:\n  ${file}`)
  process.exit(2)
}

void main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
