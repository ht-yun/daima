<#
  码审 CodeReview · 一次性开启 SSH（供远程自动化部署使用）
  在服务器上以「管理员 PowerShell」运行，约 30~90 秒
  用法：右键 → 使用 PowerShell 运行
        或 powershell -NoProfile -ExecutionPolicy Bypass -File ".\0-开启SSH.ps1"
  说明：只做三件事——安装 OpenSSH Server、设为自动启动并启动、放行本机 22 端口
#>

$ErrorActionPreference = "Continue"
$Host.UI.RawUI.WindowTitle = "开启 SSH 服务"

function Say($m)  { Write-Host $m -ForegroundColor Cyan }
function Good($m) { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Bad($m)  { Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Warn($m) { Write-Host "  [注意] $m" -ForegroundColor Yellow }

Write-Host "==============================================" -ForegroundColor DarkGray
Write-Host "  开启 OpenSSH Server" -ForegroundColor White
Write-Host "==============================================" -ForegroundColor DarkGray

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Bad "需要管理员权限：请右键本文件 → 以管理员身份运行"
  Read-Host "按回车退出"; exit 1
}

# 1. 检查是否已安装
Say "1/4 检查 OpenSSH Server 是否已安装"
$cap = Get-WindowsCapability -Online -Name "OpenSSH.Server*" -ErrorAction SilentlyContinue
if ($cap -and $cap.State -eq "Installed") {
  Good "已安装，跳过安装步骤"
} else {
  Say "    正在安装（需要联网，约 1 分钟）..."
  try {
    Add-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0" -ErrorAction Stop | Out-Null
    Good "安装完成"
  } catch {
    Bad ("安装失败：" + $_.Exception.Message)
    Warn "可在「服务器管理器 → 添加角色和功能 → 功能 → OpenSSH 服务器」中手动勾选安装"
    Read-Host "按回车退出"; exit 1
  }
}

# 2. 设为自动启动并启动
Say "2/4 配置并启动 sshd 服务"
Set-Service -Name sshd -StartupType Automatic -ErrorAction SilentlyContinue
Start-Service sshd -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$svc = Get-Service sshd -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
  Good ("sshd 正在运行，启动类型：" + (Get-Service sshd).StartType)
} else {
  Bad "sshd 未能启动"
  Warn "可执行 Get-WinEvent -LogName 'OpenSSH/Operational' -MaxEvents 20 查看原因"
}

# 3. 本机防火墙放行 22
Say "3/4 放行本机防火墙 TCP 22"
if (-not (Get-NetFirewallRule -DisplayName "OpenSSH 22" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "OpenSSH 22" -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow -Profile Any | Out-Null
  Good "已创建防火墙规则"
} else {
  Good "防火墙规则已存在"
}

# 4. 自检
Say "4/4 自检"
$listen = Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue
if ($listen) { Good "本机 22 端口已监听" } else { Bad "本机 22 端口未监听" }

$who = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
Write-Host ""
Write-Host "  当前账户（SSH 登录用户名）：$who" -ForegroundColor White
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } | Select-Object -First 1 -ExpandProperty IPAddress)
if ($ip) { Write-Host "  内网地址：$ip" -ForegroundColor Gray }
Write-Host ""
Warn "别忘了阿里云安全组入方向放行 TCP 22（若尚未放行）"
Warn "部署完成后建议：限制 22 的来源 IP，或改用密钥登录，避免公网爆破"
Write-Host ""
Read-Host "完成，按回车退出"
