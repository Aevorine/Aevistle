# Driving Aevistle from outside

Aevistle can be operated by other programs on the same machine — Claude Code,
a shell script, a task scheduler. Everything here talks to one small control
interface built into the desktop app.

## Turn it on first

Settings → **Control interface** → *Allow local programs to control Aevistle*.

It is off until you do. Switching it on opens a port bound to `127.0.0.1` and
nothing else, protected by a token that is regenerated every time the app
starts.

Sending mail immediately has a **second switch**. Reading your schedule and
queuing a reminder can be undone; mail that has left cannot, so it is not
granted by the same click.

## What Claude Code needs

```
claude mcp add aevistle -- node /path/to/integrations/mcp-server.mjs
```

The Settings card has a **Copy Claude Code setup** button that fills in the
right path for this machine.

After that, ask for what you want in plain language — "remind the team about
the release every Monday at 9", "did last night's backup reminder go out?" —
and Claude picks the tool.

| Tool | What it does |
| --- | --- |
| `aevistle_status` | Accounts, reminders, unread count, whether sending is allowed |
| `aevistle_list_reminders` | Scheduled reminders with next fire time and last result |
| `aevistle_create_reminder` | Queue an email for later, one-off or repeating |
| `aevistle_cancel_reminder` | Delete a reminder |
| `aevistle_pause_reminder` | Pause or resume without deleting |
| `aevistle_send_now` | Send immediately — needs the second switch |
| `aevistle_list_activity` | Recent sends and failures, with the provider's own error text |
| `aevistle_list_contacts` | Saved contacts |
| `aevistle_list_templates` | Saved templates |
| `aevistle_list_inbox` | Received mail, headers only |

The MCP server has no dependencies and stores nothing. It reads
`~/.aevistle/endpoint.json` on each call to find the port and token, so a
restart of Aevistle needs no reconfiguring.

## From a shell script

```bash
node integrations/cli.mjs status
node integrations/cli.mjs list-reminders
node integrations/cli.mjs remind --to team@example.com \
    --subject "Standup" --at "2026-08-04 09:30" --weekly 1,2,3,4,5
node integrations/cli.mjs cancel --id job_abc123
```

Exit codes: `0` done, `2` queued for the next launch, `1` refused or failed.

The `2` case is the point. If Aevistle is not running, a request that changes
something is written to the drop folder instead of failing, and runs when the
app next starts. A script that fires at 07:00 should not fall over because
nobody had opened the app yet.

## From anything else

**HTTP.** Read `~/.aevistle/endpoint.json` for `port` and `token`, then:

```bash
curl -s -X POST "http://127.0.0.1:$PORT/control" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"op":"create_reminder","params":{
        "to":["a@example.com"],"subject":"Renew the domain",
        "at":"2026-09-01 09:00"}}'
```

Requests carrying an `Origin` or `Referer` header are refused outright, so a
web page you happen to be visiting cannot reach this even though the port is
local.

**A file.** Drop a JSON file into the drop folder (Settings → Control
interface → *Open drop folder*):

```json
{ "op": "create_reminder",
  "params": { "to": ["a@example.com"], "subject": "Renew the domain",
              "at": "2026-09-01 09:00" } }
```

It is picked up within a couple of seconds if the app is running, or at the
next launch if not. The file then moves to `drop/done/` or `drop/failed/`, and
a `.result.json` beside it records what happened. Nothing is deleted, so a
failed request can be read, fixed and dropped again.

## Operations

Every transport carries the same operations.

| `op` | Parameters |
| --- | --- |
| `status` | — |
| `list_jobs` | `limit` |
| `create_reminder` | `to[]`, `subject`, `at`, optional `body`, `cc[]`, `bcc[]`, `recurrence`, `accountId`, `name` |
| `cancel_job` | `id` |
| `toggle_job` | `id`, optional `enabled` |
| `send_now` | `to[]`, `subject`, optional `body`, `cc[]`, `bcc[]`, `accountId` |
| `list_logs` | `limit` |
| `list_contacts` | `limit` |
| `list_templates` | `limit` |
| `list_inbox` | `limit`, `unreadOnly`, `tag` |

`at` is ISO 8601 or `YYYY-MM-DD HH:mm`, read in the app machine's local
timezone. A value that cannot be parsed is an error — never a silent "now".

`recurrence` is merged over the app's defaults, so
`{"kind":"weekly","weekdays":[1]}` is enough; you do not have to supply the
fields you do not care about.

## What it will not do

- Bind to anything but the loopback interface.
- Accept a request that looks like it came from a browser page.
- Send mail while the second switch is off — including through the drop
  folder, which is checked separately so a permission enforced in one doorway
  is not missing from another.
- Return message bodies or attachments from your inbox. Headers only.

Requests are written to the activity log with the transport they arrived on,
so anything done on your behalf is visible in the app afterwards.
