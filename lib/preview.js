/**
 * Preview bridge — the host half of the conversation 「本地预览」 window.
 *
 * The Web GUI is served from an HTTP origin (`http://127.0.0.1:<port>`), so the
 * client bundle can read the live dev-server state over one exact route served
 * by the harness `webServer` service:
 *
 *   GET  /plugins/dsh-miaoda/preview
 *        → { ok, version, servers[], projects[], now }
 *   POST /plugins/dsh-miaoda/preview   { action: 'start' | 'stop', project? }
 *        → the same snapshot, taken after the action finished
 *
 * This route never widens what the plugin can already do: it drives the very
 * same supervisor the `miaoda_dev` tool uses, and only for projects the plugin
 * can already see. Requests must be same-origin (the GUI origin), which keeps a
 * random page from poking at local dev servers through the harness.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import * as dev from './devserver.js';
import { readProjectMeta, scanProjects } from './runtime.js';
import { currentProject } from './workbench.js';
import { json, readJsonBody, sameOrigin } from './http.js';

export const PREVIEW_ROUTE = '/plugins/dsh-miaoda/preview';

const START_WAIT_MS = 15_000;

/**
 * Ports a dev server started outside this plugin is likely to be on. The Miaoda
 * fullstack template's vite preset binds the client to `CLIENT_DEV_PORT` or
 * 8080 (`strictPort`), with the Nest backend on `SERVER_PORT` or 3000; plain
 * vite projects use 5173. 8080 is first because the preview wants the page,
 * not the API.
 */
const DEFAULT_PORTS = [8080, 5173, 5174, 4173, 3000];

/**
 * Ports a project can be on, from its own `.env.local` / `.env` overrides
 * (`CLIENT_DEV_PORT`, `SERVER_PORT`) before the built-in list.
 * @param {Array<Record<string, any>>} projects - known projects.
 * @returns {number[]}
 */
function candidatePorts(projects) {
  /** @type {number[]} */
  const ports = [];
  const seen = new Set();
  const push = (value) => {
    if (!Number.isInteger(value) || value <= 0 || value >= 65536 || seen.has(value)) return;
    seen.add(value);
    ports.push(value);
  };
  for (const project of projects) {
    const root = typeof project?.root === 'string' ? project.root : '';
    if (root === '') continue;
    for (const name of ['.env.local', '.env']) {
      let text = '';
      try {
        text = fs.readFileSync(path.join(root, name), 'utf8');
      } catch {
        continue;
      }
      for (const key of ['CLIENT_DEV_PORT', 'SERVER_PORT']) {
        const match = new RegExp(`^\\s*${key}\\s*=\\s*["']?(\\d{2,5})`, 'm').exec(text);
        if (match) push(Number(match[1]));
      }
    }
  }
  for (const port of DEFAULT_PORTS) push(port);
  return ports;
}

/**
 * Whether something is listening on a loopback port.
 * Vite/Nest in the 妙搭 template bind `localhost`, which on Windows resolves to
 * IPv6 `::1` only — probing just `127.0.0.1` reports "nothing running" even
 * though the page is up, so both families are checked.
 * @param {number} port - TCP port. @param {number} [timeoutMs] - connect budget.
 * @returns {Promise<boolean>}
 */
export function probePort(port, timeoutMs = 150) {
  const probeHost = (host) =>
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
  return Promise.all([probeHost('::1'), probeHost('127.0.0.1')]).then((results) => results.some(Boolean));
}

/**
 * Whether the server behind a port is the Vite dev server rather than the Nest
 * backend. Both listen on localhost in the fullstack template, and a leftover
 * backend answers `GET /` with its own `Cannot GET /` JSON — which is exactly
 * what a preview window pointed at the wrong port shows. Vite serves its
 * virtual `/@vite/client` module, so that is the cheapest discriminator.
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function looksLikeVite(port, timeoutMs = 800) {
  try {
    const response = await fetch(`http://localhost:${port}/@vite/client`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: '*/*' },
    });
    if (!response.ok) return false;
    const type = response.headers.get('content-type') ?? '';
    if (!/javascript|ecmascript/i.test(type)) return false;
    return /vite/i.test(await response.text());
  } catch {
    return false;
  }
}

/**
 * Find a dev server the plugin did not start — the common case when the user
 * ran `npm run dev` in their own terminal and then opened the preview, which
 * otherwise has no port to point the iframe at.
 * @param {Array<Record<string, any>>} projects - known projects.
 * @returns {Promise<{port: number, url: string, vite: boolean}|undefined>}
 */
async function detectLocalServer(projects) {
  const ports = candidatePorts(projects);
  const results = await Promise.all(ports.map(async (port) => ({ port, open: await probePort(port) })));
  const open = results.filter((entry) => entry.open).map((entry) => entry.port);
  if (open.length === 0) return undefined;
  const flags = await Promise.all(open.map((port) => looksLikeVite(port)));
  const vitePort = open[flags.indexOf(true)];
  const port = vitePort ?? open[0];
  // Miaoda serves every app under its base path, so the page is not at `/`.
  const base = basePathOf(projects);
  return { port, url: `http://localhost:${port}${vitePort === undefined ? '' : base}`, vite: vitePort !== undefined };
}

/**
 * Read `CLIENT_BASE_PATH` out of the project's env files.
 *
 * The fullstack template writes `CLIENT_BASE_PATH="/app/app_xxx"`, and Vite
 * mounts the whole app there — `http://localhost:8080/` only answers with a
 * redirect, which is why a detected server used to open a blank window.
 * @param {Array<Record<string, any>>} projects - candidate projects.
 * @returns {string} normalized base path, or '' when there is none.
 */
export function basePathOf(projects) {
  for (const project of projects ?? []) {
    const root = typeof project?.root === 'string' ? project.root : '';
    if (root === '') continue;
    for (const name of ['.env.local', '.env']) {
      let text = '';
      try {
        text = fs.readFileSync(path.join(root, name), 'utf8');
      } catch {
        continue;
      }
      const match = /^\s*CLIENT_BASE_PATH\s*=\s*(.*)$/m.exec(text);
      if (!match) continue;
      const value = match[1].trim().replace(/^["']|["']$/g, '').trim();
      if (value === '' || value === '/') return '';
      const trimmed = value.replace(/\/+$/, '');
      return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    }
  }
  return '';
}

/**
 * One project as the preview window needs it: a stable root, a display name and
 * whether `npm run dev` even exists (html apps ship without a package.json).
 * @param {string} root - absolute project root.
 * @returns {Record<string, unknown>}
 */
function describeProject(root) {
  const meta = readProjectMeta(root);
  return {
    root,
    name: path.basename(root),
    appId: meta?.appId ?? null,
    hasDevScript: dev.hasDevScript(root),
  };
}

/**
 * Every project the window could offer to run: the configured one, the open
 * workspace, anything this plugin already started, plus one-level scans.
 * @param {Record<string, any>} config - plugin config.
 * @param {Array<Record<string, any>>} servers - current dev-server records.
 * @returns {Array<Record<string, unknown>>}
 */
function discoverProjects(config, servers) {
  /** @type {string[]} */
  const roots = [];
  const seen = new Set();
  const push = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return;
    const root = path.resolve(value);
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    if (seen.has(key) || !fs.existsSync(root)) return;
    seen.add(key);
    roots.push(root);
  };
  const pushIfProject = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return;
    const root = path.resolve(value);
    if (readProjectMeta(root)) push(root);
  };

  pushIfProject(config?.project);
  pushIfProject(process.cwd());
  // The workbench remembers the project the user last opened/cloned; the
  // preview must know it too, otherwise a project living outside this session's
  // workspace never shows up and the window has nothing to start or preview.
  pushIfProject(currentProject()?.root);
  for (const server of servers) push(server.project);
  for (const candidate of scanProjects(process.cwd())) push(candidate);
  return roots.map(describeProject);
}

/**
 * Decide which project a start/stop request is about.
 * @param {Record<string, any>} config - plugin config.
 * @param {unknown} requested - `project` from the request body.
 * @param {Array<Record<string, any>>} servers - current dev-server records.
 * @returns {string|undefined} absolute root.
 */
function resolveProject(config, requested, servers) {
  const candidates = [];
  if (typeof requested === 'string' && requested.trim() !== '') candidates.push(path.resolve(requested));
  if (typeof config?.project === 'string' && config.project.trim() !== '') candidates.push(path.resolve(config.project));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const running = servers.filter((server) => server.running === true && typeof server.url === 'string' && server.url !== '');
  if (running.length > 0) return running[0].project;
  const remembered = currentProject();
  if (remembered && fs.existsSync(remembered.root)) return remembered.root;
  const scanned = scanProjects(process.cwd());
  if (scanned.length === 1) return scanned[0];
  if (readProjectMeta(process.cwd())) return process.cwd();
  if (servers.length === 1) return servers[0].project;
  return undefined;
}

/**
 * Build the request handler for {@link PREVIEW_ROUTE}.
 * @param {{config?: Record<string, any>, version?: string}} [options] - plugin facts.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createPreviewHandler(options = {}) {
  const config = options.config ?? {};
  const version = typeof options.version === 'string' && options.version !== '' ? options.version : '0.0.0';

  return async function previewHandler(req, res) {
    try {
      if (!sameOrigin(req)) {
        json(res, 403, { ok: false, error: 'origin-rejected' });
        return;
      }
      const method = String(req?.method ?? 'GET').toUpperCase();
      if (method === 'GET' || method === 'HEAD') {
        const servers = dev.list();
        json(res, 200, await snapshotOf(servers, version, config));
        return;
      }
      if (method !== 'POST') {
        json(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      const contentType = String(req?.headers?.['content-type'] ?? '').toLowerCase();
      if (!contentType.startsWith('application/json')) {
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
      const action = typeof body?.action === 'string' ? body.action : '';
      if (action !== 'start' && action !== 'stop') {
        json(res, 400, { ok: false, error: 'unsupported-action', action });
        return;
      }
      const before = dev.list();
      const project = resolveProject(config, body?.project, before);
      if (project === undefined) {
        json(res, 409, {
          ok: false,
          error: 'no-project',
          ...(await snapshotOf(before, version, config)),
        });
        return;
      }
      if (action === 'start' && !dev.hasDevScript(project)) {
        json(res, 400, { ok: false, error: 'no-dev-script', project });
        return;
      }
      const port = Number.isInteger(body?.port) && body.port > 0 && body.port < 65536 ? body.port : undefined;
      if (action === 'start') {
        await dev.start(project, { waitMs: START_WAIT_MS, port });
      } else {
        await dev.stop(project);
      }
      const servers = dev.list();
      json(res, 200, { ...(await snapshotOf(servers, version, config)), action, project, port });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(res, 500, { ok: false, error: 'internal', message });
    }
  };
}

/**
 * Add a proxy entry for a dev server this plugin did not start, so the preview
 * window can point at it. Only used while nothing of ours is running.
 * @param {Array<Record<string, any>>} servers - records from the supervisor.
 * @param {Array<Record<string, any>>} projects - known projects.
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function includeDetected(servers, projects) {
  if (servers.some((server) => server.running === true)) return servers;
  const found = await detectLocalServer(projects);
  // A port that answers but is not Vite is the backend (or a leftover of it).
  // Pointing the iframe there only shows the API's 404, so leave the preview in
  // its "nothing detected" state instead of pretending a page is up.
  if (!found || found.vite !== true) return servers;
  const owner = projects[0];
  return servers.concat([
    {
      running: true,
      detected: true,
      project: owner ? owner.root : undefined,
      name: owner ? owner.name : 'localhost',
      url: found.url,
      port: found.port,
      command: 'detected',
      startedAt: new Date().toISOString(),
      logTail: '',
    },
  ]);
}

/**
 * The read model shared by GET and by the tail of a POST.
 * @param {Array<Record<string, any>>} servers - dev-server records.
 * @param {string} version - plugin version.
 * @param {Record<string, any>} config - plugin config.
 * @returns {Promise<Record<string, unknown>>}
 */
async function snapshotOf(servers, version, config) {
  const projects = discoverProjects(config, servers);
  return {
    ok: true,
    version,
    route: PREVIEW_ROUTE,
    now: Date.now(),
    servers: await includeDetected(servers, projects),
    projects,
  };
}

/**
 * Register the preview route on the harness web server, if this profile has one
 * (headless CLI profiles do not).
 * @param {any} root - root cordis context.
 * @param {Record<string, any>} config - plugin config.
 * @param {string} version - plugin version.
 * @returns {void}
 */
export function registerPreviewRoute(root, config, version) {
  if (!root || typeof root.inject !== 'function') return;
  root.inject(['webServer'], (ctx) => {
    const webServer = ctx?.webServer;
    if (!webServer || typeof webServer.register !== 'function') return;
    const handler = createPreviewHandler({ config, version });
    ctx.effect(
      () => webServer.register({ kind: 'exact', path: PREVIEW_ROUTE, handler }),
      'dsh-miaoda: preview route',
    );
  });
}
