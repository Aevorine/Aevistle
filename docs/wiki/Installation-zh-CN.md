# 安装与国内邮箱配置

简体中文 | [English](Installation.md) · [返回中文首页](Home-zh-CN.md)

## 1. 下载安装包

打开[项目最新版本页面](https://github.com/Aevorine/Aevistle/releases/latest)，在附件中选择适合设备的文件：

| 设备与需求 | 选择的文件 |
|---|---|
| Windows x64，正常安装 | 文件名以 -win-x64-setup.exe 结尾的安装版 |
| Windows x64，使用便携版 | 文件名以 -win-x64-portable.exe 结尾的便携版 |
| 支持 Android APK 的手机 | .apk 安装包 |

Windows 安装前，将下载文件的 SHA-256 校验值与该版本的 SHA256SUMS.txt 比较。项目的 Windows EXE 尚无 Authenticode 证书签名；发布清单另有 GPG 签名，桌面更新会验证 Ed25519 清单签名。完整验证步骤见 [SECURITY.md](https://github.com/Aevorine/Aevistle/blob/main/SECURITY.md)。

Android 安装时，根据系统提示允许本次安装来源；安装完成后打开应用。请先确认设备支持 Android APK，不要将不兼容的系统当成安装权限问题。GitHub 页面或附件下载失败的处理见[故障排查](Troubleshooting-zh-CN.md)。

## 2. 准备国内邮箱授权码

QQ、163、126 邮箱的第三方客户端配置使用邮箱服务授权码。不要把平时登录网页版邮箱的密码直接填进授权码栏。

**QQ 邮箱**：登录 [QQ 邮箱网页版](https://mail.qq.com/)，在设置中找到账户与 POP/IMAP/SMTP 服务相关选项，按当前界面要求开启服务、完成验证并取得授权码。需要在 Aevistle 中收信时，同时开启 IMAP 服务。界面入口可能随版本变化，优先查看 [QQ 邮箱帮助中心](https://service.mail.qq.com/)。腾讯的[邮件连接配置说明](https://main.qcloudimg.com/raw/document/product/pdf/1270_46586_cn.pdf#page=7)也说明了开启服务与使用授权码的要求。

**网易 163 / 126**：在网页版邮箱的设置中进入 POP3/SMTP/IMAP，按提示新增客户端授权密码；把生成的授权码填入 Aevistle。网易的[官方授权码说明](https://help.mail.126.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac286624f309a1a7089)同时列出了网页版和邮箱大师手机端的入口。授权码失效或丢失时，在官方邮箱设置中重新生成。

**单位邮箱**：向单位邮箱管理员索取 SMTP/IMAP 参数及允许使用的登录方式。不要套用个人 QQ 或 163 邮箱的服务器地址，也不要通过关闭证书校验来绕过单位的连接限制。

## 3. 在 Aevistle 中添加账户

进入设置中的添加账户入口，输入完整邮箱地址，检查应用识别出的服务商和参数。以下是项目内置的个人邮箱预设：

| 邮箱 | 发信服务器（SMTP） | 端口 / 加密 | 收信服务器（IMAP，可选） | 端口 / 加密 |
|---|---|---|---|---|
| QQ / Foxmail 个人邮箱 | smtp.qq.com | 465 / SSL/TLS | imap.qq.com | 993 / SSL/TLS |
| 网易 163 | smtp.163.com | 465 / SSL/TLS | imap.163.com | 993 / SSL/TLS |
| 网易 126 | smtp.126.com | 465 / SSL/TLS | imap.126.com | 993 / SSL/TLS |

表格对应[项目当前预设](https://github.com/Aevorine/Aevistle/blob/main/src/core/mail/providers.ts)。465 加密发信配置可对照[腾讯官方 SMTP 配置表](https://intl.cloud.tencent.com/zh/document/product/1266/71700)，网易域名和加密客户端设置可对照[网易官方说明](https://help.mail.126.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac25c12dcb3d46222b6)。企业邮箱、别名登录或管理员自定义配置，以各自官方要求为准。

保存前点击测试连接。连接测试只验证连接和鉴权，不会发送邮件；通过后，再给自己的邮箱发送一条测试提醒，确认实际投递正常。

## 4. 设置北京时间与调休

以北京时间安排任务时，先检查设备系统时间和时区为 UTC+08:00。给海外联系人设置接收时间窗口时，再按对方所在地选择时区，不要把北京时间直接当作对方的当地时间。

在工作日历中选择中国预设，核对需要使用的年份。中国日历既有法定假期，也有周六、周日补班；只设置“跳过周末”不能覆盖调休。还需要在每一条提醒中启用相应的工作日策略，否则提醒默认不受工作日历约束。

每年的日期应以国务院通知和单位实际安排为准。例如 [2026 年节假日通知（北京市政府转载）](https://www.beijing.gov.cn/zhengce/zhengcefagui/202511/t20251104_4258873.html)列出的补班日需要与普通周末区分。学校、轮班岗位或单位自定假期，可在工作日历中按实际安排修改。新一年的数据不可用时，不要直接沿用上一年的日期。

## 5. 保持后台运行

**Windows**：启用托盘后台运行，并确认关闭窗口后托盘图标仍在。退出应用、关机或休眠会影响到点发送；请先用短时间测试提醒确认你的设备行为。

**Android 兼容手机**：按应用提示允许通知、精确闹钟及必要的后台运行权限。在手机系统设置中查找自启动、后台活动和电池优化选项。华为的[官方排查说明](https://consumer.huawei.com/cn/support/content/zh-cn15872069/)列出了适用设备上的应用启动管理和电池优化入口；其他品牌与系统版本的菜单名称可能不同。

如果某项权限已开启，但锁屏后仍延迟，请继续阅读[手机后台问题排查](Troubleshooting-zh-CN.md)。

官方说明核对日期：2026-10-12。邮箱设置入口和手机菜单以当前官方界面为准。
