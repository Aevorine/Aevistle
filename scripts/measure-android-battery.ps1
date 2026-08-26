# 安卓后台收取耗电实测 — 需要一台用 USB 连着、开了 USB 调试的手机。
#
# 什么能测、什么不能：耗电只能在真手机上测（模拟器和电脑都没有电池），
# 所以这个脚本自动化的是"取证"这一半 —— 清零系统电量账本、等你正常用一段时间、
# 再把 Aevistle 名下的耗电从账本里摘出来。跑法：
#
#   pwsh scripts/measure-android-battery.ps1          # 默认等 4 小时
#   pwsh scripts/measure-android-battery.ps1 -Hours 8
#
# 步骤（脚本会逐步提示）：
#   1. 清零 batterystats（系统自己的耗电账本，重置不影响任何数据）。
#   2. 拔掉 USB 线，像平常一样用手机 N 小时 —— Aevistle 留在后台收信即可。
#   3. 时间到了插回 USB，回到这个窗口按回车。
#   4. 脚本导出账本，打印 Aevistle 名下的估算耗电（mAh）和唤醒/网络次数，
#      原始转储存到 battery-dump.txt 供细看。
#
# 读数怎么看：一个 5 分钟轮询间隔的邮件应用，几小时的后台收取通常在个位数
# mAh —— 手机电池一般是 4000-5000 mAh，也就是千分之几。如果看到几十 mAh
# 以上，把 battery-dump.txt 发回来查唤醒锁。

param([double]$Hours = 4)

$ErrorActionPreference = 'Stop'

function Find-Adb {
    $cmd = Get-Command adb -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        "$env:ANDROID_HOME\platform-tools\adb.exe",
        "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
    )
    foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
    throw "adb not found - install Android platform-tools or set ANDROID_HOME."
}

$adb = Find-Adb
$state = & $adb get-state 2>$null
if ($state -ne 'device') {
    throw "No device answers adb (state: '$state'). Plug the phone in and enable USB debugging."
}

Write-Host "`n[1/3] Resetting the system battery ledger..."
& $adb shell dumpsys batterystats --reset | Out-Null
Write-Host "      Done. UNPLUG the phone now and use it normally for $Hours hour(s)."
Write-Host "      Leave Aevistle in the background the whole time."
Write-Host "`n      When the time is up, plug the phone back in and press Enter here."
Read-Host  '      (Enter to continue)'

Write-Host "`n[2/3] Pulling the ledger..."
$dump = & $adb shell dumpsys batterystats --charged dev.aevistle.app
$raw = Join-Path (Split-Path $PSScriptRoot -Parent) 'battery-dump.txt'
$dump | Set-Content -Encoding UTF8 $raw

Write-Host "[3/3] What the ledger says about Aevistle:`n"
$hits = $dump | Select-String -Pattern 'Estimated power use|dev\.aevistle\.app|Uid u0a\d+:.*aevistle|Wake lock|Mobile network|WiFi network' -Context 0, 1
if ($hits) { $hits | ForEach-Object { $_.Line.Trim() } | Select-Object -First 40 | ForEach-Object { Write-Host "  $_" } }
else { Write-Host '  (no Aevistle lines - the app may not have run in the window; raw dump saved anyway)' }
Write-Host "`nRaw dump: $raw"
Write-Host 'Single-digit mAh over a few hours is normal for a 5-minute mail poll; tens of mAh is worth a look.'
