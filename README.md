# dsh-miaoda

在 DeepSeek Harness 里开发**飞书妙搭（Miaoda）**应用：本地跑起来、一键发上线、把线上版本拉回本地——你只负责写代码。

> 说明：飞书的产品叫「妙搭」（miaoda.feishu.cn）；百度有个同名竞品「秒哒」（miaoda.cn），本插件只服务飞书妙搭。

---

## 它解决什么问题

官方 `lark-cli` 已经把妙搭的 API 铺全了（`apps +init` / `+release-create` / `+db-*` …），但一条完整闭环要串十来条命令、还要理解分支模型、release 状态机、审批中断、凭证刷新、线上版本到底该从哪里取。**这个插件把那套知识固化成 7 个工具 + 1 个技能**，模型不用每次重新摸索，你也不用背命令。

插件本身**不重写任何 API、不保存任何凭据**：所有远端操作都转交给 `lark-cli`，认证状态完全由它自己管理。

---

## 前置条件

| 依赖 | 要求 | 检查方式 |
| --- | --- | --- |
| DeepSeek Harness | 桌面版 2.0.x（带插件管理器） | — |
| `lark-cli` | ≥ 1.0.98，已在 PATH 或默认 npm 全局目录 | `lark-cli --version` |
| 飞书账号 | **必须登录用户身份**（妙搭应用是个人资产，机器人身份不行） | `lark-cli auth status` 里 `User identity` 为 ready |
| 项目 | 已 `+init` 的妙搭应用目录（含 `.spark/meta.json`） | `ls .spark/meta.json` |

> ⚠️ 如果 `lark-cli auth status` 显示 `User identity: missing (DPoP key unavailable or inconsistent)`，那么**所有 `--as user` 命令都会失败**（典型报错 `failed to acquire token storage lock`）。先修认证，插件不会替你绕过它——它只会把这个状态如实报在 `miaoda_status` 里。

---

## 安装

插件管理器 → 「插件」页 → 安装 → 选择本地目录：

```
<仓库路径>/dsh-miaoda
```

或者在 Creator 模式里让助手调用 `plugin_manager`，spec 填 `link:<仓库路径>/dsh-miaoda`。

装完需要**重启 DSH 进程**（插件包 / 启用 bundle 都不会热生效）。

验证：新会话里问「妙搭状态」，应当出现 `miaoda_status` 工具和 `miaoda` 技能。

---

## 7 个工具

| 工具 | 作用 | 典型调用 |
| --- | --- | --- |
| `miaoda_status` | 一次体检：CLI 可用性、认证身份、项目识别、dev server、最近一次发布、线上 vs 本地 HEAD 差异 | `{}` |
| `miaoda_apps` | 列出我名下的妙搭应用 / 查单个应用详情 | `{action:"list", keyword:"报销"}` |
| `miaoda_pull` | 拉代码，四种语义 | `{mode:"online"}` |
| `miaoda_dev` | 本地 dev server 的后台生命周期 | `{action:"start"}` |
| `miaoda_publish` | 提交 → 推送 → 创建发布 → 轮询终态 | `{reason:"修复列表分页"}` |
| `miaoda_env` | 拉 `.env.local` / 列出变量名（不打印值） | `{action:"pull"}` |
| `miaoda_lark` | 逃生舱：argv 数组透传给 lark-cli，覆盖上面没封装的命令 | `{argv:["apps","+db-table-list","--app-id","app_x"]}` |

所有工具返回同一个形状 `{ok, text}`：`ok=false` 时 `text` 里永远带着**下一步该做什么**（刷新凭证 / 补 apply-reason / 等审批 / 先提交）。

### `miaoda_pull` 的四种 mode

| mode | 拿到什么 | 用在哪 |
| --- | --- | --- |
| `init` | 分步拉取：取仓库地址 → clone `sprint/default` → `env-pull` → `npm ci` → `setup:local`（`dry_run:true` 时只打印 `apps +init` 的计划） | 第一次把妙搭应用落到本地 |
| `work` | 工作分支最新（`git pull --rebase`） | 同事推了新代码，本地没改动 |
| `online` | **精确的线上版本**：最近一次 `finished` release 的 `commit_id` → `git fetch` + `checkout`（或 `worktree`） | 回滚、对齐线上、排查线上问题 |
| `export` | 服务端打的 zip 快照（无 git 历史 / 无 `.env.local` / 不能推回） | 只想要一份只读源码 |

`online` 是关键能力：`main` 分支只是发布态快照的近似，`+export` 拿的是 default branch 最后一次提交，**只有 release 的 `commit_id` 能精确还原某一版线上代码**。

### `miaoda_publish` 的行为边界

1. 分支必须是 `sprint/default`（`main` 由平台 fast-forward，禁直推、禁 force-push）。
2. `commit` → `push` → `+release-create` 三步都可单独关闭（`commit:false` / `push:false` / `poll:false`）。
3. `frontend` / `full_stack` 必须给 `reason`（写进 `--apply-reason`，单行 ≤1000 字符）；`html` 应用**不接受** `--apply-reason`。
4. 没给 `reason` 时插件**不会瞎编发版说明**，会停在"已推送、未发布"并告诉你去补。
5. 没有推送成功就绝不创建 release——发布流水线只认**远端**已有提交。
6. 提交前会检查待提交的改动：发现 `.env.local` 这类密钥文件、或图片/字体/音视频等资源文件，**拒绝提交**并告诉你正确做法（密钥进 `.gitignore`、资源走 `+file-upload`）。确认要强行提交时传 `force:true`。
7. 终态只有 `finished` / `failed`。遇到 `current_node_info.current_status=PENDING`（待审批）立刻停止轮询，把 `release_id` 和审批地址交还给你，**不会自动审批、不会重发**。
8. 20 秒一轮，上限约 5 分钟；超时不会假装成功。
9. **不需要你先配 git 身份**：全新 clone 里没有 `user.name` / `user.email`，插件会用当前登录的妙搭用户（`lark-cli auth status` 的 `userName` / `openId`）拼一个身份，通过 `git -c` 传给这一次 commit——不会写进你的全局或仓库配置。你自己配过身份时优先用你的。

---

## skill：`miaoda`

随包分发的中文工作流技能，包含：

- 四种"代码状态"（本地工作区 / 远端工作分支 / 发布态 main / 线上运行版本）的区分与同步方向；
- 三种 app_type（`full_stack` / `frontend` / `html`）在安装、启动、发布上的差异；
- 五条标准流程（新建、接手存量、日常开发、上线、回滚）；
- 9 条硬规则（资源文件必须 `+file-upload`、DB 变更随发布走、只信本轮 `+release-get` 等）；
- 故障表（认证、凭证、审批、端口占用）；
- `skills/miaoda/references/` 下 30 份官方 `lark-apps` reference 原文，离线可查。

---

## 侧边栏工作台：扫码 → appId → 发布

右侧栏点开「妙搭工作台」，三步走完一条链路：

1. **连接飞书** —— 面板一打开就自动发起一次 Device Flow 登录，直接显示二维码和「在浏览器打开确认页」。用飞书扫一下，面板每 4 秒轮询，授权后自动变成「已登录 · 你的飞书账号」；二维码 10 分钟内有效，过期可以重新生成。
2. **拉取项目** —— 已经拉到本地的项目会直接列在「本地已有项目」里，点「打开」就切过去；要拉新的就填 `app_xxx`，按「拉取到本地」。拉取走分步流程（取仓库地址 → `git clone sprint/default` → 拉 `.env.local` → `npm ci` → `npm run setup:local`），每一步和下载百分比都实时进日志，不会像 `apps +init` 那样一声不吭卡几分钟。默认落在**当前工作区根目录**（即 DSH 打开的那个目录，例如 `~/miaoda`）下的 `<app_id>`；「保存位置」留空就是默认，点一下工作区小标签或直接填绝对路径即可换地方，改过之后会记住。
3. **发布上线** —— 先给一张 **VSCode 风格的改动清单**：每个文件一行，左边是状态徽章（`A` 新增 / `M` 修改 / `D` 删除 / `R` 重命名），右边是 `+12 −3` 的增删行数；点一行就地展开 unified diff（绿加红删、hunk 头高亮），再点收起。每行都有勾选框，默认全选——只想发一部分就取消勾选，发布只提交勾中的文件。

   清单下面是当前分支 / 未提交 / 待推送的胶囊标签和「发布上线」按钮：点下去 = 有改动就 `git add/commit` + push `sprint/default` + 创建发布 + 轮询到终态，全过程日志就在面板里。html 应用不需要理由，其它类型默认填了一句「妙搭工作台发布」，可以改。

   不想开面板也行：`miaoda_publish {action:"status"}` 在会话里直接打印同一份清单，`files:[...]` 只发选中的那几个。

项目有 `scripts.dev` 时，拉取完成后插件会自动把它跑起来；面板底部还有一行 dev server：「启动 / 停止」和「预览」——预览就是前面那个本地视窗。

数据来自宿主注册的 `/plugins/dsh-miaoda/workbench`（同源校验；同一时刻只跑一个任务，导入/发布都会实时回日志），二维码走单独的 `/plugins/dsh-miaoda/workbench/qr.png`，PNG 直出，不经过前端脚本。

面板平时用 `?light=1` 轮询：只读宿主缓存，**一个子进程都不起**；打开面板、点完动作、按刷新时才要全量快照（才去问 `lark-cli auth status` 和 `git status`）。这样面板开着不动也不会反复闪窗口。

---

## 会话视窗：本地预览

`miaoda_dev {action:"start"}` 之后，页面的地址会出现在会话里——但地址不是页面。插件自带的「本地预览」把本地 dev server 直接嵌进 DSH 的界面，改完代码刷新就能看到，不用切浏览器。

三个入口，同一个视窗：

| 入口 | 在哪 | 适合 |
| --- | --- | --- |
| **本地预览** 标签 | 会话头部的 View 标签行（标签多时在右侧「…」菜单里） | 一边让模型改代码、一边盯着页面 |
| `miaoda_dev` 工具卡 | 每次启动 / 查询 dev server 的结果卡 | 看到 `地址: http://localhost:8080` 后一键「打开预览」 |
| **本地预览** 右栏 tab | 右侧栏（与写代码的轨迹并排） | 长会话里常驻，不占对话区 |

视窗里有的东西：

- **地址栏**：直接输入任何本地地址（`5173`、`localhost:3000/app`、完整 URL 都认），手填优先于自动发现；输空则回到「自动跟随运行中的 dev server」。
- **自动发现端口**：没经过插件启动、而是你自己在终端里跑着的 dev server，预览也会找到——按 `CLIENT_DEV_PORT` / `SERVER_PORT`（读项目 `.env.local`）→ `8080`（妙搭 fullstack 模板的 vite preset 默认值，`strictPort`）→ `5173` / `5174` / `4173` / `3000` 的顺序探一次本地端口。找不到才显示空状态。
- **设备宽度**：自适应 / 平板 834px / 手机 390px，窄屏时自动加一圈窗口外框。
- **刷新 / 在浏览器打开 / 在右侧栏打开**：iframe 导航常被页面自身的状态卡住，刷新走的是重挂载，比 F5 干净。
- **状态点 + 项目名 + 端口**：数据来自宿主的路由，每 2.5 秒同步一次，dev server 自己退出时也会如实变成「未运行」。
- **连不上时的横幅**：先探测再提示（页面还在编译 / 已经退出），并给一个「重试」。

启动 dev server 时也可以直接点名端口：`miaoda_dev {action:"start", port:8080}`。模板里 `dev` 是 `./scripts/dev.sh`（bash 入口），Windows 上 `npm run dev` 走 `cmd.exe` 会在任何端口出现之前就退出。插件按三级降级选启动方式：**妙搭全栈模板 → 直接起 vite + nest（0.3.12 起，见下）**；否则模板自带 `scripts/dev-local.js`（纯 Node，和 `dev.sh` 的本地分支等价）；都没有才退回 `npm run dev`。

**妙搭全栈模板会直接起 vite + nest，不经任何 shell**：`dev:client` 是 `NODE_ENV=development vite ...` 这种 POSIX 写法，`npm run` 只能靠 `script-shell`（本机是 Git Bash）执行，而 MSYS 在把环境变量传给原生进程时会把以 `_PATH` 结尾的变量当成路径改写——`CLIENT_BASE_PATH="/app/app_xxxxxxxx"` 会变成 `C:/Program Files/Git/app/app_xxxxxxxx`，于是 Vite 把整个页面挂在那个假 base 下，`/` 只是 302，预览窗口一片空白。`lib/dev-launcher.mjs` 自己做 dotenv + 直接 `node node_modules/vite/bin/vite.js`，环境变量原样传下去；页面地址因此是 `http://localhost:8080/app/<appId>/`，也正是插件记录、预览打开的那个地址（`MIAODA_NO_DIRECT_LAUNCH=1` 可退回老路径）。

这条直连路径替掉了模板 `scripts/dev-local.js` 里的两件准备工作，它们本来也不影响页面渲染：`action-plugin init` 由插件在安装阶段跑（带 ESM hook），`miaoda-cli skills sync --local` 同步的是给编码 agent 看的技能副本——插件自己就带 `miaoda` skill 和 30 份官方 reference。

它是怎么取数的：`lib/preview.js` 在 harness 的 `webServer` 上注册一条 `exact` 路由 `/plugins/dsh-miaoda/preview`，读的是 `miaoda_dev` 用的同一个 supervisor；写操作只有 `start` / `stop` 两个，且必须同源（`Origin` 与请求 `Host` 一致），所以任意网页都碰不到你的本地服务。`lib/client.js` 是手写的客户端 bundle（`window.__ModuleLoader__.load` 工厂形式，只 `require("react")`），三个入口共用同一个模块级 store。

**改完要重启 DSH**：`lib/` 下的宿主代码和客户端 bundle 都在进程启动时装载，热重载只覆盖配置层。装好插件、改完代码之后，退出 DSH 再打开。

```bash
npm test    # 宿主的合同自测 + 客户端 bundle 冒烟测试，都不需要启动 DSH
```

---

## 常见问题

**`miaoda_status` 说找不到项目**
妙搭项目根目录必须有 `.spark/meta.json`。传 `project` 参数指过去，或在项目目录里打开会话。

**git push 报 401/403**
插件会自动跑一次 `apps +git-credential-init` 再重试；仍失败就停住——别再试第四个命令，先修认证。

**发布报 `Author identity unknown` / `unable to auto-detect email address`**
0.3.16 前会出现这行：全新 clone 没有 `user.name` / `user.email`，`git commit` 直接拒。现在插件会用登录身份兜底（`git -c user.name=… -c user.email=…`，不改你的配置）。想用自己的名字提交，配一次即可：`git config --global user.name "你的名字"` + `git config --global user.email "you@example.com"`。

**发布时报「会把密钥类文件提交上去」**
这是故意的拦截。`.env.local` 里是 dev 环境变量，提交后会被写进远端仓库历史。先确认它在 `.gitignore` 里，然后重新发布；确实需要提交时加 `force:true`。

**发布一直 `publishing`**正常，通常 1~3 分钟。超过 5 分钟插件会停下并保留 `release_id`，可以用 `miaoda_lark` 继续查。

**发布 `failed`**
看 `miaoda_lark` 拉回来的 `error_logs`。修完重新 `miaoda_publish`，不要复用旧 release。

**关闭 DeepSeek Harness 后还有 node.exe 在跑 / 端口一直被占**
`npm run dev` 会拉起一整棵树（npm → npx → concurrently → nest / vite），而 Windows 不会因为父进程退出就收掉它，于是窗口关了、`node.exe` 还在，8080 / 3000 一直占着。0.3.11 起插件不再直接 spawn 这条命令，而是包一层 `lib/dev-watchdog.mjs`：它每 1.5 秒探测一次宿主进程，宿主一消失就把整棵树 `taskkill /T /F` 收掉；正常退出时插件的 `stopAll` 也会清理。另外每次启动都会读 `~/.dsh/miaoda-dev-servers.json`，把上一个会话遗留、且宿主已经不在的 dev server 补刀收掉（只动 `node.exe`，不会误杀复用了同一个 pid 的其它程序）。升级前就已经跑起来的旧进程不在记录里，需要重启电脑或在任务管理器里手动结束。

**端口被占用 / dev server 起不来**
`miaoda_dev {action:"logs"}` 看日志；`stop` 再 `start`。插件为每个项目维护独立 record，`stopAll` 会在插件卸载时自动执行。知道端口就直接 `miaoda_dev {action:"start", port:8080}`，日志里读不到地址时用它兜底，预览立刻有目标。

**启动后预览还是 `Cannot GET /` 这种 JSON 404**
说明 8080 上待着的是**后端**（也可能是上一次 dev 会话留下的孤儿进程）：模板的 vite preset 用 `CLIENT_DEV_PORT`（默认 8080，`strictPort: true`），抢不到端口就直接退出，只剩 Nest 在那儿回 404。0.3.9 起插件启动前会先给前端、后端各挑一个空闲端口（`CLIENT_DEV_PORT` / `SERVER_PORT` 显式注入，默认从 8080 / 3000 试起，被占就顺延），并把挑中的地址立刻写进面板；自动发现别人启动的服务时，还会用 `GET /@vite/client` 确认那是不是 Vite 页面，是后端就宁可不显示，也不把 404 当页面。

**页面明明开着，预览却显示「未运行 / 没有端口」**
模板里 vite 的 `host` 是 `localhost`，在 Windows 上只监听了 IPv6（`[::1]:8080`），只探 `127.0.0.1` 会得出"没在跑"的错误结论。插件同时探 `::1` 与 `127.0.0.1`，并优先取前端端口（`CLIENT_DEV_PORT` → `8080` → 5173 …），后端 `SERVER_PORT` 不会顶替掉页面地址。

**预览窗口一直空白，提示「暂时连不上这个地址」，而 dev server 明明是 running（0.3.12）**
不要只看端口：妙搭的每个应用都发布在 `/app/<appId>/` 下，页面地址是 `http://localhost:8080/app/app_xxx/`，`http://localhost:8080/` 只是一个 302 跳转。而 0.3.11 及以前还有第二个坑——`npm run` 走的 Git Bash（`script-shell`）会把 `.env.local` 里的 `CLIENT_BASE_PATH="/app/app_xxx"` 改写成 `C:/Program Files/Git/app/app_xxx`，Vite 于是把整个站点挂在那个假 base 下。0.3.12 起：① `lib/dev-launcher.mjs` 直接起 vite / nest，不经 shell，`CLIENT_BASE_PATH` 原样保留；② 从 Vite 的 `Local:` 行里连 base path 一起记下来，预览直接打开 `http://localhost:8080/app/app_xxx/`。验证方法：`miaoda_dev {action:"logs"}` 里应该看到 `[dev-launcher] 页面地址: http://localhost:8080/app/<appId>/`。

**页面能打开，但一直停在「正在检查账号权限...」（0.3.13）**
页面里的身份不是从 cookie 来的，而是模板的 vite 预设在 dev 层**冒充沙箱网关**塞进去的：只有 `isLocalDev()` 为真时，它才会给 `/api` 请求加 `x-larkgw-suda-webuser` 头，Nest 才渲染得出 `window.userId`。而 `isLocalDev()` 认的是 **`MIAODA_LOCAL_DEV=1`** —— 这个变量本来是 `scripts/dev-local.js` 自己 export 的，0.3.12 的直连启动器绕过了它，于是身份为空、`useCurrentUserProfile()` 返回空对象、`AccessGate` 的 `loading` 永远不结束。0.3.13 起启动器在起进程前照 `dev-local.js` 补齐 `MIAODA_LOCAL_DEV=1`、`MIAODA_APP_TYPE=3`，并按同样的规则把 `.env.local` 里 `SUDA_WEBUSER` 的 `\"` 反转义成合法 JSON。验证：`miaoda_dev {action:"logs"}` 里应看到 `MIAODA_LOCAL_DEV=1`，页面头部脚本里 `window.userId` 不再是空串。

**第一次启动 dev server 特别慢**
妙搭 fullstack 模板的 `dev` 脚本会先跑一次 `miaoda-cli app sync`（同步平台脚本 + 把 `@lark-apaas/*` 升到 latest），第一次要下载整条工具链，几分钟很正常；之后有缓存会快很多。插件在「启动 dev server」之后就不再干等：地址一出现，面板底部那一行会自动显示并可点「预览」。想跳过 sync 可以设环境变量 `MIAODA_DEV_SCRIPT=dev:local`（模板的 `dev:local` 在 Windows 上依赖本地 `lark-cli` shim，不保证可用）。
另外模板的 `scripts/dev-local.js` 在 Windows 上用 `spawn('npx')` 起 `concurrently`，而 Windows 的 `npx` 只是 `.cmd`，会报 `spawn npx ENOENT`。插件启动 dev server 时会通过 `NODE_OPTIONS=--require lib/npx-shim.cjs` 把这个调用改写掉，项目文件不会被改动。

**拉取时 npm 安装报 `ERR_UNSUPPORTED_ESM_URL_SCHEME` / `command failed`**
上游 `@lark-apaas/fullstack-cli` 的入口是 `await import(path.join(__dirname, '../dist/index.js'))`，在 Windows 上这就是个 `C:\...` 字符串，现代 Node 的 ESM 加载器只认 `file://`，于是抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'c:'`，npm 对外只显示一句 `command failed`。那条命令来自模板 `package.json` 的 `postinstall`（`npx -y @lark-apaas/fullstack-cli@latest action-plugin init`），不是依赖本身坏了。

插件的处理（0.3.10 起：默认不再出现这个报错）：`npm ci` / `npm install` 直接带着 `lib/esm-path-hook.mjs`（`NODE_OPTIONS=--import`，只把 ESM 里的盘符路径改写成 `file://`，CJS 的 `require` 不动）跑，模型下发的 `postinstall` 因此一次就能跑通，不再有"先报错、再 `--ignore-scripts` 重装一遍"的浪费。万一仍然失败，插件才退回老路：`--ignore-scripts` 重装拿到完整依赖，再用同一个 hook 自己跑一次 `action-plugin init`，把 `package.json` 里 `actionPlugins` 声明的能力（比如发飞书消息）补装上；安装摘要里会写明 `action plugin 已装 / 未装`。同一个 hook 也注入给 dev server，模板 `dev-local.js` 里那次 `action-plugin init` 因此同样能跑通。设 `MIAODA_NO_ESM_HOOK=1` 可以整条链路关掉它。

**屏幕老是闪出黑色命令行窗口**
插件里所有子进程都带 `windowsHide`；此外 `lark-cli` 优先用系统 `node`（`C:\Program Files\nodejs\node.exe`）启动，找不到时才回退到宿主自己的可执行文件并补 `ELECTRON_RUN_AS_NODE=1`——否则宿主是 Electron，每轮轮询都会拉起一个 GUI 进程，看起来就是一个闪一下的窗口。
仍然闪的话看 `%USERPROFILE%\.dsh\miaoda-spawn.log`：每次 spawn 都会记一行时间 + 命令，对照闪烁的时刻就知道是谁。轮询本身也降频了（工作台 4s、预览 4s，页面切到后台时暂停；工作台平时只读 `?light=1` 缓存快照、完全不起子进程；git 状态 30s 一次、登录状态 45s 一次，且 `git status` 用 `--porcelain=v2 --branch` 一次拿全分支/未提交/领先落后，不再连跑 7 条 git）。

**想看这次到底改了哪些文件（0.3.14）**
发布页顶部就是改动清单：状态徽章 + 增删行数 + 点开看 diff + 勾选参与发布，和编辑器里的「源代码管理」一样。命令行里用 `miaoda_publish {action:"status"}` 拿同一份结果；`{action:"publish", files:[...]}` 只提交选中的文件。工作区干净时清单给空态提示，不会把"没有改动"误当成一次发布。

---

## 开发

```bash
npm test        # 官方合同自测（桩 cordis 上下文，不需要启动 DSH）
```

`test/fake-host.mjs` 校验：注册了哪些工具、是否满足 harness 的 `ctx.tools.register` 校验（无 type 数组、`output.render` 是函数、返回值符合 `{ok,text}` schema）、skill 是否带齐 `name/description/content/source/provider`、预览与工作台路由是否注册、同源 / JSON / action 校验、二维码路由，以及源码解析类纯函数。

`test/client-smoke.mjs` 在 `node:vm` 里跑 `lib/client.js`：假 `__ModuleLoader__` / react / document / fetch，断言三个注册点（会话 View、工具卡、两个右栏 tab）、空态与运行态渲染、工具卡解析，以及工作台三种状态（未登录自动出二维码、等待扫码、已登录 + 项目摘要）。

`test/client-smoke.mjs` 在 `node:vm` 里按 harness 的方式加载 `lib/client.js`：假 `__ModuleLoader__` / 假 react / 假 `document`，验证三个界面注册点、空态与运行态的真实渲染、`miaoda_dev` 工具卡上的按钮确实走到 `sidebarRight.openTab`，以及 `normalizeUrl` / `parseDevText` 这类纯函数。

## License

MIT

## 来源与致谢

- `skills/miaoda/references/` 下的 30 份 `lark-apps-*.md` 是飞书官方 Agent Skill `lark-apps` 的文档副本，通过 `lark-cli skills read lark-apps` 离线导出，仅作随包参考；版权归飞书（Lark）所有。若官方文档更新，用 `lark-cli skills read lark-apps` 重新导出即可。
- 妙搭（Miaoda）的平台能力全部来自 `lark-cli` 的 `apps` 命令域与本机 git，本插件不访问任何私有接口、不保存任何凭据（登录态由 `lark-cli` 自己管理）。

