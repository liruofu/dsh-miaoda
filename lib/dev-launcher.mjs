/**
 * Start the Miaoda full-stack template without a shell in the way.
 *
 * `npm run dev:client` is `NODE_ENV=development vite --config vite.config.ts`,
 * i.e. POSIX shell syntax, so npm has to run it through whatever
 * `script-shell` is configured — in practice Git Bash. That has a nasty
 * side effect: MSYS converts environment variables whose name ends in `PATH`
 * on the way to a native process, so the template's
 *
 *   CLIENT_BASE_PATH="/app/app_xxx"
 *
 * arrives at Vite as `C:/Program Files/Git/app/app_xxx`. Vite then builds its
 * whole page under that public base, `GET /` redirects there, nothing matches
 * and the preview window shows a blank page ("暂时连不上这个地址").
 *
 * This launcher does the same two jobs `scripts/dev-local.js` does — load
 * `.env` / `.env.local`, run Vite and Nest side by side — but spawns the
 * binaries directly with `node`, so no MSYS process ever touches the env and
 * `CLIENT_BASE_PATH` stays exactly what the platform wrote.
 *
 * Usage: node dev-launcher.mjs   (cwd must be the project root)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { applyLocalDevEnv, readProjectEnv } from './template-env.mjs';

const project = process.cwd();
const isWindows = process.platform === 'win32';

/**
 * Merge `.env` then `.env.local` into the process environment, keeping values
 * that are already set — this is dotenv's default and what the template relies
 * on (the plugin passes the ports in that way).
 * @returns {string[]} keys that came from the files.
 */
function loadDotenv() {
  const merged = readProjectEnv(project);
  const applied = [];
  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] !== undefined && process.env[key] !== '') continue;
    process.env[key] = value;
    applied.push(key);
  }
  process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';
  const webuser = applyLocalDevEnv(process.env);
  if (webuser === 'invalid') {
    process.stderr.write('[dev-launcher] SUDA_WEBUSER 解析失败，账号身份可能为空\n');
  }
  return applied;
}

/**
 * One supervised half of the dev server.
 * @typedef {object} Half
 * @property {string} name - stream prefix.
 * @property {string} entry - node script to run.
 * @property {string[]} args - argv for the entry.
 * @property {import('node:child_process').ChildProcess} [child]
 */

/** @type {Half[]} */
const halves = [];
let shuttingDown = false;
let exitCode = 0;

/**
 * @param {string} name - stream prefix.
 * @param {string} entry - node script path, relative to the project.
 * @param {string[]} args - argv.
 * @returns {Half|undefined}
 */
function half(name, entry, args) {
  const absolute = path.join(project, entry);
  if (!fs.existsSync(absolute)) {
    process.stderr.write(`[${name}] 缺少 ${entry}，先用 npm install 装上依赖\n`);
    exitCode = 1;
    return undefined;
  }
  return { name, entry: absolute, args };
}

/**
 * Stream a child's output line by line with a prefix.
 * @param {Half} target - half being started.
 * @returns {void}
 */
function startHalf(target) {
  const options = {
    cwd: project,
    env: process.env,
    windowsHide: true,
  };
  let child;
  let piped = true;
  try {
    child = spawn(process.execPath, [target.entry, ...target.args], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // Some sandboxes refuse to create pipes for grandchildren (EPERM). Losing
    // the "[client] " prefix beats not starting at all, so retry with the
    // parent's own stdio.
    if (error?.code !== 'EPERM' && error?.code !== 'EINVAL') {
      process.stderr.write(`[${target.name}] 启动失败: ${error.message}\n`);
      shutdown(1);
      return;
    }
    try {
      child = spawn(process.execPath, [target.entry, ...target.args], { ...options, stdio: ['ignore', 'inherit', 'inherit'] });
      piped = false;
    } catch (retryError) {
      process.stderr.write(`[${target.name}] 启动失败: ${retryError.message}\n`);
      shutdown(1);
      return;
    }
  }
  target.child = child;
  const forward = (stream, sink) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) sink.write(`[${target.name}] ${line}\n`);
    });
  };
  if (piped) {
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
  }
  child.on('error', (error) => {
    process.stderr.write(`[${target.name}] 启动失败: ${error.message}\n`);
    shutdown(error.code === 'ENOENT' ? 1 : 1);
  });
  child.on('exit', (code, signal) => {
    // `nest start --watch` keeps running; Vite dying means the page is gone, so
    // take the other half down with it instead of leaving half a dev server.
    if (shuttingDown) return;
    process.stdout.write(`[${target.name}] 已退出（${signal ?? code ?? 0}）\n`);
    shutdown(typeof code === 'number' ? code : 1);
  });
}

/**
 * Kill both halves and exit.
 * @param {number} code - exit code.
 * @returns {void}
 */
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = code;
  for (const target of halves) {
    const child = target.child;
    if (!child || child.pid === undefined) continue;
    try {
      if (isWindows) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGTERM');
    } catch {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }
  setTimeout(() => process.exit(exitCode), isWindows ? 400 : 0);
}

const loaded = loadDotenv();
process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';

const client = half('client', 'node_modules/vite/bin/vite.js', ['--config', 'vite.config.ts']);
const server = half('server', 'node_modules/@nestjs/cli/bin/nest.js', ['start', '--watch']);
if (!client || !server) {
  process.stderr.write(`[dev-launcher] 项目结构不完整（${project}）\n`);
  process.exit(1);
}
halves.push(/** @type {Half} */ (client), /** @type {Half} */ (server));

process.stdout.write(
  `[dev-launcher] 从 .env/.env.local 注入 ${loaded.length} 个变量；CLIENT_BASE_PATH=${process.env.CLIENT_BASE_PATH ?? '(未设置)'}；MIAODA_LOCAL_DEV=${process.env.MIAODA_LOCAL_DEV ?? '(未设置)'}\n`,
);
// Base path matters: every Miaoda app is served under /app/<appId>/, so say it
// out loud — it is the URL the preview window has to open.
process.stdout.write(`[dev-launcher] 页面地址: http://localhost:${process.env.CLIENT_DEV_PORT ?? '8080'}${process.env.CLIENT_BASE_PATH ?? ''}/\n`);

for (const target of halves) startHalf(target);

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('SIGBREAK', () => shutdown(0));
process.on('exit', () => {
  if (!shuttingDown) {
    for (const target of halves) {
      try {
        target.child?.kill();
      } catch {
        /* already gone */
      }
    }
  }
});
