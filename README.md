# 码审 CodeReview

一个跑在本机的代码审查工具：**本地规则引擎 + 大模型深度分析 + 一键修复 + 前后对比**。
粘贴或拖入代码，几十秒内得到带行号的问题清单、五维评分和可对比的修改建议。

## 功能

**审查能力**

- 19 条本地规则，覆盖安全 / 语法 / 逻辑 / 性能 / 规范五个维度，纯前端计算、不联网也能跑
- 大模型深度分析：把代码和规则命中一起交给模型，返回结构化 JSON，附带修改建议与修复后代码
- 一键修复：用修复后的代码替换编辑器，并重新跑规则看还剩多少问题
- 逐行 diff 对比：新增绿、删除红，并给出修复前后的五维分数增量
- 五维评分：每维 100 分起，高危 −15、中危 −8、提示 −3，下限 0
- 大文件保护：超过 400 行或 16KB 自动切换精简提示词，只报问题不返回整份修复，避免超时

**输入方式**

- 编辑器直接写，支持 Python / JavaScript / Java 语法高亮
- 拖拽或选择本地文件导入，导入后自动开始检查
- 粘贴 GitHub 地址（仓库 / 目录 / 单文件 / `owner/repo` 均可）拉取代码直接分析

**界面**

- 概览页：统计卡、五维雷达图、最近审查、风险预警、评分趋势、快捷入口
- 审阅台：左侧代码、右侧「问题 / 对比 / 对话」三标签
- 全局检索：按文件名、代码内容搜索历史审查记录
- 深色 / 浅色主题，深色下可选代码雨背景（三档强度，可关闭）
- 顶栏运行日志、历史记录抽屉、模型配置弹窗

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | React 18 + TypeScript + Vite 5 |
| 编辑器 | CodeMirror 6 |
| 后端 | Node 原生 `http`，单文件 `server/index.mjs`，无框架 |
| 模型 | 任意 OpenAI 兼容接口（默认 DeepSeek），多模态走 DashScope |
| 格式化 | Python `black` / Prettier / 内置 Java 缩进整理 |

前后端同源部署：Node 服务同时提供 API 和 `dist/` 静态资源，只有一个端口。

## 快速开始

需要 **Node.js 18+**（推荐 20 LTS）。Python 格式化功能额外需要 Python 3 + `black`，不装也能用，只是该功能会被跳过。

```bash
# 1. 安装依赖
npm install

# 2. 准备配置
cp .env.example .env      # Windows: copy .env.example .env
#    编辑 .env，至少填 MODEL_API_KEY；不填则进入演示模式

# 3. 构建前端
npm run build

# 4. 启动（同时提供 API 与页面）
npm start                 # 等价于 node server/index.mjs
```

打开 http://127.0.0.1:8080 。如果 `.env` 里配置了 `APP_USERS`，会先要求登录。

开发模式另开两个终端：

```bash
node server/index.mjs     # 终端 1：API，端口取 .env 的 APP_PORT（默认 8787）
npm run dev               # 终端 2：Vite 热更新，127.0.0.1:5173
```

开发代理写在 `vite.config.ts` 里，默认指向 `127.0.0.1:8787`；如果你改了 `APP_PORT`，记得同步改这里的 `target`。

Windows 下也可以直接双击 `start.cmd`（构建并启动）或 `dev.cmd`（开发模式）。

## 配置

所有配置走 `.env`，模板见 [.env.example](.env.example)。

| 变量 | 说明 |
| --- | --- |
| `MODEL_BASE_URL` / `MODEL_NAME` / `MODEL_API_KEY` | 文本模型接口、模型名、密钥 |
| `MODEL_TIMEOUT_MS` / `MODEL_TEMPERATURE` | 请求超时（默认 45s）、采样温度（默认 0.1） |
| `MODEL_MOCK=1` | 演示模式，不调用真实模型，返回内置样例结果 |
| `MM_*` | 图片识别 / 语音转写的接口与密钥 |
| `APP_USERS` | 登录账号，`user:pass` 逗号分隔，留空则不启用登录 |
| `APP_HOST` / `APP_PORT` | 监听地址与端口，默认 `0.0.0.0:8080` |
| `GITHUB_TOKEN` | 可选。提高 GitHub API 限额，并支持私有仓库 |
| `GITHUB_PROXY` | 可选。`raw.githubusercontent.com` 不通时的镜像地址，默认 `https://gh-proxy.com/` |
| `PYTHON_BIN` | 可选。指定 Python 解释器，用于 `black` 格式化 |

密钥只在服务端读写，前端拿不到；日志不记录代码内容和密钥。

## 目录结构

```
server/index.mjs           API 服务：模型调用、格式化、GitHub 拉取、鉴权、静态托管
src/
  App.tsx                  页面骨架、状态、AI 分析流程
  components/
    Overview.tsx           概览页（统计、雷达、趋势、预警）
    CodeEditor.tsx         CodeMirror 封装、问题行装饰、行跳转
    FilePicker.tsx         本地文件 / GitHub 仓库双页签
    MatrixRain.tsx         深色主题代码雨背景
    SettingsPanel.tsx      设置面板
    Sidebar.tsx            侧栏导航
    ChatPanel.tsx          代码问答
    DiffView.tsx           逐行对比
    RulesPanel.tsx         规则库
  engine/rules.ts          19 条本地规则
  engine/score.ts          五维评分
  data/samples.ts          内置样例
  styles.css               设计变量、布局、主题
tools/                     回归与截图脚本（开发用，不参与构建）
docs/                      部署与设计文档
deploy-aliyun/             阿里云 Windows 部署手册与测试报告
```

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/auth` | 当前登录状态 |
| `POST` | `/api/login` | 登录 |
| `GET` | `/api/config` | 模型配置（不含密钥） |
| `POST` | `/api/config` | 保存模型配置 |
| `POST` | `/api/analyze` | 代码深度分析 |
| `POST` | `/api/format` | 格式化 |
| `POST` | `/api/lint` | 语法检查 |
| `POST` | `/api/fix` | 生成修复结果 |
| `POST` | `/api/chat` | 针对代码提问 |
| `GET` | `/api/github/tree` | 拉取仓库文件树 |
| `GET` | `/api/github/file` | 拉取单个文件内容 |

## 部署

**Docker**

```bash
docker compose up -d --build
```

**Windows + pm2**

```powershell
npm install -g pm2
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

详细步骤见 [docs/部署-完整流程.md](docs/部署-完整流程.md) 与 [deploy-aliyun/阿里云Windows部署手册.md](deploy-aliyun/阿里云Windows部署手册.md)。

> 部署到公网前请务必：改掉 `.env` 里的默认账号密码、用安全组限制端口、开启 HTTPS 反向代理。

## 测试

仓库带一套基于 Chrome DevTools Protocol 的端到端脚本，直接跑真实页面：

```bash
node tools/ui-test.mjs http://127.0.0.1:8080/    # 主流程 27 项
node tools/ov-shot.mjs http://127.0.0.1:8080     # 概览与导航 19 项
node tools/ov-mobile.mjs http://127.0.0.1:8080   # 移动端 9 项
node tools/file-test.mjs http://127.0.0.1:8080/  # 文件导入
node tools/gh-test.mjs http://127.0.0.1:8080/    # GitHub 导入 13 项
node tools/rain-edge-test.mjs                    # 代码雨边界 8 项
```

脚本用系统 Chrome 的无头模式，需要把 `tools/*.mjs` 顶部的 `CHROME` 常量改成你机器上的路径。

## 已知限制

- 规则是静态检查，跨函数、跨文件的语义问题依赖模型分析
- 单文件建议 500 行以内；更大的文件会走精简分析，不返回整份修复
- Java 格式化只整理缩进，不重排语句
- 代码雨在 768px 以下和系统开启「减少动态效果」时不渲染

## 许可

仅供学习与内部使用。
