中文：[常见问题](常见问题.md)

## Authentication fails

Check the provider's client credential, enabled SMTP/IMAP service, full address, host, port and encryption. A successful web login does not establish that third-party client access is configured. Organizational mail can require administrator approval. See [First-run setup](First-run-setup.md).

## Connection test succeeds but mail is missing

The connection test does not send mail. Schedule a short reminder to yourself and inspect the activity log. If the provider rejected it, check its actual error and limits. If it accepted the message, check bounces, recipient filters and spam folders before retrying.

## A calendar rule has no effect

The reminder's working-day policy defaults to off. Enable it on the intended task, verify the calendar year and make-up days, and check quiet hours and recipient windows. See [Working calendar](Working-calendar.md).

## Windows stops sending after closing the window

Check that the tray process remains, rather than the application having been quit. Check sleep, shutdown and network state. Missed occurrences are handled by the reminder's catch-up policy; inspect the result rather than assuming every missed message is resent.

## Android works only while open

Distinguish a missing send from a missing notification using the activity log. Check alarm, notification, network, autostart and battery restrictions. Vendor settings vary by model and OS release. After changing them, test a short reminder to yourself with the screen locked; permission toggles alone do not establish delivery behavior.

## Pairing fails

Keep both apps open, rescan an unexpired code, and check local network reachability. Guest Wi-Fi can isolate clients. There is no cloud relay fallback; use an offline pairing file when devices cannot reach each other.

## Downloads or updates fail

Check the release page and its file download separately. Download manually from the official [release page](https://github.com/Aevorine/Aevistle/releases/latest), then verify the artifacts. Do not clear accounts or application data to fix a download failure.

## Report a problem

Include the app version, OS/device, provider type, time zone, reproduction steps, expected and actual result, and redacted error text. Do not attach credentials, real message content or a full data directory. Use [Issues](https://github.com/Aevorine/Aevistle/issues/new/choose), or [private reporting](https://github.com/Aevorine/Aevistle/security/advisories/new) for security problems.
