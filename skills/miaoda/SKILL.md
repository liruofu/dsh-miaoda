---
name: miaoda
description: 在本地开发飞书妙搭（Miaoda）应用：初始化/同步项目、启动本地 dev server、发布上线、拉取线上正在运行的版本。当用户提到妙搭、Miaoda、app_id、sprint/default、发布妙搭应用时使用。
---

# 妙搭本地开发

妙搭（Miaoda，旧名 Spark）是飞书的应用平台。本地开发的本质是 **一个 git 工作分支 + 一条平台发布流水线**：

```
本地改代码 → git push origin sprint/default → 发起发布 → 平台构建/审批/部署 → 线上
```

平台不读你的工作区，只读**远端已经 push 的 `sprint/default`**。这是所有规则的源头。

## 先分清四样东西

| 东西 | 是什么 |
|---|---|
| 本地工作区 | 你正在改的文件；没 commit 就不在任何地方 |
| 远端 `sprint/default` | 工作分支，发布的输入；push 了 ≠ 发布了 |
| `main` | 发布态快照，发布成功后由服务端 fast-forward；**禁止直推、禁止 force-push** |
| release 记录 | 每次发布的 `release_id` + `commit_id` + status；`finished` 那条的 commit 才是线上代码 |

`+export` 导出的只是仓库默认分支的一次 git archive，**不是**线上运行态。

## 工具速查

| 工具 | 用途 |
|---|---|
| `miaoda_status` | 开工前先跑：clig 安装、user 登录、项目 app_id、git 状态、dev server、线上/本地是否一致 |
| `miaoda_apps` | 应用名 ↔ `app_id`；确认 app_type（html / frontend / full_stack） |
| `miaoda_pull` | `init` 克隆新项目 / `work` 同步工作分支 / `online` 取线上运行版本 / `export` 导出 zip |
| `miaoda_dev` | `install`、`start`、`status`、`logs`、`stop` 本地 dev server |
| `miaoda_publish` | commit → push → 发起发布 → 轮询到终态，一条命令 |
| `miaoda_env` | `pull` 生成/修复 `.env.local`；`list` 看变量名 |
| `miaoda_lark` | 兜底：任何上面没封装的 `lark-cli` 命令（DB、日志、文件、权限） |

## 三种应用类型

| 类型 | 有无 DB | 本地启动 | 发布理由 |
|---|---|---|---|
| `full_stack` | 有（dev/online 双环境） | `npm run dev` | **必填** |
| `frontend` | 无 | `npm run dev` | **必填** |
| `html`（创意模式） | 无 | 无 npm，文件直接放仓库根目录 | **禁止传** |

类型用 `miaoda_apps action=get` 或 `miaoda_status` 确认，不要猜。

## 标准流程

### A. 新建应用
1. `miaoda_apps` 里没找到 → 需要平台侧先创建（用 `miaoda_lark` 调 `apps +create`，参数 `--name`、`--app-type`、`--description`）。
2. `miaoda_pull mode=init app_id=app_xxx dir=./my-app`
3. 读项目里的 `.agents/skills/plugin-guide/SKILL.md`（`+init` 生成，讲插件目录与调用规范）
4. `miaoda_dev action=install` → `action=start`

### B. 接手已有项目
1. 有 app_id → `miaoda_pull mode=init`；只有名字 → `miaoda_apps keyword="..."` 找到 app_id。
2. 目录已存在 → 直接 `miaoda_status`，`miaoda_pull mode=work` 同步。

### C. 日常开发
```
miaoda_status                     # 确认状态
miaoda_pull mode=work             # 别人可能推过新代码
（写代码）
miaoda_dev action=logs            # 看编译/运行错误
```

### D. 发布
```
miaoda_publish reason="一句话说清这次改了什么"
```
内部就是 `git add` → `commit` → `push origin sprint/default` → `+release-create` → 每 20 秒 `+release-get` 轮询。

- `frontend` / `full_stack` 的 `reason` 必须真实、单行、不含密文；**拿不准发布目的就先问用户，不要编**。
- `html` 不传 reason；html 的另一条通道是 `+html-publish`（`--path` 必须相对路径、需要 `index.html`、10/20/200MB 限制）。

### E. 拉取线上正在跑的版本
```
miaoda_pull mode=online          # 默认生成独立 worktree，不动当前工作区
miaoda_pull mode=online checkout=true   # 或就地 detached HEAD
```
流程：`+release-list --status finished --page-size 1` → `+release-get` 取 `commit_id` → `git fetch` → `worktree add`/`checkout`。
只在同一 `release_id` 查回 `finished` 时才能说"这份就是线上版本"；`+list` 里的 `is_published=true` 不算。

## 硬规则（违反会出事）

1. **发布只认远端已 push 的代码**。本地没提交的改动不会上线，`miaoda_publish` 默认会先帮你 commit + push。
2. **发布终态只有 `finished` / `failed`**。普通 `publishing` 每 20 秒查一次，最多约 5 分钟。
3. **看到 `current_node_info.current_status = PENDING` 立刻停止轮询**：那是在等审批负责人。不自动审批、不重试、不新建 release，只把 `release_id` 和审批链接原样告诉用户。
4. **`status=pending` 但没有明确 PENDING 节点**：停止轮询，原样报告，不要补出审批人或链接。
5. **禁止直推 `main`、禁止 force-push**；要求 fast-forward。云端比本地新 → `git pull --rebase origin sprint/default`。
6. **图片/字体/音视频必须走 `+file-upload`** 拿远端 URL 引用，禁止提交进 git、禁止 base64 内联。
7. **环境变量**：`+env-pull` 只拉 dev 启动期变量写进 `.env.local`；线上值默认看不到（`+env-list --include-values` 能看到，但不要外泄）。
8. **git 401/403** → 先 `lark-cli apps +git-credential-init --app-id <id> --as user` 刷新凭证，再重试原命令；仍失败就停下报告，不要换路。
9. **数据库**：`--environment dev|online`（不是 `--env`）。dev 结构变更走应用发布链路，不要另造"数据库发布"步骤。

## 常见故障

| 现象 | 处理 |
|---|---|
| 所有 `--as user` 命令失败 / `token storage lock` | user 身份缺失：让用户跑 `lark-cli auth login --as user`（插件不代持凭据） |
| `git push` 401/403 | `+git-credential-init` 刷新后重试一次 |
| 发布停在 pending | 应用配了审批：把 release_id 交给用户，等审批人在妙搭页面处理 |
| 本地和服务不一致 | `miaoda_pull mode=work` 拉最新；`mode=online` 看线上到底跑了什么 |
| 端口/启动异常 | `miaoda_dev action=logs`，`action=stop` 后重来；8080 被占会自动换成 8081 起 |
| 关闭 DSH 后 node.exe 还在 | 0.3.11 起由 `lib/dev-watchdog.mjs` 在宿主退出 1.5s 内 `taskkill /T` 收掉整棵树；每次启动还会清理上一会话的遗留进程（记录在 `~/.dsh/miaoda-dev-servers.json`） |
| 预览空白 / 连不上，但 dev server 是 running | 页面地址必须带 base：`http://localhost:8080/app/<appId>/`，`/` 只是 302。0.3.12 起 `lib/dev-launcher.mjs` 直接起 vite+nest（不经 Git Bash），并在日志里打印 `页面地址:`；先看 `miaoda_dev action=logs` 的这一行 |
| 页面停在「正在检查账号权限...」 | 身份头没注入：vite 预设只在 `MIAODA_LOCAL_DEV=1` 时才给 `/api` 加 `x-larkgw-suda-webuser`。0.3.13 起启动器会自动补这个变量并反转义 `SUDA_WEBUSER`；日志里应看到 `MIAODA_LOCAL_DEV=1`，页面 HTML 里 `window.userId` 不是空串 |

## 更多细节

`references/` 下有官方 lark-apps 技能的全部章节（`local-dev.md`、`release-create.md`、`db.md`、`file.md`、`observability.md`……），需要精确参数时直接读对应文件。也可以 `lark-cli skills read lark-apps references/<name>.md` 拿最新版。
