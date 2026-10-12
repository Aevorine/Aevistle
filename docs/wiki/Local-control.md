中文：[本地控制接口](本地控制接口.md)

## Enable local control

In Settings, enable the desktop control interface. It is off by default, listens only on 127.0.0.1 and uses a token regenerated at application startup. Immediate sending is a separate permission; enabling control alone does not grant it.

## CLI and MCP

The local clients are under integrations and are also published as @aevorine/aevistle-control in GitHub Packages. For a source checkout, use read-only commands first:

~~~powershell
node integrations/cli.mjs status
node integrations/cli.mjs list-reminders
~~~

These read the app's current endpoint. The Settings card offers a setup command for the MCP client using the correct local path; integrations/mcp-server.mjs is the dependency-free server entry point.

| Capability | Examples |
|---|---|
| Read | Status, reminders, recent activity, contacts and templates |
| Schedule | Create, pause or cancel reminders |
| Send immediately | Requires the separate sending switch |
| Inbox | Headers, not message bodies or attachments |

## Requests when the app is closed

Mutating CLI requests can be queued in the drop folder for the next launch. A queued request is not an already executed action. Inspect its result and activity record when the app runs.

Do not share endpoint.json, bearer tokens, drop files or their results publicly. The HTTP interface refuses browser-shaped requests and does not expose a remote network service. Full operations, parameters and queue semantics are in [integrations/README.md](https://github.com/Aevorine/Aevistle/blob/main/integrations/README.md).
