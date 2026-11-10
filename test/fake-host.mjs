/**
 * 插件合同自测：用一个桩 cordis 上下文加载 lib/index.js 并验证
 *  - apply() 注册了几个工具、几个 skill
 *  - 每个工具定义满足 harness `ctx.tools.register` 的校验规则
 *  - execute() 的返回值满足 output.schema（ok:boolean / text:string，无多余字段）
 *  - render() 返回 [{type:'text', text}]
 * 另外跑一遍纯函数的单元检查（JSON 提取、嵌套取值、dev URL 解析、项目定位）。
 *
 * 直接 `npm test`，不需要启动 DSH。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { apply } = await import('../lib/index.js');
const ops = await import('../lib/ops.js');
const runtime = await import('../lib/runtime.js');
const dev = await import('../lib/devserver.js');
const preview = await import('../lib/preview.js');
const workbench = await import('../lib/workbench.js');

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
};
const checkAsync = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
};

/** 收集注册结果的最小 cordis 替身。 */
function fakeHost() {
  const tools = [];
  const skills = [];
  const disposers = [];
  const logs = [];
  const routes = [];
  const effectLabels = [];
  const ctx = {
    tools: { register: (definition) => { tools.push(definition); } },
    skills: { register: (skill) => { skills.push(skill); return () => {}; } },
    effect: (factory, label) => {
      if (typeof label === 'string') effectLabels.push(label);
      disposers.push(factory());
    },
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message]),
    },
    webServer: {
      register: (route) => {
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index !== -1) routes.splice(index, 1);
        };
      },
    },
  };
  const root = {
    inject: (dependencies, callback) => {
      assert.ok(Array.isArray(dependencies) && dependencies.length > 0, 'inject 需要依赖列表');
      callback(ctx);
    },
  };
  return { root, tools, skills, disposers, logs, routes, effectLabels };
}

/** harness 的 assertSupportedJsonSchema 会拒绝 type 数组，这里同样拒绝。 */
function assertNoTypeArray(schema, where) {
  if (schema === null || typeof schema !== 'object') return;
  if (Array.isArray(schema.type)) throw new Error(`${where}: type 数组不被支持`);
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && value && typeof value === 'object') {
      for (const [name, sub] of Object.entries(value)) assertNoTypeArray(sub, `${where}.properties.${name}`);
    } else if (key === 'items') {
      assertNoTypeArray(value, `${where}.items`);
    } else if (typeof value === 'object' && value !== null) {
      assertNoTypeArray(value, `${where}.${key}`);
    }
  }
}

/** 校验一次工具返回值是否符合 RESULT_SCHEMA。 */
function assertResultShape(value, where) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${where}: 返回值必须是对象`);
  assert.equal(typeof value.ok, 'boolean', `${where}: ok 必须是 boolean`);
  assert.equal(typeof value.text, 'string', `${where}: text 必须是 string`);
  const extra = Object.keys(value).filter((key) => key !== 'ok' && key !== 'text');
  assert.deepEqual(extra, [], `${where}: 有多余字段 ${extra.join(',')}（schema 是 additionalProperties:false）`);
}

console.log('dsh-miaoda 插件合同自测\n');

const host = fakeHost();
apply(host.root, { project: '' });

check('注册了 7 个工具', () => {
  assert.equal(host.tools.length, 7, `实际 ${host.tools.length}`);
});
check('工具名全部以 miaoda_ 开头且唯一', () => {
  const names = host.tools.map((tool) => tool.name);
  assert.ok(names.every((name) => /^miaoda_[a-z]+$/.test(name)), `命名异常: ${names.join(',')}`);
  assert.equal(new Set(names).size, names.length, '工具有重名');
});
check('每个工具都有 description / parameters / output / execute', () => {
  for (const tool of host.tools) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 30, `${tool.name}: description 太短`);
    assert.equal(tool.parameters.type, 'object', `${tool.name}: parameters 必须是 object`);
    assert.ok(tool.parameters.properties, `${tool.name}: 缺少 properties`);
    assert.equal(typeof tool.execute, 'function', `${tool.name}: 缺少 execute`);
    assert.equal(typeof tool.output.render, 'function', `${tool.name}: output.render 必须是函数`);
    assert.equal(typeof tool.output.schema, 'object', `${tool.name}: 缺少 output.schema`);
  }
});
check('没有 type 数组（assertSupportedJsonSchema 会拒绝）', () => {
  for (const tool of host.tools) {
    assertNoTypeArray(tool.parameters, `${tool.name}.parameters`);
    assertNoTypeArray(tool.output.schema, `${tool.name}.output.schema`);
  }
});
check('render 返回 content block', () => {
  for (const tool of host.tools) {
    const blocks = tool.output.render({}, { ok: true, text: 'hello' });
    assert.ok(Array.isArray(blocks) && blocks.length === 1, `${tool.name}: render 必须返回数组`);
    assert.equal(blocks[0].type, 'text');
    assert.equal(blocks[0].text, 'hello');
  }
});
check('注册了 miaoda 技能', () => {
  assert.equal(host.skills.length, 1);
  const skill = host.skills[0];
  assert.equal(skill.name, 'miaoda');
  assert.ok(skill.description.length > 10, 'skill description 太短');
  assert.ok(skill.content.includes('妙搭'), 'skill content 应是 SKILL.md 正文');
  assert.ok(!skill.content.startsWith('---'), 'frontmatter 应被剥离');
  assert.equal(typeof skill.source, 'string');
  assert.equal(skill.provider, 'dsh-miaoda');
});
check('apply 注册了卸载清理', () => {
  assert.ok(host.disposers.length >= 1, '没有 effect 清理器');
  assert.equal(typeof host.disposers[0], 'function');
  assert.ok(host.effectLabels.includes('dsh-miaoda: dev server cleanup'), `effect: ${host.effectLabels.join(' / ')}`);
  assert.ok(host.effectLabels.includes('dsh-miaoda: preview route'), `effect: ${host.effectLabels.join(' / ')}`);
  host.disposers[0](); // 幂等，且不应抛
});

await checkAsync('miaoda_apps action=get 缺 app_id 时优雅失败（不 spawn）', async () => {
  const tool = host.tools.find((item) => item.name === 'miaoda_apps');
  const value = await tool.execute({ action: 'get' }, {});
  assertResultShape(value, 'miaoda_apps');
  assert.equal(value.ok, false);
  assert.match(value.text, /app_id/);
});

await checkAsync('miaoda_pull 未知 mode 时优雅失败', async () => {
  const tool = host.tools.find((item) => item.name === 'miaoda_pull');
  const value = await tool.execute({ mode: 'nope' }, {});
  assertResultShape(value, 'miaoda_pull');
  // 没有 lark-cli 时会先报 lark-cli 缺失，两种失败都可以接受
  assert.equal(value.ok, false);
});

await checkAsync('miaoda_lark 空 argv 时优雅失败', async () => {
  const tool = host.tools.find((item) => item.name === 'miaoda_lark');
  const value = await tool.execute({ argv: [] }, {});
  assertResultShape(value, 'miaoda_lark');
  assert.equal(value.ok, false);
});

console.log('\n预览路由\n');

/** 一个够用的假请求：Readable + method/headers。 */
function fakeRequest({ method = 'GET', url = '/plugins/dsh-miaoda/workbench', headers = {}, body } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  stream.method = method;
  stream.url = url;
  stream.headers = { host: '127.0.0.1:49698', ...headers };
  return stream;
}

/** 记录状态码与 JSON 响应体的假响应。 */
function fakeResponse() {
  const out = { status: 0, body: null };
  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(status) {
      out.status = status;
      res.headersSent = true;
    },
    end(payload) {
      out.body = typeof payload === 'string' ? JSON.parse(payload) : null;
      res.writableEnded = true;
    },
  };
  return { res, out };
}

const route = host.routes.find((item) => item.path === preview.PREVIEW_ROUTE);

check('注册了 exact 预览路由', () => {
  assert.ok(route, `没有注册 ${preview.PREVIEW_ROUTE}`);
  assert.equal(route.kind, 'exact');
  assert.equal(typeof route.handler, 'function');
});

await checkAsync('GET 返回 servers/projects 快照', async () => {
  const { res, out } = fakeResponse();
  await route.handler(fakeRequest(), res);
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.route, preview.PREVIEW_ROUTE);
  assert.equal(typeof out.body.version, 'string');
  assert.ok(Array.isArray(out.body.servers));
  assert.ok(Array.isArray(out.body.projects));
});

await checkAsync('跨源请求被 403 拒绝', async () => {
  const { res, out } = fakeResponse();
  await route.handler(fakeRequest({ headers: { origin: 'http://evil.example' } }), res);
  assert.equal(out.status, 403);
  assert.equal(out.body.error, 'origin-rejected');
});

await checkAsync('同源请求放行', async () => {
  const { res, out } = fakeResponse();
  await route.handler(fakeRequest({ headers: { origin: 'http://127.0.0.1:49698' } }), res);
  assert.equal(out.status, 200);
});

await checkAsync('非 JSON 的 POST 被 415 拒绝', async () => {
  const { res, out } = fakeResponse();
  await route.handler(
    fakeRequest({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"action":"start"}' }),
    res,
  );
  assert.equal(out.status, 415);
});

await checkAsync('未知 action 被 400 拒绝', async () => {
  const { res, out } = fakeResponse();
  await route.handler(
    fakeRequest({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'nuke' }) }),
    res,
  );
  assert.equal(out.status, 400);
  assert.equal(out.body.error, 'unsupported-action');
});

await checkAsync('没有 dev 脚本的项目拒绝 start（不 spawn）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoda-preview-'));
  fs.mkdirSync(path.join(dir, '.spark'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.spark', 'meta.json'), JSON.stringify({ app_id: 'app_preview' }));
  try {
    const { res, out } = fakeResponse();
    await route.handler(
      fakeRequest({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start', project: dir }),
      }),
      res,
    );
    assert.equal(out.status, 400);
    assert.equal(out.body.error, 'no-dev-script');
    assert.equal(out.body.project, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const wbRoute = host.routes.find((item) => item.path === workbench.WORKBENCH_ROUTE);
const qrRoute = host.routes.find((item) => item.path === workbench.WORKBENCH_QR_ROUTE);

check('注册了工作台路由与二维码路由', () => {
  assert.ok(wbRoute, `没有注册 ${workbench.WORKBENCH_ROUTE}`);
  assert.ok(qrRoute, `没有注册 ${workbench.WORKBENCH_QR_ROUTE}`);
  assert.equal(wbRoute.kind, 'exact');
  assert.equal(qrRoute.kind, 'exact');
  assert.equal(typeof wbRoute.handler, 'function');
  assert.equal(typeof qrRoute.handler, 'function');
  assert.ok(host.effectLabels.includes('dsh-miaoda: workbench route'), `effect: ${host.effectLabels.join(' / ')}`);
});

await checkAsync('工作台 GET 返回快照', async () => {
  const { res, out } = fakeResponse();
  await wbRoute.handler(fakeRequest(), res);
  assert.equal(out.status, 200, `status ${out.status} ${JSON.stringify(out.body)}`);
  assert.equal(out.body.ok, true);
  assert.equal(typeof out.body.version, 'string');
  assert.ok(Array.isArray(out.body.servers));
  assert.ok(Array.isArray(out.body.candidateDirs));
  assert.ok(Array.isArray(out.body.locals), '本地项目列表应是数组');
  assert.equal(typeof out.body.baseDir, 'string');
  assert.ok(path.isAbsolute(out.body.baseDir), `baseDir 不是绝对路径: ${out.body.baseDir}`);
  assert.ok(
    ['custom', 'workspace', 'cwd', 'fallback'].includes(out.body.baseDirSource),
    `baseDirSource 未知: ${out.body.baseDirSource}`,
  );
  assert.ok(Array.isArray(out.body.workspaces), '缺少 workspaces 列表');
  assert.ok(out.body.login, '缺少 login 状态');
  assert.ok(out.body.task, '缺少 task 状态');
});

await checkAsync('工作台 light 快照不依赖子进程也能返回', async () => {
  const { res, out } = fakeResponse();
  await wbRoute.handler(fakeRequest({ url: '/plugins/dsh-miaoda/workbench?light=1' }), res);
  assert.equal(out.status, 200, `status ${out.status} ${JSON.stringify(out.body)}`);
  assert.equal(out.body.ok, true);
  assert.ok(out.body.auth && typeof out.body.auth === 'object');
});

await checkAsync('工作台 base 拒绝相对路径并接受恢复默认', async () => {
  const { res, out } = fakeResponse();
  await wbRoute.handler(
    fakeRequest({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'base', dir: 'relative/dir' }),
    }),
    res,
  );
  assert.equal(out.status, 400);
  assert.equal(out.body.error, 'invalid-base-dir');

  const reset = fakeResponse();
  await wbRoute.handler(
    fakeRequest({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'base', dir: '' }),
    }),
    reset.res,
  );
  assert.equal(reset.out.status, 200, JSON.stringify(reset.out.body));
  assert.equal(reset.out.body.baseDirSource === 'custom', false);
});

await checkAsync('工作台跨源请求被 403 拒绝', async () => {
  const { res, out } = fakeResponse();
  await wbRoute.handler(fakeRequest({ headers: { origin: 'http://evil.example' } }), res);
  assert.equal(out.status, 403);
  assert.equal(out.body.error, 'origin-rejected');
});

await checkAsync('工作台非 JSON POST 被 415 拒绝', async () => {
  const { res, out } = fakeResponse();
  await wbRoute.handler(
    fakeRequest({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"action":"login"}' }),
    res,
  );
  assert.equal(out.status, 415);
  assert.equal(out.body.error, 'content-type-must-be-json');
});

await checkAsync('工作台未知 action 被 400 拒绝', async () => {
  const { res, out } = fakeResponse();
  await wbRoute.handler(
    fakeRequest({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'nuke' }),
    }),
    res,
  );
  assert.equal(out.status, 400);
  assert.equal(out.body.error, 'unsupported-action');
});

await checkAsync('工作台 select 非妙搭目录被 400 拒绝', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoda-wb-plain-'));
  try {
    const { res, out } = fakeResponse();
    await wbRoute.handler(
      fakeRequest({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'select', root: dir }),
      }),
      res,
    );
    assert.equal(out.status, 400);
    assert.equal(out.body.error, 'not-a-miaoda-project');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await checkAsync('二维码路由在没有二维码时回 404', async () => {
  const { res, out } = fakeResponse();
  await qrRoute.handler(fakeRequest(), res);
  assert.equal(out.status, 404);
  assert.equal(out.body.error, 'no-qr');
});

console.log('\n单元检查\n');

check('extractJson 能从混合输出里取出 JSON', () => {
  assert.deepEqual(runtime.extractJson('log line\n{"ok":true,"data":{"a":1}}'), { ok: true, data: { a: 1 } });
  assert.deepEqual(runtime.extractJson('{"ok":true}'), { ok: true });
  assert.equal(runtime.extractJson('not json at all'), undefined);
});
check('findScalar 能穿透嵌套结构取值', () => {
  const payload = { data: { release: { release_id: 'release_1', current_node_info: { current_status: 'PENDING' } } } };
  assert.equal(runtime.findScalar(payload, ['release_id']), 'release_1');
  assert.equal(runtime.findScalar(payload, ['current_status']), 'PENDING');
  assert.equal(runtime.findScalar(payload, ['nope']), undefined);
});
check('parseServedUrl 识别常见 dev server 输出', () => {
  assert.deepEqual(dev.parseServedUrl('  VITE ready in 512 ms\n  Local: http://localhost:5173/'), { port: 5173, url: 'http://localhost:5173' });
  assert.deepEqual(dev.parseServedUrl('ready on http://127.0.0.1:3000'), { port: 3000, url: 'http://localhost:3000' });
  assert.equal(dev.parseServedUrl('no url here'), undefined);
});
check('parseServedUrl 保留 base path（妙搭页面在 /app/<appId>/ 下）', () => {
  assert.deepEqual(dev.parseServedUrl('[client]   ➜  Local:   http://localhost:8080/app/app_xxxxxxxx/'), {
    port: 8080,
    url: 'http://localhost:8080/app/app_xxxxxxxx',
  });
  assert.deepEqual(dev.parseServedUrl('Local: http://localhost:8080/app/app_x/,'), {
    port: 8080,
    url: 'http://localhost:8080/app/app_x',
  });
});
check('devCommand 对妙搭全栈模板直接起 vite + nest，不经 shell', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoda-tpl-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: './scripts/dev.sh' } }));
  fs.writeFileSync(path.join(root, 'vite.config.ts'), 'export default {}\n');
  fs.mkdirSync(path.join(root, 'server'), { recursive: true });
  for (const entry of ['node_modules/vite/bin/vite.js', 'node_modules/@nestjs/cli/bin/nest.js']) {
    const file = path.join(root, entry);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '// stub\n');
  }
  const picked = dev.devCommand(root, 'dev');
  assert.match(picked.command, /dev-launcher\.mjs/, '模板项目应走 dev-launcher');
  assert.match(picked.command, /^".*" ".*dev-launcher\.mjs"$/, '路径要带引号，防止空格被 cmd 拆开');
  assert.ok(Array.isArray(picked.argv) && picked.argv[1].endsWith('dev-launcher.mjs'), '要给 watchdog 一份 argv，绕开 shell');
  // 关掉开关后回到老路径（这个临时项目没有 dev-local.js，于是回退到 npm）
  process.env.MIAODA_NO_DIRECT_LAUNCH = '1';
  try {
    assert.equal(dev.devCommand(root, 'dev').command, 'npm run dev');
  } finally {
    delete process.env.MIAODA_NO_DIRECT_LAUNCH;
  }
  fs.rmSync(root, { recursive: true, force: true });
});
check('template-env 复刻 dev-local.js：MIAODA_LOCAL_DEV 与 SUDA_WEBUSER 反转义', async () => {
  const { applyLocalDevEnv, readProjectEnv } = await import('../lib/template-env.mjs');
  const env = { SUDA_WEBUSER: '{\\"user_id\\":\\"42\\"}' };
  delete env.MIAODA_LOCAL_DEV;
  const result = applyLocalDevEnv(env);
  assert.equal(env.MIAODA_LOCAL_DEV, '1', '没有 MIAODA_LOCAL_DEV，vite 预设就不注入 x-larkgw-suda-webuser 身份头');
  assert.equal(env.MIAODA_APP_TYPE, '3', '模板 dev-local.js 也会补 MIAODA_APP_TYPE');
  assert.equal(result, 'unescaped');
  assert.deepEqual(JSON.parse(env.SUDA_WEBUSER), { user_id: '42' }, 'SUDA_WEBUSER 必须是合法 JSON');
  // 已经是合法 JSON 时不改写
  const env2 = { SUDA_WEBUSER: '{\"a\":1}' };
  assert.equal(applyLocalDevEnv(env2), 'ok');
  // 读 .env 文件：.env.local 覆盖 .env
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoda-env-'));
  fs.writeFileSync(path.join(dir, '.env'), 'A=1\nB=2\n');
  fs.writeFileSync(path.join(dir, '.env.local'), 'B=3\nCLIENT_BASE_PATH="/app/app_1"\n');
  assert.deepEqual(readProjectEnv(dir), { A: '1', B: '3', CLIENT_BASE_PATH: '/app/app_1' });
  fs.rmSync(dir, { recursive: true, force: true });
});
check('urlLineScore 优先 client 的 Local 行，其次普通行，最后 server 行', () => {
  const client = dev.urlLineScore('[client]   ➜  Local:   http://localhost:5173/');
  const plain = dev.urlLineScore('  Local: http://localhost:5173/');
  const server = dev.urlLineScore('[server] listening on http://localhost:3000');
  assert.ok(client >= plain, `client ${client} 应不弱于 plain ${plain}`);
  assert.ok(plain > server, `plain ${plain} 应强于 server ${server}`);
  // 启动器自己打印的那行是权威来源（带 base path），要压过 vite 的 Local 行
  const banner = dev.urlLineScore('[dev-launcher] 页面地址: http://localhost:8080/app/app_x/');
  assert.ok(banner > client, `banner ${banner} 应强于 client ${client}`);
});
check('pageBase 从 .env.local 取页面 base，并归一化成 /app/xxx', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoda-base2-'));
  fs.writeFileSync(path.join(dir, '.env.local'), 'CLIENT_BASE_PATH="/app/app_9/"\n');
  assert.equal(dev.pageBase(dir), '/app/app_9');
  fs.writeFileSync(path.join(dir, '.env.local'), 'CLIENT_BASE_PATH=app_9\n');
  assert.equal(dev.pageBase(dir), '/app_9');
  fs.writeFileSync(path.join(dir, '.env.local'), 'OTHER=1\n');
  assert.equal(dev.pageBase(dir), '');
  fs.rmSync(dir, { recursive: true, force: true });
});
check('devCommand 绕过 bash 入口，直接跑 scripts/dev-local.js', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoda-devcmd-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: './scripts/dev.sh' } }));
  // 还没同步出 dev-local.js：回退到 npm run dev（让 npm 报真实的错）
  assert.equal(dev.devCommand(root, 'dev').command, 'npm run dev');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'dev-local.js'), '// stub\n');
  assert.equal(dev.devCommand(root, 'dev').command, 'node scripts/dev-local.js');
  // 普通 npm 脚本不受影响
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  assert.equal(dev.devCommand(root, 'dev').command, 'npm run dev');
  fs.rmSync(root, { recursive: true, force: true });
});
await checkAsync('probePort 只认真正监听中的端口', async () => {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal(await preview.probePort(port), true, `端口 ${port} 应该在监听`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await preview.probePort(port), false, `端口 ${port} 已关闭`);
});
await checkAsync('probePort 认识只绑 ::1 的 dev server（Windows 上 localhost 走 IPv6）', async () => {
  const { createServer } = await import('node:net');
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '::1', resolve);
    });
  } catch {
    // 本机没有 IPv6 回环时跳过，避免把环境问题算成回归
    return;
  }
  const port = server.address().port;
  try {
    assert.equal(await preview.probePort(port), true, `只绑 ::1 的端口 ${port} 应该被识别`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
check('basePathOf 从 .env.local 读出妙搭页面的 base path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoda-base-'));
  try {
    fs.writeFileSync(path.join(root, '.env.local'), 'CLIENT_BASE_PATH="/app/app_xxxxxxxx"\nX=1\n');
    assert.equal(preview.basePathOf([{ root }]), '/app/app_xxxxxxxx');
    fs.writeFileSync(path.join(root, '.env.local'), 'CLIENT_BASE_PATH=\n');
    assert.equal(preview.basePathOf([{ root }]), '', '空值表示没有 base');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(preview.basePathOf([]), '');
});
await checkAsync('looksLikeVite 不会把后端端口当成页面', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"code":"NOT_FOUND","message":"Cannot GET /"}}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal(await preview.looksLikeVite(port), false, '后端 404 不应被当成 Vite');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
await checkAsync('pickFreePort 跳过被占用的端口（残留 dev server 不该让 Vite 直接退出）', async () => {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const taken = server.address().port;
  try {
    const port = await dev.pickFreePort(taken, new Set());
    assert.notEqual(port, taken, '被占用的端口必须跳过');
    assert.ok(port > taken && port < taken + 40, `应顺延到附近的空闲端口，实际 ${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
await checkAsync('esm-path-hook 让 import("C:\\…") 可用（模板 postinstall 的崩因）', async () => {
  if (process.platform !== 'win32') return; // 只有 Windows 的盘符路径会触发 ERR_UNSUPPORTED_ESM_URL_SCHEME
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-miaoda-esm-'));
  const file = path.join(dir, 'probe.mjs');
  fs.writeFileSync(file, 'export default "ok";\n', 'utf8');
  try {
    await import('../lib/esm-path-hook.mjs');
    const mod = await import(file);
    assert.equal(mod.default, 'ok', '钩子应把 C:\\… 改写成 file:// 后成功加载');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
check('watchdogCommand 用 node 包一层，父进程 pid 传自己（DSH 退出后不留孤儿）', () => {
  const wrapped = dev.watchdogCommand('npm run dev');
  if (!wrapped) return; // 机器上没有独立 node 时退回 shell，行为与旧版一致
  assert.ok(wrapped.args[0].endsWith('dev-watchdog.mjs'), `第一个参数应是 watchdog 脚本：${wrapped.args[0]}`);
  assert.equal(wrapped.args[1], String(process.pid), 'watchdog 要盯着当前进程');
  assert.equal(wrapped.args[2], 'npm run dev', '命令原样透传');
  assert.ok(fs.existsSync(wrapped.file), 'node 可执行文件应存在');
  // argv 形式走 `--`，绕开 cmd.exe 对内部引号的拆解
  const direct = dev.watchdogCommand(['C:\\Program Files\\nodejs\\node.exe', 'C:\\a b\\launcher.mjs']);
  if (direct) {
    assert.equal(direct.args[2], '--');
    assert.deepEqual(direct.args.slice(3), ['C:\\Program Files\\nodejs\\node.exe', 'C:\\a b\\launcher.mjs']);
  }
});
check('watchdog 脚本与 ESM hook 都在，且 files 覆盖 .mjs/.cjs（发布时不丢）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
  for (const name of ['lib/dev-watchdog.mjs', 'lib/esm-path-hook.mjs', 'lib/npx-shim.cjs']) {
    assert.ok(fs.existsSync(path.join(PKG_ROOT, name)), `${name} 应存在`);
  }
  assert.ok(pkg.files.includes('lib/**/*.mjs'), 'files 必须包含 .mjs');
  assert.ok(pkg.files.includes('lib/**/*.cjs'), 'files 必须包含 .cjs');
  const src = fs.readFileSync(path.join(PKG_ROOT, 'lib/dev-watchdog.mjs'), 'utf8');
  assert.ok(src.includes('parentAlive'), 'watchdog 需要探测父进程存活');
  assert.ok(src.includes('taskkill'), 'watchdog 需要用 taskkill /T 收掉整棵树');
});
await checkAsync('reapOrphans 只收拾上一个会话的孤儿，不动本会话与还活着的宿主（dryRun）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoda-home-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const lock = {
      'C:/p/own': { pid: process.pid, hostPid: process.pid },
      'C:/p/orphan': { pid: process.pid, hostPid: 999999 },
      'C:/p/gone': { pid: 999998, hostPid: 999999 },
      'C:/p/other-window': { pid: 999997, hostPid: process.pid },
    };
    fs.writeFileSync(path.join(home, 'miaoda-dev-servers.json'), JSON.stringify(lock));
    const result = await dev.reapOrphans({ dryRun: true, verify: async () => true });
    assert.deepEqual(result.kept.sort(), [process.pid, 999997].sort(), `本会话与其它窗口的条目应保留，实际 ${JSON.stringify(result.kept)}`);
    assert.deepEqual(result.reaped, [process.pid], `只应把孤儿（宿主已死但进程还在）算作待清理，实际 ${JSON.stringify(result.reaped)}`);
    assert.ok(result.skipped.includes(999998), '已经退出的进程只记录、不 kill');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
check('riskyChanges 拦住密钥和资源文件', () => {
  const risk = ops.riskyChanges([
    ' M src/App.tsx',
    '?? .env.local',
    '?? .env.example',
    ' M public/logo.png',
    'R  old.png -> new.png',
    '?? deploy_key.pem',
    ' M README.md',
  ]);
  assert.deepEqual(risk.secrets, ['.env.local', 'deploy_key.pem']);
  assert.deepEqual(risk.resources, ['public/logo.png', 'new.png']);
  assert.deepEqual(ops.riskyChanges([' M src/App.tsx']), { secrets: [], resources: [] });
});
check('describeLarkError 拼出可读错误', () => {
  const text = runtime.describeLarkError({ ok: false, error: { type: 'internal', message: 'boom', hint: 'retry' } });
  assert.match(text, /boom/);
  assert.match(text, /retry/);
});
check('locateProject 找不到项目时抛带 hint 的 MiaodaError', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoda-empty-'));
  const previous = process.cwd();
  try {
    process.chdir(empty);
    assert.throws(() => ops.locateProject({}, {}), (error) => error instanceof ops.MiaodaError && typeof error.hint === 'string');
  } finally {
    process.chdir(previous);
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
check('locateProject 能识别 .spark/meta.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoda-proj-'));
  fs.mkdirSync(path.join(dir, '.spark'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.spark', 'meta.json'), JSON.stringify({ app_id: 'app_test123' }));
  try {
    const project = ops.locateProject({ project: dir }, {});
    assert.equal(project.appId, 'app_test123');
    assert.equal(project.root, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
check('hasDevScript 读 package.json 的 scripts.dev', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoda-pkg-'));
  try {
    assert.equal(dev.hasDevScript(dir), false, '空目录应无 dev 脚本');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    assert.equal(dev.hasDevScript(dir), true);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { 'dev:local': 'node dev.js' } }));
    assert.equal(dev.hasDevScript(dir), true, '只有 dev:local 也算能启动');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
check('preferredScript 默认用 dev，可用 MIAODA_DEV_SCRIPT 覆盖', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoda-script-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', 'dev:local': 'node dev.js' } }));
    assert.equal(dev.preferredScript(dir), 'dev', '默认走模板官方入口');
    process.env.MIAODA_DEV_SCRIPT = 'dev:local';
    assert.equal(dev.preferredScript(dir), 'dev:local', '环境变量可以强制指定');
    delete process.env.MIAODA_DEV_SCRIPT;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
check('pullStaged 拒绝非法 appId 与非空目录（不 spawn 子进程）', async () => {
  const cli = { node: process.execPath, entry: path.join(os.tmpdir(), 'missing-cli.js') };
  await assert.rejects(() => ops.pullStaged(cli, { appId: 'bad-id' }), /app_id 格式不对/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoda-pull-'));
  try {
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
    await assert.rejects(() => ops.pullStaged(cli, { appId: 'app_abc123', dir }), /目标目录不是空的/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
check('refreshGitCredential 在不存在的 app 上返回 false 而不抛', async () => {
  const cli = runtime.resolveLarkCli();
  if (!cli) return; // 没装 lark-cli 的机器跳过
  const ok = await ops.refreshGitCredential(cli, 'app_doesnotexist000', {});
  assert.equal(typeof ok, 'boolean');
});

// #region change list (VSCode-style "what changed")
const changes = await import('../lib/changes.js');

check('changes: badgeOf 把 porcelain 状态映射成单字母徽章', () => {
  assert.equal(changes.badgeOf('??'), 'A');
  assert.equal(changes.badgeOf(' M'), 'M');
  assert.equal(changes.badgeOf('M '), 'M');
  assert.equal(changes.badgeOf('AD'), 'D');
  assert.equal(changes.badgeOf(' D'), 'D');
  assert.equal(changes.badgeOf('R '), 'R');
  assert.equal(changes.badgeOf('C M'), 'C');
  assert.equal(changes.badgeOf('UU'), 'U');
});

check('changes: parsePorcelainZ 解析 -z 输出并在重命名时带出原名', () => {
  const raw = [' M src/a.ts', '?? src/b.ts', 'R  src/new.ts\0src/old.ts', ' D src/c.ts'].join('\0') + '\0';
  const entries = changes.parsePorcelainZ(raw);
  assert.deepEqual(entries[0], { path: 'src/a.ts', xy: ' M' });
  assert.deepEqual(entries[1], { path: 'src/b.ts', xy: '??' });
  assert.equal(entries[2].path, 'src/new.ts');
  assert.equal(entries[2].from, 'src/old.ts');
  assert.deepEqual(entries[3], { path: 'src/c.ts', xy: ' D' });
});

check('changes: parseNumstat 读出增删行数并标记二进制', () => {
  const stats = changes.parseNumstat('12\t3\tsrc/a.ts\n-\t-\tlogo.png\n0\t40\tsrc/c.ts\n');
  assert.deepEqual(stats.get('src/a.ts'), { additions: 12, deletions: 3, binary: false });
  assert.deepEqual(stats.get('logo.png'), { additions: 0, deletions: 0, binary: true });
  assert.deepEqual(stats.get('src/c.ts'), { additions: 0, deletions: 40, binary: false });
});

check('changes: diffRows 区分 meta/hunk/add/del/ctx', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
  ].join('\n');
  const kinds = changes.diffRows(patch).map((row) => row.kind);
  assert.deepEqual(kinds, ['meta', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add', 'add']);
  assert.equal(changes.diffRows(patch)[7].text, '+const b = 3;');
});

check('changes: 未跟踪文件也能给出可显示的补丁', () => {
  const result = changes.untrackedPatchOf('new.txt', 'one\ntwo\n');
  assert.match(result.patch, /^diff --git a\/new\.txt b\/new\.txt/);
  assert.match(result.patch, /new file mode/);
  assert.match(result.patch, /@@ -0,0 \+1,2 @@/);
  assert.match(result.patch, /\+one/);
  assert.match(result.patch, /\+two/);
  assert.equal(result.untracked, true);
  assert.equal(changes.untrackedPatchOf('bin.dat', 'a\u0000b').binary, true);
});

check('changes: describeChanges 给出文件数、增删与逐行清单', () => {
  const summary = ops.describeChanges(
    {
      files: [
        { path: 'src/a.ts', status: 'M', additions: 12, deletions: 3 },
        { path: 'src/b.ts', status: 'A', additions: 8, deletions: 0, untracked: true },
      ],
      summary: { files: 2, additions: 20, deletions: 3, byStatus: { M: 1, A: 1 } },
    },
    { appId: 'app_abc123' },
  );
  assert.match(summary, /2 个文件/);
  assert.match(summary, /\+20 −3/);
  assert.match(summary, /src\/a\.ts/);
  assert.match(summary, /src\/b\.ts/);
  assert.match(summary, /M/);
  assert.match(summary, /A/);
});

check('changes: describeChanges 对空改动给出明确提示', () => {
  const text = ops.describeChanges({ files: [], summary: { files: 0, additions: 0, deletions: 0, byStatus: {} } }, {});
  assert.match(text, /没有需要发布|干净/);
});
check('publish: 没有 git 身份时用登录身份兜底，且只通过 -c 传给 commit', () => {
  // 机器上配了身份就不要多管闲事。
  assert.deepEqual(ops.identityArgs({ name: '张三', email: 'zhangsan@test.com' }), []);
  // 全新 clone 没有任何身份：用当前登录的妙搭用户兜底。
  assert.deepEqual(ops.identityArgs({ userName: '张三', openId: 'ou_1234567890abcdef1234567890abcdef' }), [
    '-c',
    'user.name=张三',
    '-c',
    'user.email=ou1234567890abcdef1234567890abcdef@miaoda.local',
  ]);
  // 连登录态都拿不到时也要能提交，不能因为身份缺失把发布卡死。
  assert.deepEqual(ops.identityArgs({}), ['-c', 'user.name=Miaoda User', '-c', 'user.email=miaoda@miaoda.local']);
  // 只有一半配置时，只补缺的那一半。
  const half = ops.identityArgs({ name: '张三', openId: 'ou_abc' });
  assert.equal(half[1], 'user.name=张三');
  assert.equal(half[3], 'user.email=ouabc@miaoda.local');
  const emailOnly = ops.identityArgs({ email: 'x@y.z' });
  assert.equal(emailOnly.length, 4);
  assert.equal(emailOnly[3], 'user.email=x@y.z');
});
// #endregion

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
