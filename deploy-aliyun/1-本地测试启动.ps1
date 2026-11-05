<#
  码审 CodeReview · 本地测试启动脚本
  用途：在本机以生产模式启动 dist + server，监听 0.0.0.0:8080
  用法：powershell -ExecutionPolicy Bypass -File ".\1-本地测试启动.ps1"
        也可右键「使用 PowerShell 运行」
#>

param(
  [string]$Root = ".\src-app",
  [int]$Port = 8080
)

$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "码审 CodeReview - 本地测试 (0.0.0.0:$Port)"

function Info($m) { Write-Host "[信息] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[通过] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[注意] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[失败] $m" -ForegroundColor Red }

Write-Host "==============================================" -ForegroundColor DarkGray
Write-Host "  码审 CodeReview · 本地测试启动" -ForegroundColor White
Write-Host "==============================================" -ForegroundColor DarkGray

# 1. 目录与关键文件检查
if (-not (Test-Path $Root)) { Fail "目录不存在：$Root"; Read-Host "按回车退出"; exit 1 }
Set-Location $Root
Info "工作目录：$Root"

$need = @("server\index.mjs", "dist\index.html", "dist\eng.traineddata", ".env")
$missing = @()
foreach ($f in $need) {
  if (-not (Test-Path (Join-Path $Root $f))) { $missing += $f }
}
if ($missing.Count -gt 0) {
  Fail ("缺少文件：" + ($missing -join ", "))
  Warn "请先执行 npm run build 生成 dist"
  Read-Host "按回车退出"; exit 1
}
Ok "关键文件齐全：server/index.mjs、dist/index.html、dist/eng.traineddata、.env"

# 2. Node 环境检查
try {
  $nv = (& node -v) 2>$null
  $pv = (& npm -v) 2>$null
  Ok "Node $nv / npm $pv"
} catch {
  Fail "未检测到 Node.js，请手动安装后重开窗口"
  Read-Host "按回车退出"; exit 1
}

# 3. 端口占用检查
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  $ownerIds = @($busy | Select-Object -ExpandProperty OwningProcess -Unique)
  Warn ("端口 $Port 已被占用，PID: " + ($ownerIds -join ", "))
  $ans = Read-Host "是否结束占用进程并继续？(Y/N)"
  if ($ans -eq "Y") {
    foreach ($p in $ownerIds) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
  } else {
    Info "已取消启动"; exit 0
  }
}

# 4. 后台启动服务（子任务托管，便于 Ctrl+C 时一并回收）
$env:APP_HOST = "0.0.0.0"
$env:APP_PORT = "$Port"
$env:NODE_ENV = "production"

Info "启动服务：node server/index.mjs（监听 0.0.0.0:$Port）"

$job = Start-Job -ScriptBlock {
  param($r, $p)
  Set-Location $r
  $env:APP_HOST = "0.0.0.0"
  $env:APP_PORT = "$p"
  $env:NODE_ENV = "production"
  node server/index.mjs 2>&1
} -ArgumentList $Root, $Port

try {
  # 等待端口就绪（最多 20 秒）
  $ready = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    $listen = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($listen) { $ready = $true; break }
    if ($job.State -eq "Completed" -or $job.State -eq "Failed") { break }
  }

  if (-not $ready) {
    Fail "服务未能监听 $Port 端口，启动日志如下："
    Receive-Job -Job $job
    Read-Host "按回车退出"; exit 1
  }

  # 健康检查
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 8
    Ok ("健康检查通过：HTTP " + $r.StatusCode + " " + $r.Content)
  } catch {
    Warn ("健康检查失败：" + $_.Exception.Message)
  }

  try {
    $r2 = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 8
    Ok ("首页可访问：HTTP " + $r2.StatusCode + "，" + $r2.RawContentLength + " 字节")
  } catch {
    Warn ("首页访问失败：" + $_.Exception.Message)
  }

  $lanIp = (Get-NetIPAddress -AddressFamily IPv4 |
            Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
            Select-Object -First 1 -ExpandProperty IPAddress)

  Write-Host ""
  Write-Host "  本机访问   ：http://127.0.0.1:$Port" -ForegroundColor Green
  if ($lanIp) { Write-Host "  局域网访问 ：http://$lanIp`:$Port" -ForegroundColor Green }
  Write-Host "  登录账号   ：见 .env 中的 APP_USERS" -ForegroundColor Green
  Write-Host "  停止服务   ：按 Ctrl+C" -ForegroundColor Green
  Write-Host ""
  Write-Host "---------------- 服务实时日志 ----------------" -ForegroundColor DarkGray

  # 持续输出日志，直到进程退出或用户 Ctrl+C
  while ($job.State -eq "Running") {
    Receive-Job -Job $job
    Start-Sleep -Seconds 1
  }
  Receive-Job -Job $job
  Warn "服务已退出"
}
finally {
  if ($job) {
    if ($job.State -eq "Running") { Stop-Job -Job $job -ErrorAction SilentlyContinue }
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  }
}
