# 安装指南

简体中文 | [English](Installation.md)

从[最新版本页面](https://github.com/Aevorine/Aevistle/releases/latest)下载安装文件。

Windows 用户选择 x64 安装版或便携版。Android 用户选择 APK 安装包，并允许从你信任的来源安装应用。安装前，将文件的 SHA-256 校验值与 SHA256SUMS.txt 中的记录比较；校验值可用于确认文件是否发生变化。按照 [SECURITY.md](https://github.com/Aevorine/Aevistle/blob/main/SECURITY.md) 中的说明核对公钥指纹并验证 GPG 签名。桌面自动更新会验证 Ed25519 更新清单签名。

添加账户时，填写邮件服务商提供的 SMTP 发送设置。如果服务商要求，使用应用专用密码或受支持的 OAuth 授权登录方式。IMAP 邮件接收功能可以按需启用。

在 Windows 上，关闭桌面窗口后，应用会留在系统托盘中继续调度；退出应用或关闭电脑会停止发送。Android 定时发送还取决于系统授予的闹钟权限、电池设置和后台运行权限。

完整设置步骤和平台限制见[仓库 README](https://github.com/Aevorine/Aevistle/blob/main/README.md)。
