'use strict';
// Loaded through NODE_OPTIONS=--require for dev-server child processes.
//
// The Miaoda fullstack template's scripts/dev-local.js does `spawn('npx', …)`
// with the default `shell: false`. On Windows `npx` is only a .cmd shim, which
// CreateProcess cannot execute, so the dev server dies with `spawn npx ENOENT`.
// Rewriting that one call to `npx.cmd` + `shell: true` keeps the template
// untouched and only affects the process we launch.
const childProcess = require('node:child_process');

const isWindows = process.platform === 'win32';
const SHELL_COMMANDS = new Set(['npx', 'lark-cli']);

function rewrite(command) {
  if (!isWindows || typeof command !== 'string') return null;
  const name = command.trim();
  if (!SHELL_COMMANDS.has(name)) return null;
  return `${name}.cmd`;
}

function quoteArg(value) {
  const text = String(value);
  if (!/[\s"]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function patch(method) {
  const original = childProcess[method];
  if (typeof original !== 'function' || original.__miaodaPatched) return;
  const patched = function (command, args, options) {
    const replacement = rewrite(command);
    if (!replacement) return original.apply(this, arguments);
    const argv = Array.isArray(args) ? args.map(quoteArg) : [];
    const opts = Array.isArray(args) ? options ?? {} : args ?? {};
    return original.call(this, replacement, argv, { ...opts, shell: true, windowsHide: true });
  };
  patched.__miaodaPatched = true;
  childProcess[method] = patched;
}

patch('spawn');
patch('spawnSync');
