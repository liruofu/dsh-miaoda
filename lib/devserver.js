/**
 * Long-lived dev server supervisor.
 *
 * `npm run dev` is a foreground process that never exits, so it cannot be run
 * through a tool call that must return. This module keeps one child per project
 * directory, captures its output in a ring buffer, and exposes start / stop /
 * status / logs to the tools.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dshHome, findNodeBinary, killTree, noteSpawn, runProcess } from './runtime.js';
import { readProjectEnv } from './template-env.mjs';

/** @type {Map<string, ServerRecord>} */
const servers = new Map();

const MAX_LINES = 600;

/** Default ports of the fullstack template: Vite page and Nest backend. */
const WEB_PORT = 8080;
const API_PORT = 3000;

/**
 * On Windows, project scripts that call `spawn('npx')` (the Miaoda fullstack
 * template does this) fail with ENOENT because npx is only a .cmd shim. Ship a
 * --require hook that rewrites exactly those calls; it is inert elsewhere.
 * @returns {string|undefined} path to the hook.
 */
function shimPath() {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'npx-shim.cjs');
    return fs.existsSync(file) ? file : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The ESM resolver shim: `@lark-apaas/fullstack-cli` starts with
 * `await import(<windows absolute path>)`, which Node rejects with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME. The template calls that CLI during
 * `dev-local.js` (action-plugin init), so the dev server needs it too.
 * @returns {string|undefined} file:// URL of the hook.
 */
function esmHookUrl() {
  if (process.env.MIAODA_NO_ESM_HOOK === '1') return undefined;
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'esm-path-hook.mjs');
    return fs.existsSync(file) ? pathToFileURL(file).href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Child environment for `npm run dev`: windowsHide-friendly NODE_OPTIONS with
 * the npx shim, plus the usual browser/colour suppression.
 * @returns {NodeJS.ProcessEnv}
 */
function devEnv(extra) {
  const env = { ...process.env, ...extra, BROWSER: 'none', FORCE_COLOR: '0' };
  if (process.platform === 'win32') {
    const shim = shimPath();
    if (shim) {
      const normalized = shim.replace(/\\/g, '/');
      const requireFlag = `--require "${normalized}"`;
      env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${requireFlag}` : requireFlag;
    }
    const hook = esmHookUrl();
    if (hook) {
      const importFlag = `--import "${hook}"`;
      env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${importFlag}` : importFlag;
    }
  }
  return env;
}

/**
 * Whether something is already listening on a port.
 *
 * This has to be a *connect* probe, not a bind probe: libuv sets
 * `SO_REUSEADDR` on Windows, so binding `::` happily succeeds on a port that
 * another process is already serving — including the ghost of a dev server
 * whose pid is long gone. Connecting tells the truth, and it checks both
 * families because the template binds `localhost`, which is `::1` there.
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
function portAccepts(port, timeoutMs = 250) {
  const probe = (host) =>
    new Promise((resolve) => {
      const socket = net.connect({ host, port });
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    });
  return Promise.all([probe('::1'), probe('127.0.0.1')]).then((results) => results.some(Boolean));
}

/**
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isPortFree(port) {
  return portAccepts(port).then((busy) => !busy);
}

/**
 * First free port at or after `preferred`. A stale dev server from an earlier
 * session keeps 8080 and 3000 occupied; without this the Vite dev server
 * (`strictPort: true`) simply exits and the preview ends up showing whatever
 * the orphan process answers — typically the Nest 404.
 * @param {number} preferred
 * @param {Set<number>} used
 * @returns {Promise<number>}
 */
async function pickFreePort(preferred, used) {
  for (let port = preferred; port < preferred + 40; port += 1) {
    if (used.has(port)) continue;
    if (await isPortFree(port)) return port;
  }
  return preferred;
}

export { isPortFree, pickFreePort };

/**
 * @typedef {object} ServerRecord
 * @property {import('node:child_process').ChildProcess} child
 * @property {string} project
 * @property {string} script
 * @property {string} command
 * @property {string} startedAt
 * @property {number|undefined} pid
 * @property {string[]} lines
 * @property {number|undefined} port
 * @property {string|undefined} url
 * @property {string|undefined} exitCode
 * @property {string|undefined} signal
 */

/**
 * Pick the package manager the project actually uses.
 * @param {string} project - project root. @returns {'pnpm'|'npm'}
 */
export function detectPackageManager(project) {
  return fs.existsSync(path.join(project, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
}

/**
 * Whether this project has a dev script at all (html apps have no package.json).
 * @param {string} project - project root. @returns {boolean}
 */
export function hasDevScript(project) {
  const file = path.join(project, 'package.json');
  if (!fs.existsSync(file)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof pkg?.scripts?.dev === 'string' || typeof pkg?.scripts?.['dev:local'] === 'string';
  } catch {
    return false;
  }
}

/**
 * How good a URL found on one output line is as the preview target. The
 * template runs both halves through `concurrently`, so the backend's URL can
 * show up first; the client dev server's `Local:` line is the page we want.
 * @param {string} line - one output line. @returns {number} higher is better.
 */
export function urlLineScore(line) {
  // The launcher prints the exact page URL it is about to serve, base path and
  // all — trust it above anything the two child processes say.
  if (line.includes('[dev-launcher]')) return 4;
  if (line.includes('Local:') || line.includes('local:')) return 3;
  if (line.includes('[client]')) return 2;
  if (line.includes('[server]')) return 1;
  return 2;
}

/**
 * The public base path of a Miaoda app, e.g. `/app/app_xxxxxxxx`. Empty when
 * the template did not set one.
 * @param {string} project - project root.
 * @returns {string} normalized base or ''.
 */
export function pageBase(project) {
  let base = '';
  try {
    base = readProjectEnv(project).CLIENT_BASE_PATH ?? '';
  } catch {
    return '';
  }
  base = base.trim();
  if (!base || base === '/') return '';
  if (!base.startsWith('/')) base = `/${base}`;
  return base.replace(/\/+$/, '');
}
/**
 * Which npm script boots the local server. The Miaoda fullstack template's
 * `dev` script runs `miaoda-cli app sync` first, which downloads a toolchain
 * and can stall for minutes; `dev:local` is the runbook's local path and skips
 * that sync. Prefer it when present.
 * @param {string} project - project root. @returns {string}
 */
export function preferredScript(project) {
  // Escape hatch for templates whose `dev:local` really works. The Miaoda
  // fullstack template's `dev:local` shells out to a local `lark-cli` shim that
  // Windows cannot spawn without a shell, so `dev` stays the safe default.
  const override = process.env.MIAODA_DEV_SCRIPT;
  if (override === 'dev' || override === 'dev:local') return override;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
    if (typeof pkg?.scripts?.dev === 'string') return 'dev';
  } catch {
    /* no package.json → `dev` will fail with a clear npm error */
  }
  return 'dev';
}

/**
 * Read the command to run for one script, working around the Miaoda fullstack
 * template's bash entry: `scripts.dev` is `./scripts/dev.sh`, which `cmd.exe`
 * cannot execute on Windows (no bash, no shebang support), so `npm run dev`
 * dies before any server starts and the preview never learns a port.
 *
 * The template ships `scripts/dev-local.js` for exactly the local case (the
 * dash script's "本地 → 走 dev-local.js" branch), and that file is plain Node,
 * so run it directly instead of going through the shell.
 * @param {string} project - project root.
 * @param {string} script - npm script name.
 * @returns {{command: string, label: string}} command line plus a display label.
 */
export function devCommand(project, script) {
  const manager = detectPackageManager(project);
  // Preferred: start Vite and Nest ourselves. `npm run` would go through the
  // configured `script-shell` (Git Bash on this machine), and MSYS rewrites the
  // template's `CLIENT_BASE_PATH=/app/app_xxx` into `C:/Program Files/Git/...`
  // on the way to Vite — the page then lives under a nonsense base and the
  // preview cannot load it. See lib/dev-launcher.mjs.
  const launcher = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dev-launcher.mjs');
  const isTemplate =
    script === 'dev' &&
    process.env.MIAODA_NO_DIRECT_LAUNCH !== '1' &&
    fs.existsSync(path.join(project, 'vite.config.ts')) &&
    fs.existsSync(path.join(project, 'server')) &&
    fs.existsSync(path.join(project, 'node_modules', 'vite', 'bin', 'vite.js')) &&
    fs.existsSync(path.join(project, 'node_modules', '@nestjs', 'cli', 'bin', 'nest.js'));
  const launcherNode = findNodeBinary();
  if (isTemplate && launcherNode && fs.existsSync(launcher)) {
    return {
      command: `"${launcherNode}" "${launcher}"`,
      argv: [launcherNode, launcher],
      label: 'vite + nest（直连，不经 shell）',
    };
  }
  let body = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
    body = typeof pkg?.scripts?.[script] === 'string' ? pkg.scripts[script] : '';
  } catch {
    /* no package.json → fall through to npm, which reports the real error */
  }
  const runsShellScript = /\.sh(?:\s|$)/.test(body.trim());
  const localEntry = path.join(project, 'scripts', 'dev-local.js');
  if (runsShellScript && fs.existsSync(localEntry)) {
    return { command: 'node scripts/dev-local.js', label: 'node scripts/dev-local.js' };
  }
  return { command: `${manager} run ${script}`, label: `${manager} run ${script}` };
}

/**
 * Extract the first reachable URL from server output.
 * @param {string} line - one output line. @returns {{port: number, url: string}|undefined}
 */
export function parseServedUrl(line) {
  const portMatch = /localhost:(\d{2,5})|127\.0\.0\.1:(\d{2,5})|0\.0\.0\.0:(\d{2,5})/.exec(line);
  // Keep the path: every Miaoda app is served under its CLIENT_BASE_PATH
  // (`/app/app_xxx/`), so `http://localhost:8080` alone opens nothing — Vite
  // answers that with a redirect and the preview stays blank.
  const urlMatch = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d{2,5}))?(\/[^\s"'<>]*)?/.exec(line);
  if (urlMatch) {
    let rest = (urlMatch[2] ?? '').replace(/[),.;]+$/, '');
    while (rest.endsWith('/')) rest = rest.slice(0, -1);
    const port = urlMatch[1] ? Number(urlMatch[1]) : rest === '' ? 80 : 0;
    if (port > 0) return { port, url: `http://localhost:${port}${rest}` };
  }
  if (portMatch) {
    const port = Number(portMatch[1] ?? portMatch[2] ?? portMatch[3]);
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      return { port, url: `http://localhost:${port}` };
    }
  }
  return undefined;
}

/**
 * Snapshot of one running server.
 * @param {ServerRecord} record - internal record.
 * @returns {Record<string, unknown>}
 */
export function snapshot(record) {
  const failed = record.exitCode !== undefined;
  return {
    running: !failed && record.child.exitCode === null && record.child.signalCode === null,
    project: record.project,
    command: record.command,
    startedAt: record.startedAt,
    pid: record.pid,
    port: record.port,
    url: record.url,
    ...(failed ? { exitCode: record.exitCode } : {}),
    ...(record.signal ? { signal: record.signal } : {}),
    logTail: record.lines.slice(-40).join('\n'),
  };
}

/**
 * Status of the server for one project, if this plugin started it.
 * @param {string} project - project root. @returns {Record<string, unknown>|undefined}
 */
export function status(project) {
  const record = servers.get(projectKey(project));
  return record ? snapshot(record) : undefined;
}

/**
 * Snapshot of every server this plugin has started, whether it is still running
 * or already exited. The conversation preview window reads this list, so entries
 * outlive their process until the project is started again or stopped.
 * @returns {Array<Record<string, unknown>>}
 */
export function list() {
  return [...servers.values()].map((record) => ({
    ...snapshot(record),
    name: path.basename(record.project),
    script: record.script,
  }));
}

/**
 * Recent output lines.
 * @param {string} project - project root. @param {number} [limit] - line count.
 * @returns {string[]}
 */
export function logs(project, limit = 80) {
  const record = servers.get(projectKey(project));
  return record ? record.lines.slice(-limit) : [];
}

/** @param {string} project - project root. @returns {string} */
function projectKey(project) {
  return process.platform === 'win32' ? project.toLowerCase() : project;
}

/**
 * Wrap the dev command in `lib/dev-watchdog.mjs`, which kills the whole tree as
 * soon as this harness process disappears.
 *
 * Without it, quitting DeepSeek Harness leaves npm → node → nest/vite running:
 * Windows does not reap a child when its parent exits, so the orphan keeps
 * 8080 / 3000 and the next preview shows a stale backend's 404.
 * @param {string} command - shell command line to run.
 * @returns {{file: string, args: string[]}|undefined} spawn target, if a node
 *   binary and the watchdog script are both available.
 */
export function watchdogCommand(command) {
  const node = findNodeBinary();
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dev-watchdog.mjs');
  if (!node || !fs.existsSync(script)) return undefined;
  // An argv array means "spawn this program directly" — cmd.exe would mangle
  // the inner quotes of `"C:\Program Files\nodejs\node.exe" "…\x.mjs"`.
  if (Array.isArray(command)) return { file: node, args: [script, String(process.pid), '--', ...command] };
  return { file: node, args: [script, String(process.pid), command] };
}

/**
 * Start `npm run dev` for a project, wait for a URL or for output to settle.
 * @param {string} project - project root.
 * @param {{script?: string, waitMs?: number, env?: Record<string,string>}} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function start(project, options = {}) {
  const key = projectKey(project);
  const existing = servers.get(key);
  if (existing && existing.child.exitCode === null && existing.child.signalCode === null) {
    return { ...snapshot(existing), alreadyRunning: true };
  }
  const script = options.script ?? preferredScript(project);
  const plan = devCommand(project, script);
  const { command, label } = plan;
  // Pin both halves to ports we know are free: the template's Vite preset takes
  // `CLIENT_DEV_PORT` (default 8080, `strictPort`) and the Nest backend takes
  // `SERVER_PORT` (default 3000). Explicit ports also give us the preview URL
  // before a single line of output arrives.
  const clientPort = await pickFreePort(Number(options.port) || WEB_PORT, new Set());
  const serverPort = await pickFreePort(API_PORT, new Set([clientPort]));
  const portEnv = { CLIENT_DEV_PORT: String(clientPort), SERVER_PORT: String(serverPort) };
  const shell = process.platform === 'win32'
    ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
    : { file: '/bin/sh', args: ['-c', command] };
  const { spawn } = await import('node:child_process');
  const target = watchdogCommand(plan.argv ?? command) ?? shell;
  noteSpawn(target.file, target.args);
  const child = spawn(target.file, target.args, {
    cwd: project,
    env: devEnv({ ...portEnv, ...options.env }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  /** @type {ServerRecord} */
  const record = {
    child,
    project,
    script,
    command: label,
    startedAt: new Date().toISOString(),
    pid: child.pid,
    lines: [`[dsh-miaoda] CLIENT_DEV_PORT=${clientPort} SERVER_PORT=${serverPort}`],
    port: clientPort,
    // Every Miaoda app lives under its CLIENT_BASE_PATH ("/app/app_xxx/"), so
    // seeding the bare origin would make the preview open a 302. Read the base
    // up front; the log lines still refine it later (that is what urlScore is
    // for).
    url: `http://localhost:${clientPort}${pageBase(project)}/`,
    urlScore: 2,
    exitCode: undefined,
    signal: undefined,
  };
  servers.set(key, record);
  rememberServer(record);
  // The template runs both halves through `concurrently`, so the backend's URL
  // can show up first. Score the lines and keep the best one: the client dev
  // server (`[client] … Local:`) is the page a preview window should show.
  const push = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line === '') continue;
      record.lines.push(line);
      if (record.lines.length > MAX_LINES) record.lines.splice(0, record.lines.length - MAX_LINES);
      const served = parseServedUrl(line);
      if (!served) continue;
      const score = urlLineScore(line);
      if (record.url === undefined || score > record.urlScore) {
        record.port = served.port;
        record.url = served.url;
        record.urlScore = score;
      }
    }
  };
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', push);
  child.stderr?.on('data', push);
  child.on('exit', (code, signal) => {
    record.exitCode = code === null ? 'null' : String(code);
    record.signal = signal ?? undefined;
  });
  child.on('error', (error) => {
    record.lines.push(`[spawn error] ${error.message}`);
    record.exitCode = 'spawn-error';
  });
  // An explicit port wins over anything parsed from the logs: templates that
  // print no URL at all (or print it only after a long sync) still get a
  // preview the moment the caller names the port. The score stays at 2 so a
  // real `[client] … Local:` line may still correct the auto-picked port.
  if (Number.isInteger(options.port) && options.port > 0 && options.port < 65536) {
    record.port = options.port;
    record.url = `http://localhost:${options.port}`;
    record.urlScore = 3;
  }
  const waitMs = options.waitMs ?? 12_000;
  const deadline = Date.now() + waitMs;
  // The URL is known up front; what we actually wait for is the port to start
  // answering, i.e. for Vite to finish scanning and bind.
  while (Date.now() < deadline) {
    if (record.exitCode !== undefined) break;
    if (!(await isPortFree(clientPort))) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // Give the bundler a moment to print its final "ready" line after the URL.
  await new Promise((resolve) => setTimeout(resolve, 400));
  return { ...snapshot(record), alreadyRunning: false };
}

/**
 * Stop the server for one project.
 * @param {string} project - project root. @returns {Record<string, unknown>}
 */
export async function stop(project) {
  const key = projectKey(project);
  const record = servers.get(key);
  if (!record) return { stopped: false, reason: 'no server started by dsh-miaoda for this project' };
  const wasRunning = record.child.exitCode === null && record.child.signalCode === null;
  killTree(record.child);
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (record.child.exitCode !== null || record.child.signalCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  servers.delete(key);
  forgetServer(project);
  return { stopped: true, wasRunning, pid: record.pid };
}

/** Stop everything, for plugin disposal. @returns {void} */
export function stopAll() {
  for (const record of servers.values()) {
    killTree(record.child);
    forgetServer(record.project);
  }
  servers.clear();
}

/**
 * Run a one-shot install in the project.
 * @param {string} project - project root.
 * @param {{install?: boolean, signal?: AbortSignal}} [options]
 * @returns {Promise<{ok: boolean, text: string}>}
 */
export async function install(project, options = {}) {
  const manager = detectPackageManager(project);
  const command = manager === 'pnpm' ? 'pnpm install' : 'npm install';
  const shell = process.platform === 'win32'
    ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command], verbatim: true }
    : { file: '/bin/sh', args: ['-c', command], verbatim: false };
  const result = await runProcess(shell.file, shell.args, {
    cwd: project,
    timeoutMs: 600_000,
    signal: options.signal,
    windowsVerbatimArguments: shell.verbatim,
  });
  const ok = result.code === 0 && !result.timedOut && !result.spawnError;
  const tail = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).slice(-25).join('\n');
  return { ok, text: `${command} ${ok ? 'succeeded' : 'failed'} (exit ${result.code ?? result.spawnError})\n${tail}` };
}

/**
 * Cross-session record of the dev servers this plugin started.
 *
 * The watchdog already kills the tree when the harness exits, but it cannot
 * help when the whole host is killed `taskkill /T`-style, and it says nothing
 * about servers started by an older, watchdog-less build. Writing a small lock
 * file lets the next session reap whatever survived.
 * @returns {string} absolute path of the lock file.
 */
function lockFile() {
  return path.join(dshHome(), 'miaoda-dev-servers.json');
}

/** @returns {Record<string, Record<string, any>>} */
function readLocks() {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** @param {Record<string, Record<string, any>>} locks - full lock table. @returns {void} */
function writeLocks(locks) {
  try {
    const file = lockFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(locks, null, 2)}\n`);
  } catch {
    /* a missing lock file only costs us the next reap */
  }
}

/** @param {Record<string, any>} record - live server. @returns {void} */
function rememberServer(record) {
  const locks = readLocks();
  locks[record.project] = {
    pid: record.pid,
    hostPid: process.pid,
    url: record.url,
    startedAt: record.startedAt,
  };
  writeLocks(locks);
}

/** @param {string} project - project root. @returns {void} */
function forgetServer(project) {
  const locks = readLocks();
  if (!(project in locks)) return;
  delete locks[project];
  writeLocks(locks);
}

/** @param {unknown} value - candidate pid. @returns {boolean} */
function pidAlive(value) {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

/**
 * Guard against pid reuse: only kill a survivor that still looks like the node
 * process we started, never some unrelated program that inherited the number.
 * @param {number} pid - candidate pid.
 * @returns {Promise<boolean>}
 */
async function looksLikeNode(pid) {
  if (process.platform !== 'win32') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return stat.includes('node') || stat.includes('dev-watchdog');
    } catch {
      return true;
    }
  }
  const result = await runProcess('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeoutMs: 5_000 });
  return /node\.exe|node|cmd\.exe/i.test(result.stdout);
}

/**
 * Kill dev servers left behind by a previous harness session.
 *
 * A server started by this session is left alone; so is one whose owning
 * harness is still alive (a second window). Everything older than the current
 * process that is still running is an orphan — it holds the preview port and
 * keeps `node.exe` alive after the window closed, which is exactly the symptom
 * this is here to remove.
 * @param {{dryRun?: boolean, verify?: (pid: number) => Promise<boolean>}} [options] -
 *   `dryRun` reports without killing; `verify` overrides the pid-reuse guard.
 * @returns {Promise<{reaped: number[], skipped: number[], kept: number[]}>}
 */
export async function reapOrphans(options = {}) {
  const verify = options.verify ?? looksLikeNode;
  const locks = readLocks();
  const reaped = [];
  const skipped = [];
  const kept = [];
  let changed = false;
  for (const [project, entry] of Object.entries(locks)) {
    if (!entry || typeof entry !== 'object') {
      delete locks[project];
      changed = true;
      continue;
    }
    if (Number(entry.hostPid) === process.pid) {
      kept.push(Number(entry.pid));
      continue;
    }
    // Another live window owns it: it will clean up after itself.
    if (pidAlive(entry.hostPid)) {
      kept.push(Number(entry.pid));
      continue;
    }
    changed = true;
    delete locks[project];
    if (!pidAlive(entry.pid) || !(await verify(Number(entry.pid)))) {
      skipped.push(Number(entry.pid));
      continue;
    }
    if (options.dryRun) {
      reaped.push(Number(entry.pid));
      continue;
    }
    if (process.platform === 'win32') {
      await runProcess('taskkill', ['/PID', String(entry.pid), '/T', '/F'], { timeoutMs: 10_000 });
    } else {
      try {
        process.kill(Number(entry.pid), 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    reaped.push(Number(entry.pid));
  }
  if (changed && !options.dryRun) writeLocks(locks);
  return { reaped, skipped, kept };
}
