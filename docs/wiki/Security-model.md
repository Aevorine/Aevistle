中文：[安全模型](安全模型.md)

## Credentials and message data

Windows stores account credentials through Electron safeStorage backed by the Windows user account. Android uses its Keystore for encrypted credential storage. Schedules, contacts and activity data are kept separately; a file without a password can still reveal personal recipients, subjects or local paths.

Mail is sent to your configured SMTP provider. Receiving uses IMAP when enabled. Local scheduling does not mean that the provider or recipient's server never sees the message.

## Network boundaries

| Feature | Boundary |
|---|---|
| Mail transport | Configured SMTP/IMAP provider |
| Update check | Opt-in project release check |
| New Chinese calendar data | Manual retrieval from a displayed source |
| Device pairing | Direct local network connection; no cloud relay |
| Desktop control | Loopback address and a per-session token; off by default |

Immediate sending through local control requires separate permission. A live encrypted pairing and a backup file have different credential-transfer rules; see [Cross-device sync](Cross-device-sync.md).

## Limits and reporting

These protections do not make an already compromised device trustworthy or hide mail from the provider used to deliver it. Protect the OS account, review recipients and attachments, and keep backups private.

Do not put credentials, endpoint tokens, real message content or full data folders in public Issues. Report vulnerabilities through [private reporting](https://github.com/Aevorine/Aevistle/security/advisories/new). Release verification, the threat model and implementation details are in [SECURITY.md](https://github.com/Aevorine/Aevistle/blob/main/SECURITY.md).
