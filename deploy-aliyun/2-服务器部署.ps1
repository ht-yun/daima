<#
  码审 CodeReview · 阿里云 Windows 服务器一键部署脚本
  前提：已手动安装 Node.js（本脚本不自动安装），已把部署包上传到服务器
  用法（管理员 PowerShell）：
        powershell -ExecutionPolicy Bypass -File ".\2-服务器部署.ps1"
        powershell -ExecutionPolicy Bypass -File ".\2-服务器部署.ps1" -Zip "C:\codereview\codereview-deploy.zip"
  说明：不含任何远程操作，只在本机（服务器）上执行本地命令
#>

param(
  [string]$Root      = "C:\codereview\src-app",
  [string]$Zip       = "",
  [int]$Port         = 8080,
  [string]$AppName   = "codereview",
  [switch]$SkipStartupTask
)

$ErrorActionPreference = "Continue"
$Host.UI.RawUI.WindowTitle = "码审 CodeReview - 服务器部署"

function Step($m) { Write-Host ""; Write-Host "==> $m" -ForegroundColor White }
function Info($m) { Write-Host "    [信息] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    [通过] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    [注意] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "    [失败] $m" -ForegroundColor Red }

Write-Host "==============================================" -ForegroundColor DarkGray
Write-Host "  码审 CodeReview · 服务器部署" -ForegroundColor White
Write-Host "  目标目录：$Root   端口：$Port" -ForegroundColor DarkGray
Write-Host "==============================================" -ForegroundColor DarkGray

# ---------- 0. 管理员权限 ----------
Step "0/8 检查管理员权限"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Fail "请以「管理员身份」运行 PowerShell 后重试"
  Read-Host "按回车退出"; exit 1
}
Ok "管理员权限正常"

# ---------- 1. Node 校验（不自动安装） ----------
Step "1/8 校验 Node.js 环境（需你手动安装）"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$npmCmd  = Get-Command npm  -ErrorAction SilentlyContinue
if (-not $nodeCmd -or -not $npmCmd) {
  Fail "未检测到 Node.js / npm"
  Write-Host ""
  Write-Host "  请先手动安装 Node.js：" -ForegroundColor Yellow
  Write-Host "  1) 下载 https://npmmirror.com/mirrors/node/v22.11.0/node-v22.11.0-x64.msi" -ForegroundColor Yellow
  Write-Host "  2) 默认选项安装，确保勾选 Add to PATH" -ForegroundColor Yellow
  Write-Host "  3) 关闭并重开 PowerShell，执行 node -v / npm -v 确认" -ForegroundColor Yellow
  Write-Host ""
  Read-Host "按回车退出"; exit 1
}
$nodeVer = (& node -v)
$npmVer  = (& npm -v)
Ok "node $nodeVer / npm $npmVer"

$major = [int](($nodeVer.TrimStart("v")) -split "\.")[0]
if ($major -lt 18) {
  Warn "Node 主版本为 $major，建议 20 或 22，否则 Vite 构建/ESM 可能异常"
}

# ---------- 2. 目录与解压 ----------
Step "2/8 准备目录"
New-Item -ItemType Directory -Force -Path $Root | Out-Null
Ok "目录就绪：$Root"

if ($Zip -ne "") {
  if (-not (Test-Path $Zip)) { Fail "压缩包不存在：$Zip"; Read-Host "按回车退出"; exit 1 }
  Info "解压 $Zip → $Root"
  Expand-Archive -Path $Zip -DestinationPath $Root -Force
  Ok "解压完成"
} else {
  Info "未指定 -Zip，跳过解压（按已手动上传的文件继续）"
}

# ---------- 3. 文件完整性 ----------
Step "3/8 校验关键文件"
$need = @("server\index.mjs", "dist\index.html", ".env", "ecosystem.config.cjs", "dist\eng.traineddata")
$missing = @()
foreach ($f in $need) {
  $p = Join-Path $Root $f
  if (Test-Path $p) {
    $len = (Get-Item $p).Length
    Ok ("{0,-26} {1,10:N0} 字节" -f $f, $len)
  } else {
    Fail ("{0,-26} 缺失" -f $f)
    $missing += $f
  }
}
if ($missing.Count -gt 0) {
  Warn ("缺少：" + ($missing -join ", "))
  Warn "dist 缺失请在本地 npm run build 后重新上传"
  Read-Host "按回车退出"; exit 1
}

# ---------- 4. .env 安全检查 ----------
Step "4/8 检查 .env 配置与安全项"
$envPath = Join-Path $Root ".env"
$envText = Get-Content $envPath -Raw -Encoding UTF8
function Get-EnvVal($key) {
  $m = [regex]::Match($envText, "(?m)^\s*$key\s*=\s*(.*?)\s*$")
  if ($m.Success) { return $m.Groups[1].Value.Trim('"').Trim("'") }
  return ""
}

$portCfg = Get-EnvVal "APP_PORT"
if ($portCfg -eq "$Port") {
  Ok "APP_PORT = $portCfg"
} else {
  Warn "APP_PORT 当前为 '$portCfg'，与部署端口 $Port 不一致"
  Warn "请把 .env 里 APP_PORT 改为 $Port（pm2 的 ecosystem 会用环境变量覆盖，但手动 node 启动会读该值）"
}

$users = Get-EnvVal "APP_USERS"
if ($users -eq "") {
  Fail "APP_USERS 为空 —— 等于关闭登录校验，任何人都能用你的 API Key！请立即设置 用户名:密码"
} elseif ($users -match "admin:change-me" -or $users -match ":testpass") {
  Fail "APP_USERS 仍是默认账号密码（admin:change-me）—— 公网部署前必须修改！"
  Warn "格式示例：APP_USERS=admin:change-me
} else {
  Ok "APP_USERS 已自定义（非默认密码）"
}

$key = Get-EnvVal "MODEL_API_KEY"
if ($key -eq "" -or $key -eq "sk-xxx") {
  Warn "MODEL_API_KEY 为空，AI 分析将不可用（接口返回 NO_MODEL）"
} else {
  Ok ("MODEL_API_KEY 已配置（" + $key.Substring(0, [Math]::Min(6, $key.Length)) + "***）")
}

$mmKey = Get-EnvVal "MM_API_KEY"
if ($mmKey -ne "") { Ok ("MM_API_KEY 已配置（" + $mmKey.Substring(0, [Math]::Min(6, $mmKey.Length)) + "***）") }
if ((Get-EnvVal "NODE_ENV") -eq "development") { Warn ".env 中 NODE_ENV=development，生产环境应删除或改为 production" }

# ---------- 5. 防火墙 ----------
Step "5/8 放行本机防火墙 TCP $Port"
$ruleName = "CodeReview $Port"
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
  Ok "防火墙规则已存在：$ruleName"
} else {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any | Out-Null
  Ok "已创建防火墙规则：$ruleName"
}
Warn "别忘了阿里云控制台安全组也要放行 TCP $Port（入方向，授权对象 0.0.0.0/0 或你的固定 IP）"

# ---------- 6. pm2 安装与启动 ----------
Step "6/8 安装并启动 pm2"
$pm2Cmd = Get-Command pm2 -ErrorAction SilentlyContinue
if (-not $pm2Cmd) {
  Info "未找到 pm2，执行 npm install -g pm2"
  & npm install -g pm2
  if ($LASTEXITCODE -ne 0) { Fail "pm2 安装失败，请检查网络或换用 npm config set registry https://registry.npmmirror.com"; Read-Host "按回车退出"; exit 1 }
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
  $pm2Cmd = Get-Command pm2 -ErrorAction SilentlyContinue
  if (-not $pm2Cmd) { Warn "pm2 已装但当前会话找不到命令，请重开 PowerShell 后手动执行 pm2 start ecosystem.config.cjs" }
}
if ($pm2Cmd) {
  Ok ("pm2 版本：" + (& pm2 -v))
  Set-Location $Root
  Info "停止旧进程（如存在）"
  & pm2 delete $AppName 2>$null | Out-Null
  Info "启动：pm2 start ecosystem.config.cjs"
  & pm2 start (Join-Path $Root "ecosystem.config.cjs")
  if ($LASTEXITCODE -ne 0) { Fail "pm2 启动失败，请查看 pm2 logs"; Read-Host "按回车退出"; exit 1 }
  Start-Sleep -Seconds 3
  & pm2 status
}

# ---------- 7. 开机自启 ----------
Step "7/8 配置开机自启"
if ($SkipStartupTask) {
  Info "已指定 -SkipStartupTask，跳过"
} else {
  $startupPkg = (& npm ls -g pm2-windows-startup --depth=0 2>$null) -join "`n"
  if ($startupPkg -notmatch "pm2-windows-startup") {
    Info "安装 pm2-windows-startup"
    & npm install -g pm2-windows-startup
  }
  $startupCmdExists = Get-Command pm2-startup -ErrorAction SilentlyContinue
  if ($startupCmdExists) {
    & pm2-startup install
    Ok "pm2-windows-startup 已注册开机自启"
  } else {
    Warn "未找到 pm2-startup 命令，改用计划任务方案"
  }

  # 计划任务兜底（更稳）：开机以 SYSTEM 执行 pm2 resurrect
  $taskName = "CodeReview-pm2"
  $pm2Path = (Get-Command pm2 -ErrorAction SilentlyContinue).Source
  if (-not $pm2Path) {
    $pm2Path = Join-Path $env:APPDATA "npm\pm2.cmd"
  }
  if (Test-Path $pm2Path) {
    $tr = "`"$pm2Path`" resurrect"
    & schtasks /create /tn $taskName /tr $tr /sc onstart /ru SYSTEM /rl highest /f 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Ok "计划任务已创建：$taskName（开机执行 pm2 resurrect）" }
    else { Warn "计划任务创建失败，可手动执行：schtasks /create /tn $taskName /tr `"`"$pm2Path`" resurrect`" /sc onstart /ru SYSTEM /rl highest /f" }
  } else {
    Warn "未定位到 pm2.cmd，请手动配置开机自启"
  }

  if ($pm2Cmd) { & pm2 save; Ok "已执行 pm2 save（保存当前进程快照）" }
}

# ---------- 8. 验收 ----------
Step "8/8 验收测试"
Start-Sleep -Seconds 2
$listen = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listen) { Ok "端口 $Port 正在监听" } else { Warn "端口 $Port 未监听，请执行 pm2 logs $AppName 排查" }

try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 10
  Ok ("健康检查：HTTP " + $r.StatusCode + " " + $r.Content)
} catch { Fail ("健康检查失败：" + $_.Exception.Message) }

try {
  $r2 = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 10
  Ok ("首页：HTTP " + $r2.StatusCode + "，" + $r2.RawContentLength + " 字节")
} catch { Fail ("首页访问失败：" + $_.Exception.Message) }

$pubIp = ""
try {
  $pubIp = (Invoke-WebRequest -Uri "http://ip.3322.net" -UseBasicParsing -TimeoutSec 6).Content.Trim()
} catch { Warn "公网 IP 查询失败（不影响部署）" }

Write-Host ""
Write-Host "==============================================" -ForegroundColor DarkGray
Write-Host "  部署完成" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor DarkGray
Write-Host "  本机访问：http://127.0.0.1:$Port" -ForegroundColor Green
if ($pubIp) { Write-Host "  公网访问：http://$pubIp`:$Port （需安全组放行 $Port）" -ForegroundColor Green }
Write-Host "  常用命令：pm2 status / pm2 logs $AppName / pm2 restart $AppName" -ForegroundColor Gray
Write-Host ""
Write-Host "  ⚠ 安全提醒" -ForegroundColor Red
Write-Host "  1. .env 内有真实 API Key，勿外发、勿提交 Git；泄露后立即吊销重建" -ForegroundColor Yellow
Write-Host "  2. 默认密码 testpass 必须改掉，本项目登录无失败次数限制" -ForegroundColor Yellow
Write-Host "  3. 公网严禁 npm run dev（5173 无鉴权、暴露源码）" -ForegroundColor Yellow
Write-Host "  4. 安全组只放行 $Port，3389 建议限制来源 IP" -ForegroundColor Yellow
Write-Host ""
Read-Host "按回车退出"
