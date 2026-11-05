<#
  码审 CodeReview · 远程部署脚本（无交互版）
  用途：通过 SSH 远程执行，全程不阻塞、不等待输入，输出可解析的结果行
  与 2-服务器部署.ps1 的区别：去掉所有 Read-Host / 交互确认，适合自动化调用
  用法：powershell -NoProfile -ExecutionPolicy Bypass -File deploy-remote.ps1 -Root "C:\codereview\src-app" -Port 8080
#>

param(
  [string]$Root    = "C:\codereview\src-app",
  [int]$Port       = 8080,
  [string]$AppName = "codereview"
)

$ErrorActionPreference = "Continue"
function Line($tag, $msg) { Write-Output ("[" + $tag + "] " + $msg) }

Line "START" ("root=" + $Root + " port=" + $Port)

# 1. Node 校验
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Line "FAIL" "node-not-found"; exit 2 }
Line "OK" ("node " + (& node -v) + " / npm " + (& npm -v))

# 2. 文件校验
$need = @("server\index.mjs", "dist\index.html", ".env", "ecosystem.config.cjs", "dist\eng.traineddata")
$miss = @()
foreach ($f in $need) {
  if (-not (Test-Path (Join-Path $Root $f))) { $miss += $f }
}
if ($miss.Count -gt 0) { Line "FAIL" ("missing: " + ($miss -join ",")); exit 3 }
Line "OK" "files-present"

# 3. 防火墙
$ruleName = "CodeReview $Port"
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any | Out-Null
  Line "OK" ("firewall-added " + $Port)
} else {
  Line "OK" ("firewall-exists " + $Port)
}

# 4. pm2
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
$pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
if (-not $pm2) {
  Line "INFO" "installing-pm2"
  & npm install -g pm2 --registry https://registry.npmmirror.com 2>&1 | Out-Null
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
  $pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
}
if (-not $pm2) { Line "FAIL" "pm2-not-available"; exit 4 }
Line "OK" ("pm2 " + (& pm2 -v))

Set-Location $Root
& pm2 delete $AppName 2>&1 | Out-Null
& pm2 start (Join-Path $Root "ecosystem.config.cjs") 2>&1 | Out-Null
Start-Sleep -Seconds 3
& pm2 save 2>&1 | Out-Null

$status = (& pm2 jlist 2>$null) -join ""
if ($status -match '"status":"online"') { Line "OK" "pm2-online" } else { Line "WARN" "pm2-not-online" }

# 5. 开机自启（计划任务，SYSTEM 账户执行 pm2 resurrect）
$pm2CmdPath = (Get-Command pm2 -ErrorAction SilentlyContinue).Source
if (-not $pm2CmdPath) { $pm2CmdPath = Join-Path $env:APPDATA "npm\pm2.cmd" }
$taskName = "CodeReview-pm2"
$tr = "`"" + $pm2CmdPath + "`" resurrect"
& schtasks /create /tn $taskName /tr $tr /sc onstart /ru SYSTEM /rl highest /f 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0 -or (schtasks /query /tn $taskName 2>$null)) { Line "OK" "startup-task" } else { Line "WARN" "startup-task-failed" }

# 6. 验收
Start-Sleep -Seconds 2
$listen = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listen) { Line "OK" ("listening " + $Port) } else { Line "FAIL" ("not-listening " + $Port) }

try {
  $r = Invoke-WebRequest -Uri ("http://127.0.0.1:" + $Port + "/api/health") -UseBasicParsing -TimeoutSec 10
  Line "OK" ("health " + $r.StatusCode + " " + $r.Content)
} catch { Line "FAIL" ("health " + $_.Exception.Message) }

try {
  $r2 = Invoke-WebRequest -Uri ("http://127.0.0.1:" + $Port + "/") -UseBasicParsing -TimeoutSec 10
  Line "OK" ("index " + $r2.StatusCode + " bytes=" + $r2.RawContentLength)
} catch { Line "FAIL" ("index " + $_.Exception.Message) }

Line "DONE" ("http://127.0.0.1:" + $Port)
