/**
 * Miaoda-specific operations: project discovery, pull, dev, publish, env.
 *
 * Everything here is written against the official `lark-cli apps` surface plus
 * native git. There is no private API: the platform's own workflow is
 * "work branch (sprint/default) + release pipeline", and the plugin only
 * automates the steps documented in the bundled lark-apps skill.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as dev from './devserver.js';
import { collectChanges, stagePaths } from './changes.js';
import {
  describeLarkError,
  findScalar,
  isRecord,
  readProjectMeta,
  resolveLarkCli,
  runGit,
  runLark,
  runProcess,
  scanProjects,
  stamp,
} from './runtime.js';

/** A user-facing failure that should be reported, not thrown as a crash. */
export class MiaodaError extends Error {
  /**
   * @param {string} message - what went wrong. @param {string} [hint] - what to do instead.
   */
  constructor(message, hint) {
    super(message);
    this.name = 'MiaodaError';
    this.hint = hint;
  }
}

/** @param {string} text @returns {string} */
const short = (text, limit = 400) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

/**
 * Resolve the lark-cli launcher or explain how to install it.
 * @param {Record<string, any>} config - plugin config.
 * @returns {{node: string, entry: string}}
 */
export function requireLark(config) {
  const cli = resolveLarkCli(config?.larkCliEntry);
  if (!cli) {
    throw new MiaodaError(
      'lark-cli not found: 未找到 lark-cli 可执行入口',
      '先安装官方 CLI：npm install -g @larksuite/cli，然后运行 lark-cli auth login --as user',
    );
  }
  return cli;
}

/**
 * Locate the Miaoda project a call applies to.
 * @param {{project?: string}} args - tool arguments.
 * @param {Record<string, any>} config - plugin config.
 * @returns {{root: string, appId: string}}
 */
export function locateProject(args, config) {
  /** @type {string[]} */
  const tried = [];
  const candidates = [];
  if (typeof args?.project === 'string' && args.project.trim() !== '') {
    candidates.push(path.resolve(args.project));
  } else if (typeof config?.project === 'string' && config.project.trim() !== '') {
    candidates.push(path.resolve(config.project));
  } else {
    candidates.push(process.cwd());
  }
  for (const base of candidates) {
    tried.push(base);
    const meta = readProjectMeta(base);
    if (meta) {
      if (!meta.appId) {
        throw new MiaodaError(
          `${base}\\.spark\\meta.json 里没有 app_id`,
          '该目录不是有效的妙搭项目；请用 miaoda_pull mode=init 重新初始化',
        );
      }
      return { root: base, appId: meta.appId };
    }
  }
  // Fall back to a one-level scan: the session workspace usually holds the app.
  const base = candidates[candidates.length - 1];
  const found = scanProjects(base);
  if (found.length === 1) {
    const meta = readProjectMeta(found[0]);
    if (meta?.appId) return { root: found[0], appId: meta.appId };
  }
  if (found.length > 1) {
    throw new MiaodaError(
      `在 ${base} 下发现多个妙搭项目，无法确定用哪一个：${found.map((dir) => path.basename(dir)).join(', ')}`,
      '用 project 参数指明项目目录，例如 {"project": "C:\\\\path\\\\to\\\\app"}',
    );
  }
  throw new MiaodaError(
    `没有找到妙搭项目（已检查：${tried.join(', ')}）`,
    '三种做法：① 传入 project 指向项目根目录；② 已有 app_id 时用 miaoda_pull mode=init 克隆到本地；③ 用 miaoda_apps 先查 app_id',
  );
}

/**
 * Current branch, dirty state and divergence from the work branch.
 * @param {string} root - project root.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function gitState(root) {
  // One process instead of seven: the panel polls this, and every extra spawn
  // is another chance of a console window flashing on Windows.
  const status = await runGit(['status', '--porcelain=v2', '--branch'], { cwd: root, timeoutMs: 60_000 });
  if (status.ok) {
    const parsed = parsePorcelainV2(status.stdout);
    if (parsed) return parsed;
  }
  return await gitStateFallback(root, status);
}

/**
 * Parse `git status --porcelain=v2 --branch`.
 * @param {string} stdout
 * @returns {{branch: string, head: string, upstream: string|undefined, dirtyFiles: string[], dirty: boolean, ahead: number|undefined, behind: number|undefined, error: string|undefined} | null}
 */
function pathOfV2(record) {
  if (record.startsWith('? ')) return unquotePath(record.slice(2));
  // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
  // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
  // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
  const skip = record.startsWith('u ') ? 10 : record.startsWith('2 ') ? 9 : 8;
  let index = 0;
  for (let count = 0; count < skip; count += 1) {
    const space = record.indexOf(' ', index);
    if (space === -1) return '';
    index = space + 1;
  }
  const rest = record.slice(index);
  const tab = rest.indexOf('\t');
  return unquotePath(tab === -1 ? rest : rest.slice(0, tab));
}

/**
 * Strip git's C-style quoting from a path field.
 * @param {string} value
 */
function unquotePath(value) {
  const text = String(value).trim();
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;
  return text
    .slice(1, -1)
    .replace(/\\(["\\])/g, '$1')
    .replace(/\\t/g, '\t')
    .replace(/\\n/g, '\n');
}

function parsePorcelainV2(stdout) {
  let branch = '(unknown)';
  let head = '(unknown)';
  let upstream;
  let ahead;
  let behind;
  const files = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length).trim();
    else if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim();
      head = oid === '(initial)' ? oid : oid.slice(0, 7);
    } else if (line.startsWith('# branch.upstream ')) upstream = line.slice('# branch.upstream '.length).trim();
    else if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+)\s+-(\d+)/.exec(line);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (/^[12u?] /.test(line)) files.push(pathOfV2(line));
  }
  if (branch === '(unknown)') return null;
  return { branch, head, upstream, dirtyFiles: files, dirty: files.length > 0, ahead, behind, error: undefined };
}

/**
 * Older git builds without the porcelain=v2 branch headers.
 * @param {string} root
 * @param {{ok: boolean, error?: string, stdout: string}} status - the failed v2 attempt.
 */
async function gitStateFallback(root, status) {
  const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  const head = await runGit(['rev-parse', '--short', 'HEAD'], { cwd: root });
  const plain = status.ok ? status : await runGit(['status', '--porcelain'], { cwd: root, timeoutMs: 60_000 });
  const files = plain.ok
    ? plain.stdout
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '' && !line.startsWith('#'))
        .map(porcelainPath)
        .filter((file) => file !== '')
    : [];
  const remote = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: root, timeoutMs: 30_000 });
  const ahead = await runGit(['rev-list', '--count', '@{u}..HEAD'], { cwd: root, timeoutMs: 30_000 });
  const behind = await runGit(['rev-list', '--count', 'HEAD..@{u}'], { cwd: root, timeoutMs: 30_000 });
  return {
    branch: branch.ok ? branch.stdout : '(unknown)',
    head: head.ok ? head.stdout : '(unknown)',
    upstream: remote.ok ? remote.stdout : undefined,
    dirtyFiles: files,
    dirty: files.length > 0,
    ahead: ahead.ok && /^\d+$/.test(ahead.stdout) ? Number(ahead.stdout) : undefined,
    behind: behind.ok && /^\d+$/.test(behind.stdout) ? Number(behind.stdout) : undefined,
    error: branch.ok ? undefined : short(branch.error ?? ''),
  };
}

/**
 * Fetch app metadata through `+get`.
 * @param {{node:string, entry:string}} cli - launcher.
 * @param {string} appId - Miaoda app id.
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{appId: string, appType: string|undefined, name: string|undefined, raw: unknown}>}
 */
export async function appInfo(cli, appId, options = {}) {
  const result = await runLark(cli, ['apps', '+get', '--app-id', appId, '--as', 'user'], {
    timeoutMs: 60_000,
    signal: options.signal,
  });
  if (!result.ok) {
    throw new MiaodaError(`查询应用信息失败：${result.error}`, '先确认 lark-cli 已用 user 身份登录：lark-cli auth login --as user');
  }
  return {
    appId,
    appType: findScalar(result.data, ['app_type', 'appType']),
    name: findScalar(result.data, ['name', 'app_name']),
    raw: result.data,
  };
}

/**
 * Ask lark-cli to refresh git credentials, then retry once — the documented
 * recovery for 401/403 from the Miaoda git remote.
 * @param {{node:string, entry:string}} cli - launcher.
 * @param {string} appId - Miaoda app id.
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<boolean>} whether the credential refresh succeeded.
 */
export async function refreshGitCredential(cli, appId, options = {}) {
  const result = await runLark(cli, ['apps', '+git-credential-init', '--app-id', appId, '--as', 'user'], {
    timeoutMs: 90_000,
    signal: options.signal,
  });
  return result.ok;
}

/**
 * Pull the cloud work branch (`sprint/default`) into the local checkout.
 * @param {{root:string, appId:string}} project - resolved project.
 * @param {{node:string, entry:string}} cli - launcher.
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{ok: boolean, text: string}>}
 */
export async function pullWork(project, cli, options = {}) {
  const before = await gitState(project.root);
  if (before.dirty) {
    return {
      ok: false,
      text: `本地有 ${before.dirtyFiles.length} 个未提交改动，先处理再同步：\n${before.dirtyFiles.slice(0, 20).join('\n')}\n提示：用 miaoda_publish 提交，或自行 git stash。`,
    };
  }
  let pull = await runGit(['pull', '--rebase', 'origin', 'sprint/default'], { cwd: project.root, signal: options.signal });
  let refreshed = false;
  if (!pull.ok && isAuthFailure(pull.error)) {
    refreshed = await refreshGitCredential(cli, project.appId, options);
    if (refreshed) pull = await runGit(['pull', '--rebase', 'origin', 'sprint/default'], { cwd: project.root, signal: options.signal });
  }
  if (!pull.ok) {
    return {
      ok: false,
      text: `同步 sprint/default 失败：${short(pull.error ?? '')}${refreshed ? '' : '\n提示：可能是 git 凭证过期，可先跑 lark-cli apps +git-credential-init 再重试。'}`,
    };
  }
  const after = await gitState(project.root);
  return {
    ok: true,
    text: `已同步工作分支 sprint/default。\nHEAD: ${after.head}（之前 ${before.head}）\n分支: ${after.branch}`,
  };
}

/** @param {string|undefined} error @returns {boolean} */
/** 会泄露密钥的文件名（`.env.local` 之类）。示例/模板文件例外。 */
const SECRET_NAME = /^\.env(\.|$)/i;
const SECRET_EXAMPLE = /\.(example|sample|template|dist)$/i;
const SECRET_SUFFIX = /\.(pem|key|p12|pfx)$/i;
/** 妙搭建议走 `+file-upload` 的资源文件，不该进 git。 */
const RESOURCE_SUFFIX = /\.(png|jpe?g|gif|webp|bmp|ico|mp4|mov|webm|mp3|wav|ogg|ttf|otf|woff2?|zip|tar|gz|7z|pdf|psd|fig|sketch|ai)$/i;

/** 从 `git status --porcelain` 的行里取出路径（兼容改名 `a -> b` 与单字符状态列）。 */
function porcelainPath(line) {
  const text = String(line ?? '');
  const body = text.startsWith(' ') || /^[MADRCU?!]{2} /.test(text) ? text.slice(3) : /^[MADRCU?!] /.test(text) ? text.slice(2) : text;
  const arrow = body.lastIndexOf(' -> ');
  return (arrow === -1 ? body : body.slice(arrow + 4)).replace(/^"|"$/g, '').trim();
}

/**
 * 在 commit 之前拦截两类东西：密钥文件（会泄露）和资源文件（`+file-upload` 才是正路）。
 * @param {string[]} lines - 路径列表（也兼容 `git status --porcelain` 的原始行）。
 */
/**
 * Human readable rendering of a change list — the same ordering and badges the
 * workbench draws, so tool output and UI never disagree.
 * @param {{files: {path: string, status: string, additions: number, deletions: number, binary: boolean}[], summary: {files: number, additions: number, deletions: number}}} changes - from collectChanges.
 * @param {{root?: string}} project - project the changes belong to.
 * @returns {string} multi-line summary.
 */
export function describeChanges(changes, project) {
  const summary = changes.summary ?? { files: 0, additions: 0, deletions: 0 };
  if (!summary.files) {
    return `工作区是干净的，没有待发布的改动${project?.root ? `（${project.root}）` : ''}。`;
  }
  const head = `待发布 ${summary.files} 个文件，+${summary.additions} −${summary.deletions}`;
  const width = Math.min(60, Math.max(...changes.files.map((file) => file.path.length)));
  const rows = changes.files.map((file) => {
    const counts = file.binary ? '二进制' : `+${file.additions} −${file.deletions}`;
    return `  ${file.status}  ${file.path.padEnd(width)}  ${counts}`;
  });
  const risk = riskyChanges(changes.files.map((file) => `${file.status === 'A' ? '?? ' : ' M '}${file.path}`));
  const warn = [];
  if (risk.secrets.length > 0) warn.push(`其中 ${risk.secrets.length} 个是密钥类文件（.env.local / *.pem / *.key），提交会进远端历史`);
  if (risk.resources.length > 0) warn.push(`其中 ${risk.resources.length} 个是资源文件（图片/字体/音视频），应走 lark-cli apps +file-upload`);
  const tail = warn.length > 0 ? `\n\n注意：${warn.join('；')}。确认无误再发布，或先加进 .gitignore。` : '';
  return `${head}\n${rows.join('\n')}${tail}`;
}

export function riskyChanges(lines) {
  const secrets = [];
  const resources = [];
  for (const line of lines) {
    const raw = String(line ?? '');
    if (!raw.trim()) continue;
    // gitState reports plain repo-relative paths; accept legacy `git status` rows too.
    const file = /^[12u?] /.test(raw)
      ? pathOfV2(raw)
      : /^[ MADRCU?!]{1,2} \S/.test(raw)
        ? porcelainPath(raw)
        : raw.trim();
    const base = path.basename(file);
    if ((SECRET_NAME.test(base) && !SECRET_EXAMPLE.test(base)) || SECRET_SUFFIX.test(base)) secrets.push(file);
    else if (RESOURCE_SUFFIX.test(base)) resources.push(file);
  }
  return { secrets, resources };
}

function isAuthFailure(error) {
  if (!error) return false;
  return /401|403|authentication|credential|permission denied|Authentication failed|could not read Username/i.test(error);
}

/**
 * Materialize the code that the latest successful release actually deployed.
 *
 * `+export` is only a snapshot of the repository's default branch, so the exact
 * online revision is addressed by release → commit_id, as the official skill
 * documents.
 * @param {{root:string, appId:string}} project - resolved project.
 * @param {{node:string, entry:string}} cli - launcher.
 * @param {{mode?: 'worktree'|'checkout', signal?: AbortSignal}} [options]
 * @returns {Promise<{ok: boolean, text: string}>}
 */
export async function pullOnline(project, cli, options = {}) {
  const list = await runLark(cli, ['apps', '+release-list', '--app-id', project.appId, '--status', 'finished', '--page-size', '1', '--as', 'user'], {
    timeoutMs: 90_000,
    signal: options.signal,
  });
  if (!list.ok) {
    throw new MiaodaError(`查询发布记录失败：${list.error}`, '确认已用 user 身份登录，且该应用至少发布成功过一次');
  }
  const releaseId = findScalar(list.data, ['release_id', 'releaseId']);
  if (!releaseId) {
    return { ok: false, text: '这个应用还没有一次 finished 状态的发布，线上没有可拉取的版本。先 miaoda_publish 发布一次。' };
  }
  const detail = await runLark(cli, ['apps', '+release-get', '--app-id', project.appId, '--release-id', releaseId, '--as', 'user'], {
    timeoutMs: 90_000,
    signal: options.signal,
  });
  if (!detail.ok) throw new MiaodaError(`查询发布详情失败：${detail.error}`);
  const commit = findScalar(detail.data, ['commit_id', 'commitId', 'commit']);
  const status = findScalar(detail.data, ['status']);
  const onlineUrl = findScalar(detail.data, ['online_url', 'onlineUrl']);
  if (!commit || commit.length < 7) {
    return { ok: false, text: `发布 ${releaseId}（status=${status ?? '?'}）没有返回 commit_id，无法精确定位线上代码。` };
  }
  const fetch = await runGit(['fetch', 'origin', '--tags'], { cwd: project.root, signal: options.signal });
  if (!fetch.ok) {
    const refreshed = await refreshGitCredential(cli, project.appId, options);
    if (!refreshed) throw new MiaodaError(`git fetch 失败：${fetch.error}`, 'git 凭证可能已过期');
    const retry = await runGit(['fetch', 'origin'], { cwd: project.root, signal: options.signal });
    if (!retry.ok) throw new MiaodaError(`刷新凭证后 git fetch 仍失败：${retry.error}`);
  }
  const exists = await runGit(['cat-file', '-e', `${commit}^{commit}`], { cwd: project.root, timeoutMs: 30_000 });
  if (!exists.ok) {
    return { ok: false, text: `远端没有提交 ${commit}（可能是 force-push 或权限不足）。先用 +export 拿仓库快照：miaoda_pull mode=export` };
  }
  const mode = options.mode ?? 'worktree';
  if (mode === 'checkout') {
    const checkout = await runGit(['checkout', '--detach', commit], { cwd: project.root, signal: options.signal });
    if (!checkout.ok) throw new MiaodaError(`git checkout ${commit} 失败：${checkout.error}`);
    return {
      ok: true,
      text: `已切到线上发布对应的提交（detached HEAD）。\nrelease: ${releaseId}\ncommit: ${commit}\n${onlineUrl ? `线上地址: ${onlineUrl}\n` : ''}只读排查完成后用 git checkout ${(await gitState(project.root)).branch} 回到工作分支。`,
    };
  }
  const dir = path.join(project.root, '..', `${path.basename(project.root)}-online-${commit.slice(0, 7)}`);
  if (fs.existsSync(dir)) {
    return { ok: true, text: `线上快照已存在：${dir}\nrelease: ${releaseId}\ncommit: ${commit}${onlineUrl ? `\n线上地址: ${onlineUrl}` : ''}` };
  }
  const worktree = await runGit(['worktree', 'add', dir, commit], { cwd: project.root, signal: options.signal });
  if (!worktree.ok) throw new MiaodaError(`git worktree add 失败：${worktree.error}`);
  return {
    ok: true,
    text: `已把线上版本取到独立目录（不影响当前工作区）：\n目录: ${dir}\nrelease: ${releaseId}\ncommit: ${commit}${onlineUrl ? `\n线上地址: ${onlineUrl}` : ''}\n用完删除：git worktree remove "${dir}"`,
  };
}

/**
 * Clone a Miaoda app into a directory (`+init`).
 * @param {{node:string, entry:string}} cli - launcher.
 * @param {{appId: string, dir: string, dryRun?: boolean, signal?: AbortSignal}} options
 * @returns {Promise<{ok: boolean, text: string, dir: string}>}
 */
export async function pullInit(cli, options) {
  if (!/^app_[A-Za-z0-9]+$/.test(options.appId)) {
    throw new MiaodaError(`app_id 格式不对：${options.appId}`, 'app_id 形如 app_xxxxxxx，可用 miaoda_apps 查询');
  }
  const dir = path.resolve(options.dir);
  const argv = ['apps', '+init', '--app-id', options.appId, '--dir', dir, '--as', 'user'];
  if (options.dryRun) argv.push('--dry-run');
  const result = await runLark(cli, argv, { timeoutMs: 300_000, signal: options.signal });
  if (!result.ok) {
    throw new MiaodaError(`初始化项目失败：${result.error}`, '确认 app_id 正确、当前用户有该应用权限、目标目录可写');
  }
  const tail = result.text.split(/\r?\n/).slice(-12).join('\n');
  return { ok: true, dir, text: `项目已就绪：${dir}\n${tail}` };
}

/**
 * Run npm on Windows without a shell. `npm` is a .cmd shim, so Node's
 * spawn(..., {shell:false}) cannot exec it directly — go through cmd.exe.
 * @param {string[]} args - npm argv.
 * @returns {{command:string, args:string[]}}
 */
function npmCommand(args) {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe';
    return { command: comspec, args: ['/d', '/s', '/c', `npm ${args.join(' ')}`] };
  }
  return { command: 'npm', args };
}

/** Absolute path of the ESM resolver shim shipped next to this file. */
const ESM_HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'esm-path-hook.mjs');

/**
 * Environment that lets Node accept `C:\...` ESM specifiers.
 *
 * The Miaoda template's `postinstall` runs `@lark-apaas/fullstack-cli
 * action-plugin init`, whose entry does `await import(path.join(__dirname,
 * '../dist/index.js'))` — a bare Windows path, which Node rejects with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME. npm only reports "command failed", so `npm ci`
 * dies in postinstall and leaves a half-installed tree. Loading our resolver
 * hook through NODE_OPTIONS fixes it for npm and for every script it spawns,
 * which means the install succeeds on the first try instead of being retried
 * with `--ignore-scripts`.
 * @param {Record<string, string>} [extra] - extra variables to merge in.
 * @returns {Record<string, string>} environment for a child process.
 */
function esmHookEnv(extra = {}) {
  // `--import` needs Node 20.6+; a project pinned to an older runtime would
  // otherwise fail to start *every* script with a bad-option error.
  const [major, minor] = String(process.versions.node).split('.').map((part) => Number(part));
  const supportsImport = major > 20 || (major === 20 && minor >= 6);
  const hookUrl =
    !supportsImport || process.env.MIAODA_NO_ESM_HOOK === '1' || !fs.existsSync(ESM_HOOK)
      ? ''
      : pathToFileURL(ESM_HOOK).href;
  const nodeOptions = [process.env.NODE_OPTIONS, hookUrl ? `--import "${hookUrl}"` : ''].filter(Boolean).join(' ');
  const env = { ...extra };
  if (nodeOptions) env.NODE_OPTIONS = nodeOptions;
  return env;
}

function npxCommand(args) {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe';
    return { command: comspec, args: ['/d', '/s', '/c', `npx ${args.join(' ')}`] };
  }
  return { command: 'npx', args };
}

/**
 * Install the project's `actionPlugins` (the 妙搭 template's postinstall step).
 *
 * The upstream `@lark-apaas/fullstack-cli` entry ends with
 * `await import(path.join(__dirname, '../dist/index.js'))`; on Windows that is
 * a `C:\...` specifier, which every current Node rejects with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME. npm surfaces only "command failed", so the
 * failure looks unexplained. Loading `lib/esm-path-hook.mjs` via NODE_OPTIONS
 * rewrites the specifier to file:// and the CLI runs properly.
 * @param {string} project - project root.
 * @param {{signal?: any, note?: (line: string) => void}} [options] - plumbing.
 * @returns {Promise<string>} one line for the install summary.
 */
async function installActionPlugins(project, options = {}) {
  let plugins = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
    if (pkg && typeof pkg.actionPlugins === 'object' && pkg.actionPlugins !== null) plugins = pkg.actionPlugins;
  } catch {
    plugins = {};
  }
  const names = Object.keys(plugins);
  if (names.length === 0) return '无 actionPlugin';
  const npx = npxCommand(['-y', '@lark-apaas/fullstack-cli@latest', 'action-plugin', 'init']);
  try {
    options.note?.('   安装项目自带的 action plugin（发飞书消息等能力）…');
    const result = await runProcess(npx.command, npx.args, {
      cwd: project,
      timeoutMs: 600_000,
      signal: options.signal,
      env: esmHookEnv(),
      onLine: throttleLines(options.note || (() => {})),
    });
    if (result.code === 0) return `action plugin 已装（${names.join(', ')}）`;
    const detail = short((result.stderr || result.stdout || '').trim(), 200);
    return `action plugin 未装（${detail || `npx exited with ${result.code}`}）`;
  } catch (error) {
    return `action plugin 未装（${error instanceof Error ? error.message : String(error)}）`;
  }
}

/**
 * Keep a chatty child (git progress, npm) from flooding the task log: forward
 * the milestones, at most one generic progress line every few seconds.
 * @param {(line: string) => void} onLine - sink.
 * @param {{intervalMs?: number}} [options]
 * @returns {(line: string) => void}
 */
function throttleLines(onLine, options = {}) {
  const intervalMs = options.intervalMs ?? 2500;
  let last = 0;
  return (line) => {
    const text = String(line).trim();
    if (text === '') return;
    const important =
      text.startsWith('Cloning into') ||
      text.includes('remote: Total') ||
      text.includes('Receiving objects: 100%') ||
      text.includes('Resolving deltas: 100%') ||
      text.includes('Updating files: 100%') ||
      text.startsWith('added ') ||
      text.startsWith('changed ') ||
      text.startsWith('audited ') ||
      text.startsWith('npm error') ||
      text.startsWith('npm ERR!') ||
      text.startsWith('error:') ||
      text.startsWith('fatal:');
    const now = Date.now();
    if (important) {
      last = now;
      onLine(`   ${text}`);
      return;
    }
    if (now - last < intervalMs) return;
    const percent = text.slice(text.indexOf('Receiving objects:') + 18).match(/^[^0-9]*([0-9]+)%/);
    if (text.startsWith('Receiving objects:') && percent) {
      last = now;
      onLine(`   下载中 ${percent[1]}%`);
    }
  };
}

/**
 * Pull an app the fast way: credential → clone → env → deps → setup.
 *
 * `apps +init` does all of this behind one opaque call and buffers until the
 * end, so a fullstack app looks frozen for minutes. These are the same steps
 * from the runbook, reported one by one.
 * @param {{node:string, entry:string}} cli - launcher.
 * @param {{appId:string, dir?:string, baseDir?:string, onLine?:(line:string)=>void, signal?:AbortSignal}} options
 * @returns {Promise<{ok:boolean, dir:string, repositoryUrl:string, text:string}>}
 */
export async function pullStaged(cli, options) {
  const note = typeof options.onLine === 'function' ? options.onLine : () => {};
  const appId = String(options.appId ?? '').trim();
  if (!/^app_[A-Za-z0-9]+$/.test(appId)) {
    throw new MiaodaError(`app_id 格式不对：${appId}`, 'app_id 形如 app_xxxxxxx，可用 miaoda_apps 查询');
  }
  const target = path.resolve(options.dir ?? path.join(options.baseDir ?? process.cwd(), appId));
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    throw new MiaodaError(`目标目录不是空的：${target}`, '换一个保存位置，或先把该目录挪走');
  }

  note('① 取仓库地址（git-credential-init）…');
  const credential = await runLark(cli, ['apps', '+git-credential-init', '--app-id', appId, '--as', 'user', '--format', 'json'], {
    timeoutMs: 90_000,
    signal: options.signal,
  });
  if (!credential.ok) {
    throw new MiaodaError(`拿不到仓库地址：${credential.error}`, '确认 app_id 正确、当前飞书账号有该应用权限');
  }
  const repositoryUrl = findScalar(credential.data, ['repository_url']);
  if (typeof repositoryUrl !== 'string' || !repositoryUrl.startsWith('http')) {
    throw new MiaodaError('lark-cli 没有返回 repository_url', '确认该应用已初始化仓库（html 应用只有导出快照，没有 git 仓库）');
  }

  note(`② 克隆 sprint/default → ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const clone = await runProcess('git', ['clone', '--branch', 'sprint/default', '--single-branch', '--progress', repositoryUrl, target], {
    timeoutMs: 600_000,
    signal: options.signal,
    onLine: throttleLines(note),
  });
  if (clone.code !== 0) {
    const detail = short((clone.stderr || clone.stdout || clone.spawnError || '').trim(), 600);
    throw new MiaodaError(`克隆失败：${detail || `git exited with ${clone.code}`}`, '检查网络与飞书账号权限；必要时重试一次');
  }

  if (!readProjectMeta(target)) {
    try {
      fs.mkdirSync(path.join(target, '.spark'), { recursive: true });
      fs.writeFileSync(path.join(target, '.spark', 'meta.json'), `${JSON.stringify({ app_id: appId }, null, 2)}\n`, 'utf8');
      note('   已补写 .spark/meta.json');
    } catch (error) {
      note(`   写 .spark/meta.json 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  note('③ 拉取本地环境变量（.env.local）…');
  const env = await runLark(cli, ['apps', '+env-pull', '--app-id', appId, '--project-path', target, '--as', 'user', '--format', 'json'], {
    timeoutMs: 120_000,
    signal: options.signal,
  });
  if (!env.ok) note(`   环境变量没拉下来：${env.error}（稍后可在项目里跑 npm run setup:local -- ${appId}）`);

  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
  } catch {
    pkg = null;
  }
  let deps = '无需安装';
  if (pkg && typeof pkg === 'object') {
    const hasLock = fs.existsSync(path.join(target, 'package-lock.json'));
    const args = hasLock ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
    note(`④ 安装依赖（npm ${args[0]}，这一步最慢，通常 1–3 分钟）…`);
    const npm = npmCommand(args);
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      note(`   …依赖安装中（${Math.round((Date.now() - startedAt) / 1000)}s）`);
    }, 20_000);
    const install = await runProcess(npm.command, npm.args, {
      cwd: target,
      timeoutMs: 900_000,
      signal: options.signal,
      // The template's postinstall needs the ESM path hook on Windows; passing
      // it here means the very first `npm ci` can succeed instead of dying in
      // postinstall and forcing a slow `--ignore-scripts` second pass.
      env: esmHookEnv(),
      onLine: throttleLines(note),
    });
    clearInterval(heartbeat);
    if (install.code !== 0) {
      // A failing `postinstall` (e.g. @lark-apaas/fullstack-cli's action-plugin
      // init under Node 24 on Windows) leaves the tree half-installed. Retry
      // without lifecycle scripts so `npm run dev` still has its deps.
      note('   安装脚本仍然报错，改用 --ignore-scripts 再装一次……');
      const retry = await runProcess(npm.command, [...npm.args, '--ignore-scripts'], {
        cwd: target,
        timeoutMs: 900_000,
        signal: options.signal,
        env: esmHookEnv(),
        onLine: throttleLines(note),
      });
      if (retry.code !== 0) {
        const detail = short((retry.stderr || retry.stdout || retry.spawnError || install.stderr || '').trim(), 600);
        throw new MiaodaError(`依赖安装失败：${detail || `npm exited with ${retry.code}`}`, '在项目目录里手动跑一次 npm ci 看完整报错');
      }
      const failureLines = (install.stderr || install.stdout || '')
        .trim()
        .split(String.fromCharCode(10))
        .map((line) => line.replace(String.fromCharCode(13), '').trim())
        .filter(Boolean);
      const failure = short(failureLines.slice(-3).join(' / '), 300);
      const actionLine = await installActionPlugins(target, { signal: options.signal, note });
      deps = `已安装（跳过安装脚本：${failure || 'postinstall 失败'}；${actionLine}）`;
      note('   依赖已就绪；项目自带的安装脚本没跑成功，这件事后面可以不管。');
    } else {
      deps = `已安装（npm ${args[0]}）`;
    }
  }

  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null ? pkg.scripts : {};
  if (typeof scripts['setup:local'] === 'string') {
    note(`⑤ 生成本地运行环境（npm run setup:local -- ${appId}）…`);
    const npm = npmCommand(['run', 'setup:local', '--', appId]);
    const setup = await runProcess(npm.command, npm.args, {
      cwd: target,
      timeoutMs: 300_000,
      signal: options.signal,
      onLine: throttleLines(note),
    });
    if (setup.code !== 0) note(`   setup:local 没跑成功：${short((setup.stderr || setup.stdout || '').trim(), 400)}`);
  }

  return {
    ok: true,
    dir: target,
    repositoryUrl,
    text: `项目已就绪：${target}\n仓库：已克隆 sprint/default\n依赖：${deps}\n环境变量：${env.ok ? '已拉取 .env.local' : '未拉取（稍后手动 setup:local）'}`,
  };
}

/**
 * Export a repository snapshot zip (works for apps you only have download access to).
 * @param {{node:string, entry:string}} cli - launcher.
 * @param {{appId: string, dir: string, signal?: AbortSignal}} options
 * @returns {Promise<{ok: boolean, text: string}>}
 */
export async function pullExport(cli, options) {
  const output = `./miaoda-export-${options.appId}-${stamp()}.zip`;
  const result = await runLark(cli, ['apps', '+export', '--app-id', options.appId, '--output', output, '--as', 'user'], {
    cwd: options.dir,
    timeoutMs: 180_000,
    signal: options.signal,
  });
  if (!result.ok) {
    const extra = /40901|not published/.test(result.error ?? '') ? '（该 html 应用从未发布，先发布再导出）' : '';
    throw new MiaodaError(`导出失败：${result.error}${extra}`);
  }
  return { ok: true, text: `已导出源码快照：${path.join(options.dir, output)}\n注意：zip 没有 git 历史与凭证，不能直接推回；仅用于阅读/审计/别人的应用。` };
}

/**
 * Git refuses to commit without `user.name` / `user.email`, and a fresh Miaoda
 * clone has neither: the platform's own tooling never writes them, so a machine
 * without a global git identity cannot publish at all
 * (`Author identity unknown ... fatal: unable to auto-detect email address`).
 *
 * The plugin therefore derives an identity — from the git config when it exists,
 * otherwise from the signed-in Miaoda/Feishu user — and passes it with `-c`, so
 * nothing is written into the user's global config and repositories stay as they
 * were.
 * @param {{name?:string, email?:string, userName?:string, openId?:string}} input
 * @returns {string[]} argv prefix for `git` (`-c user.name=... -c user.email=...`).
 */
export function identityArgs(input = {}) {
  const pick = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
  const name = pick(input.name);
  const email = pick(input.email);
  if (name && email) return [];
  const openId = pick(input.openId).replace(/[^A-Za-z0-9]/g, '');
  const userName = pick(input.userName);
  const finalName = name || userName || 'Miaoda User';
  const finalEmail = email || (openId ? `${openId}@miaoda.local` : 'miaoda@miaoda.local');
  return ['-c', `user.name=${finalName}`, '-c', `user.email=${finalEmail}`];
}

/**
 * Resolve the identity git should commit with: configured -> signed-in user.
 * @param {{root:string}} project
 * @param {{node:string, entry:string}} cli
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{args: string[], name: string, email: string, source: string}>}
 */
async function commitIdentity(project, cli, options = {}) {
  const read = async (key) => {
    const out = await runGit(['config', '--get', key], { cwd: project.root, timeoutMs: 15_000 });
    return out.ok ? String(out.stdout ?? '').trim() : '';
  };
  const name = await read('user.name');
  const email = await read('user.email');
  if (name && email) return { args: [], name, email, source: 'git config' };
  let userName = '';
  let openId = '';
  try {
    const status = await runLark(cli, ['auth', 'status', '--json'], { timeoutMs: 30_000, signal: options.signal });
    const user = isRecord(status?.data?.identities?.user) ? status.data.identities.user : null;
    userName = user && typeof user.userName === 'string' ? user.userName : '';
    openId = user && typeof user.openId === 'string' ? user.openId : '';
  } catch {
    /* not signed in: fall back to a neutral identity */
  }
  const args = identityArgs({ name, email, userName, openId });
  const finalName = args.length ? args[1].slice('user.name='.length) : name;
  const finalEmail = args.length ? args[3].slice('user.email='.length) : email;
  return { args, name: finalName, email: finalEmail, source: args.length ? '妙搭登录身份' : 'git config' };
}

/**
 * Publish: commit → push → release-create → poll to a terminal state.
 * @param {{root:string, appId:string}} project - resolved project.
 * @param {{node:string, entry:string}} cli - launcher.
 * @param {{reason?: string, message?: string, commit?: boolean, push?: boolean, poll?: boolean, signal?: AbortSignal}} options
 * @returns {Promise<{ok: boolean, text: string}>}
 */
export async function publish(project, cli, options = {}) {
  const info = await appInfo(cli, project.appId, options);
  const appType = info.appType ?? 'unknown';
  const git = await gitState(project.root);
  if (git.error) throw new MiaodaError(`git 状态异常：${git.error}`);
  if (git.branch !== 'sprint/default') {
    throw new MiaodaError(
      `当前分支是 ${git.branch}，不是工作分支 sprint/default`,
      '妙搭只允许发布 sprint/default：git checkout sprint/default（或 git switch -c sprint/default）后重试',
    );
  }
  const steps = [];
  if (git.dirty) {
    if (options.commit === false) {
      return { ok: false, text: `工作区有未提交改动且 commit=false，发布只认已提交并 push 的代码：\n${git.dirtyFiles.slice(0, 20).join('\n')}` };
    }
    const selected = Array.isArray(options.files) && options.files.length > 0 ? options.files : null;
    const risk = riskyChanges(selected ?? git.dirtyFiles);
    if (options.force !== true && (risk.secrets.length > 0 || risk.resources.length > 0)) {
      const lines = [];
      if (risk.secrets.length > 0) {
        lines.push(`会把密钥类文件提交上去：\n  ${risk.secrets.slice(0, 10).join('\n  ')}`);
        lines.push('这些文件里是环境变量/私钥，提交后会进入远端仓库历史。');
        lines.push('正确做法：让 .gitignore 忽略它（`.env.local` 必须被忽略），再把需要的变量用 miaoda_env 管理。');
      }
      if (risk.resources.length > 0) {
        lines.push(`会把资源文件提交上去：\n  ${risk.resources.slice(0, 10).join('\n  ')}`);
        lines.push('妙搭的图片/字体/音视频应该走 `lark-cli apps +file-upload` 拿远端 URL，而不是进 git（仓库体积和加载都会变差）。');
      }
      return { ok: false, text: `没有提交，先处理这些改动：\n\n${lines.join('\n\n')}\n\n确认无误要强行发布时，再带 force=true 调用一次。` };
    }
    const message = options.message?.trim() || `chore: update via dsh-miaoda ${stamp()}`;
    const add = selected
      ? await stagePaths(project.root, selected, { signal: options.signal })
      : await runGit(['add', '-A'], { cwd: project.root, signal: options.signal });
    if (!add.ok) throw new MiaodaError(`git add 失败：${add.error}`);
    const identity = await commitIdentity(project, cli, options);
    const commit = await runGit([...identity.args, 'commit', '-m', message], {
      cwd: project.root,
      signal: options.signal,
    });
    if (!commit.ok) {
      const raw = String(commit.error ?? '');
      if (/Author identity unknown|unable to auto-detect email/i.test(raw)) {
        throw new MiaodaError(
          'git commit 失败：这台机器没有配置 git 提交身份',
          '设置一次即可：git config --global user.name "你的名字" && git config --global user.email "you@example.com"',
        );
      }
      throw new MiaodaError(`git commit 失败：${raw}`);
    }
    steps.push(
      `commit: ${message}` + (identity.args.length ? `（提交身份：${identity.name} <${identity.email}>，来自${identity.source}）` : ''),
    );
  } else {
    steps.push('commit: 工作区干净，跳过');
  }
  if (options.push !== false) {
    let push = await runGit(['push', 'origin', 'sprint/default'], { cwd: project.root, signal: options.signal });
    if (!push.ok && isAuthFailure(push.error)) {
      await refreshGitCredential(cli, project.appId, options);
      push = await runGit(['push', 'origin', 'sprint/default'], { cwd: project.root, signal: options.signal });
    }
    if (!push.ok) throw new MiaodaError(`git push 失败：${short(push.error ?? '')}`, '若是凭证问题，先 lark-cli apps +git-credential-init 再重试');
    steps.push('push: sprint/default 已同步到远端');
  }
  const html = appType === 'html';
  const reason = options.reason?.trim();
  if (!html && !reason) {
    return {
      ok: false,
      text: `代码已 push，但还没发布。\n${appType} 类型应用的发布必须带发布理由（apply-reason）。\n请用一句话说明这次改动，然后重跑：miaoda_publish reason="..."`,
    };
  }
  const argv = ['apps', '+release-create', '--app-id', project.appId, '--branch', 'sprint/default', '--as', 'user'];
  if (!html && reason) argv.push('--apply-reason', reason);
  const created = await runLark(cli, argv, { timeoutMs: 300_000, signal: options.signal });
  if (!created.ok) {
    const blocked = /feature_not_available|approval/.test(created.error ?? '');
    throw new MiaodaError(
      `创建发布失败：${created.error}`,
      blocked ? '该应用启用了发布审批，普通发布接口被拦；请在妙搭页面发起发布' : undefined,
    );
  }
  const releaseId = findScalar(created.data, ['release_id', 'releaseId']);
  steps.push(`release-create: ${releaseId ?? '(no release_id)'}`);
  if (!releaseId) {
    return { ok: false, text: `发布已发起，但响应里没有 release_id，无法跟踪状态。原始输出：\n${short(created.text, 800)}` };
  }
  if (options.poll === false) {
    return { ok: true, text: `发布已发起，未轮询。\n${steps.join('\n')}\n用 miaoda_publish 之外的 miaoda_lark 查询：apps +release-get --app-id ${project.appId} --release-id ${releaseId}` };
  }
  const polled = await pollRelease(cli, project.appId, releaseId, options);
  return { ok: polled.state === 'finished', text: `${steps.join('\n')}\n${polled.text}` };
}

/**
 * Poll `+release-get` to a terminal state, stopping on an approval gate.
 *
 * The documented cadence is one query every 20s for at most ~5 minutes; a
 * PENDING node means a human approver is involved, so polling stops instead of
 * faking progress or auto-approving.
 * @param {{node:string, entry:string}} cli - launcher.
 * @param {string} appId - app id.
 * @param {string} releaseId - release id.
 * @param {{signal?: AbortSignal, intervalMs?: number, maxWaitMs?: number}} [options]
 * @returns {Promise<{state: 'finished'|'failed'|'pending'|'timeout'|'unknown', text: string}>}
 */
export async function pollRelease(cli, appId, releaseId, options = {}) {
  const interval = options.intervalMs ?? 20_000;
  const deadline = Date.now() + (options.maxWaitMs ?? 300_000);
  let lastStatus = 'unknown';
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const result = await runLark(cli, ['apps', '+release-get', '--app-id', appId, '--release-id', releaseId, '--as', 'user'], {
      timeoutMs: 60_000,
      signal: options.signal,
    });
    if (!result.ok) {
      lastStatus = `query-failed: ${result.error}`;
      continue;
    }
    const status = (findScalar(result.data, ['status']) ?? 'unknown').toLowerCase();
    lastStatus = status;
    const nodeStatus = findScalar(result.data, ['current_status', 'currentStatus']);
    if (status === 'finished') {
      const url = findScalar(result.data, ['online_url', 'onlineUrl']);
      return { state: 'finished', text: `发布成功。release: ${releaseId}${url ? `\n线上地址: ${url}` : ''}` };
    }
    if (status === 'failed') {
      const logs = findScalar(result.data, ['error_log', 'error_logs', 'errorLog', 'message']);
      return { state: 'failed', text: `发布失败。release: ${releaseId}\n${logs ? `原因: ${short(logs, 800)}` : '未返回错误详情'}` };
    }
    if (nodeStatus && String(nodeStatus).toUpperCase() === 'PENDING') {
      return {
        state: 'pending',
        text: `发布在等待审批（current_node_info.current_status=PENDING），已停止轮询。\nrelease: ${releaseId}\n需要应用审批负责人在妙搭页面处理；处理完后再查：miaoda_lark apps +release-get --app-id ${appId} --release-id ${releaseId}`,
      };
    }
    if (status === 'pending') {
      return {
        state: 'pending',
        text: `发布状态停在 pending 且没有明确的 PENDING 节点，按规则原样报告不自动处理。\nrelease: ${releaseId} status: pending`,
      };
    }
  }
  return { state: 'timeout', text: `轮询超时（约 5 分钟），最后一次状态：${lastStatus}。\nrelease: ${releaseId}\n可稍后用 miaoda_lark 再查，不要重复新建 release。` };
}

/**
 * Pull dev environment variables into `.env.local`.
 * @param {{root:string, appId:string}} project - resolved project.
 * @param {{node:string, entry:string}} cli - launcher.
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{ok: boolean, text: string}>}
 */
export async function envPull(project, cli, options = {}) {
  const result = await runLark(cli, ['apps', '+env-pull', '--app-id', project.appId, '--as', 'user'], {
    cwd: project.root,
    timeoutMs: 90_000,
    signal: options.signal,
  });
  if (!result.ok) throw new MiaodaError(`拉取环境变量失败：${result.error}`);
  return { ok: true, text: `已把 dev 环境变量合并写入 ${path.join(project.root, '.env.local')}（保留本地手写行与注释，不回显值）。` };
}

/**
 * List dev environment variable keys.
 * @param {{root:string, appId:string}} project - resolved project.
 * @param {{node:string, entry:string}} cli - launcher.
 * @param {{environment?: string, signal?: AbortSignal}} [options]
 * @returns {Promise<{ok: boolean, text: string}>}
 */
export async function envList(project, cli, options = {}) {
  const environment = options.environment === 'online' ? 'online' : 'dev';
  const result = await runLark(cli, ['apps', '+env-list', '--app-id', project.appId, '--environment', environment, '--as', 'user'], {
    cwd: project.root,
    timeoutMs: 60_000,
    signal: options.signal,
  });
  if (!result.ok) throw new MiaodaError(`查询环境变量失败：${result.error}`);
  const keys = collectKeys(result.data);
  return {
    ok: true,
    text: keys.length > 0
      ? `${environment} 环境变量 ${keys.length} 个：\n${keys.map((key) => `- ${key}`).join('\n')}`
      : `${environment} 环境变量为空（或该应用类型不支持 env）。`,
  };
}

/**
 * Collect `key`-ish fields from a nested lark-cli payload.
 * @param {unknown} node - payload.
 * @returns {string[]}
 */
function collectKeys(node) {
  /** @type {Set<string>} */
  const keys = new Set();
  const walk = (value, depth) => {
    if (depth > 4 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') keys.add(item);
        else if (isRecord(item) && typeof item.key === 'string') keys.add(item.key);
        else walk(item, depth + 1);
      }
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'key' && typeof entry === 'string') keys.add(entry);
      else if (Array.isArray(entry) && key.endsWith('s')) walk(entry, depth + 1);
      else if (isRecord(entry)) walk(entry, depth + 1);
    }
  };
  walk(node, 0);
  return [...keys].sort();
}

/**
 * One health-check pass over environment, auth, project, dev server and release.
 * @param {{project?: string}} args - tool arguments.
 * @param {Record<string, any>} config - plugin config.
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{ok: boolean, text: string, data: Record<string, unknown>}>}
 */
export async function statusReport(args, config, options = {}) {
  /** @type {string[]} */
  const sections = [];
  /** @type {Record<string, unknown>} */
  const data = {};
  let cli;
  try {
    cli = requireLark(config);
    data.larkCli = cli.entry;
    sections.push(`lark-cli: ${cli.entry}`);
  } catch (error) {
    sections.push(`lark-cli: 未找到 — ${error instanceof Error ? error.message : String(error)}`);
    sections.push('安装：npm install -g @larksuite/cli');
  }
  let authLine = 'auth: 未检查';
  if (cli) {
    const auth = await runLark(cli, ['auth', 'status'], { timeoutMs: 45_000, signal: options.signal });
    if (auth.ok) {
      const identity = findScalar(auth.data, ['identity']);
      const userMissing = /missing/i.test(auth.text) && /user/i.test(auth.text);
      const name = findScalar(auth.data, ['user_name', 'userName', 'name']);
      authLine = userMissing
        ? `auth: ⚠ 只有 bot 身份，user 身份缺失（${name ?? 'unknown'}）→ 所有 --as user 的业务命令会失败`
        : `auth: ok${identity ? ` (${identity})` : ''}${name ? ` ${name}` : ''}`;
      data.auth = { userMissing, identity, name };
    } else {
      authLine = `auth: 查询失败 — ${auth.error}`;
    }
    sections.push(authLine);
  }
  /** @type {{root: string, appId: string}|undefined} */
  let project;
  try {
    project = locateProject(args, config);
    const git = await gitState(project.root);
    const info = cli ? await appInfo(cli, project.appId, options).catch((error) => ({ appType: undefined, name: undefined, error: String(error) })) : undefined;
    data.project = { root: project.root, appId: project.appId, ...git, appType: info?.appType, name: info?.name };
    sections.push(
      [
        `项目: ${project.root}`,
        `app_id: ${project.appId}${info?.appType ? ` (${info.appType})` : ''}${info?.name ? ` "${info.name}"` : ''}`,
        `分支: ${git.branch}  HEAD: ${git.head}`,
        `工作区: ${git.dirty ? `${git.dirtyFiles.length} 个未提交改动` : '干净'}${git.ahead !== undefined ? `, 领先上游 ${git.ahead}` : ''}${git.behind ? `, 落后上游 ${git.behind}` : ''}`,
      ].join('\n'),
    );
  } catch (error) {
    sections.push(`项目: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof MiaodaError && error.hint) sections.push(`  → ${error.hint}`);
  }
  if (project) {
    const server = dev.status(project.root);
    data.devServer = server;
    sections.push(server
      ? `本地服务: 运行中 pid=${server.pid} ${server.url ?? '(未识别端口)'} 启动于 ${server.startedAt}`
      : '本地服务: 未启动（用 miaoda_dev action=start）');
  }
  if (cli && project && data.auth && !data.auth.userMissing) {
    const list = await runLark(cli, ['apps', '+release-list', '--app-id', project.appId, '--page-size', '1', '--as', 'user'], {
      timeoutMs: 60_000,
      signal: options.signal,
    });
    if (list.ok) {
      const releaseId = findScalar(list.data, ['release_id', 'releaseId']);
      const releaseStatus = findScalar(list.data, ['status']);
      const releaseCommit = findScalar(list.data, ['commit_id', 'commitId']);
      data.lastRelease = { releaseId, releaseStatus, releaseCommit };
      sections.push(`最近发布: ${releaseId ?? '(无)'} status=${releaseStatus ?? '?'}${releaseCommit ? ` commit=${releaseCommit.slice(0, 7)}` : ''}`);
      const head = data.project?.head;
      if (releaseCommit && head && typeof head === 'string' && releaseCommit.slice(0, 7) !== head.slice(0, 7)) {
        sections.push(`  → 线上版本(${releaseCommit.slice(0, 7)}) 与本地 HEAD(${head}) 不一致：本地有新改动未发布，或线上有别人发布的版本`);
      }
    } else {
      sections.push(`最近发布: 查询失败 — ${list.error}`);
    }
  }
  return { ok: true, data, text: sections.join('\n\n') };
}

/**
 * List the user's Miaoda apps.
 * @param {{node:string, entry:string}} cli - launcher.
 * @param {{keyword?: string, ownership?: string, appType?: string, pageToken?: string, signal?: AbortSignal}} options
 * @returns {Promise<{ok: boolean, text: string, apps: unknown[]}>}
 */
export async function listApps(cli, options = {}) {
  const argv = ['apps', '+list', '--as', 'user'];
  if (options.keyword) argv.push('--keyword', options.keyword);
  if (options.ownership) argv.push('--ownership', options.ownership);
  if (options.appType) argv.push('--app-type', options.appType);
  if (options.pageToken) argv.push('--page-token', options.pageToken);
  const result = await runLark(cli, argv, { timeoutMs: 60_000, signal: options.signal });
  if (!result.ok) {
    throw new MiaodaError(`查询应用列表失败：${result.error}`, '需要 user 身份：lark-cli auth login --as user');
  }
  const apps = collectApps(result.data);
  const nextToken = findScalar(result.data, ['page_token', 'pageToken', 'next_page_token']);
  const lines = apps.map((app) => {
    const id = app.app_id ?? app.appId ?? '(no id)';
    const type = app.app_type ?? app.appType ?? '';
    const name = app.name ?? app.app_name ?? '';
    return `- ${name} | ${id} | ${type}`;
  });
  return {
    ok: true,
    apps,
    text: apps.length > 0
      ? `找到 ${apps.length} 个应用：\n${lines.join('\n')}${nextToken ? `\n还有更多，用 page_token="${nextToken}" 继续` : ''}`
      : '没有匹配的应用。',
  };
}

/**
 * Extract app objects from a `+list` payload without assuming a fixed nesting.
 * @param {unknown} payload - decoded envelope.
 * @returns {Record<string, any>[]}
 */
function collectApps(payload) {
  /** @type {Record<string, any>[]} */
  const apps = [];
  const walk = (value, depth) => {
    if (depth > 5 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isRecord(item) && (typeof item.app_id === 'string' || typeof item.appId === 'string')) apps.push(item);
        else walk(item, depth + 1);
      }
      return;
    }
    if (!isRecord(value)) return;
    for (const entry of Object.values(value)) walk(entry, depth + 1);
  };
  walk(payload, 0);
  return apps;
}

export { describeLarkError, runLark, stamp };
