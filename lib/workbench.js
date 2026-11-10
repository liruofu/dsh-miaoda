/**
 * Sidebar workbench — the host half of the three-step panel:
 *
 *   1. 扫码登录       auth login (device flow) + auth qrcode
 *   2. 输入 appId     apps +init → 项目落到本地
 *   3. 一键发布       commit → push → release-create → poll
 *
 * Like the preview bridge this is one exact route on the GUI origin:
 *
 *   GET  /plugins/dsh-miaoda/workbench            → snapshot
 *   GET  /plugins/dsh-miaoda/workbench/qr.png     → login QR image
 *   POST /plugins/dsh-miaoda/workbench  { action } → start an operation
 *
 * Import and publish take minutes, so they run as a single background task and
 * the panel polls the snapshot instead of holding an HTTP request open.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as dev from './devserver.js';
import { collectChanges, diffRows, filePatch } from './changes.js';
import {
  MiaodaError,
  appInfo,
  gitState,
  pullStaged,
  publish,
} from './ops.js';
import { dshHome, errorMessage, nodeEnv, noteSpawn, readProjectMeta, resolveLarkCli, runLark, scanProjects } from './runtime.js';
import { bytes, json, readJsonBody, sameOrigin } from './http.js';

export const WORKBENCH_ROUTE = '/plugins/dsh-miaoda/workbench';
export const WORKBENCH_QR_ROUTE = '/plugins/dsh-miaoda/workbench/qr.png';

const LOGIN_TIMEOUT_MS = 600_000;
const AUTH_CACHE_MS = 45_000;
const GIT_CACHE_MS = 30_000;
const APP_CACHE_MS = 120_000;
const TASK_LINE_LIMIT = 200;

const STATE_FILE = path.join(dshHome(), 'miaoda-workbench.json');

/**
 * Everything the panel needs that is not derived on the fly.
 * @returns {{projectRoot: string|null, baseDir: string|null, recent: string[]}}
 */
function loadPersisted() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      projectRoot: typeof raw?.projectRoot === 'string' ? raw.projectRoot : null,
      baseDir: typeof raw?.baseDir === 'string' ? raw.baseDir : null,
      recent: Array.isArray(raw?.recent) ? raw.recent.filter((item) => typeof item === 'string') : [],
    };
  } catch {
    return { projectRoot: null, baseDir: null, recent: [] };
  }
}

const persisted = loadPersisted();

const wb = {
  projectRoot: persisted.projectRoot,
  baseDir: persisted.baseDir,
  recent: persisted.recent,
  login: {
    status: 'idle',
    deviceCode: null,
    verificationUrl: null,
    qrFile: null,
    qrError: null,
    startedAt: 0,
    expiresAt: 0,
    error: null,
    child: null,
    timer: null,
  },
  task: {
    id: null,
    kind: null,
    status: 'idle',
    startedAt: 0,
    finishedAt: 0,
    lines: [],
    text: '',
    error: null,
  },
};

const cache = {
  auth: { at: 0, value: null, inFlight: null },
  git: { at: 0, root: null, value: null },
  app: { at: 0, appId: null, value: null },
  changes: { at: 0, root: null, value: null },
};

function savePersisted() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ projectRoot: wb.projectRoot, baseDir: wb.baseDir, recent: wb.recent }, null, 2),
    );
  } catch {
    /* a lost preference is not worth breaking the panel */
  }
}

/**
 * Where pulled projects land by default: `~/miaoda`, or `~/Desktop/miaoda`
 * when the user keeps code on the desktop.
 * @returns {string}
 */
export function defaultBaseDir() {
  const candidates = [
    path.join(os.homedir(), 'miaoda'),
    path.join(os.homedir(), 'Desktop', 'miaoda'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* try the next one */
    }
  }
  return path.join(os.homedir(), 'miaoda');
}

const WORKSPACE_CACHE_MS = 30_000;
let workspaceCache = { at: 0, value: [] };

/**
 * The web client keeps its workspaces in the desktop store. Pulling the list
 * lets a pulled project land next to the code the user is already looking at.
 * @returns {Array<{id: string, dir: string, title: string, sessionIds: string[], updatedAt: string}>}
 */
function listWorkspaces() {
  if (workspaceCache.value.length > 0 && Date.now() - workspaceCache.at < WORKSPACE_CACHE_MS) {
    return workspaceCache.value;
  }
  let value = [];
  try {
    const file = path.join(dshHome(), 'storages', 'workspace.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const table = raw?.tables?.workspaces ?? {};
    value = Object.entries(table)
      .map(([id, entry]) => ({
        id,
        dir: typeof entry?.path === 'string' ? entry.path : null,
        title: typeof entry?.title === 'string' ? entry.title : '',
        sessionIds: Array.isArray(entry?.sessionIds) ? entry.sessionIds.filter((s) => typeof s === 'string') : [],
        updatedAt: typeof entry?.updatedAt === 'string' ? entry.updatedAt : '',
      }))
      .filter((entry) => typeof entry.dir === 'string' && entry.dir.length > 0);
  } catch {
    value = [];
  }
  workspaceCache = { at: Date.now(), value };
  return value;
}

/**
 * Session directory mtimes: the freshest session is usually the one on screen.
 * @returns {Map<string, number>}
 */
function sessionTouchedAt() {
  const touched = new Map();
  const dir = path.join(dshHome(), 'sessions');
  let parents;
  try {
    parents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return touched;
  }
  for (const parent of parents) {
    if (!parent.isDirectory()) continue;
    let children;
    try {
      children = fs.readdirSync(path.join(dir, parent.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory() || !child.name.startsWith('session-')) continue;
      try {
        touched.set(child.name.slice('session-'.length), fs.statSync(path.join(dir, parent.name, child.name)).mtimeMs);
      } catch {
        /* a disappearing session is not an error here */
      }
    }
  }
  return touched;
}

/**
 * @returns {{id: string, dir: string, title: string} | null}
 */
function activeWorkspace() {
  const workspaces = listWorkspaces();
  if (workspaces.length === 0) return null;
  const touched = sessionTouchedAt();
  let best = null;
  let bestAt = -1;
  for (const workspace of workspaces) {
    let at = 0;
    for (const id of workspace.sessionIds) {
      const seen = touched.get(id);
      if (typeof seen === 'number' && seen > at) at = seen;
    }
    if (at === 0) at = Date.parse(workspace.updatedAt) || 0;
    if (at > bestAt) {
      bestAt = at;
      best = workspace;
    }
  }
  return best;
}

function safeCwd() {
  try {
    const cwd = process.cwd();
    return cwd && fs.statSync(cwd).isDirectory() ? cwd : null;
  } catch {
    return null;
  }
}

/**
 * Folders the panel offers as one-click destinations: every known workspace
 * plus the directory DSH was opened in.
 * @param {string} current
 * @returns {Array<{dir: string, title: string, current: boolean}>}
 */
function workspaceChoices(current) {
  const choices = [];
  const seen = new Set();
  const push = (dir, title) => {
    if (typeof dir !== 'string' || dir.length === 0) return;
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
    if (seen.has(key)) return;
    seen.add(key);
    choices.push({ dir, title: title || path.basename(dir), current: samePath(dir, current) });
  };
  const cwd = safeCwd();
  if (cwd && !isInstallDir(cwd)) push(cwd, '');
  for (const workspace of listWorkspaces()) push(workspace.dir, workspace.title);
  return choices.slice(0, 8);
}

function isInstallDir(dir) {
  return /program files|programdata|appdata[\\/]local[\\/]programs|^[a-z]:[\\/]?windows([\\/]|$)/i.test(dir);
}

/**
 * Where new projects land, in order of preference:
 *   1. whatever the panel saved,
 *   2. the directory this DSH process was opened in (the session workspace),
 *   3. the workspace the web client reports as active,
 *   4. `~/miaoda` (or `~/Desktop/miaoda`).
 * @returns {{dir: string, source: 'custom'|'workspace'|'cwd'|'fallback', title: string}}
 */
export function resolveBaseDir() {
  if (typeof wb.baseDir === 'string' && wb.baseDir.length > 0) {
    return { dir: wb.baseDir, source: 'custom', title: '' };
  }
  const workspaces = listWorkspaces();
  const cwd = safeCwd();
  if (cwd && !isInstallDir(cwd)) {
    const match = workspaces.find((workspace) => samePath(workspace.dir, cwd));
    return { dir: cwd, source: 'workspace', title: match?.title ?? '' };
  }
  const active = activeWorkspace();
  if (active) return { dir: active.dir, source: 'workspace', title: active.title };
  return { dir: defaultBaseDir(), source: 'fallback', title: '' };
}

function baseDir() {
  return resolveBaseDir().dir;
}

/**
 * Persist the destination chosen in the panel. An empty value restores the
 * automatic workspace default.
 * @param {unknown} dir
 * @returns {{dir: string, source: string, title: string}}
 */
export function setBaseDir(dir) {
  const value = typeof dir === 'string' ? dir.trim() : '';
  if (value.length === 0) {
    wb.baseDir = null;
  } else {
    if (!path.isAbsolute(value)) {
      throw new MiaodaError('保存位置需要是绝对路径', '例如 C:\\Users\\me\\Desktop\\我的项目');
    }
    wb.baseDir = value;
  }
  savePersisted();
  return resolveBaseDir();
}

function targetDirFor(appId) {
  return path.join(baseDir(), appId);
}

function qrDir() {
  // lark-cli only writes inside cwd, /tmp and ~/files.
  const dir = path.join(os.homedir(), 'files');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* the CLI will report the failure itself */
  }
  return dir;
}

function clearCaches() {
  cache.auth.at = 0;
  cache.git.at = 0;
  cache.app.at = 0;
}

/**
 * @param {Record<string, any>} result - result of `auth status`.
 * @returns {Record<string, unknown>}
 */
function interpretAuth(result) {
  if (!result?.ok || !result.data || typeof result.data !== 'object') {
    return {
      available: false,
      userName: null,
      appId: null,
      tokenStatus: null,
      expiresAt: null,
      error: String(result?.error ?? 'unavailable'),
    };
  }
  const data = result.data;
  const user = data.identities?.user ?? {};
  return {
    available: user.status === 'ready' && user.available === true,
    userName: typeof user.userName === 'string' ? user.userName : null,
    appId: typeof data.appId === 'string' ? data.appId : null,
    tokenStatus: typeof user.tokenStatus === 'string' ? user.tokenStatus : null,
    expiresAt: typeof user.expiresAt === 'string' ? user.expiresAt : null,
    error: null,
  };
}

/**
 * Current login state, memoized for a few seconds because the panel polls.
 * @param {{node:string, entry:string}} cli - launcher.
 * @param {boolean} [force]
 * @returns {Promise<Record<string, unknown>>}
 */
async function authStatus(cli, force = false) {
  const now = Date.now();
  if (!force && cache.auth.value && now - cache.auth.at < AUTH_CACHE_MS) return cache.auth.value;
  if (cache.auth.inFlight) return cache.auth.inFlight;
  cache.auth.inFlight = (async () => {
    const result = await runLark(cli, ['auth', 'status', '--json'], { timeoutMs: 45_000 });
    const value = interpretAuth(result);
    cache.auth = { at: Date.now(), value, inFlight: null };
    return value;
  })();
  try {
    return await cache.auth.inFlight;
  } catch (error) {
    cache.auth.inFlight = null;
    throw error;
  }
}

async function gitFor(root) {
  const now = Date.now();
  if (cache.git.root === root && now - cache.git.at < GIT_CACHE_MS) return cache.git.value;
  const value = await gitState(root);
  cache.git = { at: now, root, value };
  return value;
}

async function appFor(cli, appId) {
  const now = Date.now();
  if (cache.app.appId === appId && now - cache.app.at < APP_CACHE_MS) return cache.app.value;
  let value = null;
  try {
    const info = await appInfo(cli, appId);
    value = { name: info.name ?? null, appType: info.appType ?? null };
  } catch (error) {
    value = { name: null, appType: null, error: error instanceof Error ? error.message : String(error) };
  }
  cache.app = { at: now, appId, value };
  return value;
}

/**
 * The project the workbench is currently pointed at.
 * @returns {{root: string, appId: string|null, name: string}|undefined}
 */
/**
 * Keep the projects a user actually opened at the top of the picker, even when
 * they live outside the current workspace root.
 * @param {string} root
 */
function rememberProject(root) {
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  wb.recent = [root, ...wb.recent.filter((item) => (process.platform === 'win32' ? item.toLowerCase() : item) !== key)].slice(0, 8);
  savePersisted();
}

export function currentProject() {
  const root = wb.projectRoot;
  if (typeof root !== 'string' || root === '') return undefined;
  if (!fs.existsSync(root)) return undefined;
  const meta = readProjectMeta(root);
  return { root, appId: meta?.appId ?? null, name: path.basename(root) };
}

function taskView() {
  return {
    id: wb.task.id,
    kind: wb.task.kind,
    status: wb.task.status,
    startedAt: wb.task.startedAt,
    finishedAt: wb.task.finishedAt,
    lines: wb.task.lines.slice(-40),
    text: wb.task.text,
    error: wb.task.error,
  };
}

/**
 * Run one long operation at a time; the panel polls `task` for progress.
 * @param {'import'|'publish'} kind - task kind.
 * @param {(note: (line: string) => void) => Promise<{text?: string}>} runner - body.
 * @returns {{ok: boolean, error?: string, id?: string}}
 */
function startTask(kind, runner) {
  if (wb.task.status === 'running') return { ok: false, error: 'busy' };
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  wb.task = { id, kind, status: 'running', startedAt: Date.now(), finishedAt: 0, lines: [], text: '', error: null };
  const note = (line) => {
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    wb.task.lines.push(`${stamp}  ${line}`);
    if (wb.task.lines.length > TASK_LINE_LIMIT) wb.task.lines.shift();
  };
  Promise.resolve()
    .then(() => runner(note))
    .then((result) => {
      wb.task.status = 'done';
      wb.task.finishedAt = Date.now();
      wb.task.text = typeof result?.text === 'string' ? result.text : '';
      note('完成');
      clearCaches();
    })
    .catch((error) => {
      wb.task.status = 'error';
      wb.task.finishedAt = Date.now();
      wb.task.error = error instanceof Error ? error.message : String(error);
      clearCaches();
    });
  return { ok: true, id };
}

function cancelLogin(reason) {
  const login = wb.login;
  if (login.child) {
    try {
      login.child.kill();
    } catch {
      /* already gone */
    }
    login.child = null;
  }
  if (login.timer) {
    clearTimeout(login.timer);
    login.timer = null;
  }
  if (login.status === 'pending') {
    login.status = 'idle';
    login.error = reason ?? null;
  }
}

function finishLogin(status, error) {
  if (wb.login.timer) {
    clearTimeout(wb.login.timer);
    wb.login.timer = null;
  }
  wb.login.status = status;
  wb.login.error = error ?? null;
  wb.login.deviceCode = null;
  clearCaches();
}

/**
 * Kick off the device flow: get a code, render it as a QR image, then wait for
 * the user in the background so the panel can keep polling.
 * @param {{node:string, entry:string}} cli - launcher.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function startLogin(cli) {
  cancelLogin('重新生成二维码');
  const result = await runLark(cli, ['auth', 'login', '--no-wait', '--json'], { timeoutMs: 90_000 });
  if (!result.ok) {
    throw new MiaodaError(`发起登录失败：${result.error}`, '确认 lark-cli 可用：lark-cli auth status');
  }
  const data = result.data ?? {};
  const deviceCode = typeof data.device_code === 'string' ? data.device_code : '';
  const verificationUrl = typeof data.verification_url === 'string' ? data.verification_url : '';
  if (!deviceCode || !verificationUrl) {
    throw new MiaodaError('登录响应缺少 device_code / verification_url', '升级 lark-cli：npm i -g @larksuite/cli');
  }
  const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) * 1000 : LOGIN_TIMEOUT_MS;
  const qrFile = path.join(qrDir(), 'dsh-miaoda-qr.png');
  const qr = await runLark(cli, ['auth', 'qrcode', verificationUrl, '--output', qrFile, '--size', '360'], {
    timeoutMs: 90_000,
  });
  const now = Date.now();
  wb.login = {
    status: 'pending',
    deviceCode,
    verificationUrl,
    qrFile: qr.ok ? qrFile : null,
    qrError: qr.ok ? null : String(qr.error ?? 'qrcode-failed'),
    startedAt: now,
    expiresAt: now + expiresIn,
    error: null,
    child: null,
    timer: null,
  };
  noteSpawn(cli.node, [cli.entry, 'auth', 'login', '--device-code']);
  const child = spawn(cli.node, [cli.entry, 'auth', 'login', '--device-code', deviceCode, '--json'], {
    windowsHide: true,
    // The host's execPath is the Electron binary; without this the child boots a
    // second GUI instance and a window flashes on screen every time.
    env: nodeEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += String(chunk);
    if (output.length > 8000) output = output.slice(-4000);
  });
  child.stderr?.on('data', (chunk) => {
    output += String(chunk);
    if (output.length > 8000) output = output.slice(-4000);
  });
  child.on('error', (error) => {
    if (wb.login.child !== child) return;
    wb.login.child = null;
    finishLogin('error', error.message);
  });
  child.on('exit', (code) => {
    if (wb.login.child !== child) return;
    wb.login.child = null;
    if (code === 0) {
      finishLogin('authorized', null);
      return;
    }
    const expired = /expire|expired|超时|timed? ?out/i.test(output);
    finishLogin(expired ? 'expired' : 'error', expired ? '二维码已过期，重新生成' : tail(output) || `exit ${code}`);
  });
  wb.login.child = child;
  wb.login.timer = setTimeout(() => {
    if (wb.login.status !== 'pending') return;
    cancelLogin();
    finishLogin('expired', '二维码已过期，重新生成');
  }, expiresIn + 5_000);
  wb.login.timer.unref?.();
  return {
    status: wb.login.status,
    verificationUrl,
    qr: wb.login.qrFile ? `${WORKBENCH_QR_ROUTE}?t=${wb.login.startedAt}` : null,
    qrError: wb.login.qrError,
    expiresAt: wb.login.expiresAt,
  };
}

function tail(text, limit = 400) {
  const trimmed = String(text ?? '').trim();
  return trimmed.length > limit ? trimmed.slice(-limit) : trimmed;
}

/**
 * `+init` into a fresh directory and remember it as the active project.
 * @param {{node:string, entry:string}} cli - launcher.
 * @param {{appId: string, dir?: string}} input - request.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function importProject(cli, input) {
  const appId = String(input.appId ?? '').trim();
  if (!/^app_[A-Za-z0-9]+$/.test(appId)) {
    throw new MiaodaError(`app_id 格式不对：${appId || '(空)'}`, 'app_id 形如 app_xxxxxxx，可从妙搭链接里复制');
  }
  const requestedBase =
    typeof input.baseDir === 'string' && input.baseDir.trim() !== '' ? path.resolve(input.baseDir.trim()) : null;
  const dir =
    typeof input.dir === 'string' && input.dir.trim() !== ''
      ? path.resolve(input.dir)
      : path.join(requestedBase ?? baseDir(), appId);
  if (fs.existsSync(dir)) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      /* unreadable counts as occupied */
      entries = ['?'];
    }
    if (entries.length > 0) {
      throw new MiaodaError(`目录已存在且非空：${dir}`, '换一个目录，或先清空该目录');
    }
  }
  const info = await appInfo(cli, appId);
  const result = await pullStaged(cli, {
    appId,
    dir,
    baseDir: requestedBase ?? undefined,
    onLine: typeof input.onLine === 'function' ? input.onLine : undefined,
  });
  if (requestedBase) wb.baseDir = requestedBase;
  wb.projectRoot = dir;
  rememberProject(dir);
  clearCaches();
  return {
    root: dir,
    appId,
    appName: info.name ?? null,
    appType: info.appType ?? null,
    text: result.text,
  };
}

/**
 * The snapshot the panel renders.
 *
 * `light` never starts a child process: it serves whatever was cached by the
 * last full snapshot. The panel polls with `light=1` so idle screens cannot
 * flash a console window, and asks for a full snapshot on mount, after every
 * action, and when the user hits refresh.
 * @param {{node:string, entry:string}} cli - launcher.
 * @param {string} version
 * @param {{light?: boolean}} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
async function snapshot(cli, version, options = {}) {
  const light = options.light === true;
  const auth = light
    ? cache.auth.value ??
      (wb.login.status === 'authorized'
        ? { available: true, userName: null, fromLogin: true }
        : { available: false, unknown: true, userName: null })
    : await authStatus(cli);
  const resolved = resolveBaseDir();
  const project = currentProject();
  const git = project
    ? light
      ? cache.git.root === project.root
        ? cache.git.value
        : null
      : await gitFor(project.root)
    : null;
  const app = project?.appId
    ? light
      ? cache.app.appId === project.appId
        ? cache.app.value
        : null
      : await appFor(cli, project.appId)
    : null;
  const servers = dev.list();
  const running = servers.find((server) => project && samePath(server.project, project.root)) ?? null;
  // The change list is the VSCode-style "what am I about to publish" view; it
  // is cheap (two git calls) but skipped in light polls to keep them snappy.
  // Light polls reuse the last full result, otherwise the panel would blink the
  // list away every four seconds.
  const changes = project
    ? light
      ? cache.changes.root === project.root
        ? cache.changes.value
        : null
      : await collectChanges(project.root)
    : null;
  if (project && !light) cache.changes = { at: Date.now(), root: project.root, value: changes };
  else if (!project) cache.changes = { at: Date.now(), root: null, value: null };
  return {
    ok: true,
    version,
    route: WORKBENCH_ROUTE,
    now: Date.now(),
    auth,
    login: {
      status: wb.login.status,
      verificationUrl: wb.login.verificationUrl,
      qr: wb.login.status === 'pending' && wb.login.qrFile ? `${WORKBENCH_QR_ROUTE}?t=${wb.login.startedAt}` : null,
      qrError: wb.login.qrError,
      expiresAt: wb.login.expiresAt,
      error: wb.login.error,
    },
    task: taskView(),
    project: project
      ? {
          root: project.root,
          name: project.name,
          appId: project.appId,
          app,
          git,
          dev: running ? { running: running.running, url: running.url, port: running.port, pid: running.pid } : null,
          hasDevScript: dev.hasDevScript(project.root),
        }
      : null,
    servers: servers.map((server) => ({
      name: server.name,
      project: server.project,
      running: server.running,
      url: server.url ?? null,
      port: server.port ?? null,
    })),
    changes,
    baseDir: resolved.dir,
    baseDirSource: resolved.source,
    baseDirTitle: resolved.title,
    workspaces: workspaceChoices(resolved.dir),
    candidateDirs: listCandidates(),
    locals: localProjects(project ? project.root : null),
  };
}

/**
 * Projects the user can open without typing an app id: recently opened ones
 * first, then whatever the workspace scan finds.
 * @param {string|null} currentRoot
 */
function localProjects(currentRoot) {
  const seen = new Set();
  const rows = [];
  const add = (root, source) => {
    if (!root || seen.has(process.platform === 'win32' ? root.toLowerCase() : root)) return;
    let meta;
    try {
      meta = readProjectMeta(root);
    } catch {
      return;
    }
    if (!meta) return;
    seen.add(process.platform === 'win32' ? root.toLowerCase() : root);
    let hasDev = false;
    try {
      hasDev = dev.hasDevScript(root);
    } catch {
      hasDev = false;
    }
    rows.push({
      root,
      name: path.basename(root),
      appId: meta.appId ?? null,
      hasDevScript: hasDev,
      current: Boolean(currentRoot) && samePath(root, currentRoot),
      source,
    });
  };
  for (const root of wb.recent) add(root, 'recent');
  for (const candidate of listCandidates()) add(candidate.root, 'scan');
  return rows.slice(0, 12);
}

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Freshly scanned projects under the base dir, as import alternatives.
 * @returns {Array<{root: string, name: string, appId: string|null}>}
 */
function listCandidates() {
  const dirs = [baseDir()];
  for (const workspace of listWorkspaces()) dirs.push(workspace.dir);
  const cwd = safeCwd();
  if (cwd) dirs.push(cwd);
  const seen = new Set();
  const roots = [];
  for (const dir of dirs) {
    let found = [];
    try {
      found = scanProjects(dir);
    } catch {
      found = [];
    }
    for (const root of found) {
      const key = process.platform === 'win32' ? root.toLowerCase() : root;
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push(root);
    }
  }
  return roots.slice(0, 12).map((root) => ({
    root,
    name: path.basename(root),
    appId: readProjectMeta(root)?.appId ?? null,
  }));
}

/**
 * Route handler.
 * @param {{config: Record<string, any>, version: string}} options - plugin context.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createWorkbenchHandler({ config, version }) {
  return async function handler(req, res) {
    try {
      if (!sameOrigin(req)) {
        json(res, 403, { ok: false, error: 'origin-rejected' });
        return;
      }
      const cli = resolveLarkCli(config?.larkCliEntry);
      if (!cli) {
        json(res, 500, { ok: false, error: 'lark-cli-not-found', version });
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const light = String(req.url ?? '').includes('light=1');
        json(res, 200, await snapshot(cli, version, { light }));
        return;
      }
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        json(res, 415, { ok: false, error: 'content-type-must-be-json' });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        json(res, 400, { ok: false, error: error instanceof Error ? error.message : 'invalid-body' });
        return;
      }
      const action = String(body.action ?? '');
      switch (action) {
        case 'login': {
          if (String(body.value ?? 'start') === 'cancel') {
            cancelLogin('已取消');
            json(res, 200, { ok: true, login: { status: wb.login.status } });
            return;
          }
          const login = await startLogin(cli);
          json(res, 200, { ok: true, login });
          return;
        }
        case 'logout': {
          cancelLogin('已退出登录');
          await runLark(cli, ['auth', 'logout', '--json'], { timeoutMs: 60_000 });
          clearCaches();
          json(res, 200, { ok: true });
          return;
        }
        case 'import': {
          const requestedBase = typeof body.baseDir === 'string' ? body.baseDir.trim() : '';
          const started = startTask('import', async (note) => {
            note(`拉取应用 ${String(body.appId ?? '')}`);
            const result = await importProject(cli, {
              appId: body.appId,
              dir: typeof body.dir === 'string' && body.dir.trim().length > 0 ? body.dir.trim() : undefined,
              baseDir: requestedBase.length > 0 ? requestedBase : undefined,
              onLine: note,
            });
            note(`已就绪：${result.root}`);
            if (result.appType === 'html') note('这是 html 类型应用：没有 dev server，改完直接发布');
            else {
              try {
                note('启动 dev server…（首次要同步平台工具链，可能要几分钟）');
                const launched = await dev.start(result.root, { waitMs: 6_000 });
                if (launched.url) note(`dev server 已就绪：${launched.url}`);
                else if (launched.running) note('dev server 启动中：地址一出现，面板底部会自动显示');
                else note('dev server 没起来，可在面板底部重试');
              } catch (error) {
                note(`dev server 启动失败：${errorMessage(error)}（可在面板底部重试）`);
              }
            }
            return { text: result.text };
          });
          json(res, 200, started);
          return;
        }
        case 'base': {
          let resolved;
          try {
            resolved = setBaseDir(body.dir);
          } catch (error) {
            json(res, 400, { ok: false, error: 'invalid-base-dir', message: errorMessage(error) });
            return;
          }
          json(res, 200, { ok: true, baseDir: resolved.dir, baseDirSource: resolved.source, baseDirTitle: resolved.title });
          return;
        }
        case 'changes': {
          const project = currentProject();
          if (!project) {
            json(res, 400, { ok: false, error: 'no-project' });
            return;
          }
          const changes = await collectChanges(project.root);
          json(res, 200, { ok: true, ...changes });
          return;
        }
        case 'diff': {
          const project = currentProject();
          if (!project) {
            json(res, 400, { ok: false, error: 'no-project' });
            return;
          }
          const target = typeof body.path === 'string' ? body.path : '';
          const patch = await filePatch(project.root, target);
          json(res, 200, { ok: true, ...patch, rows: diffRows(patch.patch) });
          return;
        }
        case 'publish': {
          const project = currentProject();
          if (!project) {
            json(res, 400, { ok: false, error: 'no-project' });
            return;
          }
          if (!project.appId) {
            json(res, 409, { ok: false, error: 'no-app-id', message: '项目缺少 .spark/meta.json 的 app_id' });
            return;
          }
          const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
          const force = body.force === true;
          const started = startTask('publish', async (note) => {
            note('检查工作区…');
            const git = await gitState(project.root);
            note(`分支 ${git.branch}，未提交 ${git.dirtyFiles.length} 个文件`);
            if (git.branch !== 'sprint/default') {
              throw new MiaodaError(`当前分支是 ${git.branch}，不是 sprint/default`, '妙搭只允许发布 sprint/default');
            }
            note('提交 → push → 创建发布 → 等待结果');
            const files = Array.isArray(body.files)
              ? body.files.filter((file) => typeof file === 'string' && file.trim() !== '')
              : undefined;
            const result = await publish({ root: project.root, appId: project.appId }, cli, {
              reason: reason || undefined,
              force,
              poll: true,
              files: files && files.length > 0 ? files : undefined,
            });
            if (!result.ok) throw new MiaodaError(result.text);
            return { text: result.text };
          });
          json(res, 200, started);
          return;
        }
        case 'dev': {
          const project = currentProject();
          if (!project) {
            json(res, 400, { ok: false, error: 'no-project' });
            return;
          }
          if (!dev.hasDevScript(project.root)) {
            json(res, 400, { ok: false, error: 'no-dev-script' });
            return;
          }
          if (String(body.value ?? 'start') === 'stop') {
            await dev.stop(project.root);
            json(res, 200, { ok: true, running: false });
            return;
          }
          const state = await dev.start(project.root, { waitMs: 15_000 });
          json(res, 200, { ok: true, running: state.running, url: state.url ?? null, port: state.port ?? null });
          return;
        }
        case 'select': {
          const root = path.resolve(String(body.root ?? ''));
          if (!fs.existsSync(root)) {
            json(res, 400, { ok: false, error: 'missing-directory', root });
            return;
          }
          if (!readProjectMeta(root)) {
            json(res, 400, { ok: false, error: 'not-a-miaoda-project', root });
            return;
          }
          wb.projectRoot = root;
          rememberProject(root);
          clearCaches();
          json(res, 200, { ok: true, root });
          return;
        }
        default:
          json(res, 400, { ok: false, error: 'unsupported-action', action });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = error instanceof MiaodaError ? error.hint : undefined;
      json(res, 500, { ok: false, error: 'internal', message, hint });
    }
  };
}

/**
 * Tear down the background login waiter when the plugin unloads.
 * @returns {void}
 */
export function shutdown() {
  cancelLogin('插件已重载');
  if (wb.task.status === 'running') {
    wb.task.status = 'error';
    wb.task.error = '插件已重载，任务中断';
  }
}

/**
 * Serve the QR image generated for the pending login.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createQrHandler() {
  return function handler(req, res) {
    if (!sameOrigin(req)) {
      json(res, 403, { ok: false, error: 'origin-rejected' });
      return;
    }
    const file = wb.login.qrFile;
    if (!file || !fs.existsSync(file)) {
      json(res, 404, { ok: false, error: 'no-qr' });
      return;
    }
    try {
      bytes(res, 200, 'image/png', fs.readFileSync(file));
    } catch (error) {
      json(res, 500, { ok: false, error: 'qr-read-failed', message: error instanceof Error ? error.message : String(error) });
    }
  };
}

/**
 * Register both routes on the harness web server.
 * @param {{inject: Function}} root - plugin context.
 * @param {Record<string, any>} config - plugin config.
 * @param {string} version - plugin version.
 * @returns {void}
 */
export function registerWorkbenchRoutes(root, config, version) {
  root.inject(['webServer'], (ctx) => {
    const webServer = ctx?.webServer;
    if (!webServer?.register) return;
    const handler = createWorkbenchHandler({ config, version });
    ctx.effect(
      () => webServer.register({ kind: 'exact', path: WORKBENCH_ROUTE, handler }),
      'dsh-miaoda: workbench route',
    );
    ctx.effect(
      () => webServer.register({ kind: 'exact', path: WORKBENCH_QR_ROUTE, handler: createQrHandler() }),
      'dsh-miaoda: workbench qr route',
    );
    ctx.effect(() => () => shutdown(), 'dsh-miaoda: workbench shutdown');
  });
}
