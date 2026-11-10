# dsh-miaoda

在 DeepSeek Harness 里开发**飞书妙搭（Miaoda）**应用：本地跑起来、一键发上线、把线上版本拉回本地——你只写代码。


插件不重写任何 API、不保存任何凭据：所有远端操作都交给 `lark-cli`，登录态由它自己管理。

## 前置条件

| 依赖 | 要求 | 检查 |
| --- | --- | --- |
| DeepSeek Harness | 桌面版 2.0.x | — |
| `lark-cli` | ≥ 1.0.98 | `lark-cli --version` |
| 飞书账号 | **用户身份必须已登录**（妙搭应用是个人资产，机器人身份不行） | `lark-cli auth status` 里 `User identity` 为 ready |
| 项目 | 已 `+init` 的妙搭应用目录（含 `.spark/meta.json`） | `ls .spark/meta.json` |

若 `auth status` 显示 `User identity: missing (DPoP key unavailable or inconsistent)`，所有 `--as user` 命令都会失败（典型报错 `failed to acquire token storage lock`）。先修认证，插件不会替你绕过。

## 安装

插件管理器 →「插件」页 → 安装 → 选本地目录 `<仓库路径>/dsh-miaoda`；或在 Creator 模式里调 `plugin_manager`，spec 填 `link:<仓库路径>/dsh-miaoda`。

装完**重启 DSH 进程**。验证：新会话里问「妙搭状态」，应出现 `miaoda_status` 工具和 `miaoda` 技能。

## 工具

| 工具 | 作用 |
| --- | --- |
| `miaoda_status` | 体检：CLI、认证身份、项目识别、dev server、最近发布、线上 vs 本地 HEAD |
| `miaoda_apps` | 列出我名下的应用 / 查单个应用详情 |
| `miaoda_pull` | 拉代码（`init` / `work` / `online` / `export`） |
| `miaoda_dev` | dev server 生命周期（`install` / `start` / `status` / `logs` / `stop`） |
| `miaoda_publish` | 改动清单（`status`）与发布（`publish`） |
| `miaoda_env` | 拉 `.env.local` / 列出变量名（不打印值） |
| `miaoda_lark` | 逃生舱：argv 直接透传给 lark-cli |

所有工具返回 `{ok, text}`；`ok=false` 时 `text` 里一定带下一步该做什么。

### `miaoda_pull` 的四种 mode

| mode | 拿到什么 | 用途 |
| --- | --- | --- |
| `init` | 取仓库地址 → clone `sprint/default` → `env-pull` → `npm ci` → `setup:local` | 第一次落到本地 |
| `work` | 工作分支最新（`git pull --rebase`） | 同事推了新代码、本地无改动 |
| `online` | 最近一次 `finished` release 的 `commit_id` → `git fetch` + `checkout` | 回滚、对齐线上、排查线上问题 |
| `export` | 服务端打的 zip 快照（无 git 历史、无 `.env.local`、不能推回） | 只要一份只读源码 |

只有 release 的 `commit_id` 能精确还原某一版线上代码；`+export` 拿的是 default branch 最后一次提交。

### 发布规则

- 分支必须是 `sprint/default`；`main` 由平台 fast-forward，禁直推、禁 force-push。
- `frontend` / `full_stack` 必须给 `reason`（单行 ≤1000 字符）；`html` 应用**不接受** `--apply-reason`。没给时不瞎编，停在「已推送、未发布」并提示补。
- 没有推送成功绝不创建 release——流水线只认远端已有提交。
- 提交前检查改动：`.env.local` 这类密钥文件、图片/字体/音视频等资源文件会被拒绝（资源应走 `+file-upload`）。确认要提交加 `force:true`。
- 终态只有 `finished` / `failed`，20 秒一轮、上限约 5 分钟；遇到待审批（`current_status=PENDING`）立刻停止轮询，交还 `release_id` 和审批地址，不自动审批、不重发。
- 全新 clone 没有 `user.name` / `user.email`，插件用当前登录的妙搭身份经 `git -c` 传给这一次 commit，不写你的配置；你自己配过身份时优先用你的。

## 侧边栏工作台

右栏「妙搭工作台」三步：

1. **连接飞书** —— 打开即发起 Device Flow，显示二维码，授权后自动变「已登录」。
2. **拉取项目** —— 已有项目直接列出可点开；新的填 `app_xxx` 拉取。默认落在当前工作区根目录下的 `<app_id>`。
3. **发布上线** —— VSCode 风格改动清单：状态徽章（`A`/`M`/`D`/`R`）+ `+12 −3` 行数，点行展开 unified diff，勾选决定提交哪些文件。按钮 = commit + push + 创建发布 + 轮询终态。

命令行等价：`miaoda_publish {action:"status"}` 打印同一份清单，`files:[...]` 只发选中的。

## 本地预览

`miaoda_dev {action:"start"}` 后地址会出现在会话里；插件自带的「本地预览」把 dev server 嵌进 DSH 界面。

三个入口：会话头部 **本地预览** 标签、`miaoda_dev` 工具卡上的「打开预览」、右栏 **本地预览** tab。

- 地址栏可手填任意本地地址，留空则自动跟随运行中的 dev server。
- 自动发现：按项目 `.env.local` 的 `CLIENT_DEV_PORT` / `SERVER_PORT` → `8080` → `5173` / `5174` / `4173` / `3000` 顺序探测；用 `GET /@vite/client` 确认是不是 Vite，避免把后端 404 当页面。
- 同时探 `::1` 与 `127.0.0.1`（模板绑 `localhost`，Windows 上只落 IPv6）。
- 可指定端口：`miaoda_dev {action:"start", port:8080}`。

启动方式三级降级：**妙搭全栈模板 → 直连 vite + nest**；否则模板自带 `scripts/dev-local.js`；再否则 `npm run dev`。

直连这条（`MIAODA_NO_DIRECT_LAUNCH=1` 可关）是为了绕开两个 Windows 坑：`dev:client` 是 POSIX 写法、只能经 `script-shell`（Git Bash）跑，而 MSYS 会把 `CLIENT_BASE_PATH="/app/app_xxx"` 改写成 `C:/Program Files/Git/app/app_xxx`，页面因此挂在假 base 下；同时补上 `scripts/dev-local.js` 原本设置的 `MIAODA_LOCAL_DEV=1`、`MIAODA_APP_TYPE=3`（缺了它页面会停在「正在检查账号权限」）。页面地址形如 `http://localhost:8080/app/<appId>/`。

## 常见问题

**找不到项目** —— 项目根目录必须有 `.spark/meta.json`；传 `project` 指过去，或在项目目录里开会话。

**git push 401/403** —— 插件会自动跑一次 `apps +git-credential-init` 再重试；仍失败就停下修认证，别继续试第四条命令。

**`Author identity unknown`** —— 没配 git 身份时的旧版本报错；现在有登录身份兜底。想用自己的名字：`git config --global user.name "…"` + `user.email`。

**发布一直 `publishing`** —— 通常 1~3 分钟；超 5 分钟插件会停下保留 `release_id`，可 `miaoda_lark` 继续查。

**发布 `failed`** —— 看 `miaoda_lark` 拉回的 `error_logs`，修完重新 `miaoda_publish`，不要复用旧 release。

**关闭 DSH 后还有 `node.exe` 在跑 / 端口被占** —— 插件用 `lib/dev-watchdog.mjs` 包住 dev server，宿主一消失就 `taskkill /T /F` 收掉整棵树；每次启动也会清理上个会话遗留、宿主已不在的记录（只动 `node.exe`）。升级前已在跑的旧进程需要手动结束。

**端口被占用 / 起不来** —— `miaoda_dev {action:"logs"}` 看日志，`stop` 再 `start`；启动前插件会先挑空闲端口（前端 8080 起、后端 3000 起，被占就顺延），日志读不到地址时用 `port` 兜底。

**预览是 `Cannot GET /` 这种 JSON 404** —— 8080 上待着的是后端（或孤儿进程），前端抢不到 `strictPort` 的端口就退出了。0.3.9 起会自动让位；自动发现时也用 `/@vite/client` 校验。

**页面开着却显示「未运行 / 没有端口」** —— 见上面 IPv6 探测。

**预览空白、提示「暂时连不上」而 dev server 是 running** —— 地址漏了 base path。页面在 `/app/<appId>/` 下，`/` 只是 302。看日志里的 `[dev-launcher] 页面地址: …/app/<appId>/`。

**页面停在「正在检查账号权限...」** —— 缺 `MIAODA_LOCAL_DEV=1`，身份头没注入。日志里应能看到该行；见上面直连启动器的说明。

**npm 报 `ERR_UNSUPPORTED_ESM_URL_SCHEME` / `command failed`** —— 上游 `@lark-apaas/fullstack-cli` 入口用 `import("C:\\…")`，ESM 只认 `file://`。插件给 `npm ci` / `install` 和 dev server 注入 `lib/esm-path-hook.mjs`（`NODE_OPTIONS=--import`，只改写 ESM、不动 CJS `require`），默认不再出现；`MIAODA_NO_ESM_HOOK=1` 可关。

**闪黑色命令行窗口** —— 所有子进程带 `windowsHide`，`lark-cli` 优先用系统 `node` 启动（避免拉起 Electron GUI 进程）。仍闪就看 `%USERPROFILE%\.dsh\miaoda-spawn.log`，每次 spawn 记一行。

**第一次启动特别慢** —— 模板 `dev` 脚本会先跑 `miaoda-cli app sync`（同步平台脚本、装工具链），第一次几分钟正常，之后有缓存。想跳过：`MIAODA_DEV_SCRIPT=dev:local`。

## 开发

```bash
npm test    # 不需要启动 DSH
```

`test/fake-host.mjs` 用桩 cordis 上下文校验：工具注册符合 harness 合同（无 type 数组、`output.render` 是函数、返回值合 `{ok,text}`）、skill 带齐 `name/description/content/source/provider`、路由同源与 JSON 校验、以及解析类纯函数。

`test/client-smoke.mjs` 在 `node:vm` 里按 harness 的方式加载 `lib/client.js`（假 `__ModuleLoader__` / react / document / fetch），验证三个注册点、空态与运行态的渲染、工具卡按钮走到 `sidebarRight.openTab`，以及 `normalizeUrl` / `parseDevText` 等纯函数。

## License

MIT

## 来源与致谢

- `skills/miaoda/references/` 下的 30 份 `lark-apps-*.md` 是飞书官方 Agent Skill `lark-apps` 的文档副本（`lark-cli skills read lark-apps` 导出），随包参考，版权归飞书。官方更新后可重新导出。
- 平台能力全部来自 `lark-cli` 的 `apps` 命令域与本机 git；本插件不访问私有接口、不保存凭据。
