/**
 * Process / lark-cli / git plumbing for dsh-miaoda.
 *
 * Deliberately dependency-free: the plugin registers plain tool definitions
 * through `ctx.tools.register` and never imports `@deepseek-ai/*` at runtime
 * (those packages live inside the harness, not in the profile's node_modules).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Default ceiling for a single lark-cli invocation. */
export const LARK_TIMEOUT_MS = 120_000;
/** `+release-create` performs a server-side deploy; give it more room. */
export const RELEASE_TIMEOUT_MS = 300_000;
/** Git remotes of a Miaoda app can be slow on a cold connection. */
export const GIT_TIMEOUT_MS = 180_000;

/**
 * Environment for spawning `process.execPath` with a script argument.
 *
 * Inside the Electron host `process.execPath` is the app binary: without
 * `ELECTRON_RUN_AS_NODE` the child boots another GUI instance (a window pops
 * up on every poll). The flag is inert for a plain node binary.
 *
 * Returns the full environment so a direct `spawn(..., { env })` call does not
 * accidentally drop PATH / APPDATA / proxy settings.
 * @param {Record<string,string>} [extra]
 */
export function nodeEnv(extra) {
  return { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extra };
}

/**
 * Append one line per spawned process so a flashing console window can be
 * traced back to the command that opened it. Best effort, never throws.
 * @param {string} command
 * @param {string[]} args
 */
export function noteSpawn(command, args) {
  if (process.platform !== 'win32') return;
  try {
    const file = path.join(dshHome(), 'miaoda-spawn.log');
    try {
      if (fs.statSync(file).size > 512 * 1024) fs.rmSync(file, { force: true });
    } catch {
      /* no log yet */
    }
    const head = args.slice(0, 5).join(' ').slice(0, 160);
    fs.appendFileSync(file, `${new Date().toISOString()} ${path.basename(command)} ${head}\n`);
  } catch {
    /* logging must never break a tool call */
  }
}

/**
 * Feed a stream through a line splitter. Handles LF, CRLF and bare CR (git
 * progress keeps rewriting the same line with carriage returns), so callers
 * get whole lines without escape-sequence games.
 * @param {(line: string, stream: 'stdout'|'stderr') => void} emit
 * @returns {(chunk: string, stream: 'stdout'|'stderr') => void}
 */
function streamLines(emit) {
  const CR = 13;
  const LF = 10;
  let buffer = '';
  let pendingCR = false;
  return (chunk, stream) => {
    const text = String(chunk);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === CR) {
        pendingCR = true;
        continue;
      }
      if (code === LF) {
        emit(buffer, stream);
        buffer = '';
        pendingCR = false;
        continue;
      }
      if (pendingCR) {
        emit(buffer, stream);
        buffer = '';
        pendingCR = false;
      }
      buffer += text[index];
    }
  };
}

/**
 * Spawn a process and collect its output.
 *
 * Never uses a shell for `node`/`git`; callers that need a shell shim (`npm`)
 * pass the interpreter explicitly through `shellCommand`.
 * @param {string} command - executable path or name.
 * @param {string[]} args - argv.
 * @param {{cwd?: string, env?: Record<string,string>, timeoutMs?: number, signal?: AbortSignal, stdin?: string, windowsVerbatimArguments?: boolean, onLine?: (line: string, stream: 'stdout'|'stderr') => void}} [options]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean, spawnError: string|undefined}>}
 */
export function runProcess(command, args, options = {}) {
  const { cwd, env, timeoutMs = 120_000, signal, stdin, windowsVerbatimArguments, onLine } = options;
  noteSpawn(command, args);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
        shell: false,
        windowsVerbatimArguments,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: errorMessage(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutMs)
      : undefined;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const tail = onLine ? streamLines(onLine) : null;
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      tail?.(chunk, 'stdout');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      tail?.(chunk, 'stderr');
    });
    child.on('error', (error) => { spawnError = errorMessage(error); });
    child.on('close', (code) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, spawnError });
    });
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    } else {
      child.stdin?.end();
    }
    if (signal) {
      if (signal.aborted) killTree(child);
      else signal.addEventListener('abort', () => killTree(child), { once: true });
    }
  });
}

/**
 * Kill a child and its descendants. On Windows `taskkill /T` is the only
 * reliable way to reach the npm → node → vite chain.
 * @param {import('node:child_process').ChildProcess} child - spawned child.
 * @returns {void}
 */
export function killTree(child) {
  if (!child || child.killed || child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    try { child.kill(); } catch { /* already gone */ }
  }
}

/** @param {unknown} error - anything thrown. @returns {string} */
export function errorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return String(error);
}

/**
 * Normalize a Windows path for `fs` use and keep it absolute.
 * @param {string} value - user supplied path. @returns {string}
 */
export function toAbsolute(value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(value);
}

/**
 * Parse the first JSON document found in mixed CLI output.
 *
 * lark-cli prints human-readable lines before its JSON payload in some
 * subcommands, so a bare `JSON.parse` is not enough.
 * @param {string} text - raw stdout. @returns {unknown}
 */
export function extractJson(text) {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* fall through */ }
  }
  // Line-oriented fallback: the last line that parses as JSON wins.
  const lines = trimmed.split(/\r?\n/).reverse();
  for (const line of lines) {
    const candidate = line.trim();
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
    try { return JSON.parse(candidate); } catch { /* keep looking */ }
  }
  return undefined;
}

/**
 * Pick a plain Node binary when one is installed.
 *
 * Preferred over `process.execPath`, which inside the Electron host points at
 * the GUI executable: running it with a script argument would need
 * `ELECTRON_RUN_AS_NODE` and, when that is missing, flashes a window.
 * @returns {string|undefined}
 */
export function findNodeBinary() {
  const candidates = [];
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles;
    const localAppData = process.env.LOCALAPPDATA;
    if (programFiles) candidates.push(path.join(programFiles, 'nodejs', 'node.exe'));
    if (localAppData) candidates.push(path.join(localAppData, 'Programs', 'nodejs', 'node.exe'));
    if (process.env.NVM_SYMLINK) candidates.push(path.join(process.env.NVM_SYMLINK, 'node.exe'));
  } else {
    candidates.push('/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node');
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore unreadable candidates */
    }
  }
  const base = path.basename(process.execPath).toLowerCase();
  return base === 'node.exe' || base === 'node' ? process.execPath : undefined;
}

/**
 * Probe known install locations for the lark-cli Node entry so the plugin can
 * spawn `node <entry>` directly instead of round-tripping through cmd.exe.
 * @param {string|undefined} explicit - user configured entry path.
 * @returns {{node: string, entry: string, shim: string|undefined}|undefined}
 */
export function resolveLarkCli(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  const appData = process.env.APPDATA;
  if (appData) {
    candidates.push(path.join(appData, 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js'));
    candidates.push(path.join(appData, 'npm', 'node_modules', 'lark-cli', 'scripts', 'run.js'));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { node: findNodeBinary() ?? process.execPath, entry: candidate, shim: undefined };
  }
  // Fall back to parsing the npm shim so a renamed package still resolves.
  const shim = appData ? path.join(appData, 'npm', 'lark-cli.cmd') : undefined;
  if (shim && fs.existsSync(shim)) {
    const source = fs.readFileSync(shim, 'utf8');
    const match = /"%dp0%\\?([^"%]+\.(?:js|cjs|mjs))"/.exec(source) ?? /%dp0%\\([^"\s]+)/.exec(source);
    if (match) {
      const entry = path.join(path.dirname(shim), match[1]);
      if (fs.existsSync(entry)) return { node: findNodeBinary() ?? process.execPath, entry, shim };
    }
  }
  return undefined;
}

/**
 * Run one `lark-cli apps ...` command and decode its JSON envelope.
 * @param {{node:string, entry:string}} cli - resolved launcher.
 * @param {string[]} argv - arguments after the entry script.
 * @param {{cwd?: string, timeoutMs?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<{ok: boolean, code: number|null, data: unknown, text: string, error: string|undefined, stderr: string, timedOut: boolean}>}
 */
export async function runLark(cli, argv, options = {}) {
  const { cwd, timeoutMs = LARK_TIMEOUT_MS, signal } = options;
  const result = await runProcess(cli.node, [cli.entry, ...argv], { cwd, timeoutMs, signal, env: nodeEnv() });
  const data = extractJson(result.stdout);
  const text = result.stdout.trim();
  let error;
  if (result.spawnError) {
    error = result.spawnError;
  } else if (result.timedOut) {
    error = `lark-cli timed out after ${timeoutMs}ms`;
  } else if (data !== undefined && isRecord(data) && data.ok === false) {
    error = describeLarkError(data);
  } else if (result.code !== 0) {
    error = (result.stderr.trim() || text || `lark-cli exited with code ${result.code}`).slice(0, 1200);
  }
  return {
    ok: error === undefined,
    code: result.code,
    data,
    text,
    error,
    stderr: result.stderr.trim(),
    timedOut: result.timedOut,
  };
}

/**
 * Turn a lark-cli failure envelope into one actionable line.
 * @param {Record<string, unknown>} payload - decoded envelope.
 * @returns {string}
 */
export function describeLarkError(payload) {
  const error = isRecord(payload.error) ? payload.error : undefined;
  const message = error && typeof error.message === 'string' ? error.message : 'lark-cli reported ok=false';
  const hint = error && typeof error.hint === 'string' ? ` (${error.hint})` : '';
  const type = error && typeof error.type === 'string' ? `[${error.type}] ` : '';
  return `${type}${message}${hint}`;
}

/**
 * Run a git command inside a project directory.
 * @param {string[]} argv - git arguments.
 * @param {{cwd: string, timeoutMs?: number, signal?: AbortSignal}} options
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, error: string|undefined}>}
 */
export async function runGit(argv, options) {
  const { cwd, timeoutMs = GIT_TIMEOUT_MS, signal } = options;
  const result = await runProcess('git', argv, { cwd, timeoutMs, signal });
  const stdout = result.stdout.trimEnd();
  const stderr = result.stderr.trimEnd();
  let error;
  if (result.spawnError) error = result.spawnError;
  else if (result.timedOut) error = `git ${argv[0]} timed out after ${timeoutMs}ms`;
  else if (result.code !== 0) error = (stderr || stdout || `git exited with code ${result.code}`).slice(0, 1200);
  return { ok: error === undefined, code: result.code, stdout, stderr, error };
}

/** @param {unknown} value - candidate. @returns {value is Record<string, any>} */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Depth-first search for the first scalar value under any of `keys`.
 * lark-cli nests the same field at `data.x`, `data.data.x` or `data.release.x`
 * depending on the subcommand, so callers must not hard-code a path.
 * @param {unknown} node - root value.
 * @param {string[]} keys - candidate field names, priority order.
 * @param {number} [maxDepth] - recursion guard.
 * @returns {string|undefined}
 */
export function findScalar(node, keys, maxDepth = 6) {
  if (maxDepth < 0 || node === null || node === undefined) return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findScalar(item, keys, maxDepth - 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(node)) return undefined;
  for (const key of keys) {
    const value = node[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (typeof value === 'number') return String(value);
  }
  for (const value of Object.values(node)) {
    if (typeof value === 'object' && value !== null) {
      const found = findScalar(value, keys, maxDepth - 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Read `.spark/meta.json` for a project directory.
 * @param {string} dir - candidate project root.
 * @returns {{appId: string, raw: Record<string, unknown>}|undefined}
 */
export function readProjectMeta(dir) {
  const file = path.join(dir, '.spark', 'meta.json');
  if (!fs.existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const appId = isRecord(raw) && typeof raw.app_id === 'string' ? raw.app_id : undefined;
    return { appId, raw: isRecord(raw) ? raw : {} };
  } catch {
    return undefined;
  }
}

/**
 * Find Miaoda projects directly under `dir` (one level deep).
 * @param {string} dir - search root. @returns {string[]} absolute project paths.
 */
export function scanProjects(dir) {
  const found = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const candidate = path.join(dir, entry.name);
    if (fs.existsSync(path.join(candidate, '.spark', 'meta.json'))) found.push(candidate);
  }
  return found;
}

/** Whether a directory looks like the plugin's own package (skip it when scanning). */
export function looksLikeMiaodaCli(dir) {
  return fs.existsSync(path.join(dir, 'lib', 'index.js')) && fs.existsSync(path.join(dir, 'cordis.patch.yml'));
}

/** @returns {string} a short timestamp suitable for file names. */
export function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** @returns {string} the harness home directory, falling back to the user profile. */
export function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
}
