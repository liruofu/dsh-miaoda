/**
 * Tool definitions exposed to the model.
 *
 * Each entry is a plain object matching the harness's `ctx.tools.register`
 * contract (`name`, `description`, `parameters` JSON Schema, `output`,
 * `execute`), with no `@deepseek-ai/*` import.
 */
import path from 'node:path';
import * as dev from './devserver.js';
import * as ops from './ops.js';
import { collectChanges } from './changes.js';
import { MiaodaError } from './ops.js';
import { findScalar, runLark } from './runtime.js';

/** The canonical result value every tool returns. */
const RESULT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '是否成功' },
    text: { type: 'string', description: '面向人和模型的可读结果（Markdown）' },
  },
  required: ['ok', 'text'],
  additionalProperties: false,
});

/** Reusable `render` for the uniform result shape. */
const renderResult = (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }];

/**
 * Wrap a tool body so a thrown MiaodaError becomes a schema-valid failure
 * instead of an opaque tool error.
 * @param {(args: Record<string, any>, exec: {signal?: AbortSignal}) => Promise<{ok: boolean, text: string}>} body
 * @returns {(args: Record<string, any>, exec: {signal?: AbortSignal}) => Promise<{ok: boolean, text: string}>}
 */
function guard(body) {
  return async (args, exec) => {
    try {
      return await body(args ?? {}, exec ?? {});
    } catch (error) {
      if (error instanceof MiaodaError) {
        return { ok: false, text: `${error.message}${error.hint ? `\n→ ${error.hint}` : ''}` };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, text: `内部错误：${message}` };
    }
  };
}

/** @param {string} value @returns {boolean} */
const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * Build the tool list bound to one plugin config.
 * @param {Record<string, any>} config - resolved plugin config.
 * @returns {object[]}
 */
export function createTools(config) {
  return [
    {
      name: 'miaoda_status',
      description:
        '体检飞书妙搭（Miaoda）本地开发环境：lark-cli 是否安装、登录身份（user 是否可用）、当前项目与 app_id、git 分支与工作区状态、'
        + '本地 dev server 是否在跑、最近一次发布与线上/本地是否一致。任何妙搭任务开始前先跑一次，能提前发现"user 身份缺失""线上落后本地"这类问题。',
      parameters: {
        type: 'object',
        properties: {
          project: {
            type: 'string',
            description: '妙搭项目根目录（含 .spark/meta.json）。省略时自动在当前目录及其一级子目录里查找。',
          },
        },
        additionalProperties: false,
      },
      output: { schema: RESULT_SCHEMA, render: renderResult },
      execute: guard(async (args, exec) => {
        const report = await ops.statusReport(args, config, { signal: exec.signal });
        return { ok: report.ok, text: report.text };
      }),
    },
    {
      name: 'miaoda_apps',
      description:
        '查询当前用户的妙搭应用：列出应用（可按关键词/归属/类型筛选）或查单个应用详情。用于把应用名转换成 app_id，或确认应用类型（html / frontend / full_stack，发布规则不同）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"list"（默认，列应用）或 "get"（查单个应用，需要 app_id）' },
          keyword: { type: 'string', description: 'list 时按应用名搜索' },
          app_type: { type: 'string', description: 'list 时按类型筛选：html | frontend | full_stack' },
          ownership: { type: 'string', description: 'list 时按归属筛选，例如 mine（我创建的）' },
          page_token: { type: 'string', description: 'list 翻页游标' },
          app_id: { type: 'string', description: 'action=get 时的应用 id（app_ 开头）' },
        },
        additionalProperties: false,
      },
      output: { schema: RESULT_SCHEMA, render: renderResult },
      execute: guard(async (args, exec) => {
        const cli = ops.requireLark(config);
        if (args.action === 'get') {
          if (!nonEmpty(args.app_id)) return { ok: false, text: 'action=get 需要 app_id（app_ 开头）。' };
          const info = await ops.appInfo(cli, args.app_id.trim(), { signal: exec.signal });
          const raw = JSON.stringify(info.raw, null, 2);
          return { ok: true, text: `应用: ${info.name ?? '(未命名)'}\napp_id: ${info.appId}\n类型: ${info.appType ?? 'unknown'}\n\n原始返回:\n${raw.slice(0, 2000)}` };
        }
        const listed = await ops.listApps(cli, {
          keyword: args.keyword,
          appType: args.app_type,
          ownership: args.ownership,
          pageToken: args.page_token,
          signal: exec.signal,
        });
        return { ok: listed.ok, text: listed.text };
      }),
    },
    {
      name: 'miaoda_pull',
      description:
        '把妙搭代码拉到本地，四种模式：'
        + 'init=用 app_id 克隆一个新项目（含脚手架与 .env.local）；'
        + 'work=同步云端工作分支 sprint/default（git pull --rebase，日常用）；'
        + 'online=取出"线上真正在跑的那份代码"（定位最近一次 finished 发布的 commit_id，用 git worktree/checkout 还原，只读）；'
        + 'export=导出仓库 zip 快照（没有 git 历史与凭证，适合阅读别人的应用）。'
        + '注意 online 与 work 不同：work 是工作分支最新，可能还没发布。',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', description: 'init | work | online | export，默认 work' },
          project: { type: 'string', description: 'mode=work/online/export 时的项目根目录；省略则自动查找' },
          app_id: { type: 'string', description: 'mode=init/export 时必填的应用 id（app_ 开头）' },
          dir: { type: 'string', description: 'mode=init 时克隆到的目录；mode=export 时 zip 存放目录（默认当前目录）' },
          checkout: { type: 'boolean', description: 'mode=online 时：true=在当前仓库切到 detached HEAD；false/省略=生成独立 worktree 目录，不动当前工作区' },
          dry_run: { type: 'boolean', description: 'mode=init 时只展示将要执行的动作，不真正克隆' },
        },
        additionalProperties: false,
      },
      output: { schema: RESULT_SCHEMA, render: renderResult },
      execute: guard(async (args, exec) => {
        const cli = ops.requireLark(config);
        const mode = args.mode ?? 'work';
        if (mode === 'init') {
          if (!nonEmpty(args.app_id)) return { ok: false, text: 'mode=init 需要 app_id（app_ 开头）。先用 miaoda_apps 查。' };
          const dir = nonEmpty(args.dir) ? args.dir : path.join(process.cwd(), args.app_id.trim());
          if (args.dry_run === true) {
            const planned = await ops.pullInit(cli, { appId: args.app_id.trim(), dir, dryRun: true, signal: exec.signal });
            return { ok: planned.ok, text: planned.text };
          }
          const progress = [];
          const result = await ops.pullStaged(cli, {
            appId: args.app_id.trim(),
            dir,
            signal: exec.signal,
            onLine: (line) => {
              progress.push(line);
              if (progress.length > 40) progress.shift();
            },
          });
          const tail = progress.slice(-14).join('\n');
          return {
            ok: result.ok,
            text: `${result.text}\n过程：\n${tail}\n下一步：cd "${result.dir}" → miaoda_dev action=start`,
          };
        }
        if (mode === 'export') {
          if (!nonEmpty(args.app_id)) return { ok: false, text: 'mode=export 需要 app_id。' };
          const dir = nonEmpty(args.dir) ? path.resolve(args.dir) : process.cwd();
          const result = await ops.pullExport(cli, { appId: args.app_id.trim(), dir, signal: exec.signal });
          return { ok: result.ok, text: result.text };
        }
        const project = ops.locateProject(args, config);
        if (mode === 'online') {
          const result = await ops.pullOnline(project, cli, {
            mode: args.checkout === true ? 'checkout' : 'worktree',
            signal: exec.signal,
          });
          return { ok: result.ok, text: result.text };
        }
        if (mode === 'work') {
          const result = await ops.pullWork(project, cli, { signal: exec.signal });
          return { ok: result.ok, text: result.text };
        }
        return { ok: false, text: `未知 mode: ${mode}，可用值：init | work | online | export` };
      }),
    },
    {
      name: 'miaoda_dev',
      description:
        '管理妙搭项目的本地开发服务器（npm run dev，常驻后台，不占用工具调用）：'
        + 'install=安装依赖；start=启动并返回访问地址与首屏日志；status=看是否在跑/端口；logs=看最近日志；stop=停止（连同子进程一起）。'
        + 'html 类型应用没有 package.json，不需要 start。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'install | start | status | logs | stop，默认 status' },
          project: { type: 'string', description: '项目根目录；省略则自动查找' },
          wait_ms: { type: 'number', description: 'start 时等待服务就绪的最长时间，默认 12000 毫秒' },
          port: { type: 'number', description: 'start 时的前端端口：默认从 8080 起挑第一个空闲端口（占用就顺延），后端端口由插件另选' },
          lines: { type: 'number', description: 'logs 返回的行数，默认 80' },
        },
        additionalProperties: false,
      },
      output: { schema: RESULT_SCHEMA, render: renderResult },
      execute: guard(async (args, exec) => {
        const action = args.action ?? 'status';
        const project = ops.locateProject(args, config);
        if (action === 'install') {
          if (!dev.hasDevScript(project.root)) return { ok: false, text: `${project.root} 没有 package.json 的 dev 脚本，html 类型应用无需安装依赖。` };
          const result = await dev.install(project.root, { signal: exec.signal });
          return { ok: result.ok, text: result.text };
        }
        if (action === 'start') {
          if (!dev.hasDevScript(project.root)) {
            return { ok: false, text: `${project.root} 没有 dev 脚本（html 类型应用）：直接改仓库根目录的文件即可，发布后由平台托管。` };
          }
          const started = await dev.start(project.root, { waitMs: args.wait_ms, port: args.port });
          const running = started.running === true;
          const tail = String(started.logTail ?? '').split('\n').slice(-15).join('\n');
          return {
            ok: running,
            text: running
              ? `dev server 已启动${started.alreadyRunning ? '（原本就在运行）' : ''}。\n地址: ${started.url ?? '(还没识别到：模板首次启动要先同步平台工具链，通常 1–3 分钟；地址一出现，面板底部会自动显示)'}\n端口: 前端 ${started.port ?? '?'}${started.pid ? ` / 进程 ${started.pid}` : ''}（8080 被占用时会自动顺延，后端端口另选，避免抢端口直接退出）\n→ 会话头部的「本地预览」标签（或本卡上的「打开预览」）可以直接看页面，改完代码刷新即可。\n\n最近输出:\n${tail}`
              : `dev server 启动失败或立即退出。\n\n最近输出:\n${tail}`,
          };
        }
        if (action === 'stop') {
          const stopped = await dev.stop(project.root);
          return { ok: true, text: stopped.stopped ? `已停止 dev server（pid ${stopped.pid}）。` : `没有由插件启动的 dev server：${stopped.reason}` };
        }
        if (action === 'logs') {
          const server = dev.status(project.root);
          const lines = dev.logs(project.root, args.lines ?? 80);
          return {
            ok: true,
            text: server
              ? `运行中 pid=${server.pid} ${server.url ?? ''}\n\n${lines.join('\n')}`
              : `当前没有运行中的 dev server。\n\n最近日志:\n${lines.join('\n') || '(无)'}`,
          };
        }
        if (action === 'status') {
          const server = dev.status(project.root);
          return {
            ok: true,
            text: server
              ? `dev server 运行中：pid=${server.pid} 地址=${server.url ?? '(未识别)'} 启动于 ${server.startedAt}`
              : 'dev server 未启动（miaoda_dev action=start）。',
          };
        }
        return { ok: false, text: `未知 action: ${action}，可用值：install | start | status | logs | stop` };
      }),
    },
    {
      name: 'miaoda_publish',
      description:
        '把本地代码发布成线上版本，一条命令走完：commit（可选）→ push 到 sprint/default → 发起发布 → 每 20 秒轮询到终态。'
        + '发布只认"已经 push 到远端的代码"。full_stack / frontend 必须提供 reason（发布理由，一句话，会显示在发布记录里）；html 不需要。'
        + '若应用配置了发布审批，会停在 PENDING 并如实告诉你，不会自动审批。先在 sprint/default 分支上再调用。',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: '项目根目录；省略则自动查找' },
          reason: { type: 'string', description: '发布理由（full_stack / frontend 必填，单行，说明这次改了什么）' },
          message: { type: 'string', description: 'git commit 信息；工作区干净时忽略' },
          commit: { type: 'boolean', description: '是否自动提交本地改动，默认 true' },
          push: { type: 'boolean', description: '是否自动 push 到 sprint/default，默认 true' },
          poll: { type: 'boolean', description: '是否轮询到发布终态，默认 true' },
          force: { type: 'boolean', description: '即使检测到密钥类文件（.env.local 等）或资源文件（图片/字体/音视频）也照常提交，默认 false' },
          action: { type: 'string', description: "status=只看这次会发布哪些文件（不提交、不推送）；publish=真正发布，默认 publish" },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: '只提交这些文件（仓库相对路径，通常来自 action=status 的结果）；省略则提交全部改动',
          },
        },
        additionalProperties: false,
      },
      output: { schema: RESULT_SCHEMA, render: renderResult },
      execute: guard(async (args, exec) => {
        const project = ops.locateProject(args, config);
        if (args.action === 'status') {
          const changes = await collectChanges(project.root, { signal: exec.signal });
          return { ok: true, text: ops.describeChanges(changes, project) };
        }
        // Always show what is about to go out: publishing blindly is how people
        // ship a stray .env or forget the one file they actually edited.
        const pending = await collectChanges(project.root, { signal: exec.signal }).catch(() => null);
        const cli = ops.requireLark(config);
        const result = await ops.publish(project, cli, {
          reason: args.reason,
          message: args.message,
          commit: args.commit,
          push: args.push,
          poll: args.poll,
          force: args.force,
          files: args.files,
          signal: exec.signal,
        });
        const head = pending ? ops.describeChanges(pending, project) + '\n\n' : '';
        return { ok: result.ok, text: head + result.text };
      }),
    },
    {
      name: 'miaoda_env',
      description:
        '管理妙搭应用的环境变量：pull=把 dev 环境变量合并写入项目 .env.local（保留本地手写行，不回显值）；'
        + 'list=只列出变量名（environment=dev|online）。线上变量的值默认拿不到，需要时用 miaoda_lark 调 +env-list --include-values。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'pull | list，默认 pull' },
          project: { type: 'string', description: '项目根目录；省略则自动查找' },
          environment: { type: 'string', description: 'list 时的环境：dev | online，默认 dev' },
        },
        additionalProperties: false,
      },
      output: { schema: RESULT_SCHEMA, render: renderResult },
      execute: guard(async (args, exec) => {
        const cli = ops.requireLark(config);
        const project = ops.locateProject(args, config);
        if ((args.action ?? 'pull') === 'list') {
          const listed = await ops.envList(project, cli, { environment: args.environment, signal: exec.signal });
          return { ok: listed.ok, text: listed.text };
        }
        const result = await ops.envPull(project, cli, { signal: exec.signal });
        return { ok: result.ok, text: result.text };
      }),
    },
    {
      name: 'miaoda_lark',
      description:
        'lark-cli 的通用兜底通道：把 argv 数组原样交给官方 CLI（不经 shell，避免注入），用于本插件未封装的命令，'
        + '例如 apps +db-table-list、+log-list、+file-upload、+access-scope-set、+plugin-install。'
        + '文档见插件自带的 miaoda skill 与 lark-cli skills read lark-apps。写操作请先确认用户意图。',
      parameters: {
        type: 'object',
        properties: {
          argv: {
            type: 'array',
            description: '命令行参数数组，例如 ["apps","+db-env-diff","--app-id","app_xxx","--as","user"]。不要包含可执行文件名 lark-cli 本身。',
            items: { type: 'string' },
          },
          cwd: { type: 'string', description: '执行目录（git/env 相关命令需要指向项目根目录）' },
          timeout_ms: { type: 'number', description: '超时时间，默认 120000 毫秒' },
        },
        required: ['argv'],
        additionalProperties: false,
      },
      output: { schema: RESULT_SCHEMA, render: renderResult },
      execute: guard(async (args, exec) => {
        const cli = ops.requireLark(config);
        const argv = Array.isArray(args.argv) ? args.argv.map((item) => String(item)) : [];
        if (argv.length === 0) return { ok: false, text: 'argv 不能为空。' };
        const result = await runLark(cli, argv, {
          cwd: nonEmpty(args.cwd) ? path.resolve(args.cwd) : undefined,
          timeoutMs: typeof args.timeout_ms === 'number' && args.timeout_ms > 0 ? args.timeout_ms : undefined,
          signal: exec.signal,
        });
        const pretty = (() => {
          const data = result.data;
          if (data === undefined) return result.text || '(no output)';
          try { return JSON.stringify(data, null, 2); } catch { return String(result.text); }
        })();
        const body = pretty.length > 6000 ? `${pretty.slice(0, 6000)}\n… (truncated)` : pretty;
        return {
          ok: result.ok,
          text: result.ok
            ? `$ lark-cli ${argv.join(' ')}\n${body}`
            : `$ lark-cli ${argv.join(' ')}\n失败：${result.error}\n\n${body.slice(0, 2000)}`,
        };
      }),
    },
  ];
}

export { findScalar };
