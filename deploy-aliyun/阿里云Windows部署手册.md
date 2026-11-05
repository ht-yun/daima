# 码审 CodeReview · 阿里云 Windows 服务器部署手册

> 项目类型：Vite 前端 + Node 原生 HTTP 后端（前后端一体，后端零第三方依赖）  
> 本地路径：`.\src-app`  
> 服务器路径：`C:\codereview\src-app`（建议，勿用中文路径）  
> 服务端口：`8080`，监听 `0.0.0.0`  
> 生产入口：`node server/index.mjs` → 同时提供 `/api/*` 接口与 `dist/` 静态页面

---

## 0. 实际部署记录（2026-11-04 已上线）

| 项目     | 实际值                                                                    |
| ------ | ---------------------------------------------------------------------- |
| 服务器    | `iZgm1dkwh13ssrZ`（Windows Server，公网 你的服务器IP）                       |
| 部署路径   | `C:\codereview\src-app`                                                |
| 运行环境   | Node **v26.13.0** / npm 11.20.0；Python 3.12.7 + black 26.10.1          |
| 运行期依赖  | `node_modules` 子集 22 MB（prettier 3.3.3 + eslint 8.57.1，95 个包）          |
| 进程托管   | pm2，进程名 `codereview`，`PM2_HOME=C:\codereview\.pm2`                     |
| 监听     | `0.0.0.0:8080`（PID 在 Services 会话）                                      |
| 开机自启   | 计划任务 `CodeReview-pm2`（SYSTEM / 开机时）→ `C:\codereview\pm2-resurrect.cmd` |
| SSH 登录 | 用户 `Administrator`（**不是** `hxy5555555558888`）                          |
| 验收     | 20 条用例全通过（见 10.1）：三语言 lint/格式化、AI 对话与审查、并发 104 req/s、强杀 2 秒自愈          |

运维脚本位于 `C:\codereview\`：`pm2-start.cmd`、`pm2-stop.cmd`、`pm2-resurrect.cmd`、`setup-startup.cmd`。

### 三个必须知道的坑（本次实际踩到）

1. **通过 SSH 起的 pm2 会随会话关闭被回收。** Windows OpenSSH 会话结束时，该会话派生的进程树会被终止。表现是：SSH 里 `pm2 start` 显示 online，断开再连就发现 8080 没有监听。正确做法是用计划任务（独立会话）拉起，即下面的 `CodeReview-pm2`。
2. **PM2_HOME 必须固定。** 默认在 `C:\Users\Administrator\.pm2`，SYSTEM 账户执行 `resurrect` 时读不到这份快照。所以统一改成 `C:\codereview\.pm2`，并让所有 pm2 操作都带这个变量（脚本里已写好）。
3. **「后端零依赖」是个错觉。** `server/index.mjs` 顶部确实只有 Node 内置模块，但 `formatJs()` 和 `lintJs()` 用的是**动态 import**（`prettier` / `eslint`），照第一版清单部署后这两个功能直接 `Cannot find package`。详见 **4.1**。同理，`.env` 里的 `PYTHON_BIN` 如果留着开发机路径，线上必然 `ENOENT` 并把本地目录结构泄露到前端报错里，详见 **4.2**。

---

## 1. 先记住三件事

| 事项   | 说明                                                            |
| ---- | ------------------------------------------------------------- |
| 后端入口 | `server/index.mjs`，只 import Node 内置模块，**运行时不依赖 node_modules** |
| 前端产物 | `dist/`，必须与 `server/` 同级，服务自动读取                               |
| 配置来源 | 根目录 `.env`（改动后重启服务生效；设置页保存会回写该文件）                             |

**关键认知**：只上传 `dist/` 只能看界面，登录、AI 分析、对话、修复全部 404/401。必须同时上传 `server/` 并以 `node server/index.mjs` 启动。

---

## 1. 本地构建（已在当前电脑执行完成）

```powershell
cd ".\src-app"
npm install
npm run build
```

本次实际执行结果（可复核）：

```
vite v5.4.21 building for production...
✓ 147 modules transformed.
dist/index.html                   0.48 kB
dist/assets/index-DhNezU1K.css   43.43 kB
dist/assets/index-BtJiCve-.js   924.79 kB │ gzip: 335.69 kB
✓ built in 12.89s
```

产物校验（`dist/` 应为 4 项 + assets）：

```
dist/index.html              481 B
dist/assets/index-*.js       940 KB
dist/assets/index-*.css       43 KB
dist/eng.traineddata         5.0 MB   ← OCR 语言包，从 public/ 复制而来
dist/app.ico                  30 KB
```

---

## 2. 本地启动测试（先在自己电脑上跑通再上服务器）

```powershell
cd ".\src-app"
$env:APP_HOST = "0.0.0.0"
$env:APP_PORT = "8080"
node server/index.mjs
```

浏览器访问 `http://127.0.0.1:8080`，同局域网可用 `http://本机IP:8080`。

本次实测结果：

```
[api] listening on http://0.0.0.0:8080 (model: deepseek-chat)
GET  /api/health   → {"ok":true,"time":...}
GET  /             → HTTP 200, 481 bytes
GET  /assets/index-BtJiCve-.js → HTTP 200, 940191 bytes
GET  /api/auth     → {"required":true,"authed":false}
POST /api/login    → 默认账号密码 → {"ok":true}
```

> 说明：`.env` 里写的是 `APP_PORT=8787`，上面用环境变量覆盖成 8080 是生效的（服务端会优先采用 `APP_*` 环境变量）。不想每次设环境变量，就直接把 `.env` 的 `APP_PORT` 改成 `8080`。

一键脚本：`deploy-aliyun\1-本地测试启动.ps1`

---

## 3. 打包上传（只传运行必需文件）

在本地执行：

```powershell
cd ".\src-app"
Compress-Archive -Path "dist","server",".env","package.json","ecosystem.config.cjs" `
                 -DestinationPath ".\codereview-deploy.zip" -Force
```

包体约 6 MB。**上传清单与禁止清单见 `deploy-aliyun\上传清单.md`**，一句话版本：

- 必传：`dist\`、`server\`、`.env`、`ecosystem.config.cjs`（`package.json` 一起带上便于以后在服务器重装依赖）
- 绝不传：`node_modules\`（平台相关、体积大，且运行时根本不需要）、`src\`（前端源码）、`tools\`、`logs\`、`*.zip`、`项目完整源码.md`

上传方式（任选）：

1. **远程桌面**：`mstsc` 连接 ECS 公网 IP → 本地磁盘映射 → 复制粘贴
2. **scp**（服务器已开 OpenSSH 时）：
   ```powershell
   scp ".\codereview-deploy.zip" Administrator@你的服务器IP:C:/codereview/
   ```

---

## 4. 服务器准备：手动安装 Node.js

> Node.js 需要你在服务器上手动安装，本手册只给校验命令，不做自动安装。

1. 下载 x64 MSI（推荐国内镜像）：`https://npmmirror.com/mirrors/node/v22.11.0/node-v22.11.0-x64.msi`
2. 双击安装，全部默认下一步，确保勾选 **Add to PATH**
3. **新开**一个 PowerShell 窗口，校验：

```powershell
node -v
npm -v
```

预期输出：`v22.11.0`（或更高的 22.x）与 `10.x`。两条命令都正常返回版本号才算安装成功；若提示“不是内部或外部命令”，重开窗口，仍不行则手动把 `C:\Program Files\nodejs` 加入系统 PATH。

### 4.1 运行期依赖 prettier / eslint（不做 JS 功能会失效）

`server/index.mjs` 静态引入的确实全是 Node 内置模块，但**有两处动态 import**：

```js
formatJs()  ->  await import("prettier")
lintJs()    ->  await import("eslint")
```

不装这两个包，前端页面能打开、AI 审查能用，但**JavaScript 格式化与 JS 规则检查会报 `Cannot find package`**（2026-11-04 首次部署就是这么踩的）。

只装这两个包的依赖树（约 22 MB / 95 个包），不要传完整 `node_modules`（141 MB，含前端包和 esbuild 二进制）：

```powershell
# 本地准备（临时目录，避免污染项目）
New-Item -ItemType Directory -Force -Path "D:\temp\rdeps" | Out-Null
cd "D:\temp\rdeps"
'{ "name":"runtime-deps","private":true,"dependencies":{ "prettier":"3.3.3","eslint":"8.57.1" } }' |
  Set-Content package.json -Encoding utf8
npm install --omit=dev --no-audit --no-fund
Compress-Archive -Path ".\node_modules\*" -DestinationPath ".\nm.zip" -Force

# 服务器解压（4.7 MB 单文件上传，比逐个 SFTP 传 1405 个文件快得多）
Expand-Archive "C:\codereview\nm.zip" -DestinationPath "C:\codereview\src-app\node_modules" -Force
Remove-Item "C:\codereview\nm.zip" -Force

# 验收
Test-Path "C:\codereview\src-app\node_modules\prettier\package.json"   # True
Test-Path "C:\codereview\src-app\node_modules\eslint\package.json"     # True
(Get-ChildItem "C:\codereview\src-app\node_modules" -Directory).Count   # 95
```

装完必须 `pm2 restart codereview`，动态 import 有模块缓存。

### 4.2 Python 3 + black（不做 Python 功能会降级）

| 能力          | 依赖                                            | 缺失表现                             |
| ----------- | --------------------------------------------- | -------------------------------- |
| Python 规则检查 | `python.exe` 跑 `server\lint_py.py`（只用标准库 ast） | `engine: failed`，提示没有 Python 运行时 |
| Python 格式化  | `python -m black`                             | 提示服务器没装 black                    |

```powershell
Invoke-WebRequest "https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe" `
  -OutFile C:\codereview\pysetup.exe -UseBasicParsing
Start-Process C:\codereview\pysetup.exe -Wait -ArgumentList `
  "/quiet","InstallAllUsers=1","PrependPath=1","Include_pip=1","Include_test=0"
& "C:\Program Files\Python312\python.exe" -m pip install black -i https://pypi.tuna.tsinghua.edu.cn/simple
& "C:\Program Files\Python312\python.exe" -V          # Python 3.12.7
& "C:\Program Files\Python312\python.exe" -m black --version
Remove-Item C:\codereview\pysetup.exe -Force
```

**关键**：新装的 Python 不会出现在已运行的服务进程 PATH 里（进程环境是启动时的快照）。所以要在 `.env` 显式指定：

```ini
PYTHON_BIN=C:\Program Files\Python312\python.exe
```

然后 `pm2 restart codereview --update-env; pm2 save`。

> 路径含空格没关系，值是整行读取、不经过 shell 解析。  
> 反之，**绝不能**把开发机路径（如 `C:\Users\Lenovo\.dsh\...\python.exe`）写进 `.env` 后上传——  
> 服务器上必然 ENOENT，而且报错会把本地目录结构泄露给前端。

---

## 5. 服务器上创建目录并解压

以**管理员身份**打开 PowerShell：

```powershell
# 建目录（避开中文路径，避免编码坑）
New-Item -ItemType Directory -Force -Path "C:\codereview\src-app" | Out-Null

# 解压上传的包
Expand-Archive -Path "C:\codereview\codereview-deploy.zip" -DestinationPath "C:\codereview\src-app" -Force

# 校验关键文件（4 个都必须存在）
cd "C:\codereview\src-app"
Test-Path "server\index.mjs"          # True
Test-Path "dist\index.html"           # True
Test-Path ".env"                      # True
Test-Path "ecosystem.config.cjs"      # True
Test-Path "dist\eng.traineddata"      # True（OCR 语言包）
```

若 `dist\eng.traineddata` 缺失，说明打包时漏了 `public\eng.traineddata`，回到本地重新构建再打包。

---

## 6. 配置 .env（公网前必做）

用记事本打开 `C:\codereview\src-app\.env`：

```ini
APP_PORT=8080
APP_HOST=0.0.0.0
APP_USERS=admin:change-me
APP_PASSWORD=
MODEL_API_KEY=sk-你的新Key
```

要点：

- `APP_PORT` 改成 **8080**（原值 8787 会让安全组放行的 8080 打不开）
- `APP_USERS` 格式为 `用户名:密码`，多个账号用逗号分隔；**不要清空**，清空后等于取消登录校验，任何人可直接用你的 Key
- `PYTHON_BIN` 若服务器没装 Python，可留空或填 `python`；只影响“Python 代码静态检查”，不影响 AI 分析主流程
- `.env` 会被设置页回写，**不要设为只读**
- 文件保存为 **ANSI 或 UTF-8 无 BOM**，避免首行变量读不到

---

## 7. pm2 常驻运行

```powershell
cd "C:\codereview\src-app"

# 1. 全局安装 pm2（本机已装 7.x）
npm install -g pm2

# 2. 启动（ecosystem 内已写死 APP_HOST=0.0.0.0 / APP_PORT=8080 / NODE_ENV=production）
pm2 start ecosystem.config.cjs

# 3. 查看状态（status 必须是 online）
pm2 status
pm2 logs codereview --lines 30

# 4. 保存当前进程列表（开机自启依赖这份快照）
pm2 save
```

> 若提示 `pm2 不是内部或外部命令`，关闭并重开 PowerShell；仍不行用 `npm root -g` 找到全局目录后把其上级加入 PATH，或直接用 `npx pm2 start ecosystem.config.cjs`。

**但通过 SSH 这样启动会踩坑**：会话断开后 pm2 守护进程和子进程会被一起回收。日常运维请统一用 `C:\codereview\` 下的两个脚本，它们带固定的 `PM2_HOME`：

```batch
C:\codereview\pm2-start.cmd     :: 启动/重启（含 pm2 save）
C:\codereview\pm2-stop.cmd      :: 停止守护进程
schtasks /run /tn CodeReview-pm2 :: 以 SYSTEM 身份在独立会话拉起（推荐）
```

在远程桌面里手工查看状态时，记得先设置同一个 PM2_HOME，否则 `pm2 list` 会是空的：

```powershell
$env:PM2_HOME = "C:\codereview\.pm2"
pm2 status
```

---

## 8. 开机自启（本机实际采用：SYSTEM 计划任务 + 固定 PM2_HOME）

不要用 `pm2-windows-startup`，也不要直接 `schtasks ... /tr "cmd /c pm2 resurrect"`——默认 PM2_HOME 在 Administrator 用户目录下，SYSTEM 账户读不到快照，重启后必然拉不起来。

**步骤一：把 PM2_HOME 固定到 `C:\codereview\.pm2`**（脚本 `C:\codereview\pm2-start.cmd`）

```bat
@echo off
set PM2_HOME=C:\codereview\.pm2
cd /d C:\codereview\src-app
call "C:\Users\Administrator\AppData\Roaming\npm\pm2.cmd" start ecosystem.config.cjs
call "C:\Users\Administrator\AppData\Roaming\npm\pm2.cmd" save
```

**步骤二：注册开机任务**（脚本 `C:\codereview\setup-startup.cmd`）

```bat
schtasks /create /tn "CodeReview-pm2" /tr "C:\codereview\pm2-resurrect.cmd" /sc onstart /ru SYSTEM /rl highest /f
```

`pm2-resurrect.cmd` 内容：

```bat
@echo off
set PM2_HOME=C:\codereview\.pm2
call "C:\Users\Administrator\AppData\Roaming\npm\pm2.cmd" resurrect
```

**步骤三：立即拉起（不等重启）**

```bat
schtasks /run /tn CodeReview-pm2
```

验证要点：`tasklist /fi "imagename eq node.exe"` 里两个 node 进程的**会话名应为 `Services`（session 0）**，而不是 `RDP-Tcp#0`。只有落在 Services 会话，才不会随远程桌面/SSH 断开而被回收。

如果要真实重启验证：

```powershell
Restart-Computer
# 回来后再看
tasklist /fi "imagename eq node.exe"
netstat -ano | findstr :8080
```

> 本次部署用 `schtasks /run` 验证了任务本身能拉起服务（等价于开机时的执行路径），未实际重启服务器。



---

## 9. 放行端口（两层都要做，缺一不可）

### 9.1 服务器内部防火墙

```powershell
New-NetFirewallRule -DisplayName "CodeReview 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
```

### 9.2 阿里云安全组

控制台 → ECS 实例 → 安全组 → 配置规则 → 入方向 → 手动添加：

| 项目   | 值                                       |
| ---- | --------------------------------------- |
| 授权策略 | 允许                                      |
| 优先级  | 1                                       |
| 协议类型 | 自定义 TCP                                 |
| 端口范围 | `8080/8080`                             |
| 授权对象 | `0.0.0.0/0`（演示）；正式环境建议改成你的办公出口 IP `/32` |

**不要**放行 5173（Vite dev）、8787（内部端口）、3000 等无关端口。

---

## 10. 验收测试

服务器本机：


```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:8080/api/health" -UseBasicParsing | Select-Object -ExpandProperty Content
# {"ok":true,"time":...}
```

公网（在你自己电脑上）：

```powershell
Invoke-WebRequest -Uri "http://你的服务器IP:8080/api/health" -UseBasicParsing
```

浏览器打开 `http://你的服务器IP:8080`，用 `.env` 里的新账号登录，跑一次「代码分析」验证 AI 链路。

排查顺序：本机通 + 公网不通 → 安全组；本机不通 → pm2 状态与 8080 监听。

### 10.1 完整验收用例（2026-11-04 实测全部通过）

设 `$B = "http://你的服务器IP:8080"`，先登录拿 cookie：

```powershell
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-RestMethod -Uri "$B/api/login" -Method Post -WebSession $s `
  -ContentType "application/json" -Body '{"username":"testuser","password":"testpass"}'
```

| #  | 用例          | 请求                                          | 期望                                                    |
| -- | ----------- | ------------------------------------------- | ----------------------------------------------------- |
| 1  | 心跳          | `GET /api/health`                           | `{"ok":true}`                                         |
| 2  | 首页          | `GET /`                                     | 200，约 481 B                                           |
| 3  | 静态资源        | `GET /assets/index-*.js`                    | 200，约 940 KB                                          |
| 4  | OCR 语言包     | `GET /eng.traineddata`                      | 200，5,199,098 B                                       |
| 5  | 未登录拦截       | `GET /api/config` 不带 cookie                 | 401 `UNAUTHORIZED`                                    |
| 6  | 错密码         | `POST /api/login` 错误密码                      | 401                                                   |
| 7  | 密钥不外泄       | `GET /api/config`                           | **只有 `hasKey/model/baseUrl/mock`，无 `sk-` 明文**         |
| 8  | Python 规则检查 | `POST /api/lint` python                     | `engine: "python-ast"`                                |
| 9  | Python 格式化  | `POST /api/format` python                   | black 格式化后的代码，`changed:true`                          |
| 10 | JS 规则检查     | `POST /api/lint` javascript                 | `engine: "eslint"`，能报未定义变量                            |
| 11 | JS 格式化      | `POST /api/format` javascript               | prettier 格式化结果                                        |
| 12 | Java 规则检查   | `POST /api/lint` java                       | `engine: "heuristic"`                                 |
| 13 | Java 格式化    | `POST /api/format` java                     | 返回格式化代码                                               |
| 14 | AI 对话       | `POST /api/chat`                            | SSE `data: {"text":"..."}` 逐字返回，末尾 `{"done":true}`    |
| 15 | AI 审查       | `POST /api/analyze`                         | 返回 `summary` + `issues[]`（含 line/severity/suggestion） |
| 16 | 文件导入往返      | `POST /api/ingest` → `GET /api/ingest/{id}` | 返回同名同内容                                               |
| 17 | 404 兜底      | `GET /not-exist-page`                       | 200 返回 index.html（SPA 前端路由回落，正常）                      |
| 18 | 并发吞吐        | 50 次 `GET /api/health`，10 并发                | 失败 0，约 104 req/s，p95 171 ms                           |
| 19 | 大文件带宽       | 5 次 `GET /eng.traineddata`，3 并发             | 失败 0，约 13 MB/s                                        |
| 20 | 崩溃自愈        | 强杀 node 进程                                  | pm2 约 **2 秒**内拉起，端口恢复，health 正常                       |

第 20 条的做法：

```powershell
$env:PM2_HOME = "C:\codereview\.pm2"
$pid8080 = (Get-NetTCPConnection -LocalPort 8080 -State Listen).OwningProcess
Stop-Process -Id $pid8080 -Force
Start-Sleep -Seconds 3
Get-NetTCPConnection -LocalPort 8080 -State Listen | Select-Object LocalPort, OwningProcess
```

如果 3 秒后没有端口监听、`pm2 status` 显示 `errored`，看 `C:\codereview\.pm2\logs\codereview-error.log`。

---

## 11. 日常运维命令

先进入正确的上下文（PM2_HOME 固定为 `C:\codereview\.pm2`）：

```powershell
$env:PM2_HOME = "C:\codereview\.pm2"
cd C:\codereview\src-app
```

```powershell
pm2 status                    # 进程状态
pm2 logs codereview           # 实时日志（Ctrl+C 退出）
pm2 logs codereview --lines 100
pm2 restart codereview        # 改完 .env 必须重启
pm2 reload codereview         # 平滑重启
pm2 stop codereview
pm2 delete codereview
pm2 monit                     # CPU/内存监控
pm2 save                      # 改完进程后重新保存快照
```

日志位置随 PM2_HOME 变化，现在是：  
`C:\codereview\.pm2\logs\codereview-out.log`、`codereview-error.log`；应用自身日志在 `C:\codereview\src-app\logs\app.log`。

远程 SSH 下排查建议直接用对应功能：

```bat
netstat -ano | findstr :8080
tasklist /fi "imagename eq node.exe"
schtasks /query /tn CodeReview-pm2
schtasks /run /tn CodeReview-pm2
```

日志文件：`C:\Users\Administrator\.pm2\logs\`；应用自身日志：`C:\codereview\src-app\logs\app.log`（会自动创建，注意定期清理）。

---

## 12. 安全清单（公网部署逐条确认）

- [ ] **改掉默认登录密码**：`.env` 的 `APP_USERS` 默认是 `admin:change-me`，公网等同裸奔，必须换成强密码（12 位以上字母+数字+符号）
- [ ] **保护真实 API Key**：`.env` 内含 DeepSeek 与通义千问（DashScope）真实密钥；不要随源码包外发、不要提交 Git、不要贴群里。若曾外泄，立刻到两家控制台**吊销并重建**
- [ ] **严禁 dev 模式上公网**：`npm run dev` 会启动 Vite 开发服务器（5173），带源码映射与热更新、无任何鉴权，只在本机调试用
- [ ] **只放行 8080**：安全组与防火墙都只开 8080；3389（远程桌面）建议限制来源 IP
- [ ] **不要清空 `APP_USERS`**：清空即关闭登录校验
- [ ] **登录无失败次数限制**：本项目未做登录限流，弱密码会被爆破，务必用强密码
- [ ] **建议上 HTTPS**：当前 Cookie 未设置 Secure 标记，纯 HTTP 传输；有条件用云厂商证书 + 反向代理，或仅内网使用
- [ ] **定期轮换密钥**：API Key 与登录密码按月轮换一次
- [ ] **`.env` 权限收紧**：只给运行账户读写权限，避免多用户服务器上被读取
- [ ] **备份**：定期备份 `C:\codereview\src-app\.env` 与 `logs\`

---

## 13. 常见问题

| 现象                                                       | 原因                                        | 处理                                               |
| -------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| 公网打不开，本机能开                                               | 安全组没放行 8080                               | 安全组入方向加 TCP 8080                                 |
| `Invoke-WebRequest` 连接被拒                                 | 服务没起或监听 127.0.0.1                         | `pm2 status`，确认 `APP_HOST=0.0.0.0`               |
| 页面 200 但接口 401                                           | 未登录/账号密码不对                                | 用 `.env` 中 `APP_USERS` 的账号登录                     |
| 打开是白屏、assets 404                                         | `dist` 没上传或路径错                            | 确认 `dist\assets\` 与 `server\` 同级                 |
| 提示 `NO_MODEL`                                            | `.env` 的 `MODEL_API_KEY` 为空               | 填 Key 后 `pm2 restart codereview`                 |
| 重启服务器后服务没了                                               | 未做开机自启或没 `pm2 save`                       | 执行第 8 节方案 A 或 B                                  |
| 中文乱码                                                     | 路径含中文或文件非 UTF-8                           | 统一用 `C:\codereview`，`.env` 存为 ANSI/UTF-8 无 BOM   |
| `npm install` 报 `Cannot read properties of null`         | 混用 pnpm 的 node_modules 布局                 | 删除 node_modules 后重装（服务器上通常不需要装依赖）                |
| 格式化/Lint 报 `Cannot find package 'prettier'` 或 `'eslint'` | 漏传运行期依赖（本文档第一版就写错了）                       | 按 **4.1** 传 `node_modules` 子集，然后 restart         |
| Python 功能报 `spawn C:\Users\xxx\...\python.exe ENOENT`    | `.env` 里 `PYTHON_BIN` 是开发机绝对路径，随包上传了      | 改成服务器实际路径（**4.2**），或删掉该行走自动探测                    |
| Python 功能报「没有可用的 Python 3 运行时」                           | 服务器没装 Python                              | 按 **4.2** 装 Python + black，并设置 `PYTHON_BIN`      |
| 装了 Python 但服务仍找不到                                        | 服务进程 PATH 是启动时快照                          | 用绝对路径写 `PYTHON_BIN`，`pm2 restart --update-env`   |
| `pm2 jlist` 输出用 `ConvertFrom-Json` 解析报重复键                | pm2 的 JSON 里有 `username`/`USERNAME` 大小写重复 | 用 `pm2 status` 或 `pm2 describe` 看，别用 PS 解析 jlist |

---

## 14. GitHub 仓库导入（v1.1 新增，需重新上传两个文件）

### 14.1 功能是什么

文件弹层里多了一个「GitHub 仓库」页签：粘贴 `https://github.com/owner/repo`（或 `/tree/分支/目录`、`/blob/分支/文件`），
服务端把代码拉下来，选中文件后进入左侧编辑器，**后续流程与本地拖文件完全一致**（规则扫描 → 静态检查 → 模型分析 → 修复）。

- 自动跳过 `node_modules`、`dist`、`build`、`target`、`vendor`、`__pycache__` 等目录和图片/压缩包等二进制
- 单文件上限 400KB，每次最多列 800 个文件，超出用 `/tree/分支/目录` 缩小范围
- 超过 400 行的文件**只定位问题、不生成整份修复代码**（模型单次输出长度上限），单条问题仍可点「修复」单独改
- 只读：不会往目标仓库写任何东西，也不需要克隆

### 14.2 这次要传什么

| 文件 | 说明 |
| --- | --- |
| `server\index.mjs` | 新增 `/api/github/tree`、`/api/github/file` 两个接口 |
| `dist\`（整个目录） | 前端新增 GitHub 页签，必须重新构建后上传 |

`.env` **不需要改**也能用（公共仓库匿名访问）。上传后执行：

```powershell
cd C:\codereview\src-app
pm2 restart codereview --update-env
pm2 save
```

### 14.3 可选配置（建议配，能明显提升稳定性）

在 `C:\codereview\src-app\.env` 末尾追加：

```ini
# 可选：私有仓库必须配；公共仓库配了也不消耗匿名额度（每小时 60 次 → 5000 次）
GITHUB_TOKEN=ghp_你的token

# 可选：服务器直连 GitHub 不通时才会自动用的加速镜像（默认 https://gh-proxy.com/）
# GITHUB_PROXY=https://gh-proxy.com/

# 可选：设为 1 则完全不走直连，强制走镜像
# GITHUB_FORCE_PROXY=0
```

Token 在 GitHub → Settings → Developer settings → Personal access tokens 生成，
公共仓库只读场景勾选 `public_repo` 即可（私有仓库勾 `repo`）。

### 14.4 上线后自检

```powershell
# 1) 本机能不能连上 GitHub（不通也不要紧，会自动走镜像）
curl.exe -s -o NUL -w "%{http_code}`n" https://api.github.com/repos/psf/requests

# 2) 通过服务拉一个公共仓库（需要先登录拿 Cookie，或直接在网页上试）
#    浏览器打开 http://公网IP:8080 → 打开文件 → GitHub 仓库 → 粘贴地址 → 载入
```

预期：出现 `psf/requests` 的文件列表，点任意 `.py` 文件能进编辑器并跑完分析。

### 14.5 报错对照

| 提示 | 含义 | 处理 |
| --- | --- | --- |
| 服务器连不上 GitHub（直连和镜像都失败） | 服务器出网被封 | 配 `GITHUB_PROXY` 指向可用代理，或给服务器开外网 |
| GitHub 接口限流了（匿名每小时 60 次） | 匿名额度用尽 | 配 `GITHUB_TOKEN` |
| 仓库、分支或文件不存在 | 地址错，或私有仓库没配 token | 核对地址 / 配 `GITHUB_TOKEN` |
| 只支持 github.com 的仓库地址 | 传了 GitLab/Gitee 链接 | 目前只支持 GitHub |

---

## 附：一页纸速查

```powershell
# 服务器首次部署（管理员 PowerShell）
New-Item -ItemType Directory -Force -Path "C:\codereview\src-app" | Out-Null
Expand-Archive "C:\codereview\codereview-deploy.zip" "C:\codereview\src-app" -Force
cd "C:\codereview\src-app"
# （先改 .env：APP_PORT=8080、APP_USERS=admin:change-me
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
npm install -g pm2-windows-startup
pm2-startup install
New-NetFirewallRule -DisplayName "CodeReview 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
Invoke-WebRequest "http://127.0.0.1:8080/api/health" -UseBasicParsing
```

阿里云控制台：安全组入方向放行 TCP 8080 → 浏览器访问 `http://服务器公网IP:8080`。
