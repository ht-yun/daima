# 码审 CodeReview · Windows Server 2022 部署手册
> 方案：Vite 构建产物 `dist/` + `serve` + `pm2`
> 目标：阿里云 ECS，公网 IP `你的服务器IP`，Windows Server 2022
> 不使用 Nginx、不使用 IIS

---

## ⚠️ 先看这一节（30 秒，决定后面怎么做）

这个项目**不是一个纯静态网站**。`dist/` 只是前端界面，所有 AI 能力（分析、对话、修复、登录、格式化）都由 `server/index.mjs` 提供。

| 部署方式 | 界面能开 | 规则扫描 | AI 分析/对话 | 登录 |
|---|---|---|---|---|
| 只部署 `dist`（本手册主方案） | ✅ | ✅ | ❌ 全部失败 | ❌ 无法登录 |
| 同时跑 `server/index.mjs`（推荐） | ✅ | ✅ | ✅ | ✅ |

**如果只是给人看界面/演示，用本手册的 serve 方案没问题。**
**如果要真正能用，看文末附录 A：一条命令同时跑前后端。**

---

## 一、本地打包（在自己电脑上做）

打开 PowerShell：

```powershell
cd .

# 1. 安装依赖（首次或依赖变更时执行）
npm install

# 2. 构建，产物在 dist\ 目录
npm run build

# 3. 打成 zip，方便传到服务器
Compress-Archive -Path dist\* -DestinationPath dist.zip -Force
```

执行完检查：

```powershell
dir dist\index.html
```

能看到 `index.html` 和 `assets\` 文件夹就算成功。

### 关于 eng.traineddata

这个 OCR 语言包**不需要放进 `dist`**，它只被 `tools/` 下的 OCR 测试脚本使用，Web 运行时不加载。
如果你要在服务器上跑 OCR 工具，才需要单独上传它，并安装 Tesseract。

---

## 二、服务器上安装 Node.js

远程桌面连上服务器（`mstsc` → `你的服务器IP`）。

1. 浏览器打开（国内镜像，速度快）：

```
https://npmmirror.com/mirrors/node/v22.11.0/node-v22.11.0-x64.msi
```

2. 下载后双击安装，一路“下一步”（默认选项即可，会自动加环境变量）
3. 关闭所有 PowerShell 窗口，**重新打开一个**，验证：

```powershell
node -v      # 应输出 v22.11.0
npm -v       # 应输出 10.x
```

如果提示“不是内部或外部命令”，说明环境变量没生效，重启服务器再试。

---

## 三、安装 serve 和 pm2

先换国内源（可选，但强烈建议）：

```powershell
npm config set registry https://registry.npmmirror.com
```

安装两个全局工具：

```powershell
npm install -g serve pm2
```

验证：

```powershell
serve --version
pm2 --version
```

---

## 四、上传文件并启动

### 4.1 建目录、传文件

```powershell
mkdir C:\codereview -Force
```

把你本地的 `dist.zip` 复制到 `C:\codereview\`（直接 Ctrl+C / Ctrl+V 到远程桌面即可），然后解压：

```powershell
cd C:\codereview
Expand-Archive -Path dist.zip -DestinationPath . -Force
```

解压后应该是：

```
C:\codereview\
  ├─ index.html
  └─ assets\
```

### 4.2 先手动试跑一次

```powershell
cd C:\codereview
serve -s . -l 8080
```

看到 `Serving!` 和地址就说明起来了。浏览器打开 `http://127.0.0.1:8080` 看看能不能显示。

**能显示** → 按 Ctrl+C 停掉，进入下一步用 pm2 常驻。
**不能显示** → 截图发我，别往下走。

> `-s` 就是单页应用模式（SPA fallback），所有找不到的路径都会返回 `index.html`。
> **不加这个参数，刷新页面必然 404。** 这是 history 路由的核心。

### 4.3 用 pm2 常驻

先停掉刚才手动跑的那个。然后在 `C:\codereview` 下装一份本地 serve（比全局命令更稳，pm2 能正确识别入口）：

```powershell
cd C:\codereview
npm init -y
npm install serve
```

启动：

```powershell
cd C:\codereview
pm2 start node_modules\serve\build\main.js --name codereview -- -s . -l 8080
```

检查状态：

```powershell
pm2 status
pm2 logs codereview --lines 20
```

看到 `codereview` 是 `online` 就成功了。

---

## 五、设置开机自启

PM2 在 Windows 上不支持原生的 `pm2 startup`，用这个包代替：

```powershell
npm install -g pm2-windows-startup
pm2-startup install
pm2 save
```

三行都要执行，顺序不能乱：

1. `pm2-startup install` 写入开机启动项
2. `pm2 save` 把当前进程列表存下来
3. 以后改了配置，**必须再执行一次 `pm2 save`**

### 验证是否真的会自启

```powershell
Restart-Computer
```

重启后重新连上，执行 `pm2 status`。如果 `codereview` 是 online，就说明开机自启成功。

> 如果重启后 pm2 列表是空的，说明 `pm2-startup install` 没生效。
> 备用方案：任务计划程序 → 创建任务 → 触发器选“启动时” → 操作填 `pm2 resurrect`。

---

## 六、放行端口（两处都要做，少一处都打不开）

### 6.1 Windows 防火墙

管理员 PowerShell：

```powershell
New-NetFirewallRule -DisplayName 'CodeReview 8080' -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
```

### 6.2 阿里云安全组

控制台 → ECS → 实例 → 安全组 → **入方向** → 添加规则：

| 授权策略 | 协议类型 | 端口范围 | 授权对象 |
|---|---|---|---|
| 允许 | 自定义 TCP | **8080/8080** | `0.0.0.0/0`（或你的 IP） |

保存后立刻生效，不需要重启。

### 6.3 验证

在**你自己电脑**的浏览器打开：

```
http://你的服务器IP:8080
```

- 打得开 → 成功
- 打不开、转圈 → 安全组没放行
- 连接被重置 → 端口被占用，换 8090 再试

---

## 七、🔴 .env 与 API Key 泄露风险（重点）

这个项目的 `.env` 里有两把真实的 Key：

```
MODEL_API_KEY=sk-...        # DeepSeek
MM_API_KEY=sk-ws-...        # 千问（视觉 + 语音）
```

### 必须遵守的五条

1. **不要把 `.env` 放进 `dist`** —— 它只给后端读，前端构建产物里不该出现。
2. **不要打包进 zip 发给别人** —— 你之前的源码包里是含 `.env` 的，转发前请删掉。
3. **不要提交到 Git / Gitee / 网盘** —— 一旦公开，Key 会被爬虫扫到，几小时内就能被刷爆额度。
4. **不要在聊天、截图、录屏里露出 Key** —— 你已经在这台对话里发过两次，建议**立刻去官网轮换**。
5. **服务器上给 `.env` 收紧权限**：

```powershell
icacls C:\codereview\.env /inheritance:r /grant:r "$env:USERNAME:(R,W)"
```

### 泄露的后果

别人拿到 Key 可以直接调你的接口跑他自己的程序，账单算在你头上。DeepSeek 和阿里云都是后付费，没有硬性上限。

### 建议动作

- 登录 DeepSeek 控制台 → API Keys → 删除旧 Key，新建一个
- 登录阿里云百炼控制台 → 同样的操作
- 把新 Key 只写进服务器的 `.env`，本地留一份在密码管理器里

---

## 八、常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| 刷新页面 404 | 启动时漏了 `-s` | 删掉进程重建，命令里带 `-s` |
| 页面空白，控制台报 404 | `dist` 路径不对 | 确认 `C:\codereview\index.html` 存在，启动用 `-s .` |
| 端口被占用 | 别的程序占了 8080 | `netstat -ano` 查 PID，或换 8090 |
| pm2 重启后没了 | 没执行 `pm2 save` | 重新 `pm2 save` |
| 外网打不开，本机能开 | 安全组没放行 | 见第六章 |
| 界面能开但 AI 全报错 | 只部署了静态文件 | 见附录 A |

---

## 九、验收清单

- [ ] 本地 `npm run build` 成功，`dist\index.html` 存在
- [ ] 服务器 `node -v` 有输出
- [ ] `pm2 status` 里 codereview 是 online
- [ ] 服务器本机浏览器能打开 `http://127.0.0.1:8080`
- [ ] 防火墙放行 8080
- [ ] 安全组放行 8080
- [ ] 自己电脑能打开 `http://你的服务器IP:8080`
- [ ] 随便点进一个页面，按 F5 刷新不 404
- [ ] 重启服务器后 pm2 自动拉起

---

## 附录 A：想真正能用（前后端一起跑）

只放 `dist` 时，AI 分析、对话、登录全部不可用。要让功能完整，把后端也跑起来。

### A.1 上传完整源码（不是只有 dist）

把项目源码传到 `C:\codereview\src-app\`（不含 `node_modules`），然后：

```powershell
cd C:\codereview\src-app
npm install
npm run build
```

### A.2 用 pm2 跑后端（它自己就会托管 dist）

```powershell
cd C:\codereview\src-app
$env:APP_HOST='0.0.0.0'
$env:APP_PORT='8080'
pm2 start server\index.mjs --name codereview --update-env
pm2 save
```

这个进程同时提供静态页面（`dist/`）和全部 API（`/api/analyze`、`/api/chat`、`/api/auth`）。
**所以不需要 serve，也不用单独跑前端。** 端口还是 8080，前面的防火墙和安全组配置完全复用。

### A.3 对比

| | serve 方案 | server/index.mjs 方案 |
|---|---|---|
| 命令复杂度 | 需要 serve + pm2 | 只要 pm2 |
| 功能完整性 | 只有界面 | 完整 |
| 依赖 | dist | 源码 + npm install |

如果目标是“给评委演示完整功能”，直接用 A.2，比 serve 更简单。

---

## 附：命令速查

```powershell
# 本地
npm install
npm run build
Compress-Archive -Path dist\* -DestinationPath dist.zip -Force

# 服务器
mkdir C:\codereview -Force
cd C:\codereview
Expand-Archive dist.zip -DestinationPath . -Force
npm init -y
npm install serve
npm install -g pm2 pm2-windows-startup
pm2 start node_modules\serve\build\main.js --name codereview -- -s . -l 8080
pm2-startup install
pm2 save

# 防火墙
New-NetFirewallRule -DisplayName 'CodeReview 8080' -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
```