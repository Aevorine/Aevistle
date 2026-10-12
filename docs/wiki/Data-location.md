中文：[数据位置](数据位置.md)

## Find the actual folder

On Windows, open Settings and use the application's data-folder display and controls. The default follows Electron's userData location, but it can be changed. Do not assume it is the installer folder or beside the portable executable.

| Item | Contains |
|---|---|
| `state.json` | Accounts, reminders, contacts, templates, activity and settings |
| `secrets.json` | OS-protected encrypted credentials |
| attachments and pasted folders | Local message attachments and pasted images |
| `dispatch-ledger.json` | Per-occurrence send bookkeeping |
| `control-audit.json` | Local control request audit records |

A data-folder change uses the app's own migration controls. Close or coordinate applications before manually copying live files, and keep a backup when moving machines.

## Backups are not credential migration

Ordinary exports exclude passwords, but can include private schedules, addresses and content. Importing an export may require entering credentials again. Copying Windows encrypted secret files to another OS user or machine is not equivalent to transferring working credentials.

Android uses application-private storage and the Android Keystore. Use application exports and imports instead of guessing or sharing its internal folders. The browser demo has its own local state and is not the native mail application.

## Local control files

The desktop integration reads ~/.aevistle/endpoint.json for the current port and token. It is a sensitive control endpoint file, not a schedule backup. Drop-folder requests and their result files can contain private mail instructions. See [Local control](Local-control.md).

For privacy before sharing a file, use [Security model](Security-model.md).
