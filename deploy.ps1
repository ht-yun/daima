$ErrorActionPreference = "Continue"
$root = "C:\codereview"
$log  = Join-Path $root "deploy.log"

New-Item -ItemType Directory -Force -Path $root | Out-Null
function Log($m) {
  $t = Get-Date -Format "HH:mm:ss"
  $line = "$t  $m"
  Write-Host $line
  Add-Content -Path $log -Value $line
}

Log "===== 开始部署 ====="
Set-Location $root

if (-not (Test-Path "$root\deploy.tar.gz")) {
  Log "错误：找不到 C:\codereview\deploy.tar.gz，请先把部署包上传到这个目录"
  exit 1
}

Log "解压部署包..."
& tar -xzf "$root\deploy.tar.gz" -C $root
if (-not (Test-Path "$root\server\index.mjs")) {
  Log "错误：解压后找不到 server\index.mjs"
  exit 1
}
Log "解压完成"

$node = "C:\Program Files\nodejs\node.exe"
$npm  = "C:\Program Files\nodejs\npm.cmd"

if (-not (Test-Path $node)) {
  Log "未检测到 Node.js，开始下载..."
  $msi = "$root\node.msi"
  $ok = $false
  foreach ($u in @(
    "https://npmmirror.com/mirrors/node/v22.11.0/node-v22.11.0-x64.msi",
    "https://nodejs.org/dist/v22.11.0/node-v22.11.0-x64.msi"
  )) {
    try {
      Log ("尝试下载: " + $u)
      Invoke-WebRequest -Uri $u -OutFile $msi -UseBasicParsing -TimeoutSec 120
      $ok = $true
      break
    } catch {
      Log ("下载失败: " + $_.Exception.Message)
    }
  }
  if (-not $ok) { Log "Node.js 下载失败，请手动安装后重跑"; exit 1 }
  Log "静默安装 Node.js..."
  Start-Process msiexec.exe -ArgumentList "/i C:\codereview\node.msi /qn /norestart" -Wait
}

if (-not (Test-Path $node)) { Log "Node.js 安装失败"; exit 1 }
Log ("Node 版本: " + (& $node -v))

Log "安装依赖（国内镜像）..."
& $npm config set registry https://registry.npmmirror.com | Out-Null
& $npm install --no-audit --no-fund 2>&1 | ForEach-Object { Write-Host $_ }

if (-not (Test-Path "$root\node_modules\vite")) {
  Log "依赖安装失败"
  exit 1
}
Log "依赖安装完成"

Log "构建前端..."
& $npm run build 2>&1 | ForEach-Object { Write-Host $_ }

if (-not (Test-Path "$root\dist\index.html")) {
  Log "构建失败：没有生成 dist\index.html"
  exit 1
}
Log "构建完成"

Log "放行防火墙 8080..."
New-NetFirewallRule -DisplayName "CodeReview 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -ErrorAction SilentlyContinue | Out-Null

$env:APP_HOST = "0.0.0.0"
$env:APP_PORT = "8080"

Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*nodejs*" } | Stop-Process -Force -ErrorAction SilentlyContinue

Log "启动服务..."
Start-Process -FilePath $node -ArgumentList "server/index.mjs" -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput "$root\server.out.log" -RedirectStandardError "$root\server.err.log"

Start-Sleep -Seconds 6
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:8080/api/health" -UseBasicParsing -TimeoutSec 10
  Log ("健康检查: " + $r.StatusCode + " " + $r.Content)
} catch {
  Log ("健康检查失败: " + $_.Exception.Message)
}

try {
  $ip = (Invoke-WebRequest -Uri "http://ip.3322.net" -UseBasicParsing -TimeoutSec 10).Content.Trim()
  Log ("服务器出口 IP: " + $ip)
} catch {
  Log "出口 IP 查询失败"
}

Log "===== 部署结束 ====="
Log "本机访问: http://127.0.0.1:8080"
Log "公网访问: http://127.0.0.1:8080"
