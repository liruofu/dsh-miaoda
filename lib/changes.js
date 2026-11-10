/**
 * The "what am I about to publish" view: a VSCode-style change list plus the
 * patch behind each entry.
 *
 * Everything is read with plain `git` (the Miaoda runbook is explicit that code
 * moves through real git, never through a platform shortcut), so this module is
 * only parsing and presentation on top of `git status` / `git diff`.
 *
 * @module lib/changes
 */
import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './runtime.js';

/** Files bigger than this are shown as "binary/too large" instead of a patch. */
const MAX_PATCH_BYTES = 256 * 1024;

/**
 * @typedef {object} ChangeEntry
 * @property {string} path - repo-relative path.
 * @property {string} [from] - previous path for renames/copies.
 * @property {'A'|'M'|'D'|'R'|'C'|'U'} status - single letter for the badge.
 * @property {number} additions - added lines (0 when unknown).
 * @property {number} deletions - removed lines (0 when unknown).
 * @property {boolean} binary - git could not count lines.
 * @property {boolean} untracked - not in the index yet.
 */

/**
 * Map a porcelain `XY` pair onto the one letter a badge should show.
 * @param {string} xy - two-character status code.
 * @returns {'A'|'M'|'D'|'R'|'C'|'U'} badge letter.
 */
export function badgeOf(xy) {
  if (xy === '??') return 'A';
  if (xy.includes('R')) return 'R';
  if (xy.includes('C')) return 'C';
  if (xy.includes('D')) return 'D';
  if (xy.includes('A')) return 'A';
  if (xy.includes('U')) return 'U';
  return 'M';
}

/**
 * Parse `git status --porcelain=v1 -z` output.
 * @param {string} raw - NUL separated porcelain text.
 * @returns {{path: string, from?: string, xy: string}[]} entries in git order.
 */
export function parsePorcelainZ(raw) {
  const tokens = raw.split('\0');
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 4) continue;
    const xy = token.slice(0, 2);
    const file = token.slice(3);
    if (xy === '!!') continue;
    if (xy.includes('R') || xy.includes('C')) {
      const from = tokens[index + 1] ?? '';
      index += 1;
      entries.push({ path: file, from, xy });
      continue;
    }
    entries.push({ path: file, xy });
  }
  return entries;
}

/**
 * Parse `git diff --numstat` output into a path -> counts map.
 * @param {string} raw - tab separated numstat text.
 * @returns {Map<string, {additions: number, deletions: number, binary: boolean}>} counts.
 */
export function parseNumstat(raw) {
  const map = new Map();
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [added, removed, ...rest] = parts;
    const file = rest.join('\t');
    const binary = added === '-' || removed === '-';
    map.set(file, {
      additions: binary ? 0 : Number(added) || 0,
      deletions: binary ? 0 : Number(removed) || 0,
      binary,
    });
  }
  return map;
}

/**
 * Count the lines of an untracked file so it still shows a `+N`.
 * @param {string} file - absolute path.
 * @returns {number} line count, or 0 when unreadable/binary.
 */
function countLines(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_PATCH_BYTES) return 0;
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('\u0000')) return 0;
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    return 0;
  }
}

/**
 * Read the working tree's changes.
 * @param {string} root - repository root.
 * @param {{signal?: AbortSignal}} [options] - abort support.
 * @returns {Promise<{files: ChangeEntry[], summary: {files: number, additions: number, deletions: number, byStatus: Record<string, number>}}>}
 */
export async function collectChanges(root, options = {}) {
  const status = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, signal: options.signal });
  if (!status.ok) return { files: [], summary: { files: 0, additions: 0, deletions: 0, byStatus: {} } };
  const entries = parsePorcelainZ(status.stdout ?? '');
  // One call covers staged + unstaged for every tracked file.
  const numstat = await runGit(['diff', '--numstat', 'HEAD'], { cwd: root, signal: options.signal });
  const counts = parseNumstat(numstat.ok ? (numstat.stdout ?? '') : '');
  /** @type {ChangeEntry[]} */
  const files = [];
  for (const entry of entries) {
    const stats = counts.get(entry.path) ?? counts.get(entry.from ?? '') ?? { additions: 0, deletions: 0, binary: false };
    const untracked = entry.xy === '??';
    files.push({
      path: entry.path,
      from: entry.from,
      status: badgeOf(entry.xy),
      additions: untracked ? countLines(path.join(root, entry.path)) : stats.additions,
      deletions: stats.deletions,
      binary: stats.binary,
      untracked,
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const byStatus = {};
  for (const file of files) byStatus[file.status] = (byStatus[file.status] ?? 0) + 1;
  return {
    files,
    summary: {
      files: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      byStatus,
    },
  };
}

/**
 * The patch for one file, ready to render line by line.
 * Untracked files have no patch, so they get a synthetic all-added body.
 * @param {string} root - repository root.
 * @param {string} file - repo-relative path.
 * @param {{signal?: AbortSignal}} [options] - abort support.
 * @returns {Promise<{path: string, patch: string, binary: boolean, untracked: boolean, truncated: boolean}>}
 */
export async function filePatch(root, file, options = {}) {
  const rel = String(file ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel === '' || rel.includes('..')) {
    return { path: rel, patch: '', binary: false, untracked: false, truncated: false };
  }
  const status = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', rel], { cwd: root, signal: options.signal });
  const entries = parsePorcelainZ(status.stdout ?? '');
  const untracked = entries.some((entry) => entry.xy === '??');
  if (untracked) {
    const absolute = path.join(root, rel);
    let body = '';
    let binary = false;
    let truncated = false;
    try {
      const stat = fs.statSync(absolute);
      if (stat.size > MAX_PATCH_BYTES) {
        truncated = true;
      } else {
        body = fs.readFileSync(absolute, 'utf8');
        if (body.includes('\u0000')) binary = true;
      }
    } catch {
      binary = true;
    }
    if (binary || truncated) return { path: rel, patch: '', binary: true, untracked: true, truncated };
    const lines = body.split('\n');
    return untrackedPatchOf(rel, body);
  }
  const diff = await runGit(['diff', 'HEAD', '--', rel], { cwd: root, signal: options.signal });
  if (!diff.ok) return { path: rel, patch: '', binary: false, untracked: false, truncated: false };
  const patch = diff.stdout ?? '';
  return {
    path: rel,
    patch,
    binary: patch.includes('Binary files') || patch.includes('GIT binary patch'),
    untracked: false,
    truncated: false,
  };
}

/**
 * Synthesize a unified patch for a file git does not track yet.
 *
 * `git diff HEAD` prints nothing for untracked files, but the panel still has to
 * show "brand new file, N added lines" the way an editor does.
 * @param {string} rel - project-relative path.
 * @param {string} body - file contents (size check happens in the caller).
 * @returns {{path:string, patch:string, binary:boolean, untracked:boolean, truncated:boolean}}
 */
export function untrackedPatchOf(rel, body) {
  const clean = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const text = String(body ?? '');
  if (text.includes('\u0000')) {
    return { path: clean, patch: '', binary: true, untracked: true, truncated: false };
  }
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const patch = [
    `diff --git a/${clean} b/${clean}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${clean}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
  return { path: clean, patch, binary: false, untracked: true, truncated: false };
}

/**
 * Split a unified diff into renderable rows.
 * @param {string} patch - unified diff text.
 * @returns {{kind: 'meta'|'hunk'|'add'|'del'|'ctx', text: string}[]} rows.
 */
export function diffRows(patch) {
  /** @type {{kind: 'meta'|'hunk'|'add'|'del'|'ctx', text: string}[]} */
  const rows = [];
  for (const line of String(patch ?? '').split('\n')) {
    if (line === '') continue;
    if (line.startsWith('@@')) rows.push({ kind: 'hunk', text: line });
    else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) {
      rows.push({ kind: 'meta', text: line });
    } else if (line.startsWith('+')) rows.push({ kind: 'add', text: line });
    else if (line.startsWith('-')) rows.push({ kind: 'del', text: line });
    else rows.push({ kind: 'ctx', text: line });
  }
  return rows;
}

/**
 * Stage exactly the given paths.
 * @param {string} root - repository root.
 * @param {string[]} files - repo-relative paths.
 * @param {{signal?: AbortSignal}} [options] - abort support.
 * @returns {Promise<{ok: boolean, error?: string}>} result.
 */
export async function stagePaths(root, files, options = {}) {
  const list = files.filter((file) => typeof file === 'string' && file.trim() !== '');
  if (list.length === 0) return { ok: false, error: '没有选择任何文件' };
  return runGit(['add', '--', ...list], { cwd: root, signal: options.signal });
}
