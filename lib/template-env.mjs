/**
 * Reading the Miaoda template's `.env` files by hand, plus the two environment
 * variables only `scripts/dev-local.js` normally sets.
 *
 * Why this exists instead of `dotenv`: the plugin must not depend on the
 * project's node_modules (it may be a half-installed tree), and the one quirk
 * that matters — `SUDA_WEBUSER` stored with `\"` escapes — is handled the same
 * way the template handles it.
 *
 * Why the extra variables matter: the vite preset decides whether to impersonate
 * the sandbox gateway with `isLocalDev()`, which requires `MIAODA_LOCAL_DEV`.
 * Without it `/api` requests reach Nest without an `x-larkgw-suda-webuser`
 * header, Nest renders `window.userId = ''`, and the app's access gate spins on
 * "正在检查账号权限" forever.
 *
 * @module lib/template-env
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal dotenv parser: the template's `.env` files are plain `KEY=value` with
 * optional surrounding quotes and no interpolation.
 * @param {string} file - absolute path.
 * @returns {Record<string, string>} parsed pairs.
 */
export function parseEnvFile(file) {
  const values = {};
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return values;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    values[key] = value;
  }
  return values;
}

/**
 * Merge `.env` then `.env.local` (the latter wins), like dotenv does.
 * @param {string} project - project root.
 * @returns {Record<string, string>} merged pairs.
 */
export function readProjectEnv(project) {
  return { ...parseEnvFile(path.join(project, '.env')), ...parseEnvFile(path.join(project, '.env.local')) };
}

/**
 * Apply what `scripts/dev-local.js` does before it spawns vite/nest.
 * @param {Record<string, string | undefined>} [env] - environment to mutate.
 * @returns {string} the `SUDA_WEBUSER` handling result for logging.
 */
export function applyLocalDevEnv(env = process.env) {
  if (!env.MIAODA_APP_TYPE) env.MIAODA_APP_TYPE = '3';
  env.MIAODA_LOCAL_DEV = '1';
  const raw = env.SUDA_WEBUSER;
  if (!raw) return 'missing';
  try {
    JSON.parse(raw);
    return 'ok';
  } catch {
    // the template stores this JSON with escaped quotes; unescape like @lark-apaas
  }
  try {
    const unescaped = raw.replace(/\\"/g, '"');
    JSON.parse(unescaped);
    env.SUDA_WEBUSER = unescaped;
    return 'unescaped';
  } catch {
    return 'invalid';
  }
}
