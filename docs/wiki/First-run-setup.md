中文：[首次设置](首次设置.md)

## Add your mailbox

1. Open Settings and add an account.
2. Enter the complete email address and review the provider preset, SMTP host, port and encryption.
3. Supply the provider's client credential or supported authorization method.
4. Enable IMAP only if you want incoming mail, and review its separate settings.
5. Run the connection test, then schedule a short reminder to your own address and confirm that it arrives.

The connection test authenticates without sending a message. It is not proof of an actual delivery.

## Client credentials

QQ, 163 and 126 use client authorization codes. Other providers may require an app password, OAuth, or administrator-approved settings. Use the provider's official instructions for your account; an ordinary web-login password is not interchangeable with a client credential.

| Personal mailbox preset | SMTP / encryption | Optional IMAP / encryption |
|---|---|---|
| QQ / Foxmail | smtp.qq.com:465 / SSL/TLS | imap.qq.com:993 / SSL/TLS |
| NetEase 163 | smtp.163.com:465 / SSL/TLS | imap.163.com:993 / SSL/TLS |
| NetEase 126 | smtp.126.com:465 / SSL/TLS | imap.126.com:993 / SSL/TLS |

These are the [application presets](https://github.com/Aevorine/Aevistle/blob/main/src/core/mail/providers.ts). Organizational accounts can use different hosts and authorization policies. Do not disable certificate verification to work around a connection problem.

## Time and background execution

Check the device clock and time zone. On Windows, leave tray execution enabled and confirm the tray icon remains after closing the window. On Android, grant the requested alarm, notification and background permissions and check the device's battery restrictions.

Configure holidays and recipient time windows separately in [Working calendar](Working-calendar.md). Then continue with [Everyday use](Everyday-use.md).
