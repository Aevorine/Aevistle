中文：[跨设备同步](跨设备同步.md)

## Pair over a local network

1. Put both devices on a network where they can reach each other.
2. Open the pairing screen and show a QR code on one device.
3. Scan it with the other device before the one-time code expires.
4. Review the selected sync scopes and the receiving device before confirming.

There is no cloud relay or meeting-point server. Guest-network isolation or a firewall can prevent two devices on the same Wi-Fi from reaching each other. Use [Troubleshooting](Troubleshooting.md) or an offline pairing file in that case.

## What syncs

| Scope | Includes |
|---|---|
| Accounts | Selected account configuration |
| Schedule | Reminders and working calendar |
| Contacts | Selected contact records |
| Templates | Mail templates |
| Appearance | Interface preferences |

A live encrypted pairing can carry a credential when the caller explicitly supplies it. Ordinary backups and offline pairing files do not contain those credentials; these are different transfer paths.

## Ongoing and offline sync

Ongoing sync retries the last-known local address while the apps are open. On Android it is a foreground feature, not an always-running cloud sync service. Remove a remembered pairing when it should no longer have access.

An offline pairing file uses PIN-derived encryption and can be carried over a cable or removable drive. It still contains private selected data, even though credentials are excluded. Confirm which device will execute synchronized reminders before enabling the same schedule in multiple places.
