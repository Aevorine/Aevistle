# Privacy and security

Account credentials and mailbox data stay on your device. Signing keys are kept outside the repository and are never uploaded as release assets or Actions secrets.

Do not include account passwords, OAuth tokens, real recipients, full mailbox exports, local endpoint files or screenshots containing private messages in an issue. Use example.com addresses and redact provider logs.

See [SECURITY.md](https://github.com/Aevorine/Aevistle/blob/main/SECURITY.md) for the security policy, network boundaries, release verification and vulnerability reporting. The local control interface is disabled by default and uses loopback plus a per-session token. Sending immediately requires its separate permission.
