/**
 * dsh-miaoda — 在本地开发飞书妙搭（Miaoda）应用的 DSH 插件。
 *
 * 安装后使用者只需要写代码：初始化/同步、本地运行、发布上线、线上版本拉取
 * 都由这里注册的工具完成。插件本身不保存任何凭据——认证仍由官方 lark-cli
 * 管理，git 走平台下发的仓库凭证。
 *
 * 该文件只 import 相对路径与 Node 内置模块，不引用 `@deepseek-ai/*`
 * （运行时这些包在 harness 内部，不在 profile 的 node_modules 里）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dev from './devserver.js';
import { registerPreviewRoute } from './preview.js';
import { createTools } from './tools.js';
import { registerWorkbenchRoutes } from './workbench.js';

export const name = 'dsh-miaoda';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_FILE = path.join(HERE, '..', 'skills', 'miaoda', 'SKILL.md');

/** package.json is read once: the preview route reports this version to the UI. */
const PACKAGE = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
  } catch {
    return {};
  }
})();

/**
 * 读取随包分发的 skill 正文。
 * @returns {string|undefined} SKILL.md 内容，缺失时返回 undefined。
 */
function readSkillContent() {
  try {
    return fs.readFileSync(SKILL_FILE, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * 从 SKILL.md 的 frontmatter 里取描述，缺省时用内置文案。
 * @param {string} content - SKILL.md 原文。
 * @returns {string} 一行描述。
 */
function skillDescription(content) {
  const match = /^---[\s\S]*?^description:\s*(.+)$/m.exec(content);
  if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  return '本地开发飞书妙搭（Miaoda）应用：初始化/同步项目、启动本地服务、发布上线、拉取线上版本。';
}

/**
 * 从 SKILL.md 中去掉 YAML frontmatter，只留正文。
 * @param {string} content - SKILL.md 原文。
 * @returns {string} 正文。
 */
function skillBody(content) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
  return (match ? content.slice(match[0].length) : content).trim();
}

/**
 * 归一化插件配置。
 * @param {Record<string, unknown>|undefined} rawConfig - harness 传入的配置。
 * @returns {{project: string|undefined, larkCliEntry: string|undefined, defaultScript: string}}
 */
function resolveConfig(rawConfig) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  return {
    project: typeof config.project === 'string' && config.project.trim() !== '' ? config.project.trim() : undefined,
    larkCliEntry: typeof config.larkCliEntry === 'string' && config.larkCliEntry.trim() !== '' ? config.larkCliEntry.trim() : undefined,
    defaultScript: typeof config.script === 'string' && config.script.trim() !== '' ? config.script.trim() : 'dev',
  };
}

/**
 * 安全地写日志：有 ctx.logger 就用它，没有就退回 console。
 * @param {any} ctx - cordis 上下文。
 * @param {'info'|'warn'|'error'} level - 日志级别。
 * @param {string} message - 内容。
 * @returns {void}
 */
function log(ctx, level, message) {
  const logger = ctx?.logger;
  const sink = logger ? Reflect.get(logger, level) : undefined;
  if (typeof sink === 'function') {
    sink.call(logger, message);
    return;
  }
  if (level === 'warn') console.warn(message);
  else if (level === 'info') console.log(message);
  else console.error(message);
}

/**
 * Cordis 插件入口。
 * @param {any} root - 根上下文。
 * @param {Record<string, unknown>|undefined} rawConfig - 插件配置。
 * @returns {void}
 */
export function apply(root, rawConfig) {
  const config = resolveConfig(rawConfig);
  root.inject(['tools'], (ctx) => {
    const tools = createTools(config);
    for (const definition of tools) {
      try {
        ctx.tools.register(definition);
      } catch (error) {
        log(ctx, 'error', `dsh-miaoda: 注册工具 ${definition.name} 失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    log(ctx, 'info', `dsh-miaoda: 已注册 ${tools.length} 个工具（${tools.map((tool) => tool.name).join(', ')}）`);
    // 插件卸载时把后台 dev server 一起收掉，避免留下孤儿进程。
    ctx.effect(() => () => dev.stopAll(), 'dsh-miaoda: dev server cleanup');
    // dev server 的兜底清理：万一宿主是被 taskkill /T 强杀、watchdog 没来得及收尾，
    // 上一个会话记录的进程会在这次启动时被收掉，而不是继续占着 8080 / 3000。
    dev.reapOrphans()
      .then((result) => {
        if (result.reaped.length > 0) {
          log(ctx, 'warn', `dsh-miaoda: 已清理上次会话遗留的 dev server 进程 ${result.reaped.join(', ')}`);
        }
      })
      .catch((error) => {
        log(ctx, 'warn', `dsh-miaoda: 清理遗留 dev server 失败: ${error instanceof Error ? error.message : String(error)}`);
      });
  });
  root.inject(['skills'], (ctx) => {
    const content = readSkillContent();
    if (content === undefined) {
      log(ctx, 'warn', `dsh-miaoda: 未找到 ${SKILL_FILE}，跳过 miaoda 技能注册`);
      return;
    }
    try {
      ctx.skills.register({
        name: 'miaoda',
        description: skillDescription(content),
        content: skillBody(content),
        source: SKILL_FILE,
        provider: 'dsh-miaoda',
        invocation: { modelInvocable: true, userInvocable: true },
      });
      log(ctx, 'info', 'dsh-miaoda: 已注册 miaoda 技能');
    } catch (error) {
      log(ctx, 'warn', `dsh-miaoda: 注册 miaoda 技能失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  // 会话视窗的宿主端：把本地 dev server 的真实状态（以及启停）通过 Web 路由
  // 暴露给 GUI 里的「本地预览」窗口。没有 webServer 的 profile（纯 CLI）会静默跳过。
  try {
    registerPreviewRoute(root, config, typeof PACKAGE.version === 'string' ? PACKAGE.version : '0.0.0');
  } catch (error) {
    log(root, 'warn', `dsh-miaoda: 注册预览路由失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  // 侧边栏工作台：扫码登录 → 输入 appId 拉取 → 一键发布。同样是 Web 路由，
  // 面板只负责展示与触发，真正的 lark-cli / git 调用都发生在宿主进程里。
  try {
    registerWorkbenchRoutes(root, config, typeof PACKAGE.version === 'string' ? PACKAGE.version : '0.0.0');
  } catch (error) {
    log(root, 'warn', `dsh-miaoda: 注册工作台路由失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}
