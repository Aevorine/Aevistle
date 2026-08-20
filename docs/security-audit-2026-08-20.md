# 独立安全审计 — 2026-08-20（0.3.27）

上一次是 [2026-08-06](security-audit-2026-08-06.md)。这一次重点看四样：
**签名密钥、依赖供应链、平台安全姿态、GitHub 仓库配置。**

每一条都写清楚**是怎么验的**。没验过的写"未验证"，不写"应该没问题"。

---

## 结论先说

| 项 | 结论 |
| --- | --- |
| 签名密钥有没有泄露进仓库 | **没有。** 全历史扫过，仓库里只有公钥 |
| 依赖有没有已知高危漏洞 | **本次修掉一个**（CVE-2026-40345），现在为零 |
| 桌面端进程隔离 | **到位**，且 CSP 是收紧过的 |
| 安卓端导出面 | **到位**，三个 `exported=true` 都是必须的 |
| GitHub 仓库配置 | **有一个真缺口：`main` 没有任何分支保护** |

---

## 一、签名密钥

### 仓库里有没有私钥

```
git log --all --diff-filter=A --name-only --pretty=format: | sort -u
  | rg -i "key|secret|\.env|\.p12|\.pfx|\.jks|keystore|credential|token"
```

命中 11 个文件，**逐个看过，全部是处理密钥的源码，没有一个是密钥本身**：

- `SecretStore.java` / `SecretTransport.java` / `OAuthTokens.java` — 安卓端存取凭据的实现
- `src/core/sync/secretTransport.ts` / `src/state/services/secrets.ts` — 配对同步时加密凭据的实现
- `scripts/setup-signing-key.{ps1,sh}` / `setup-update-signing-key.mjs` — **生成**密钥的脚本
- `electron/updateSigningKey.ts` — 只有一行常量：
  `export const UPDATE_SIGNING_PUBLIC_KEY_SPKI_BASE64 = …`，**公钥**，本来就该在仓库里
- `check-css-tokens.mjs` / `keyboardInset.ts` — 名字里带 key，与密钥无关

`git ls-files` 当前跟踪的文件里同样没有任何 `.jks` / `.keystore` / `keystore.properties` / `.env`。

### 私钥实际放在哪

安卓签名走 `android/app/build.gradle` 里的 `releaseSigning`，四项（keystore 路径、
库口令、别名、密钥口令）从**仓库外**的属性文件读；`releaseSigning == null` 时
release 构建**不会**偷偷用 debug 密钥签名去发布 —— 那条路要显式打开 `allowUnsignedRelease`。

`.gitignore` 对这一类有 9 条独立规则（`*.key` `*.p12` `*.jks` `*.keystore`
`keystore.properties` `aevistle-signing-key*` `secrets.json` `android/keystore*`
`**/aevistle-release-key*`），**并且 GitHub 侧的推送保护是开着的**，等于两道。

### 发布链路本身

`npm run release` 的顺序是硬的，中间任何一步过不去就中止，不会留下半成品 Release：

1. 算全部产物哈希，缺文件或空文件直接停
2. GPG 签 `SHA256SUMS.txt`，并**在一个只装了已公开公钥的临时钥匙串里验一次**
   —— 也就是陌生人会跑的那一遍
3. 再签 Ed25519 更新清单（自动更新走这一条）
4. 上传
5. **把上传上去的东西重新下载回来，再验一遍**

本次 0.3.27 实跑输出：`3/3 verified`，两种签名都 `All clear`。
密钥指纹 `57753E473F94B09DB3AA9A6AB865B328D5535D9B`。

---

## 二、依赖供应链

`npm run audit:deps`（对 `registry.npmjs.org` 查，绕开本机的国内镜像 —— 那个镜像
根本没实现 advisories 接口，直接 `npm audit` 会一直报 `NOT_IMPLEMENTED`）。

**审计开始时是红的**，三条高危，实为同一条链：

```
mailparser (直接依赖) → html-to-text → deepmerge-ts < 8.0.0
```

根因 [GHSA-ggr8-5vv4-36mx / CVE-2026-40345](https://github.com/advisories/GHSA-ggr8-5vv4-36mx)：
`deepmerge()` 遇到**自引用的对象图**会递归到栈溢出。`mailparser` 解析的正是**别人发来的邮件**，
这条链紧挨着不可信输入。

npm 自己给的"修复"是把 `mailparser` **降级**到 3.9.8（倒退六个补丁版本）。没采纳 ——
用 `overrides` 把 `deepmerge-ts` 顶到 `^8.0.1`，也就是真正打了补丁的版本。

**越过 `html-to-text` 声明的 `^7.1.5` 范围，所以必须验行为，不能只看装没装上：**
拿一封故意写得很难看的 HTML 邮件（标题实体、多余空格、列表、表格、引用块、`<pre>`、
中文验证码、带 alt 的图片）过 `mailparser`，把 `text` 与 `textAsHtml` 原样存下，
换完依赖再跑，**逐字节比对 → 完全一致**。

锁文件改动范围也核过：**只有 deepmerge-ts 一个包**。

审计结束时：`none found · failing at high and above`。
GitHub 的 Dependabot 告警 #3 状态已变成 `fixed`。

---

## 三、平台安全姿态

### 桌面端（Electron）

| 项 | 值 | 说明 |
| --- | --- | --- |
| `contextIsolation` | `true` | 渲染层拿不到主进程对象 |
| `nodeIntegration` | `false` | 页面里没有 `require` |
| `sandbox` | `true` | 渲染进程跑在 OS 沙箱里 |
| `setPermissionRequestHandler` | 有 | 摄像头/麦克风/地理位置这类请求走白名单，不是默认放行 |
| `setWindowOpenHandler` | `deny` | 任何 `window.open` 交给系统浏览器，绝不新开一个带 preload 的 Electron 窗口 |

CSP（`index.html`）是收紧过的，不是摆设：

```
default-src 'self';  script-src 'self';  connect-src 'self';
object-src 'none';   base-uri 'none';    form-action 'none';
img-src 'self' data: blob:;  frame-src 'self' data: blob:;
```

- `connect-src 'self'` —— 渲染层**发不出任何外部请求**。所有网络都必须经过主进程，
  也就都经过了主进程那一层的校验（图片代理、更新校验都在那儿）。
- `form-action 'none'` —— 就算真被注入了一个 `<form>`，它也提交不到任何地方。
- `object-src 'none'` / `base-uri 'none'` —— 关掉两条经典的注入面。

邮件正文另有一层：跑在 `MessageBodyFrame` 的惰性 `srcDoc` iframe 里，
不执行脚本、不发请求。**本次新增的公式渲染（KaTeX）就注入在这一层之后**，
所以专门为它加了门禁 `check:math`：只扫标签之间的文字（属性里的 `$` 永远不是分隔符）、
`trust: false`（`\href` `\url` `\includegraphics` `\htmlClass` `\htmlStyle` 一律拒绝）、
并逐条断言**输出里不得出现输入里没有的可执行属性**。7 条敌意输入，全部通过；
把标签跳过逻辑破坏掉，门禁立刻变红。

### 安卓端

| 项 | 值 |
| --- | --- |
| `allowBackup` | `false`（凭据不会进系统备份） |
| `usesCleartextTraffic` | `false` |
| `networkSecurityConfig` | 有 |
| `debuggable` | 未开启 |

`exported="true"` 只有三处，逐个核过，**都是必须**：

1. `MainActivity` —— 启动器入口，不导出就打不开。
2. `BootReceiver` —— 只监听 `BOOT_COMPLETED`、`MY_PACKAGE_REPLACED`、
   `SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED`，**三个都是系统独占广播**，
   别的应用发不出来。
3. `NextSendWidgetProvider` —— 桌面小组件，按 Android 要求必须导出。

其余接收器（复制验证码、标为已读、重试任务）以及 `InboxIdleService` 全部
`exported="false"`。这一点是有意的：导出的服务等于任何应用都能开关你的后台同步。

---

## 四、GitHub 仓库配置

已开：

- ✅ Secret scanning
- ✅ Secret scanning **push protection**（推之前就拦下来，不是事后告警）
- ✅ Dependabot 安全更新
- ✅ CI 工作流 `permissions: contents: read`（最小权限），且**不持有任何 secret**
  —— 发布签名的 GPG 私钥从不进 CI，`SECURITY.md` 里写明了这一点

### 唯一的真缺口：`main` 没有分支保护

```
$ gh api repos/Aevorine/Aevistle/branches/main/protection
Branch not protected (HTTP 404)
```

后果有两个，都不是理论问题：

1. **`npm run check` 那 60 多道门禁不是合并的必要条件。** 它在 CI 里跑，
   但没有 required status check，所以红着也能合进 main。
   —— 0.3.24 就是**门禁红着发出去的**（见 0.3.25 的更新说明）。
2. **可以强推覆盖发布历史。** 任何拿到写权限的令牌都能改写已发布版本对应的提交。

**没有替你打开**，因为打开之后会挡住直接 push 到 main —— 而这正是当前发版流程用的方式，
擅自改会让你下一次发版卡住。要开的话，两条里挑一条：

只要"门禁必须绿"，仍然允许直接 push（推荐，改动最小）：

```bash
gh api -X PUT repos/Aevorine/Aevistle/branches/main/protection --input - <<'JSON'
{"required_status_checks":{"strict":true,"contexts":["Checks (Node 20)","Checks (Node 22)"]},
 "enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null,
 "allow_force_pushes":false,"allow_deletions":false}
JSON
```

只挡强推和删除，别的都不管（最保守）：

```bash
gh api -X PUT repos/Aevorine/Aevistle/branches/main/protection --input - <<'JSON'
{"required_status_checks":null,"enforce_admins":false,"required_pull_request_reviews":null,
 "restrictions":null,"allow_force_pushes":false,"allow_deletions":false}
JSON
```

### 另外两个免费的开关

```bash
gh api -X PATCH repos/Aevorine/Aevistle --input - <<'JSON'
{"security_and_analysis":{"secret_scanning_non_provider_patterns":{"status":"enabled"}}}
JSON
```

`secret_scanning_non_provider_patterns` 是纯本地模式匹配，多认一批非厂商格式的密钥，
不外传任何东西 —— 建议开。

`secret_scanning_validity_checks` **不建议无脑开**：它会把疑似令牌**发给对应服务商**
去问"这个还活着吗"。公开仓库上通常可接受，但那是一次对外发送，属于你自己拍板的事，
所以这里只写出来，不代做。

---

## 未验证的部分（写在这里而不是留白）

- **没有做动态渗透测试**：没有对着 IMAP/SMTP 服务器做模糊测试，没有对配对协议做重放/中间人实测。
  配对加密有单元级门禁（`check:pairing-crypto`、`check:sync-replay`），但那是代码级，不是网络级。
- **没有审计 Electron / Capacitor / Android Gradle 插件自身的供应链**，只审了 npm 依赖树。
- **没有做二进制加固评估**（反调试、字符串混淆、完整性自检）。这类手段对一个开源应用
  收益有限，且与"可复现构建"的目标冲突，属于要不要做的取舍，不是遗漏。
- **本机之外的行为未验证**：所有实测都在一台 Windows 11 笔记本上完成。
