#!/usr/bin/env node
/**
 * Aevistle MCP server.
 *
 * Speaks the Model Context Protocol over stdio, so Claude Code can be pointed
 * at it with:
 *
 *     claude mcp add aevistle -- node /path/to/mcp/server.mjs
 *
 * It holds no state and no credentials. Every call is forwarded to the running
 * Aevistle over its loopback control port, which the server locates by reading
 * `~/.aevistle/endpoint.json`. That indirection is deliberate: the port is
 * ephemeral and the token is regenerated on every launch, so anything that
 * cached either would break the first time the user restarted the app.
 *
 * Written with no dependencies — JSON-RPC over stdio with Content-Length
 * framing is a hundred lines, and a server that Claude Code launches on every
 * session start should not need an install step to work.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const ENDPOINT = join(homedir(), '.aevistle', 'endpoint.json')
const PROTOCOL_VERSION = '2024-11-05'

// ---------------------------------------------------------------------------
// Talking to Aevistle
// ---------------------------------------------------------------------------

async function endpoint() {
  let raw
  try {
    raw = await readFile(ENDPOINT, 'utf8')
  } catch {
    throw new Error(
      'Aevistle is not reachable. Open the app, then Settings → Control interface → ' +
        '"Allow local programs to control Aevistle".',
    )
  }
  const parsed = JSON.parse(raw)
  if (!parsed.port || !parsed.token) throw new Error('the Aevistle endpoint file is incomplete')
  return parsed
}

async function call(op, params = {}) {
  const { port, token } = await endpoint()
  let response
  try {
    response = await fetch(`http://127.0.0.1:${port}/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ op, params }),
    })
  } catch (error) {
    // A stale endpoint file is the common case: the app was closed without a
    // clean shutdown, so the file outlived the port.
    throw new Error(
      `could not reach Aevistle on 127.0.0.1:${port} — is it still running? (${error.message})`,
    )
  }
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.ok === false) {
    throw new Error(body.error ?? `Aevistle returned HTTP ${response.status}`)
  }
  return body.result
}

// ---------------------------------------------------------------------------
// Tools
//
// The descriptions are what Claude reads to decide whether a tool applies, so
// they say when *not* to use one as well as when to.
// ---------------------------------------------------------------------------

const address = { type: 'array', items: { type: 'string' }, description: 'Email addresses.' }

const TOOLS = [
  {
    name: 'aevistle_status',
    description:
      'How many accounts, scheduled reminders, contacts and unread messages Aevistle has, and ' +
      'whether immediate sending is permitted. Call this first when unsure whether Aevistle is ' +
      'set up at all.',
    inputSchema: { type: 'object', properties: {} },
    op: 'status',
  },
  {
    name: 'aevistle_list_reminders',
    description:
      'The scheduled reminders, with their next fire time and whether the last run succeeded. ' +
      'Use before cancelling or pausing one, to get its id.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Default 50, max 500.' } },
    },
    op: 'list_jobs',
  },
  {
    name: 'aevistle_create_reminder',
    description:
      'Schedule an email to be sent later. It is queued inside Aevistle and sent by the app, so ' +
      'it fires whether or not this conversation is still open. Nothing is sent now.',
    inputSchema: {
      type: 'object',
      required: ['to', 'subject', 'at'],
      properties: {
        to: address,
        cc: address,
        bcc: address,
        subject: { type: 'string' },
        body: { type: 'string' },
        at: {
          type: 'string',
          description:
            'When to send: ISO 8601, or "YYYY-MM-DD HH:mm". Read in the app machine\'s local ' +
            'timezone. For a repeating reminder this is the first occurrence.',
        },
        recurrence: {
          type: 'object',
          description:
            'Omit for a one-off. Otherwise {"kind":"daily"|"weekly"|"monthly"|"yearly"|' +
            '"interval"|"cron", ...}; weekly takes "weekdays":[0-6] with 0 = Sunday, monthly ' +
            'takes "dayOfMonth", cron takes "cron" as a 5-field expression.',
        },
        accountId: {
          type: 'string',
          description: 'Sending account id or address. Defaults to the configured default.',
        },
        name: { type: 'string', description: 'Label in the schedule list. Defaults to the subject.' },
      },
    },
    op: 'create_reminder',
  },
  {
    name: 'aevistle_cancel_reminder',
    description: 'Delete a scheduled reminder outright. Use aevistle_pause_reminder to keep it.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    op: 'cancel_job',
  },
  {
    name: 'aevistle_pause_reminder',
    description:
      'Pause or resume a scheduled reminder without deleting it. Omit "enabled" to toggle.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' }, enabled: { type: 'boolean' } },
    },
    op: 'toggle_job',
  },
  {
    name: 'aevistle_send_now',
    description:
      'Send an email immediately. This leaves the machine at once and cannot be recalled, and it ' +
      'is refused unless the user has separately switched on "Also allow them to send mail ' +
      'immediately" in Aevistle\'s settings. Prefer aevistle_create_reminder unless the user has ' +
      'asked for something to go out now.',
    inputSchema: {
      type: 'object',
      required: ['to', 'subject'],
      properties: {
        to: address,
        cc: address,
        bcc: address,
        subject: { type: 'string' },
        body: { type: 'string' },
        accountId: { type: 'string' },
      },
    },
    op: 'send_now',
  },
  {
    name: 'aevistle_list_activity',
    description:
      'Recent send results and errors, newest first. Use to answer "did it go out?" and to read ' +
      'the provider\'s own error text after a failure.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    op: 'list_logs',
  },
  {
    name: 'aevistle_list_contacts',
    description: 'Saved contacts, for resolving a name to an address before scheduling.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    op: 'list_contacts',
  },
  {
    name: 'aevistle_list_templates',
    description: 'Saved message templates, by name and subject.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    op: 'list_templates',
  },
  {
    name: 'aevistle_list_inbox',
    description:
      'Received mail Aevistle has cached, newest first. Headers only — no bodies and no ' +
      'attachments leave the app.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
        unreadOnly: { type: 'boolean' },
        tag: { type: 'string', enum: ['none', 'important', 'flagged'] },
      },
    },
    op: 'list_inbox',
  },
]

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]))

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(message) {
  const { id, method, params } = message

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'aevistle', version: '0.1.0' },
      })
      return

    // Notifications carry no id and must not be answered.
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return

    case 'tools/list':
      reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      })
      return

    case 'tools/call': {
      const tool = BY_NAME.get(params?.name)
      if (!tool) {
        replyError(id, -32602, `unknown tool: ${params?.name}`)
        return
      }
      try {
        const result = await call(tool.op, params.arguments ?? {})
        reply(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        })
      } catch (error) {
        // Reported as a tool result rather than a protocol error: the model
        // can read it, explain it, and suggest the fix, which a transport-level
        // failure would not let it do.
        reply(id, {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
        })
      }
      return
    }

    case 'ping':
      reply(id, {})
      return

    default:
      if (id !== undefined) replyError(id, -32601, `unsupported method: ${method}`)
  }
}

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return // framing noise; a malformed line is not worth killing the session over
  }
  void handle(message).catch((error) => {
    if (message.id !== undefined) replyError(message.id, -32603, error.message)
  })
})
