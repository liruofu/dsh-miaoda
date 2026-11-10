/**
 * 客户端 bundle 冒烟测试：在 vm 里按 harness 的方式加载 lib/client.js，
 * 用假的 __ModuleLoader__ / react / document / fetch 跑一遍。
 *
 * 验证：
 *  - bundle 外壳只 regist 一个 factory，id 与包名一致，require 只碰平台模块
 *  - apply() 注册了三个界面：会话 View、右栏 tab 类型 + 主体、工具卡
 *  - 没有右栏服务时 apply() 也不抛（headless profile 也要能加载）
 *  - 组件真的能渲染：空态、有运行中 dev server 时的 iframe、工具卡的结果态
 *  - 工具卡上的「打开预览」按钮真的走到 sidebarRight.openTab
 *  - 纯函数：normalizeUrl / parseDevText / blockPhase / resultText / displayPath
 *
 * 直接 `node test/client-smoke.mjs`，不需要启动 DSH。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');

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

// #region fake platform
const entries = [];
const styles = [];
const cleanups = [];
const timers = { set: 0, clear: 0 };

function createElement(type, props, ...children) {
  const next = Object.assign({}, props || {});
  next.children = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
  return { type, props: next };
}

/**
 * 假 hooks：状态永远是初始值，effect 立即执行，但会记下每个组件实例的 hook 数，
 * 供「hook 顺序回归」检查比对两趟渲染（React #310 就是两趟 hook 数不一致）。
 */
const hookFrames = [];
const hookProfile = { current: null };

function countHook() {
  const frame = hookFrames[hookFrames.length - 1];
  if (frame) frame.count += 1;
}

const fakeReact = {
  createElement,
  useState: (initial) => {
    countHook();
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useEffect: (fn) => {
    countHook();
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
  },
  useMemo: (fn) => {
    countHook();
    return fn();
  },
  useCallback: (fn) => {
    countHook();
    return fn;
  },
  useSyncExternalStore: (_subscribe, getSnapshot) => {
    countHook();
    return getSnapshot();
  },
};

const fetchLog = [];

const sandbox = {
  console,
  URL,
  JSON,
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => {
    timers.set += 1;
    return 0;
  },
  clearInterval: () => {
    timers.clear += 1;
  },
  window: {
    __ModuleLoader__: { load: (entry) => entries.push(entry) },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    open: () => null,
  },
  document: {
    createElement: () => ({ dataset: {}, style: {}, remove: () => {} }),
    head: { appendChild: (element) => styles.push(element) },
    body: { appendChild: () => {}, removeChild: () => {} },
  },
  navigator: { clipboard: { writeText: async () => {} } },
  fetch: async (url, init) => {
    fetchLog.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body });
    return {
      ok: true,
      json: async () => ({ ok: true, version: '0.1.0', servers: [], projects: [] }),
    };
  },
};
// #endregion

console.log('dsh-miaoda 客户端 bundle 冒烟测试\n');

const context = vm.createContext(sandbox);
vm.runInContext(source, context, { filename: 'lib/client.js' });

check('bundle 外壳只注册一个入口，id 是包名', () => {
  assert.equal(entries.length, 1, `实际 ${entries.length} 个入口`);
  assert.equal(entries[0].id, 'dsh-miaoda');
  assert.equal(typeof entries[0].factory, 'function');
});

const mod = entries[0].factory((id) => {
  if (id === 'react') return fakeReact;
  throw new Error(`客户端不应该 require "${id}"（只允许平台模块）`);
});

check('导出 name / inject / apply', () => {
  assert.equal(mod.name, 'dsh-miaoda');
  assert.deepEqual([...mod.inject], ['slots', 'locale']);
  assert.equal(typeof mod.apply, 'function');
  assert.equal(mod.__internals.ROUTE, '/plugins/dsh-miaoda/preview');
  assert.equal(mod.__internals.VIEW_ID, 'miaoda-preview');
  assert.equal(mod.__internals.SIDEBAR_KIND, 'dsh-miaoda-preview');
});

// #region 注册
const sidebarOpenCalls = [];
const sidebarController = {
  openTab: (kind, options) => {
    sidebarOpenCalls.push({ kind, options });
  },
};

/**
 * 造一个够用的 client ctx：slots.inject 同步展开，注入的 owner 带 slots/effect。
 * @param {{sidebar?: boolean}} [options]
 */
function makeCtx(options = {}) {
  const bucket = [];
  const effectLabels = [];
  const tabTypes = [];
  const lang = { active: 'zh-CN' };

  const baseHost = {
    effect(fn, label) {
      effectLabels.push(label);
      const dispose = fn();
      if (typeof dispose === 'function') cleanups.push(dispose);
      return dispose;
    },
    slots: {
      inject(name, factory) {
        const registration = factory();
        bucket.push({ slot: name, registration });
        return registration;
      },
      register(defn, component) {
        return { defn, component };
      },
    },
  };

  const tabs = {
    register: (defn) => {
      tabTypes.push(defn);
      return () => {};
    },
  };

  const ctx = {
    effect: baseHost.effect,
    slots: baseHost.slots,
    locale: {
      getSnapshot: () => ({ active: lang.active }),
      subscribe: () => () => {},
    },
    get: (name) => (name === 'sidebarRight' ? sidebarController : undefined),
    inject: (deps, callback) => {
      if (!deps.includes('sidebarRightTabs')) throw new Error(`unexpected inject: ${deps.join(',')}`);
      if (options.sidebar === false) return;
      callback({
        ...baseHost,
        get: (name) => (name === 'sidebarRightTabs' ? tabs : undefined),
      });
    },
  };

  return { ctx, bucket, effectLabels, tabTypes };
}

const host = makeCtx();
mod.apply(host.ctx);

check('注入预览样式表', () => {
  assert.ok(host.effectLabels.includes('dsh-miaoda: preview styles'), `effect: ${host.effectLabels.join(' / ')}`);
  const style = styles.find((element) => element.dataset && element.dataset.plugin === 'dsh-miaoda');
  assert.ok(style, '没有找到 <style data-plugin="dsh-miaoda">');
  assert.ok(String(style.textContent).includes('.dsh-md'), '样式内容为空');
});

check('注册会话 View「本地预览」', () => {
  const entry = host.bucket.find((item) => item.slot === 'conversation.view');
  assert.ok(entry, '没有注册 conversation.view');
  assert.equal(entry.registration.defn.id, 'miaoda-preview');
  assert.equal(entry.registration.defn.name, 'conversation.view');
  assert.equal(typeof entry.registration.defn.label(), 'string');
  assert.equal(typeof entry.registration.component, 'function');
});

check('注册工具卡 miaoda_dev', () => {
  const entry = host.bucket.find((item) => item.slot === 'tool.call.toolview');
  assert.ok(entry, '没有注册 tool.call.toolview');
  assert.equal(entry.registration.defn.key, 'miaoda_dev');
});

check('注册右栏 tab 类型与主体', () => {
  assert.equal(host.tabTypes.length, 2, `注册了 ${host.tabTypes.length} 个 tab 类型`);
  const tab = host.tabTypes.find((item) => item.id === 'dsh-miaoda/preview');
  assert.ok(tab, '没有注册预览 tab 类型');
  assert.equal(tab.id, 'dsh-miaoda/preview');
  assert.equal(tab.kind, 'dsh-miaoda-preview');
  assert.equal(tab.priority, 'extension');
  assert.equal(typeof tab.title(), 'string');
  assert.ok(Array.isArray(tab.guide) && tab.guide.length > 0, '缺少 guide');
  const bodies = host.bucket.filter((item) => item.slot === 'sidebar.right.pane.tab');
  assert.equal(bodies.length, 2, `右栏主体 ${bodies.length} 个`);
  assert.deepEqual(
    bodies.map((item) => item.registration.defn.key).sort(),
    ['dsh-miaoda/preview', 'dsh-miaoda/workbench'],
  );
});

check('注册工作台 tab 类型与主体', () => {
  const tab = host.tabTypes.find((item) => item.id === 'dsh-miaoda/workbench');
  assert.ok(tab, '没有注册工作台 tab 类型');
  assert.equal(tab.kind, 'dsh-miaoda-workbench');
  assert.equal(tab.priority, 'extension');
  assert.equal(typeof tab.title(), 'string');
  assert.ok(tab.title().includes('妙搭'), `标题不对：${tab.title()}`);
  assert.ok(Array.isArray(tab.guide) && tab.guide.length > 0);
  const body = host.bucket.find(
    (item) => item.slot === 'sidebar.right.pane.tab' && item.registration.defn.key === 'dsh-miaoda/workbench',
  );
  assert.ok(body, '没有注册工作台主体');
  assert.equal(typeof body.registration.component, 'function');
});

check('没有右栏服务的 profile 里 apply 不抛', () => {
  const lonely = makeCtx({ sidebar: false });
  assert.doesNotThrow(() => mod.apply(lonely.ctx));
  assert.equal(lonely.tabTypes.length, 0);
  assert.ok(lonely.bucket.some((item) => item.slot === 'conversation.view'), '会话 View 应照样注册');
});
// #endregion

// #region 渲染
/** 用假 hooks 把函数组件展开成静态元素树。 */
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node.type === 'function') {
    const frame = { name: node.type.name || 'anonymous', count: 0 };
    hookFrames.push(frame);
    let rendered;
    try {
      rendered = node.type(Object.assign({}, node.props));
    } finally {
      hookFrames.pop();
      if (hookProfile.current) {
        hookProfile.current[frame.name] = (hookProfile.current[frame.name] || 0) + frame.count;
      }
    }
    return expand(rendered);
  }
  return { type: node.type, props: Object.assign({}, node.props, { children: expand(node.props.children) }) };
}

function walk(node, visit) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  walk(node.props ? node.props.children : undefined, visit);
}

function textOf(node) {
  const parts = [];
  const visit = (value) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string' || typeof value === 'number') {
      parts.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (typeof value !== 'object') return;
    visit(value.props ? value.props.children : undefined);
  };
  visit(node);
  return parts.join(' ');
}

function findAll(node, predicate) {
  const found = [];
  walk(node, (element) => {
    if (predicate(element)) found.push(element);
  });
  return found;
}

const zhLocale = { getSnapshot: () => ({ active: 'zh-CN' }), subscribe: () => () => {} };
const viewRegistration = host.bucket.find((item) => item.slot === 'conversation.view').registration;

check('空态：没有本地页面时给出引导而不是空白', () => {
  const tree = expand(viewRegistration.component({ locale: zhLocale }));
  const text = textOf(tree);
  assert.match(text, /本地预览/, '缺少标题');
  assert.match(text, /还没有本地运行的页面/, `空态文案缺失：${text.slice(0, 120)}`);
  assert.equal(findAll(tree, (element) => element.type === 'iframe').length, 0, '空态不应有 iframe');
  const inputs = findAll(tree, (element) => element.type === 'input');
  assert.ok(inputs.length > 0, '空态应提供地址输入框');
});

check('运行中：出现 iframe、状态点和地址', () => {
  const internals = mod.__internals;
  internals.previewState.url = '';
  internals.previewState.data = {
    ok: true,
    version: '0.1.0',
    servers: [
      {
        running: true,
        project: 'C:\\demo\\app',
        name: 'app',
        url: 'http://localhost:5173',
        port: 5173,
        pid: 4242,
        logTail: [],
      },
    ],
    projects: [{ root: 'C:\\demo\\app', name: 'app', appId: 'app_x', hasDevScript: true }],
  };
  const tree = expand(viewRegistration.component({ locale: zhLocale }));
  const frames = findAll(tree, (element) => element.type === 'iframe');
  assert.equal(frames.length, 1, `iframe 数量 ${frames.length}`);
  assert.equal(frames[0].props.src, 'http://localhost:5173');
  assert.match(String(frames[0].props.sandbox), /allow-scripts/);
  const text = textOf(tree);
  assert.match(text, /运行中/, `状态缺失：${text.slice(0, 160)}`);
  assert.ok(findAll(tree, (element) => element.type === 'button').length >= 4, '工具栏按钮不足');
});

check('右栏变体不渲染页脚、也不抢 composer', () => {
  const bodyRegistration = host.bucket.find((item) => item.slot === 'sidebar.right.pane.tab').registration;
  const sidebarTree = expand(bodyRegistration.component({ locale: zhLocale, inSidebar: true }));
  const root = findAll(sidebarTree, (element) => element.type === 'div')[0];
  assert.ok(root.props.className.includes('dsh-md-sidebar'), '缺少 sidebar 样式钩子');
  assert.equal(root.props['data-conversation-composer-overlay'], undefined, '右栏不应加 composer overlay');
  const viewTree = expand(viewRegistration.component({ locale: zhLocale }));
  const viewRoot = findAll(viewTree, (element) => element.type === 'div')[0];
  assert.equal(viewRoot.props['data-conversation-composer-overlay'], '', '会话 View 需要满高');
});
// #endregion

// #region 工具卡
const cardRegistration = host.bucket.find((item) => item.slot === 'tool.call.toolview').registration;

check('工具卡结果态：显示地址、状态和打开预览', () => {
  const tree = expand(
    cardRegistration.component({
      locale: zhLocale,
      block: {
        kind: 'success',
        isError: false,
        content: [{ type: 'text', text: 'dev server 已启动。\n地址: http://localhost:5173\npid: 4242\n\n最近输出:\n  VITE ready' }],
      },
    }),
  );
  const text = textOf(tree);
  assert.match(text, /本地开发服务器/);
  assert.match(text, /http:\/\/localhost:5173/);
  assert.match(text, /运行中/);
  assert.match(text, /打开预览/);

  const button = findAll(tree, (element) => element.type === 'button' && textOf(element).includes('打开预览'))[0];
  assert.ok(button, '没有「打开预览」按钮');
  button.props.onClick();
  assert.equal(sidebarOpenCalls.length, 1, `openTab 调用 ${sidebarOpenCalls.length} 次`);
  assert.equal(sidebarOpenCalls[0].kind, 'dsh-miaoda-preview');
  assert.equal(sidebarOpenCalls[0].options.params.url, 'http://localhost:5173');
});

check('工具卡准备态：骨架而不是空白', () => {
  const tree = expand(cardRegistration.component({ locale: zhLocale, block: { phase: 'preparing' } }));
  const text = textOf(tree);
  assert.match(text, /本地开发服务器/);
  assert.equal(findAll(tree, (element) => element.props && String(element.props.className || '').includes('skeleton')).length > 0, true);
});
// #endregion

// #region 工作台
const workbenchRegistration = host.bucket.find(
  (item) => item.slot === 'sidebar.right.pane.tab' && item.registration.defn.key === 'dsh-miaoda/workbench',
).registration;

const wbBase = {
  ok: true,
  auth: { available: false, userName: null },
  login: { status: 'idle', verificationUrl: null, qr: null, expiresAt: 0, error: null },
  task: { id: null, kind: null, status: 'idle', lines: [] },
  project: null,
  servers: [],
  baseDir: 'C:/Users/x/projects',
  candidateDirs: [],
  locals: [],
};

function renderWorkbench(data) {
  mod.__internals.workbenchState.data = data;
  return expand(workbenchRegistration.component({ locale: zhLocale, inSidebar: true }));
}

/** 渲染一趟工作台，返回「组件名 -> hook 数」快照。 */
function hookProfileOf(data) {
  hookProfile.current = {};
  // WorkbenchPanel 本身是直接调用的，它和它直接调用的渲染器的 hook 都算在根帧上。
  const rootFrame = { name: 'workbench.panel', count: 0 };
  hookFrames.push(rootFrame);
  try {
    renderWorkbench(data);
  } finally {
    hookFrames.pop();
  }
  if (rootFrame.count > 0) hookProfile.current[rootFrame.name] = rootFrame.count;
  const snapshot = hookProfile.current;
  hookProfile.current = null;
  return snapshot;
}

/**
 * 两趟渲染里同一个组件的 hook 数必须一致。
 * WorkbenchPanel 是直接调用 WbPublish/WbImport 这些渲染器（不是 React 元素），
 * 它们的 hook 挂在面板自己的 fiber 上：只要有一个条件 return 挡在 hook 前面，
 * 「有项目」那一趟就比「没项目」多一个 hook -> React #310 -> 右栏工作台整块白屏。
 */
check('工作台：无项目与有项目两趟渲染的 hooks 数量一致（防 React #310 白屏）', () => {
  const base = { ...wbBase, auth: { available: true, userName: '张三' } };
  const withProject = {
    ...base,
    project: {
      path: 'C:/Users/x/projects/app_demo',
      dir: 'C:/Users/x/projects/app_demo',
      name: 'app_demo',
      appId: 'app_demo',
      appType: 'full_stack',
      hasDevScript: true,
      git: { branch: 'sprint/default', dirty: false, dirtyFiles: [], ahead: 0, behind: 0 },
      dev: { running: false },
    },
  };
  const empty = hookProfileOf(base);
  const filled = hookProfileOf(withProject);
  const names = new Set([...Object.keys(empty), ...Object.keys(filled)]);
  for (const name of names) {
    assert.equal(
      filled[name] || 0,
      empty[name] || 0,
      `组件 ${name} 的 hook 数从 ${empty[name] || 0} 变成 ${filled[name] || 0}：hooks 顺序变了，React 会抛 #310`,
    );
  }
});

check('工作台：未登录时先给二维码入口', () => {
  const tree = renderWorkbench(wbBase);
  const text = textOf(tree);
  assert.match(text, /妙搭工作台/);
  assert.match(text, /连接飞书/);
  assert.match(text, /生成登录二维码/);
  assert.equal(findAll(tree, (element) => element.type === 'img').length, 0, '没有二维码时不应有 img');
  const loginPost = fetchLog.find(
    (call) => call.method === 'POST' && call.url === '/plugins/dsh-miaoda/workbench' && JSON.parse(call.body).action === 'login',
  );
  assert.ok(loginPost, '打开面板时应自动开始扫码登录');
});

check('工作台：等待扫码时显示二维码与确认链接', () => {
  const tree = renderWorkbench({
    ...wbBase,
    login: {
      status: 'pending',
      verificationUrl: 'https://accounts.feishu.cn/oauth/v1/device/verify?x=1',
      qr: '/plugins/dsh-miaoda/workbench/qr.png?t=1',
      qrError: null,
      expiresAt: 0,
      error: null,
    },
  });
  const images = findAll(tree, (element) => element.type === 'img');
  assert.equal(images.length, 1, `二维码图片 ${images.length} 个`);
  assert.equal(images[0].props.src, '/plugins/dsh-miaoda/workbench/qr.png?t=1');
  assert.match(textOf(tree), /扫描二维码/);
  const links = findAll(tree, (element) => element.type === 'a');
  assert.equal(links.length, 1);
  assert.match(links[0].props.href, /device\/verify/);
});

check('工作台：已登录显示用户名与 appId 输入', () => {
  const tree = renderWorkbench({ ...wbBase, auth: { available: true, userName: '张三' } });
  const text = textOf(tree);
  assert.match(text, /张三/);
  assert.match(text, /退出登录/);
  const inputs = findAll(tree, (element) => element.type === 'input');
  assert.equal(inputs[0].props.placeholder, 'app_xxxxxxxxxxxx');
  const buttons = findAll(tree, (element) => element.type === 'button' && textOf(element).includes('拉取到本地'));
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].props.disabled, true, 'appId 为空时不能拉取');
});

check('工作台：有项目时展示分支与发布入口', () => {
  const tree = renderWorkbench({
    ...wbBase,
    auth: { available: true, userName: '张三' },
    project: {
      root: 'C:/demo/app_x',
      name: 'app_x',
      appId: 'app_x',
      app: { name: 'demo', appType: 'frontend' },
      git: { branch: 'sprint/default', dirty: true, dirtyFiles: ['src/a.js'], ahead: 1 },
      dev: null,
      hasDevScript: true,
    },
  });
  const text = textOf(tree);
  assert.match(text, /sprint\/default/);
  assert.match(text, /1 个未提交/);
  const publishButton = findAll(tree, (element) => element.type === 'button' && textOf(element).includes('发布上线'))[0];
  assert.ok(publishButton, '没有发布按钮');
  assert.equal(publishButton.props.disabled, false, '一键发布：理由应已预填');
  const reasonInput = findAll(tree, (element) => element.type === 'input' && element.props.placeholder === '一句话说明这次改动')[0];
  assert.ok(reasonInput, '前端应用应有发布理由输入框');
  assert.equal(reasonInput.props.value, '妙搭工作台发布');
});

check('工作台：html 应用不需要发布理由', () => {
  const tree = renderWorkbench({
    ...wbBase,
    auth: { available: true, userName: '张三' },
    project: {
      root: 'C:/demo/app_y',
      name: 'app_y',
      appId: 'app_y',
      app: { name: 'html demo', appType: 'html' },
      git: { branch: 'sprint/default', dirty: false, dirtyFiles: [], ahead: 0 },
      dev: null,
      hasDevScript: false,
    },
  });
  const publishButton = findAll(tree, (element) => element.type === 'button' && textOf(element).includes('发布上线'))[0];
  assert.equal(publishButton.props.disabled, false);
  assert.equal(
    findAll(tree, (element) => element.type === 'input' && element.props.placeholder === '一句话说明这次改动').length,
    0,
    'html 应用不应要求发布理由',
  );
});

check('工作台：发布前按 VSCode 风格列出改动文件', () => {
  const tree = renderWorkbench({
    ...wbBase,
    auth: { available: true, userName: '张三' },
    changes: {
      files: [
        { path: 'src/App.tsx', status: 'M', additions: 12, deletions: 3 },
        { path: 'src/new.ts', status: 'A', additions: 8, deletions: 0, untracked: true },
        { path: 'old/legacy.ts', status: 'D', additions: 0, deletions: 40 },
      ],
      summary: { files: 3, additions: 20, deletions: 43, byStatus: { M: 1, A: 1, D: 1 } },
    },
    project: {
      root: 'C:/demo/app_chg',
      name: 'app_chg',
      appId: 'app_chg',
      app: { name: 'demo', appType: 'frontend' },
      git: { branch: 'sprint/default', dirty: true, dirtyFiles: ['src/App.tsx'], ahead: 0 },
      dev: null,
      hasDevScript: true,
    },
  });
  const text = textOf(tree);
  assert.match(text, /改动文件/);
  assert.match(text, /src\/App\.tsx/);
  assert.match(text, /src\/new\.ts/);
  assert.match(text, /old\/legacy\.ts/);
  assert.match(text, /\+12/);
  assert.match(text, /-3/);
  assert.match(text, /-40/);
  const badges = findAll(tree, (element) => String(element.props?.className ?? '').includes('dsh-md-badge'));
  assert.equal(badges.length, 3, '每个文件一个状态徽章');
  const boxes = findAll(tree, (element) => element.type === 'input' && element.props.type === 'checkbox');
  assert.equal(boxes.length, 3, '每个文件一个勾选框');
  assert.equal(boxes.every((box) => box.props.checked === true), true, '默认全选');
});

check('工作台：发布这一步的标题栏直接写出改动数量', () => {
  const tree = renderWorkbench({
    ...wbBase,
    auth: { available: true, userName: '张三' },
    changes: {
      files: [
        { path: 'src/a.ts', status: 'M', additions: 7, deletions: 2 },
        { path: 'src/b.ts', status: 'A', additions: 5, deletions: 0, untracked: true },
      ],
      summary: { files: 2, additions: 12, deletions: 2, byStatus: { M: 1, A: 1 } },
    },
    project: {
      root: 'C:/demo/app_aside',
      name: 'app_aside',
      appId: 'app_aside',
      app: { name: 'demo', appType: 'frontend' },
      git: { branch: 'sprint/default', dirty: true, dirtyFiles: ['src/a.ts'], ahead: 0 },
      dev: null,
      hasDevScript: true,
    },
  });
  const aside = findAll(tree, (element) => String(element.props?.className ?? '') === 'dsh-md-step-aside');
  const text = aside.map((node) => textOf(node)).join('|');
  assert.match(text, /\+12/);
  assert.match(text, /-2/);
  assert.match(text, /2 个文件/);
});

check('工作台：工作区干净时改变列表给出空态', () => {
  const tree = renderWorkbench({
    ...wbBase,
    auth: { available: true, userName: '张三' },
    changes: { files: [], summary: { files: 0, additions: 0, deletions: 0, byStatus: {} } },
    project: {
      root: 'C:/demo/app_clean',
      name: 'app_clean',
      appId: 'app_clean',
      app: { name: 'demo', appType: 'frontend' },
      git: { branch: 'sprint/default', dirty: false, dirtyFiles: [], ahead: 0 },
      dev: null,
      hasDevScript: true,
    },
  });
  assert.match(textOf(tree), /没有需要发布的改动/);
});

check('工作台：本地已有项目可直接打开', () => {
  fetchLog.length = 0;
  const tree = renderWorkbench({
    ...wbBase,
    auth: { available: true, userName: '张三' },
    locals: [
      { root: 'C:/work/app_abc', name: 'app_abc', appId: 'app_abc123', hasDevScript: true, current: false, source: 'recent' },
      { root: 'C:/work/app_def', name: 'app_def', appId: 'app_def456', hasDevScript: true, current: true, source: 'recent' },
    ],
  });
  const text = textOf(tree);
  assert.match(text, /本地已有项目/);
  assert.match(text, /当前项目/);
  const cards = findAll(tree, (element) => String(element.props.className || '').includes('dsh-md-local'));
  assert.equal(cards.filter((element) => element.type === 'div').length >= 2, true, '应渲染本地项目卡片');
  const openButtons = findAll(tree, (element) => element.type === 'button' && textOf(element) === '打开');
  assert.equal(openButtons.length, 1, `只有非当前项目才有打开按钮，实际 ${openButtons.length}`);
  openButtons[0].props.onClick();
  const selectPost = fetchLog.find(
    (call) => call.method === 'POST' && call.url === '/plugins/dsh-miaoda/workbench' && JSON.parse(call.body || '{}').action === 'select',
  );
  assert.ok(selectPost, '点打开应发 select');
  assert.equal(JSON.parse(selectPost.body).root, 'C:/work/app_abc');
});

check('工作台：没有本地项目时给出提示', () => {
  const tree = renderWorkbench({ ...wbBase, auth: { available: true, userName: '张三' } });
  assert.match(textOf(tree), /还没有拉取到本地的项目/);
});
// #endregion

// #region 纯函数
const internals = mod.__internals;

check('normalizeUrl 补全常见输入', () => {
  assert.equal(internals.normalizeUrl('5173'), 'http://localhost:5173');
  assert.equal(internals.normalizeUrl('localhost:3000/app'), 'http://localhost:3000/app');
  assert.equal(internals.normalizeUrl('  http://127.0.0.1:8080  '), 'http://127.0.0.1:8080');
  assert.equal(internals.normalizeUrl(''), '');
  assert.equal(internals.normalizeUrl('example.com'), 'http://example.com');
});

check('parseDevText 从工具文案里取地址和 pid', () => {
  const parsed = internals.parseDevText('dev server 已启动（原本就在运行）。\n地址: http://localhost:5174\npid: 9981\n\n最近输出:');
  assert.equal(parsed.url, 'http://localhost:5174');
  assert.equal(parsed.pid, '9981');
  assert.equal(parsed.running, true);
  assert.equal(parsed.failed, false);
  const failed = internals.parseDevText('dev server 启动失败或立即退出。\n\n最近输出:\nError: spawn failed');
  assert.equal(failed.running, false);
  assert.equal(failed.failed, true);
  assert.equal(failed.url, '');
});

check('blockPhase 区分三种工具阶段', () => {
  assert.equal(internals.blockPhase({ kind: 'success', content: [] }), 'result');
  assert.equal(internals.blockPhase({ phase: 'preparing' }), 'preparing');
  assert.equal(internals.blockPhase({ phase: 'delta', name: 'miaoda_dev' }), 'start');
  assert.equal(internals.blockPhase(undefined), 'preparing');
});

check('resultText 拼接 text block', () => {
  assert.equal(
    internals.resultText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
    'a\nb',
  );
  assert.equal(internals.resultText({}), '');
});

check('displayPath 去掉 http:// 与根路径', () => {
  assert.equal(internals.displayPath('http://localhost:5173/'), 'localhost:5173');
  assert.equal(internals.displayPath('http://localhost:5173/app?x=1'), 'localhost:5173/app?x=1');
  assert.equal(internals.displayPath('not a url'), 'not a url');
});

check('effectiveUrl 优先手填地址、其次运行中的 server', () => {
  internals.previewState.url = '';
  assert.equal(internals.effectiveUrl(), 'http://localhost:5173');
  internals.previewState.url = 'localhost:9000';
  assert.equal(internals.effectiveUrl(), 'http://localhost:9000');
  internals.previewState.url = '';
});
check('effectiveUrl 丢掉只带端口的旧固定值，改用 server 的 /app/<appId>/ 地址', () => {
  // 0.3.11 及以前点「打开预览」会把当时的 server url 存进 localStorage，
  // 那时它没有 base path；现在页面挂在 /app/app_x/ 下，旧固定值会让窗口一直空白。
  const savedServers = internals.previewState.data.servers;
  try {
    internals.previewState.data.servers = [
      { running: true, project: 'C:\\demo\\app_x', name: 'app_x', url: 'http://localhost:5173/app/app_x/', port: 5173 },
    ];
    internals.previewState.url = 'http://localhost:5173';
    assert.equal(internals.effectiveUrl(), 'http://localhost:5173/app/app_x/');
    // 手填了带路径的地址就尊重手填
    internals.previewState.url = 'http://localhost:5173/api';
    assert.equal(internals.effectiveUrl(), 'http://localhost:5173/api');
  } finally {
    internals.previewState.data.servers = savedServers;
    internals.previewState.url = '';
  }
});
// #endregion

for (const cleanup of cleanups) {
  try {
    cleanup();
  } catch (error) {
    /* 清理阶段的异常不影响结论 */
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
