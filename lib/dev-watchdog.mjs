/**
 * Run a long-lived command under a parent-liveness watchdog.
 *
 * `npm run dev` spawns a whole tree (npm → npx → concurrently → nest / vite).
 * When DeepSeek Harness exits, those processes are *not* its children any more
 * in any meaningful sense — Windows has no automatic cleanup — so a plain
 * spawn leaves node.exe processes running after the window is closed, still
 * holding 8080 / 3000. That is what made the next "本地预览" open a stale
 * backend.
 *
 * This wrapper is spawned by the plugin instead of the shell. It starts the
 * real command, then polls the harness pid; the moment the harness is gone it
 * kills the whole subtree and exits. It also kills the subtree on SIGTERM /
 * SIGINT / exit, so a normal quit is clean too.
 *
 * Usage: node dev-watchdog.mjs <parentPid> <command…>
 *    or: node dev-watchdog.mjs <parentPid> -- <file> <arg…>
 *
 * The `--` form spawns the program directly, without cmd.exe / sh in between.
 * That matters for commands whose argv contains quotes or spaces: cmd.exe's
 * `/s /c` strips the outer quotes of a command line that starts with one, so
 * `"C:\Program Files\nodejs\node.exe" "…\dev-launcher.mjs"` would arrive with
 * mangled paths.
 */
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const parentPid = Number(args[0]);
const rest = args.slice(1);
const direct = rest[0] === '--' ? rest.slice(1) : undefined;
const command = direct ? '' : rest.join(' ');

/** @type {import('node:child_process').ChildProcess|undefined} */
let child;
let exiting = false;

const isWindows = process.platform === 'win32';

/**
 * Kill the command and everything it spawned. On Windows `taskkill /T` is the
 * only reliable way to reach npm → node → vite.
 * @param {import('node:child_process').ChildProcess|undefined} target
 * @returns {void}
 */
function killTree(target) {
  if (!target || target.pid === undefined) return;
  try {
    if (isWindows) {
      spawn('taskkill', ['/pid', String(target.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      target.kill('SIGTERM');
    }
  } catch {
    try {
      target.kill();
    } catch {
      /* already gone */
    }
  }
}

/**
 * @param {number} code - exit code to report.
 * @returns {void}
 */
function leave(code) {
  if (exiting) return;
  exiting = true;
  killTree(child);
  // Give taskkill a moment to run before this process (and its pipe) goes away.
  setTimeout(() => process.exit(code), isWindows ? 400 : 0);
}

if (command === '' && (!direct || direct.length === 0)) {
  process.stderr.write('[dev-watchdog] 缺少要运行的命令\n');
  process.exit(2);
}

const stdio = ['ignore', 'inherit', 'inherit'];
child = direct
  ? spawn(direct[0], direct.slice(1), { cwd: process.cwd(), env: process.env, windowsHide: true, stdio })
  : spawn(isWindows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
    isWindows ? ['/d', '/s', '/c', command] : ['-c', command],
    {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      // Inherit this process's stdio: the plugin reads the grandchild's output
      // through the pipes it gave *us*.
      stdio,
    });

child.on('exit', (code, signal) => {
  process.exit(signal === null || signal === undefined ? code ?? 0 : 1);
});
child.on('error', (error) => {
  process.stderr.write(`[dev-watchdog] ${error.message}\n`);
  process.exit(1);
});

process.on('SIGTERM', () => leave(0));
process.on('SIGINT', () => leave(0));
process.on('SIGBREAK', () => leave(0));
process.on('exit', () => {
  if (!exiting) killTree(child);
});

/**
 * Parent liveness. `process.kill(pid, 0)` throws ESRCH once the harness is
 * gone; on Windows it may also throw EPERM for a live-but-protected process,
 * which is why the check treats anything other than ESRCH as "still here".
 * @returns {boolean}
 */
function parentAlive() {
  if (!Number.isInteger(parentPid) || parentPid <= 0) return true;
  if (parentPid === process.pid) return true;
  try {
    process.kill(parentPid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

const timer = setInterval(() => {
  if (parentAlive()) return;
  clearInterval(timer);
  process.stderr.write('[dev-watchdog] 宿主已退出，结束 dev server\n');
  leave(0);
}, 1_500);
timer.unref?.();
