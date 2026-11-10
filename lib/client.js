/**
 * dsh-miaoda client bundle — the conversation 「本地预览」 window.
 *
 * The harness loads this file as a classic script through
 * `window.__ModuleLoader__` and hands the factory a `require` for platform
 * modules (react, react-dom, …). Everything runs inside that factory: we share
 * one module-level store between the three surfaces we register.
 *
 *   conversation.view         id  "miaoda-preview"        — a full View tab
 *   sidebar.right.pane.tab    key "dsh-miaoda/preview"     — the same window, docked right
 *   tool.call.toolview        key "miaoda_dev"             — a card for the dev-server tool
 *
 * Data comes from the host route in lib/preview.js:
 *   GET/POST /plugins/dsh-miaoda/preview
 *
 * No React hooks, DOM APIs or CSS are invented: everything below only uses the
 * platform modules, the harness CSS variables (with light fallbacks) and the
 * slot contract documented in research/client-api/.
 */
window.__ModuleLoader__.load({
  id: "dsh-miaoda",
  factory: (require) => {
    "use strict";

    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var h = react.createElement;
    var useCallback = react.useCallback;
    var useEffect = react.useEffect;
    var useMemo = react.useMemo;
    var useState = react.useState;
    var useSyncExternalStore = react.useSyncExternalStore;

    // #region constants
    var ROUTE = "/plugins/dsh-miaoda/preview";
    var VIEW_ID = "miaoda-preview";
    var SIDEBAR_TAB_ID = "dsh-miaoda/preview";
    var SIDEBAR_KIND = "dsh-miaoda-preview";
    var STORAGE_URL = "dsh-miaoda.preview.url";
    var STORAGE_DEVICE = "dsh-miaoda.preview.device";
    var DEVICES = [
      { id: "auto", width: 0 },
      { id: "tablet", width: 834 },
      { id: "phone", width: 390 },
    ];
    var STRINGS = {
      zh: {
        viewLabel: "本地预览",
        title: "本地预览",
        tabTitle: "本地预览",
        tabGuide: "本地运行的页面",
        reload: "刷新",
        openExternal: "在浏览器打开",
        openSidebar: "在右侧栏打开",
        openPreview: "打开预览",
        copy: "复制地址",
        copied: "已复制",
        device_auto: "自适应宽度",
        device_tablet: "平板宽度",
        device_phone: "手机宽度",
        loading: "正在加载页面…",
        emptyTitle: "还没有本地运行的页面",
        emptyText: "在你自己的终端里跑着 dev server 的话，这里会自动发现端口（8080 / 5173 等）；也可以直接填端口或网址预览。",
        preview: "预览",
        startServer: "启动 dev server",
        starting: "正在启动…",
        unreachable: "暂时连不上这个地址",
        unreachableHint: "开发服务器可能还在编译，或者已经退出了。",
        retry: "重试",
        status_running: "运行中",
        status_idle: "未运行",
        status_error: "启动失败",
        cardTitle: "本地开发服务器",
        autoRefresh: "每 2.5 秒同步一次",
        port: "端口",
        projectsLabel: "工作区项目",
        noUrl: "这次调用没有返回可预览的地址。",
        err_no_project: "没有找到可启动的妙搭项目，请先初始化项目，或直接输入地址预览。",
        err_no_dev_script: "该项目没有 dev 脚本：html 类型应用由平台托管，不需要本地启动。",
        err_origin: "请求被拒绝（来源校验失败）。",
      },
      en: {
        viewLabel: "Preview",
        title: "Local preview",
        tabTitle: "Preview",
        tabGuide: "A page running on this machine",
        reload: "Reload",
        openExternal: "Open in browser",
        openSidebar: "Open in right sidebar",
        openPreview: "Open preview",
        copy: "Copy address",
        copied: "Copied",
        device_auto: "Fit width",
        device_tablet: "Tablet width",
        device_phone: "Phone width",
        loading: "Loading page…",
        emptyTitle: "No local page running yet",
        emptyText: "If a dev server is already running in your terminal, this picks up its port automatically (8080 / 5173 …). You can also type a port or URL.",
        preview: "Preview",
        startServer: "Start dev server",
        starting: "Starting…",
        unreachable: "Cannot reach this address",
        unreachableHint: "The dev server may still be compiling, or it has exited.",
        retry: "Retry",
        status_running: "Running",
        status_idle: "Stopped",
        status_error: "Failed",
        cardTitle: "Local dev server",
        autoRefresh: "Synced every 2.5s",
        port: "port",
        projectsLabel: "Workspace projects",
        noUrl: "This call returned no previewable address.",
        err_no_project: "No Miaoda project found to start. Initialize one first, or type an address to preview.",
        err_no_dev_script: "This project has no dev script: html apps are hosted by the platform and need no local server.",
        err_origin: "Request rejected (origin check failed).",
      },
    };
    // #endregion

    // #region store
    var state = {
      url: readStorage(STORAGE_URL),
      device: normalizeDevice(readStorage(STORAGE_DEVICE)),
      data: null,
      error: null,
      action: null,
      actionError: null,
    };
    var version = 0;
    var listeners = new Set();

    function bump() {
      version += 1;
      var snapshot = Array.from(listeners);
      for (var index = 0; index < snapshot.length; index += 1) {
        try {
          snapshot[index]();
        } catch (error) {
          /* one broken subscriber must not starve the others */
        }
      }
    }

    function subscribe(listener) {
      listeners.add(listener);
      return function () {
        listeners.delete(listener);
      };
    }

    function getVersion() {
      return version;
    }

    function usePreviewStore() {
      useSyncExternalStore(subscribe, getVersion, getVersion);
    }

    function useLang(locale) {
      var subscribeLang = useCallback(
        function (onChange) {
          if (!locale || typeof locale.subscribe !== "function") return function () {};
          return locale.subscribe(onChange);
        },
        [locale],
      );
      var readLang = useCallback(
        function () {
          return localeCode(locale);
        },
        [locale],
      );
      useSyncExternalStore(subscribeLang, readLang, readLang);
    }

    function localeCode(locale) {
      try {
        var snapshot = locale && typeof locale.getSnapshot === "function" ? locale.getSnapshot() : undefined;
        var active = snapshot && typeof snapshot.active === "string" ? snapshot.active.toLowerCase() : "";
        return active.indexOf("en") === 0 ? "en" : "zh";
      } catch (error) {
        return "zh";
      }
    }

    function tr(locale, key) {
      var dict = STRINGS[localeCode(locale)] || STRINGS.zh;
      if (dict[key] !== undefined) return dict[key];
      if (STRINGS.zh[key] !== undefined) return STRINGS.zh[key];
      return key;
    }

    function readStorage(key) {
      try {
        return window.localStorage.getItem(key) || "";
      } catch (error) {
        return "";
      }
    }

    function writeStorage(key, value) {
      try {
        if (value) window.localStorage.setItem(key, value);
        else window.localStorage.removeItem(key);
      } catch (error) {
        /* private mode or a locked-down store: persistence is best effort */
      }
    }

    function normalizeDevice(value) {
      for (var index = 0; index < DEVICES.length; index += 1) {
        if (DEVICES[index].id === value) return value;
      }
      return "auto";
    }

    function deviceWidth(device) {
      for (var index = 0; index < DEVICES.length; index += 1) {
        if (DEVICES[index].id === device) return DEVICES[index].width;
      }
      return 0;
    }

    // #endregion

    // #region polling
    var pollTimer = null;
    var pollConsumers = 0;
    var lastPayload = "";

    function retainPolling() {
      pollConsumers += 1;
      if (pollTimer === null) {
        void refresh();
        pollTimer = window.setInterval(function () {
          if (document.visibilityState === "hidden") return;
          void refresh();
        }, 4000);
      }
      var released = false;
      return function () {
        if (released) return;
        released = true;
        pollConsumers -= 1;
        if (pollConsumers <= 0 && pollTimer !== null) {
          window.clearInterval(pollTimer);
          pollTimer = null;
          pollConsumers = 0;
        }
      };
    }

    function refresh() {
      return fetch(ROUTE, { cache: "no-store", headers: { accept: "application/json" } })
        .then(function (response) {
          if (!response.ok) throw new Error("HTTP " + response.status);
          return response.json();
        })
        .then(function (data) {
          var raw = JSON.stringify(data);
          if (raw === lastPayload) {
            if (state.error) {
              state.error = null;
              bump();
            }
            return;
          }
          lastPayload = raw;
          state.data = data;
          state.error = null;
          bump();
        })
        .catch(function (error) {
          var message = errorMessage(error);
          if (message !== state.error) {
            state.error = message;
            bump();
          }
        });
    }

    function postAction(action, project) {
      state.action = action;
      state.actionError = null;
      bump();
      return fetch(ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ action: action, project: project || undefined }),
      })
        .then(function (response) {
          return response.json().then(
            function (data) {
              return { response: response, data: data };
            },
            function () {
              return { response: response, data: null };
            },
          );
        })
        .then(function (result) {
          var data = result.data;
          if (!result.response.ok || !data || data.ok !== true) {
            var code = data && typeof data.error === "string" ? data.error : "";
            throw new Error(actionErrorText(code, result.response.status));
          }
          state.action = null;
          state.actionError = null;
          state.data = data;
          lastPayload = JSON.stringify(data);
          bump();
        })
        .catch(function (error) {
          state.action = null;
          state.actionError = errorMessage(error);
          bump();
        });
    }

    function actionErrorText(code, status) {
      if (code === "no-project") return tr(null, "err_no_project");
      if (code === "no-dev-script") return tr(null, "err_no_dev_script");
      if (code === "origin-rejected") return tr(null, "err_origin");
      return code || "HTTP " + status;
    }

    function errorMessage(error) {
      if (!error) return "unknown error";
      if (typeof error === "string") return error;
      if (typeof error.message === "string" && error.message) return error.message;
      return String(error);
    }

    // #endregion

    // #region derived data
    function serversOf(data) {
      return data && Array.isArray(data.servers) ? data.servers : [];
    }

    function runningServers(data) {
      return serversOf(data).filter(function (server) {
        return server && server.running === true && typeof server.url === "string" && server.url !== "";
      });
    }

    function primaryServer(data) {
      var running = runningServers(data);
      if (running.length > 0) return running[0];
      var all = serversOf(data);
      for (var index = 0; index < all.length; index += 1) {
        if (all[index] && typeof all[index].url === "string" && all[index].url !== "") return all[index];
      }
      return all.length > 0 ? all[0] : null;
    }

    function effectiveUrl() {
      var manual = normalizeUrl(state.url);
      var server = primaryServer(state.data);
      var auto = server && server.url ? normalizeUrl(server.url) : "";
      if (manual) {
        // Older builds pinned the bare origin here ("打开预览" saved whatever
        // the server url was back then). Now that the page lives under
        // /app/<appId>/, that stale pin wins and the window stays blank — so
        // when the manual value carries no path and the running server knows
        // one, follow the server.
        if (auto && manual !== auto && manual === originOf(manual) && manual === originOf(auto)) return auto;
        return manual;
      }
      return auto;
    }

    function originOf(url) {
      var match = /^(?:https?):\/\/[^/]+/i.exec(url);
      return match ? match[0] : "";
    }

    function normalizeUrl(input) {
      var raw = typeof input === "string" ? input.trim() : "";
      if (!raw) return "";
      if (/^\d{2,5}$/.test(raw)) return "http://localhost:" + raw;
      if (/^[\w.-]+:\d{2,5}(\/|$)/.test(raw)) return "http://" + raw;
      if (/^(https?|about|file):/i.test(raw)) return raw;
      return "http://" + raw;
    }

    function displayPath(url) {
      try {
        var parsed = new URL(url);
        var pathname = parsed.pathname === "/" ? "" : parsed.pathname;
        return parsed.host + pathname + (parsed.search || "");
      } catch (error) {
        return url;
      }
    }

    function statusTone(server, error) {
      if (error && !server) return "idle";
      if (server && server.running === true) return "running";
      if (server && server.exitCode !== undefined) return "error";
      return "idle";
    }

    // #endregion

    // #region tool result parsing
    function blockPhase(block) {
      if (!block || typeof block !== "object") return "preparing";
      if ("kind" in block) return "result";
      return block.phase === "preparing" ? "preparing" : "start";
    }

    function resultText(block) {
      if (!block || !Array.isArray(block.content)) return "";
      var parts = [];
      for (var index = 0; index < block.content.length; index += 1) {
        var item = block.content[index];
        if (!item || typeof item !== "object") continue;
        if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
        else parts.push(JSON.stringify(item, null, 2));
      }
      return parts.join("\n");
    }

    function parseDevText(text) {
      var raw = typeof text === "string" ? text : "";
      var urlMatch = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{2,5})?(?:\/[^\s)）]*)?/i.exec(raw);
      var pidMatch = /pid\s*[=:]\s*(\d+)/i.exec(raw);
      var negative = /未启动|启动失败|立即退出|not running|failed|error/i.test(raw);
      var running = !negative && /运行中|已启动|running|地址:/i.test(raw);
      return {
        url: urlMatch ? urlMatch[0].replace(/[.,;:]+$/, "") : "",
        pid: pidMatch ? pidMatch[1] : "",
        running: running,
        failed: negative,
        text: raw,
      };
    }

    function firstLine(text) {
      var lines = String(text || "")
        .split(/\r?\n/)
        .map(function (line) {
          return line.trim();
        })
        .filter(function (line) {
          return line !== "";
        });
      if (lines.length === 0) return "";
      var line = lines[0].replace(/^#+\s*/, "");
      return line.length > 140 ? line.slice(0, 137) + "…" : line;
    }

    // #endregion

    // #region icons
    var ICONS = {
      monitor: ["M4 5h16v11H4z", "M9 20h6", "M12 16v4"],
      tablet: ["M6 3h12v18H6z", "M10.5 18h3"],
      phone: ["M8 2h8v20H8z", "M10.5 18.5h3"],
      refresh: ["M20 12a8 8 0 1 1-2.35-5.65", "M20 4.5V10h-5.4"],
      external: ["M14 4h6v6", "M20 4l-8.5 8.5", "M18 14v5H5V6h5"],
      sidebar: ["M4 4h16v16H4z", "M14 4v16"],
      copy: ["M10 8h9v12h-9z", "M5 16V4h11"],
      check: ["M4.5 12.5l5 5 10-11"],
      play: ["M8 5.5l10 6.5-10 6.5z"],
      alert: ["M12 4.5l8.5 15h-17z", "M12 10v4.5", "M12 17.2v.1"],
      terminal: ["M4 5h16v14H4z", "M8 10l2.8 2.5L8 15", "M13 15h4"],
      stop: ["M7 7h10v10H7z"],
    };

    function icon(name, extra) {
      var paths = ICONS[name] || [];
      var props = {
        width: 15,
        height: 15,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.7,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        className: "dsh-md-ico",
      };
      var overrides = extra || {};
      for (var key in overrides) {
        if (Object.prototype.hasOwnProperty.call(overrides, key)) props[key] = overrides[key];
      }
      return h(
        "svg",
        props,
        paths.map(function (d, index) {
          return h("path", { key: index, d: d });
        }),
      );
    }
    // #endregion

    // #region actions
    var pluginCtx = null;

    function sidebarController() {
      if (!pluginCtx || typeof pluginCtx.get !== "function") return null;
      try {
        return pluginCtx.get("sidebarRight") || null;
      } catch (error) {
        return null;
      }
    }

    function setUrl(value) {
      state.url = normalizeUrl(value);
      writeStorage(STORAGE_URL, state.url);
      bump();
    }

    function setDevice(value) {
      state.device = normalizeDevice(value);
      writeStorage(STORAGE_DEVICE, state.device);
      bump();
    }

    function openPreviewTab(url) {
      var resolved = normalizeUrl(url) || effectiveUrl();
      if (!resolved) return false;
      if (resolved !== state.url) {
        // Navigating to the running server is not the same as the user typing
        // an address: keep it out of localStorage so the next start (possibly
        // on another port, or with another base path) is still followed.
        state.url = resolved;
        bump();
      }
      var controller = sidebarController();
      if (!controller || typeof controller.openTab !== "function") return false;
      try {
        controller.openTab(SIDEBAR_KIND, { params: { url: resolved }, revealIfOpened: true });
        return true;
      } catch (error) {
        return false;
      }
    }

    function openExternal(url) {
      var resolved = normalizeUrl(url);
      if (!resolved) return;
      try {
        window.open(resolved, "_blank", "noopener,noreferrer");
      } catch (error) {
        /* popup blocked: nothing better to do than keep the address visible */
      }
    }

    function copyText(text, onDone) {
      var done = function () {
        if (typeof onDone !== "function") return;
        onDone(true);
        window.setTimeout(function () {
          onDone(false);
        }, 1600);
      };
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(text).then(done, function () {
            fallbackCopy(text);
            done();
          });
          return;
        }
      } catch (error) {
        /* fall through to the textarea trick */
      }
      fallbackCopy(text);
      done();
    }

    function fallbackCopy(text) {
      try {
        var area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      } catch (error) {
        /* clipboard is best effort */
      }
    }

    // #endregion

    // #region components
    function UrlField(props) {
      var locale = props.locale;
      var url = props.url;
      var onCommit = props.onCommit;
      var placeholder = props.placeholder;
      var [draft, setDraft] = useState(url);
      var [focused, setFocused] = useState(false);

      useEffect(
        function () {
          if (!focused) setDraft(url);
        },
        [url, focused],
      );

      return h(
        "div",
        { className: "dsh-md-url" + (focused ? " is-focus" : "") },
        h("span", { className: "dsh-md-url-dot" }),
        h("input", {
          className: "dsh-md-url-input",
          type: "text",
          value: focused ? draft : url,
          placeholder: placeholder,
          spellCheck: false,
          autoComplete: "off",
          "aria-label": tr(locale, "title"),
          onChange: function (event) {
            setDraft(event.target.value);
          },
          onFocus: function () {
            setFocused(true);
            setDraft(url);
          },
          onBlur: function () {
            setFocused(false);
            onCommit(draft);
          },
          onKeyDown: function (event) {
            if (event.key === "Enter") {
              onCommit(draft);
              if (event.currentTarget && event.currentTarget.blur) event.currentTarget.blur();
            } else if (event.key === "Escape") {
              setDraft(url);
              if (event.currentTarget && event.currentTarget.blur) event.currentTarget.blur();
            }
          },
        }),
      );
    }

    function EmptyState(props) {
      var locale = props.locale;
      var data = props.data;
      var busy = props.busy === true;
      var error = props.error;
      var onStart = props.onStart;
      var onUse = props.onUse;
      var [draft, setDraft] = useState("");
      var projects = data && Array.isArray(data.projects) ? data.projects : [];
      var startable = projects.filter(function (project) {
        return project && project.hasDevScript === true;
      });

      return h(
        "div",
        { className: "dsh-md-empty" },
        h("div", { className: "dsh-md-empty-icon" }, icon("terminal", { width: 22, height: 22 })),
        h("h3", { className: "dsh-md-empty-title" }, tr(locale, "emptyTitle")),
        h("p", { className: "dsh-md-empty-text" }, tr(locale, "emptyText")),
        h(
          "div",
          { className: "dsh-md-empty-row" },
          h("input", {
            className: "dsh-md-input",
            type: "text",
            value: draft,
            placeholder: "http://localhost:5173",
            spellCheck: false,
            autoComplete: "off",
            onChange: function (event) {
              setDraft(event.target.value);
            },
            onKeyDown: function (event) {
              if (event.key === "Enter") onUse(draft || "http://localhost:5173");
            },
          }),
          h(
            "button",
            {
              type: "button",
              className: "dsh-md-primary",
              onClick: function () {
                onUse(draft || "http://localhost:5173");
              },
            },
            tr(locale, "preview"),
          ),
        ),
        startable.length > 0
          ? h(
              "button",
              {
                type: "button",
                className: "dsh-md-ghost is-block",
                disabled: busy,
                onClick: function () {
                  onStart(startable[0].root);
                },
              },
              icon(busy ? "refresh" : "play", busy ? { className: "dsh-md-ico is-spin" } : undefined),
              busy ? tr(locale, "starting") : tr(locale, "startServer") + " · " + startable[0].name,
            )
          : null,
        error ? h("p", { className: "dsh-md-error" }, error) : null,
        projects.length > 0
          ? h(
              "p",
              { className: "dsh-md-empty-meta" },
              tr(locale, "projectsLabel") + "：" + projects.map(function (project) { return project.name; }).join("、"),
            )
          : null,
      );
    }

    function PreviewSurface(props) {
      usePreviewStore();
      var locale = props ? props.locale : undefined;
      useLang(locale);
      var inSidebar = props && props.inSidebar === true;
      var t = function (key) {
        return tr(locale, key);
      };

      var [frameKey, setFrameKey] = useState(0);
      var [loaded, setLoaded] = useState(false);
      var [slow, setSlow] = useState(false);
      var [probe, setProbe] = useState("idle");

      var url = effectiveUrl();
      var device = state.device;
      var server = primaryServer(state.data);
      var tone = statusTone(server, state.error);

      useEffect(function () {
        return retainPolling();
      }, []);

      useEffect(
        function () {
          setLoaded(false);
          setSlow(false);
          setProbe("idle");
        },
        [url, frameKey],
      );

      useEffect(
        function () {
          if (!url) return undefined;
          var alive = true;
          var slowTimer = window.setTimeout(function () {
            if (alive) setSlow(true);
          }, 6000);
          var probeTimer = window.setTimeout(function () {
            fetch(url, { mode: "no-cors", cache: "no-store" }).then(
              function () {
                if (alive) setProbe("ok");
              },
              function () {
                if (alive) setProbe("fail");
              },
            );
          }, 900);
          return function () {
            alive = false;
            window.clearTimeout(slowTimer);
            window.clearTimeout(probeTimer);
          };
        },
        [url, frameKey],
      );

      var reload = function () {
        setFrameKey(function (value) {
          return value + 1;
        });
      };

      var warning = url !== "" && (probe === "fail" || (!loaded && slow));
      var width = deviceWidth(device);

      return h(
        "div",
        {
          className: "dsh-md" + (inSidebar ? " dsh-md-sidebar" : ""),
          "data-conversation-composer-overlay": inSidebar ? undefined : "",
        },
        h(
          "div",
          { className: "dsh-md-bar" },
          h(
            "div",
            { className: "dsh-md-id" },
            h("span", { className: "dsh-md-status is-" + tone, title: t("status_" + tone) }),
            h("span", { className: "dsh-md-title" }, t("title")),
            server && server.name
              ? h("span", { className: "dsh-md-chip", title: server.project || server.name }, server.name)
              : null,
          ),
          h(UrlField, {
            locale: locale,
            url: url,
            placeholder: "http://localhost:5173",
            onCommit: setUrl,
          }),
          h(
            "div",
            { className: "dsh-md-tools" },
            h(
              "div",
              { className: "dsh-md-seg", role: "group" },
              DEVICES.map(function (entry) {
                var glyph = entry.id === "auto" ? "monitor" : entry.id === "tablet" ? "tablet" : "phone";
                return h(
                  "button",
                  {
                    key: entry.id,
                    type: "button",
                    className: "dsh-md-seg-btn" + (device === entry.id ? " is-on" : ""),
                    title: t("device_" + entry.id),
                    "aria-pressed": device === entry.id,
                    onClick: function () {
                      setDevice(entry.id);
                    },
                  },
                  icon(glyph),
                );
              }),
            ),
            h(
              "button",
              {
                type: "button",
                className: "dsh-md-icon-btn",
                title: t("reload"),
                disabled: !url,
                onClick: reload,
              },
              icon("refresh"),
            ),
            url
              ? h(
                  "button",
                  {
                    type: "button",
                    className: "dsh-md-icon-btn",
                    title: t("openExternal"),
                    onClick: function () {
                      openExternal(url);
                    },
                  },
                  icon("external"),
                )
              : null,
            !inSidebar && url
              ? h(
                  "button",
                  {
                    type: "button",
                    className: "dsh-md-icon-btn",
                    title: t("openSidebar"),
                    onClick: function () {
                      openPreviewTab(url);
                    },
                  },
                  icon("sidebar"),
                )
              : null,
          ),
        ),
        h(
          "div",
          { className: "dsh-md-stage" },
          url === ""
            ? h(EmptyState, {
                locale: locale,
                data: state.data,
                busy: state.action === "start",
                error: state.actionError,
                onStart: function (project) {
                  void postAction("start", project);
                },
                onUse: setUrl,
              })
            : h(
                "div",
                { className: "dsh-md-canvas is-" + device },
                h(
                  "div",
                  {
                    className: "dsh-md-window is-" + device,
                    style: width > 0 ? { width: width + "px" } : undefined,
                  },
                  device !== "auto"
                    ? h(
                        "div",
                        { className: "dsh-md-window-bar" },
                        h("span", { className: "dsh-md-window-dot" }),
                        h("span", { className: "dsh-md-window-dot" }),
                        h("span", { className: "dsh-md-window-dot" }),
                        h("span", { className: "dsh-md-window-url" }, displayPath(url)),
                      )
                    : null,
                  h(
                    "div",
                    { className: "dsh-md-window-body" },
                    h("iframe", {
                      key: url + "#" + frameKey,
                      className: "dsh-md-frame",
                      src: url,
                      title: url,
                      sandbox: "allow-scripts allow-same-origin allow-forms allow-popups allow-modals",
                      allow: "clipboard-write",
                      referrerPolicy: "no-referrer",
                      onLoad: function () {
                        setLoaded(true);
                      },
                    }),
                    !loaded
                      ? h(
                          "div",
                          { className: "dsh-md-veil" },
                          h("span", { className: "dsh-md-spinner" }),
                          h("span", null, t("loading")),
                        )
                      : null,
                  ),
                ),
                warning
                  ? h(
                      "div",
                      { className: "dsh-md-warning" },
                      icon("alert", { className: "dsh-md-warning-ico" }),
                      h(
                        "div",
                        { className: "dsh-md-warning-text" },
                        h("strong", null, t("unreachable")),
                        h("span", null, t("unreachableHint")),
                      ),
                      h(
                        "button",
                        { type: "button", className: "dsh-md-ghost", onClick: reload },
                        t("retry"),
                      ),
                    )
                  : null,
              ),
        ),
        inSidebar
          ? null
          : h(
              "div",
              { className: "dsh-md-foot" },
              h(
                "span",
                { className: "dsh-md-foot-item" },
                server && server.running
                  ? t("status_running") + (server.port ? " · " + t("port") + " " + server.port : "")
                  : t("status_idle"),
              ),
              server && server.pid ? h("span", { className: "dsh-md-foot-item" }, "pid " + server.pid) : null,
              state.error ? h("span", { className: "dsh-md-foot-item is-error" }, state.error) : null,
              h("span", { className: "dsh-md-foot-grow" }),
              h("span", { className: "dsh-md-foot-item is-dim" }, t("autoRefresh")),
            ),
      );
    }

    function MiaodaDevCard(props) {
      var locale = props ? props.locale : undefined;
      useLang(locale);
      var t = function (key) {
        return tr(locale, key);
      };
      var block = props ? props.block : undefined;
      var phase = blockPhase(block);
      var text = phase === "result" ? resultText(block) : "";
      var info = useMemo(
        function () {
          return parseDevText(text);
        },
        [text],
      );
      var [resolvedUrl, setResolvedUrl] = useState("");
      var [copied, setCopied] = useState(false);

      useEffect(
        function () {
          if (phase !== "result") return undefined;
          var alive = true;
          fetch(ROUTE, { cache: "no-store", headers: { accept: "application/json" } })
            .then(function (response) {
              return response.ok ? response.json() : null;
            })
            .then(function (data) {
              if (!alive || !data) return;
              var server = primaryServer(data);
              if (server && server.url) setResolvedUrl(normalizeUrl(server.url));
              if (!state.data) {
                state.data = data;
                bump();
              }
            })
            .catch(function () {
              /* the card still shows the text it was given */
            });
          return function () {
            alive = false;
          };
        },
        [phase],
      );

      var url = info.url || resolvedUrl;
      var tone = phase !== "result" ? "running" : info.running ? "running" : info.failed ? "error" : "idle";

      return h(
        "div",
        { className: "dsh-md-card" },
        h(
          "div",
          { className: "dsh-md-card-head" },
          h("span", { className: "dsh-md-card-ico" }, icon("terminal")),
          h("span", { className: "dsh-md-card-title" }, t("cardTitle")),
          h(
            "span",
            { className: "dsh-md-pill is-" + tone },
            h("span", { className: "dsh-md-pill-dot" }),
            phase === "result" ? t("status_" + tone) : "…",
          ),
          h("span", { className: "dsh-md-card-grow" }),
          url
            ? h(
                "button",
                {
                  type: "button",
                  className: "dsh-md-ghost",
                  onClick: function () {
                    copyText(url, setCopied);
                  },
                },
                icon(copied ? "check" : "copy"),
                copied ? t("copied") : t("copy"),
              )
            : null,
          h(
            "button",
            {
              type: "button",
              className: "dsh-md-primary is-sm",
              disabled: url === "",
              onClick: function () {
                if (!openPreviewTab(url)) openExternal(url);
              },
            },
            icon("play"),
            t("openPreview"),
          ),
        ),
        phase === "result"
          ? url
            ? h(
                "div",
                { className: "dsh-md-card-url" },
                h("span", { className: "dsh-md-mono" }, url),
                info.pid ? h("span", { className: "dsh-md-card-meta" }, "pid " + info.pid) : null,
              )
            : h("div", { className: "dsh-md-card-meta" }, firstLine(text) || t("noUrl"))
          : h(
              "div",
              { className: "dsh-md-card-skeleton" },
              h("span", { className: "dsh-md-skeleton-line" }),
              h("span", { className: "dsh-md-skeleton-line is-short" }),
            ),
      );
    }
    // #endregion

    // #region workbench
    var WB_ROUTE = "/plugins/dsh-miaoda/workbench";
    var WB_TAB_ID = "dsh-miaoda/workbench";
    var WB_KIND = "dsh-miaoda-workbench";
    var WB_STRINGS = {
      zh: {
        wbTabTitle: "妙搭工作台",
        wbTabGuide: "扫码登录 · 拉取项目 · 一键发布",
        wbTitle: "妙搭工作台",
        stepLogin: "连接飞书",
        stepImport: "拉取项目",
        stepPublish: "发布上线",
        loginScan: "用飞书扫描二维码",
        loginWaiting: "扫码后在手机上确认，这里会自动继续。",
        loginUrlHint: "或在浏览器里打开确认页",
        loginRegenerate: "重新生成",
        loginCreate: "生成登录二维码",
        loginExpired: "二维码已过期",
        loginFailed: "登录失败",
        loginOk: "已登录",
        relogin: "重新登录",
        logout: "退出登录",
        appIdLabel: "应用 appId",
        appIdPlaceholder: "app_xxxxxxxxxxxx",
        dirLabel: "保存位置",
        dirPlaceholder: "留空=保存到工作区根目录",
        dirFromWorkspace: "工作区根目录",
        dirFromCustom: "自定义目录",
        dirReset: "恢复默认",
        importAction: "拉取到本地",
        importBusy: "正在拉取…",
        importHint: "代码会以 sprint/default 分支落到本地，之后直接改文件即可。",
        currentProject: "当前项目",
        changeProject: "本地已有项目",
        localProjects: "本地已有项目",
        openProject: "打开",
        localEmpty: "还没有拉取到本地的项目，输入 appId 拉一个。",
        useProject: "打开",
        publishAction: "发布上线",
        publishBusy: "正在发布…",
        publishReason: "发布理由",
        reasonPlaceholder: "一句话说明这次改动",
        reasonDefault: "妙搭工作台发布",
        publishHint: "先提交本地改动并 push 到 sprint/default，再创建发布并等待结果。",
        changesTitle: "改动文件",
        changesEmpty: "工作区干净，没有需要发布的改动。",
        changesAll: "全选",
        changesNone: "全不选",
        changesCount: "已选",
        changesOf: "/",
        changesFiles: "个文件",
        diffLoading: "正在读取差异…",
        diffEmpty: "没有可显示的差异。",
        diffBinary: "二进制文件，不显示差异。",
        diffTooBig: "文件过大，只显示前几行。",
        branchWarn: "当前不在 sprint/default 分支，先切回工作分支再发布。",
        dirty: "个未提交",
        ahead: "个待推送",
        noProject: "先完成第 2 步，把项目拉到本地。",
        devTitle: "本地开发服务器",
        devStart: "启动",
        devPreview: "预览",
        devStop: "停止",
        running: "进行中",
        taskDone: "完成",
        taskFailed: "失败",
        htmlNote: "html 应用由平台托管，不需要本地服务器。",
        refresh: "刷新",
        busy: "正在处理上一个操作，请稍候。",
        logoutDone: "已退出登录",
      },
      en: {
        wbTabTitle: "Miaoda workbench",
        wbTabGuide: "Sign in · Pull project · Publish",
        wbTitle: "Miaoda workbench",
        stepLogin: "Connect Feishu",
        stepImport: "Pull project",
        stepPublish: "Publish",
        loginScan: "Scan the QR code with Feishu",
        loginWaiting: "Confirm on your phone and this panel continues by itself.",
        loginUrlHint: "or open the confirmation page in a browser",
        loginRegenerate: "New code",
        loginCreate: "Generate sign-in QR",
        loginExpired: "The QR code expired",
        loginFailed: "Sign-in failed",
        loginOk: "Signed in",
        relogin: "Sign in again",
        logout: "Sign out",
        appIdLabel: "App id",
        appIdPlaceholder: "app_xxxxxxxxxxxx",
        dirLabel: "Save to",
        dirPlaceholder: "Blank = workspace root",
        dirFromWorkspace: "workspace root",
        dirFromCustom: "custom folder",
        dirReset: "Use default",
        importAction: "Pull to this machine",
        importBusy: "Pulling…",
        importHint: "The code lands on branch sprint/default, ready to edit.",
        currentProject: "Current project",
        changeProject: "Local projects",
        localProjects: "Local projects",
        openProject: "Open",
        localEmpty: "Nothing pulled yet — paste an app id to pull one.",
        useProject: "Open",
        publishAction: "Publish",
        publishBusy: "Publishing…",
        publishReason: "Release reason",
        reasonPlaceholder: "One line about this change",
        reasonDefault: "Publish from the Miaoda workbench",
        publishHint: "Commits local changes, pushes sprint/default, then creates a release and waits.",
        changesTitle: "Changed files",
        changesEmpty: "Working tree is clean — nothing to publish.",
        changesAll: "Select all",
        changesNone: "Clear",
        changesCount: "Selected",
        changesOf: "/",
        changesFiles: "files",
        diffLoading: "Loading diff…",
        diffEmpty: "No diff to show.",
        diffBinary: "Binary file — diff not shown.",
        diffTooBig: "File is large — showing the first lines only.",
        branchWarn: "Not on sprint/default — switch back before publishing.",
        dirty: "uncommitted",
        ahead: "to push",
        noProject: "Finish step 2 and pull a project first.",
        devTitle: "Local dev server",
        devStart: "Start",
        devPreview: "Preview",
        devStop: "Stop",
        running: "Running",
        taskDone: "Done",
        taskFailed: "Failed",
        htmlNote: "html apps are hosted by the platform and need no local server.",
        refresh: "Refresh",
        busy: "Another operation is still running.",
        logoutDone: "Signed out",
      },
    };

    var wbState = { data: null, error: null, busy: "", actionError: null };
    var wbVersion = 0;
    var wbListeners = new Set();
    var wbTimer = null;
    var wbConsumers = 0;
    var wbLast = "";

    function wbBump() {
      wbVersion += 1;
      var snapshot = Array.from(wbListeners);
      for (var index = 0; index < snapshot.length; index += 1) {
        try {
          snapshot[index]();
        } catch (error) {
          /* one broken subscriber must not starve the others */
        }
      }
    }

    function wbSubscribe(listener) {
      wbListeners.add(listener);
      return function () {
        wbListeners.delete(listener);
      };
    }

    function wbGetVersion() {
      return wbVersion;
    }

    function useWbStore() {
      useSyncExternalStore(wbSubscribe, wbGetVersion, wbGetVersion);
    }

    function retainWbPolling() {
      wbConsumers += 1;
      if (wbTimer === null) {
        void wbRefresh({ full: wbLast === "" });
        wbTimer = window.setInterval(function () {
          if (document.visibilityState === "hidden") return;
          void wbRefresh();
        }, 4000);
      }
      var released = false;
      return function () {
        if (released) return;
        released = true;
        wbConsumers -= 1;
        if (wbConsumers <= 0 && wbTimer !== null) {
          window.clearInterval(wbTimer);
          wbTimer = null;
          wbConsumers = 0;
        }
      };
    }

    function wbRefresh(options) {
      // `light` snapshots are served from host-side caches and never spawn a
      // child process; ask for a full one on mount, after actions and on refresh.
      var full = !!(options && options.full);
      var url = full ? WB_ROUTE : WB_ROUTE + "?light=1";
      return fetch(url, { cache: "no-store", headers: { accept: "application/json" } })
        .then(function (response) {
          if (!response.ok) throw new Error("HTTP " + response.status);
          return response.json();
        })
        .then(function (data) {
          var raw = JSON.stringify(data);
          if (raw === wbLast && !wbState.error) return;
          wbLast = raw;
          wbState.data = data;
          wbState.error = null;
          wbBump();
        })
        .catch(function (error) {
          var message = errorMessage(error);
          if (message !== wbState.error) {
            wbState.error = message;
            wbBump();
          }
        });
    }

    function wbPost(action, payload) {
      // Only the two slow jobs need to be exclusive: they run a task queue on the
      // host. Everything else (login, select, base, dev) stays clickable even
      // while another request is in flight, so the panel never feels dead.
      var slow = action === "publish" || action === "import";
      if (slow && wbState.busy) return Promise.resolve(null);
      wbState.busy = action;
      wbState.actionError = null;
      wbBump();
      var body = { action: action };
      if (payload) {
        for (var key in payload) {
          if (Object.prototype.hasOwnProperty.call(payload, key)) body[key] = payload[key];
        }
      }
      return fetch(WB_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      })
        .then(function (response) {
          return response.json().then(
            function (data) {
              return { response: response, data: data };
            },
            function () {
              return { response: response, data: null };
            },
          );
        })
        .then(function (result) {
          var data = result.data;
          if (!result.response.ok || !data || data.ok !== true) {
            var code = data && typeof data.error === "string" ? data.error : "";
            throw new Error(wbErrorText(code, result.response.status, data));
          }
          wbState.busy = "";
          wbState.actionError = null;
          wbBump();
          void wbRefresh({ full: true });
          return data;
        })
        .catch(function (error) {
          wbState.busy = "";
          wbState.actionError = errorMessage(error);
          wbBump();
          return null;
        });
    }

    function wbErrorText(code, status, data) {
      if (code === "no-project") return wt(null, "noProject");
      if (code === "no-dev-script") return wt(null, "htmlNote");
      if (code === "origin-rejected") return tr(null, "err_origin");
      if (code === "busy") return wt(null, "busy");
      if (code === "internal" && data && typeof data.message === "string") {
        return data.hint ? data.message + "（" + data.hint + "）" : data.message;
      }
      return code || "HTTP " + status;
    }

    function wt(locale, key) {
      var dict = WB_STRINGS[localeCode(locale)] || WB_STRINGS.zh;
      if (dict[key] !== undefined) return dict[key];
      if (WB_STRINGS.zh[key] !== undefined) return WB_STRINGS.zh[key];
      return key;
    }

    function appIdValid(value) {
      return /^app_[A-Za-z0-9]+$/.test(String(value || "").trim());
    }

    function elapsedText(from) {
      if (!from) return "";
      var seconds = Math.max(0, Math.round((Date.now() - from) / 1000));
      var minutes = Math.floor(seconds / 60);
      var rest = seconds % 60;
      if (minutes > 0) return minutes + ":" + (rest < 10 ? "0" : "") + rest;
      return rest + "s";
    }

    function wbTaskState(task) {
      if (!task || task.status === "idle") return "idle";
      return task.status;
    }

    function WbPill(props) {
      return h(
        "span",
        { className: "dsh-md-pill" + (props.tone ? " is-" + props.tone : "") },
        h("span", { className: "dsh-md-pill-dot" }),
        props.text,
      );
    }

    function WbStep(props) {
      return h(
        "section",
        {
          className:
            "dsh-md-step" + (props.active ? " is-active" : "") + (props.done ? " is-done" : ""),
        },
        h(
          "div",
          { className: "dsh-md-step-head" },
          h("span", { className: "dsh-md-step-no" }, props.done ? "✓" : String(props.no)),
          h("span", { className: "dsh-md-step-title" }, props.title),
          props.aside ? h("span", { className: "dsh-md-step-aside" }, props.aside) : null,
        ),
        props.children,
      );
    }

    function WbTask(props) {
      var locale = props.locale;
      var task = props.task;
      if (!task || task.status === "idle") return null;
      var t = function (key) {
        return wt(locale, key);
      };
      var running = task.status === "running";
      var head = running
        ? t("running") + " · " + elapsedText(task.startedAt)
        : task.status === "done"
          ? t("taskDone") + " · " + elapsedText(task.finishedAt - (task.startedAt || task.finishedAt))
          : t("taskFailed");
      return h(
        "div",
        { className: "dsh-md-task" },
        h("div", { className: "dsh-md-task-head" }, WbPill({ tone: running ? "running" : task.status === "done" ? "running" : "error", text: head })),
        task.lines && task.lines.length
          ? h("pre", { className: "dsh-md-log" }, task.lines.join("\n"))
          : null,
        task.text ? h("pre", { className: "dsh-md-log is-result" }, task.text) : null,
        task.error ? h("p", { className: "dsh-md-error" }, task.error) : null,
      );
    }

    function WbLogin(props) {
      var locale = props.locale;
      var auth = props.auth;
      var login = props.login;
      var busy = props.busy;
      var t = function (key) {
        return wt(locale, key);
      };
      var done = !!(auth && auth.available);
      var pending = !done && login && login.status === "pending";
      var children = [];
      if (done) {
        children.push(
          h(
            "div",
            { className: "dsh-md-row" },
            WbPill({ tone: "running", text: t("loginOk") }),
            h("span", { className: "dsh-md-project-name" }, auth.userName || ""),
            h("span", { className: "dsh-md-card-grow" }),
            h(
              "button",
              {
                className: "dsh-md-ghost",
                onClick: function () {
                  void wbPost("logout");
                },
              },
              t("logout"),
            ),
          ),
        );
      } else if (pending) {
        children.push(
          h(
            "div",
            { className: "dsh-md-qr" },
            login.qr
              ? h("img", { className: "dsh-md-qr-img", src: login.qr, alt: "login qr", width: 164, height: 164 })
              : h("div", { className: "dsh-md-qr-fallback" }, (login.qrError || "qrcode")),
            h(
              "div",
              { className: "dsh-md-qr-side" },
              h("span", { className: "dsh-md-qr-title" }, t("loginScan")),
              h("span", { className: "dsh-md-hint" }, t("loginWaiting")),
              login.verificationUrl
                ? h(
                    "a",
                    {
                      className: "dsh-md-link",
                      href: login.verificationUrl,
                      target: "_blank",
                      rel: "noreferrer",
                    },
                    t("loginUrlHint"),
                  )
                : null,
              h(
                "button",
                {
                  className: "dsh-md-ghost",
                  disabled: busy === "login",
                  onClick: function () {
                    void wbPost("login", { value: "start" });
                  },
                },
                t("loginRegenerate"),
              ),
            ),
          ),
        );
      } else {
        children.push(
          h(
            "button",
            {
              className: "dsh-md-primary",
              disabled: busy === "login",
              onClick: function () {
                void wbPost("login", { value: "start" });
              },
            },
            busy === "login" ? t("running") : t("loginCreate"),
          ),
        );
        if (login && login.error) {
          children.push(h("p", { className: "dsh-md-error" }, login.error));
        }
      }
      return children;
    }

    function WbImport(props) {
      var locale = props.locale;
      var auth = props.auth;
      var project = props.project;
      var task = props.task;
      var data = props.data;
      var t = function (key) {
        return wt(locale, key);
      };
      var appIdState = useState("");
      var appId = appIdState[0];
      var setAppId = appIdState[1];
      var dirState = useState("");
      var dir = dirState[0];
      var setDir = dirState[1];
      var running = wbTaskState(task) === "running" && task.kind === "import";
      var canImport = !!(auth && auth.available) && appIdValid(appId) && !running;
      var children = [];

      if (project) {
        children.push(
          h(
            "div",
            { className: "dsh-md-project" },
            h("span", { className: "dsh-md-project-name" }, project.name),
            h("span", { className: "dsh-md-card-meta" }, project.appId || ""),
            h(
              "button",
              {
                className: "dsh-md-ghost",
                onClick: function () {
                  openPreviewTab(project.dev && project.dev.url ? project.dev.url : "");
                },
              },
              t("devPreview"),
            ),
          ),
          h("p", { className: "dsh-md-hint dsh-md-mono dsh-md-path" }, project.root),
        );
      }

      children.push(
        h(
          "label",
          { className: "dsh-md-field" },
          h("span", { className: "dsh-md-field-label" }, t("appIdLabel")),
          h("input", {
            className: "dsh-md-input",
            placeholder: t("appIdPlaceholder"),
            value: appId,
            spellCheck: false,
            onChange: function (event) {
              setAppId(event.target.value);
            },
          }),
        ),
      );

      var locals = (data && (data.locals || data.candidateDirs)) || [];
      if (locals.length > 0) {
        children.push(
          h(
            "div",
            { className: "dsh-md-locals" },
            h("span", { className: "dsh-md-field-label" }, t("localProjects")),
            locals.slice(0, 8).map(function (item) {
              return h(
                "div",
                {
                  key: item.root,
                  className: "dsh-md-local" + (item.current ? " dsh-md-local-current" : ""),
                  title: item.root,
                },
                h(
                  "div",
                  { className: "dsh-md-local-main" },
                  h("span", { className: "dsh-md-local-name" }, item.name || item.root),
                  item.appId ? h("span", { className: "dsh-md-card-meta dsh-md-mono" }, item.appId) : null,
                  item.current ? h("span", { className: "dsh-md-pill" }, t("currentProject")) : null,
                ),
                h("span", { className: "dsh-md-hint dsh-md-mono dsh-md-local-path" }, item.root),
                item.current
                  ? null
                  : h(
                      "button",
                      {
                        className: "dsh-md-ghost dsh-md-inline-btn",
                        onClick: function () {
                          void wbPost("select", { root: item.root });
                        },
                      },
                      t("openProject"),
                    ),
              );
            }),
          ),
        );
      }

      if (locals.length === 0) {
        children.push(h("p", { className: "dsh-md-hint" }, t("localEmpty")));
      }

      var baseDir = (data && data.baseDir) || "";
      var baseSource = (data && data.baseDirSource) || "";
      var baseTitle = (data && data.baseDirTitle) || "";
      var sourceLabel = t(baseSource === "custom" ? "dirFromCustom" : "dirFromWorkspace");
      children.push(
        h(
          "label",
          { className: "dsh-md-field" },
          h(
            "span",
            { className: "dsh-md-field-label dsh-md-field-label-row" },
            h("span", null, t("dirLabel")),
            h(
              "span",
              { className: "dsh-md-hint dsh-md-hint-inline" },
              sourceLabel + (baseTitle ? " · " + baseTitle : ""),
            ),
          ),
          h(
            "div",
            { className: "dsh-md-input-row" },
            h("input", {
              className: "dsh-md-input",
              placeholder: baseDir || t("dirPlaceholder"),
              title: baseDir,
              value: dir,
              spellCheck: false,
              onChange: function (event) {
                setDir(event.target.value);
              },
            }),
            dir
              ? h(
                  "button",
                  {
                    className: "dsh-md-ghost dsh-md-inline-btn",
                    onClick: function () {
                      setDir("");
                    },
                  },
                  t("dirReset"),
                )
              : null,
          ),
        ),
      );

      var workspaces = (data && data.workspaces) || [];
      if (workspaces.length > 0) {
        children.push(
          h(
            "div",
            { className: "dsh-md-chips" },
            h("span", { className: "dsh-md-field-label" }, t("dirLabel")),
            workspaces.slice(0, 6).map(function (workspace) {
              return h(
                "button",
                {
                  key: workspace.dir,
                  className: "dsh-md-chip",
                  title: workspace.dir,
                  onClick: function () {
                    setDir(workspace.current ? "" : workspace.dir);
                  },
                },
                workspace.title || workspace.dir,
              );
            }),
          ),
        );
      }

      children.push(
        h(
          "div",
          { className: "dsh-md-row" },
          h(
            "button",
            {
              className: "dsh-md-primary",
              disabled: !canImport,
              onClick: function () {
                void wbPost("import", { appId: appId.trim(), baseDir: dir.trim() || undefined });
              },
            },
            running ? t("importBusy") : t("importAction"),
          ),
        ),
        h(
          "p",
          { className: "dsh-md-hint" },
          t("importHint") +
            (appIdValid(appId) ? " " + (dir.trim() || baseDir) + "\\" + appId.trim() : ""),
        ),
      );

      if (task && task.kind === "import" && task.status !== "idle") {
        children.push(WbTask({ locale: locale, task: task }));
      }
      return children;
    }

    // region changes
    var changeState = { sig: "", omitted: {}, open: "", rows: null, loading: "", error: "", notice: "" };

    function changeSig(changes) {
      if (!changes || !Array.isArray(changes.files)) return "";
      return changes.files
        .map(function (file) {
          return file.path + "|" + file.status + "|" + file.additions + "|" + file.deletions;
        })
        .join("\n");
    }

    function syncChangeState(changes) {
      var sig = changeSig(changes);
      if (sig !== changeState.sig) {
        changeState.sig = sig;
        changeState.omitted = {};
        changeState.open = "";
        changeState.rows = null;
        changeState.loading = "";
        changeState.error = "";
        changeState.notice = "";
      }
    }

    function selectedChangeFiles(changes) {
      if (!changes || !Array.isArray(changes.files)) return [];
      return changes.files
        .filter(function (file) {
          return !changeState.omitted[file.path];
        })
        .map(function (file) {
          return file.path;
        });
    }

    function changeTotals(changes) {
      var total = { files: 0, additions: 0, deletions: 0 };
      if (!changes || !Array.isArray(changes.files)) return total;
      changes.files.forEach(function (file) {
        total.files += 1;
        total.additions += Number(file.additions) || 0;
        total.deletions += Number(file.deletions) || 0;
      });
      return total;
    }

    // The count lives in the step header, so "how many files am I about to
    // publish" is answerable without expanding anything.
    function publishAside(changes, label) {
      if (!changes || !Array.isArray(changes.files)) return null;
      if (!changes.files.length) {
        return h("span", { className: "dsh-md-step-aside" }, label("changesEmpty"));
      }
      var totals = changeTotals(changes);
      return h(
        "span",
        { className: "dsh-md-step-aside" },
        h("span", { className: "dsh-md-chg-stat is-add" }, "+" + totals.additions),
        " ",
        h("span", { className: "dsh-md-chg-stat is-del" }, "-" + totals.deletions),
        " · " + totals.files + " " + label("changesFiles"),
      );
    }

    function statText(value, kind) {
      if (value === null || value === undefined) return null;
      var text = (kind === "add" ? "+" : "-") + value;
      return h("span", { className: "dsh-md-chg-stat is-" + kind }, text);
    }

    function WbDiffRows(props) {
      var t = props.t;
      var rows = props.rows;
      if (props.error) return h("p", { className: "dsh-md-chg-diff-msg" }, props.error);
      if (props.loading) return h("p", { className: "dsh-md-chg-diff-msg" }, t("diffLoading"));
      if (!rows || !rows.length) return h("p", { className: "dsh-md-chg-diff-msg" }, t("diffEmpty"));
      return h(
        "div",
        { className: "dsh-md-chg-diff" },
        rows.map(function (row, index) {
          return h("div", { className: "dsh-md-chg-line is-" + row.kind, key: index }, row.text || " ");
        }),
      );
    }

    function WbChanges(props) {
      var locale = props.locale;
      var changes = props.changes;
      var bump = props.onChange;
      var t = function (key) {
        return wt(locale, key);
      };
      syncChangeState(changes);
      if (!changes) {
        // Before the first full snapshot the change list is still unknown — show
        // a skeleton instead of nothing, otherwise the section looks absent.
        return h(
          "div",
          { className: "dsh-md-chg" },
          h(
            "div",
            { className: "dsh-md-chg-head" },
            h("span", { className: "dsh-md-chg-title" }, t("changesTitle")),
            h("span", { className: "dsh-md-chg-sum" }, t("diffLoading")),
          ),
          h(
            "div",
            { className: "dsh-md-card-skeleton" },
            h("span", { className: "dsh-md-skeleton-line" }),
            h("span", { className: "dsh-md-skeleton-line is-short" }),
          ),
        );
      }
      var files = Array.isArray(changes.files) ? changes.files : [];
      var totals = changeTotals(changes);
      var selected = selectedChangeFiles(changes);
      var allSelected = files.length > 0 && selected.length === files.length;
      var head = [
        h("span", { className: "dsh-md-chg-title" }, t("changesTitle")),
        h("span", { className: "dsh-md-chg-sum" }, totals.files + " " + t("changesFiles")),
        statText(totals.additions || null, "add"),
        statText(totals.deletions || null, "del"),
        h("span", { className: "dsh-md-grow" }),
        files.length
          ? h(
              "button",
              {
                className: "dsh-md-ghost is-xs",
                onClick: function () {
                  if (allSelected) {
                    files.forEach(function (file) {
                      changeState.omitted[file.path] = true;
                    });
                  } else {
                    changeState.omitted = {};
                  }
                  bump();
                },
              },
              allSelected ? t("changesNone") : t("changesAll"),
            )
          : null,
      ];
      var children = [h("div", { className: "dsh-md-chg-head" }, head)];

      if (!files.length) {
        children.push(h("p", { className: "dsh-md-chg-empty" }, t("changesEmpty")));
        return h("div", { className: "dsh-md-chg" }, children);
      }

      children.push(
        h(
          "div",
          { className: "dsh-md-chg-list" },
          files.map(function (file) {
            var checked = !changeState.omitted[file.path];
            var isOpen = changeState.open === file.path;
            var row = h(
              "div",
              {
                className: "dsh-md-chg-row" + (checked ? "" : " is-off") + (isOpen ? " is-open" : ""),
                key: file.path,
                onClick: function () {
                  if (isOpen) {
                    changeState.open = "";
                    changeState.rows = null;
                  } else {
                    changeState.open = file.path;
                    changeState.rows = null;
                    changeState.error = "";
                    changeState.loading = file.path;
                    void wbPost("diff", { path: file.path }).then(function (res) {
                      changeState.loading = "";
                      if (res && res.ok === false) {
                        changeState.error = String(res.error || "diff failed");
                      } else {
                        changeState.rows = (res && res.rows) || [];
                        if (res && res.binary) changeState.notice = t("diffBinary");
                        else if (res && res.truncated) changeState.notice = t("diffTooBig");
                      }
                      bump();
                    }).catch(function (failure) {
                      changeState.loading = "";
                      changeState.rows = null;
                      changeState.error = String((failure && failure.message) || failure);
                      bump();
                    });
                  }
                  bump();
                },
              },
              h("input", {
                className: "dsh-md-chg-box",
                type: "checkbox",
                checked: checked,
                onClick: function (event) {
                  event.stopPropagation();
                  if (checked) changeState.omitted[file.path] = true;
                  else delete changeState.omitted[file.path];
                  bump();
                },
                onChange: function () {},
              }),
              h("span", { className: "dsh-md-badge is-" + String(file.status || "M").toLowerCase() }, file.status || "M"),
              h(
                "span",
                { className: "dsh-md-chg-path", title: file.from ? file.from + " → " + file.path : file.path },
                file.from ? file.from + " → " + file.path : file.path,
              ),
              file.binary ? h("span", { className: "dsh-md-chg-bin" }, "bin") : null,
              statText(file.additions || null, "add"),
              statText(file.deletions || null, "del"),
            );
            if (!isOpen) return row;
            return h(
              "div",
              { className: "dsh-md-chg-group", key: file.path + "::diff" },
              row,
              isOpen && changeState.notice ? h("p", { className: "dsh-md-chg-diff-msg" }, changeState.notice) : null,
              WbDiffRows({
                t: t,
                rows: changeState.rows,
                loading: changeState.loading === file.path,
                error: changeState.error,
              }),
            );
          }),
        ),
      );
      children.push(
        h(
          "p",
          { className: "dsh-md-chg-foot" },
          t("changesCount") + " " + selected.length + " " + t("changesOf") + " " + files.length + " " + t("changesFiles"),
        ),
      );
      return h("div", { className: "dsh-md-chg" }, children);
    }
    // endregion

    function WbPublish(props) {
      var locale = props.locale;
      var project = props.project;
      var task = props.task;
      var busy = props.busy;
      var t = function (key) {
        return wt(locale, key);
      };
      // Hooks must run on every render: WorkbenchPanel calls this renderer
      // directly (not through React elements), so the hook lives on the panel's
      // fiber. A hook behind the `!project` early return changes the hook order
      // the moment a project shows up -> React #310 and a blank sidebar tab.
      var reasonState = useState(wt(locale, "reasonDefault"));
      if (!project) return [h("p", { className: "dsh-md-hint" }, t("noProject"))];
      var git = project.git || {};
      var changes = props.changes || project.changes || null;
      var appType = project.app && project.app.appType ? String(project.app.appType) : "";
      var isHtml = appType === "html";
      var wrongBranch = git.branch && git.branch !== "sprint/default";
      var running = wbTaskState(task) === "running" && task.kind === "publish";
      var meta = [];
      if (git.branch) meta.push(git.branch);
      if (git.dirty) meta.push((git.dirtyFiles || []).length + " " + t("dirty"));
      if (git.ahead) meta.push(git.ahead + " " + t("ahead"));

      var reason = reasonState[0];
      var setReason = reasonState[1];
      var canPublish = !running && busy !== "publish" && !wrongBranch && (isHtml || reason.trim() !== "");
      var children = [WbChanges({ locale: locale, changes: changes, onChange: props.onChange })];
      children.push(
        h(
          "div",
          { className: "dsh-md-row" },
          h(
            "span",
            { className: "dsh-md-chips dsh-md-grow" },
            git.branch
              ? h("span", { className: "dsh-md-pill" + (wrongBranch ? " is-warn" : "") }, git.branch)
              : null,
            git.dirty
              ? h("span", { className: "dsh-md-pill is-warn" }, git.dirtyFiles.length + " " + t("dirty"))
              : null,
            git.ahead ? h("span", { className: "dsh-md-pill" }, git.ahead + " " + t("ahead")) : null,
            meta.length ? null : h("span", { className: "dsh-md-pill" }, "clean"),
          ),
          h(
            "button",
            {
              className: "dsh-md-primary",
              disabled: !canPublish,
              onClick: function () {
                var chosen = selectedChangeFiles(changes);
                var all = changes && Array.isArray(changes.files) ? changes.files.length : 0;
                void wbPost("publish", {
                  reason: reason.trim() || undefined,
                  files: all && chosen.length < all ? chosen : undefined,
                });
              },
            },
            running ? t("publishBusy") : t("publishAction"),
          ),
        ),
      );
      if (wrongBranch) children.push(h("p", { className: "dsh-md-warn" }, t("branchWarn")));
      if (!isHtml) {
        children.push(
          h(
            "label",
            { className: "dsh-md-field" },
            h("span", { className: "dsh-md-field-label" }, t("publishReason")),
            h("input", {
              className: "dsh-md-input",
              placeholder: t("reasonPlaceholder"),
              value: reason,
              onChange: function (event) {
                setReason(event.target.value);
              },
            }),
          ),
        );
      }
      children.push(h("p", { className: "dsh-md-hint" }, isHtml ? t("htmlNote") : t("publishHint")));
      if (task && task.kind === "publish" && task.status !== "idle") {
        children.push(WbTask({ locale: locale, task: task }));
      }
      return children;
    }

    function WbDev(props) {
      var locale = props.locale;
      var project = props.project;
      var t = function (key) {
        return wt(locale, key);
      };
      if (!project || !project.hasDevScript) return null;
      var running = !!(project.dev && project.dev.running);
      return [
        h(
          "div",
          { className: "dsh-md-row" },
          h("span", { className: "dsh-md-field-label" }, t("devTitle")),
          running
            ? WbPill({ tone: "running", text: project.dev.url || "" })
            : WbPill({ tone: "", text: tr(locale, "status_idle") }),
          h("span", { className: "dsh-md-card-grow" }),
          running
            ? h(
                "button",
                {
                  className: "dsh-md-ghost",
                  onClick: function () {
                    openPreviewTab(project.dev && project.dev.url ? project.dev.url : "");
                  },
                },
                t("devPreview"),
              )
            : null,
          running
            ? h(
                "button",
                {
                  className: "dsh-md-ghost",
                  onClick: function () {
                    void wbPost("dev", { value: "stop" });
                  },
                },
                t("devStop"),
              )
            : h(
                "button",
                {
                  className: "dsh-md-ghost",
                  onClick: function () {
                    void wbPost("dev", { value: "start" });
                  },
                },
                t("devStart"),
              ),
        ),
      ];
    }

    var wbAutoLogin = { tried: false };

    function WorkbenchPanel(props) {
      var locale = props ? props.locale : undefined;
      var inSidebar = props && props.inSidebar === false ? false : true;
      useLang(locale);
      useWbStore();
      useEffect(function () {
        return retainWbPolling();
      }, []);
      var t = function (key) {
        return wt(locale, key);
      };
      var data = wbState.data;
      var auth = data ? data.auth : null;
      var login = data ? data.login : null;
      var task = data ? data.task : null;
      var project = data ? data.project : null;
      var busy = wbState.busy;
      var error = wbState.error;
      var actionError = wbState.actionError;
      var signedIn = !!(auth && auth.available);
      var pulled = !!project;

      useEffect(
        function () {
          if (!data) return;
          if (signedIn) {
            wbAutoLogin.tried = false;
            return;
          }
          if (wbAutoLogin.tried) return;
          var status = login && login.status ? login.status : "idle";
          if (status !== "idle" && status !== "expired") return;
          wbAutoLogin.tried = true;
          void wbPost("login", { value: "start" });
        },
        [data],
      );

      return h(
        "div",
        { className: "dsh-md dsh-md-wb" + (inSidebar ? " dsh-md-wb-sidebar" : "") },
        h(
          "div",
          { className: "dsh-md-wb-head" },
          h("span", { className: "dsh-md-wb-title" }, t("wbTitle")),
          data && data.version
            ? h("span", { className: "dsh-md-wb-chip" }, "v" + data.version)
            : null,
          h("span", { className: "dsh-md-card-grow" }),
          h(
            "button",
            {
              className: "dsh-md-icon-btn",
              title: t("refresh"),
              onClick: function () {
                void wbRefresh({ full: true });
              },
            },
            icon("refresh"),
          ),
        ),
        h(
          "div",
          { className: "dsh-md-wb-body" },
          error ? h("p", { className: "dsh-md-warn" }, error) : null,
          actionError ? h("p", { className: "dsh-md-error" }, actionError) : null,
          WbStep({
            no: 1,
            title: t("stepLogin"),
            done: signedIn,
            active: !signedIn,
            aside: signedIn && auth.userName ? h("span", { className: "dsh-md-step-aside" }, auth.userName) : null,
            children: WbLogin({ locale: locale, auth: auth, login: login, busy: busy }),
          }),
          WbStep({
            no: 2,
            title: t("stepImport"),
            done: pulled,
            active: signedIn && !pulled,
            children: WbImport({ locale: locale, auth: auth, project: project, task: task, data: data }),
          }),
          WbStep({
            no: 3,
            title: t("stepPublish"),
            done: false,
            active: pulled,
            aside: publishAside(data && data.changes, t),
            children: WbPublish({
              locale: locale,
              project: project,
              task: task,
              busy: busy,
              changes: data && data.changes,
              onChange: function () {
                wbBump();
              },
            }),
          }),
          WbDev({ locale: locale, project: project }),
        ),
      );
    }
    // #endregion

    // #region styles
    var CSS = [
      ".dsh-md{display:flex;flex-direction:column;flex:1 1 auto;width:100%;height:100%;min-height:440px;min-width:0;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;line-height:1.5}",
      ".dsh-md-sidebar{min-height:0}",
      ".dsh-md-bar{display:flex;align-items:center;gap:10px;flex:none;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.07));background:var(--dsw-alias-bg-layer-1,#fff);min-width:0}",
      ".dsh-md-id{display:flex;align-items:center;gap:7px;flex:none;min-width:0}",
      ".dsh-md-title{font-weight:600;font-size:13px;white-space:nowrap}",
      ".dsh-md-status{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-caption,#aeb4bf);flex:none}",
      ".dsh-md-status.is-running{background:#2bab63;box-shadow:0 0 0 3px rgba(43,171,99,.16)}",
      ".dsh-md-status.is-error{background:#e34d59;box-shadow:0 0 0 3px rgba(227,77,89,.16)}",
      ".dsh-md-chip{max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f2f3f5);color:var(--dsw-alias-label-secondary,#5f6672)}",
      ".dsh-md-url{display:flex;align-items:center;gap:7px;flex:1 1 220px;min-width:120px;height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.08));background:var(--dsw-alias-bg-layer-2,#f7f8fa);transition:border-color .15s ease,background .15s ease}",
      ".dsh-md-url.is-focus{border-color:var(--dsw-alias-state-business-primary,#3370ff);background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dsh-md-url-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-caption,#b7bcc7);flex:none}",
      ".dsh-md-url-input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary,#1f2329);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:0;height:100%}",
      ".dsh-md-url-input::placeholder{color:var(--dsw-alias-label-caption,#aeb4bf)}",
      ".dsh-md-tools{display:flex;align-items:center;gap:4px;flex:none}",
      ".dsh-md-seg{display:flex;align-items:center;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f2f3f5)}",
      ".dsh-md-seg-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#767c87);cursor:pointer;padding:0}",
      ".dsh-md-seg-btn:hover{color:var(--dsw-alias-label-primary,#1f2329)}",
      ".dsh-md-seg-btn.is-on{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);box-shadow:0 1px 2px rgba(0,0,0,.1)}",
      ".dsh-md-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);cursor:pointer;padding:0}",
      ".dsh-md-icon-btn:hover:enabled{background:var(--dsw-alias-bg-layer-2,#f2f3f5);color:var(--dsw-alias-label-primary,#1f2329)}",
      ".dsh-md-icon-btn:disabled{opacity:.4;cursor:default}",
      ".dsh-md-stage{position:relative;flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden;background-color:var(--dsw-alias-bg-layer-2,#f5f6f8);background-image:radial-gradient(circle at 1px 1px,rgba(0,0,0,.055) 1px,transparent 0);background-size:18px 18px}",
      ".dsh-md-canvas{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}",
      ".dsh-md-canvas.is-auto{padding:0}",
      ".dsh-md-canvas.is-tablet,.dsh-md-canvas.is-phone{padding:16px;overflow:auto;align-items:center}",
      ".dsh-md-window{display:flex;flex-direction:column;min-height:0;background:#fff;overflow:hidden}",
      ".dsh-md-window.is-auto{flex:1 1 auto;width:100%}",
      ".dsh-md-window.is-tablet,.dsh-md-window.is-phone{flex:none;height:100%;max-height:100%;border:1px solid var(--dsw-alias-border-default,rgba(0,0,0,.1));border-radius:12px;box-shadow:0 10px 30px rgba(15,23,42,.12)}",
      ".dsh-md-window-bar{display:flex;align-items:center;gap:6px;flex:none;height:28px;padding:0 10px;background:var(--dsw-alias-bg-layer-2,#f2f3f5);border-bottom:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.06))}",
      ".dsh-md-window-dot{width:8px;height:8px;border-radius:50%;background:rgba(0,0,0,.12);flex:none}",
      ".dsh-md-window-url{margin-left:8px;font-size:11px;color:var(--dsw-alias-label-tertiary,#767c87);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-md-window-body{position:relative;flex:1 1 auto;min-height:0;background:#fff}",
      ".dsh-md-frame{display:block;width:100%;height:100%;border:0;background:#fff}",
      ".dsh-md-veil{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:10px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-tertiary,#767c87);font-size:12px;z-index:2}",
      ".dsh-md-spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-top-color:var(--dsw-alias-state-business-primary,#3370ff);animation:dsh-md-spin .8s linear infinite}",
      ".is-spin{animation:dsh-md-spin .9s linear infinite}",
      ".dsh-md-warning{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:flex;align-items:center;gap:10px;max-width:min(560px,calc(100% - 32px));padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-default,rgba(0,0,0,.1));box-shadow:0 8px 24px rgba(15,23,42,.14);z-index:3}",
      ".dsh-md-warning-ico{color:#e6a23c;flex:none}",
      ".dsh-md-warning-text{display:flex;flex-direction:column;min-width:0;font-size:12px;line-height:1.45}",
      ".dsh-md-warning-text strong{font-weight:600}",
      ".dsh-md-warning-text span{color:var(--dsw-alias-label-tertiary,#767c87)}",
      ".dsh-md-empty{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:32px 24px;text-align:center}",
      ".dsh-md-empty-icon{display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.08));color:var(--dsw-alias-label-secondary,#5f6672)}",
      ".dsh-md-empty-title{margin:0;font-size:15px;font-weight:600}",
      ".dsh-md-empty-text{margin:0;max-width:460px;font-size:13px;color:var(--dsw-alias-label-tertiary,#767c87)}",
      ".dsh-md-empty-row{display:flex;align-items:center;gap:8px;width:min(440px,100%);margin-top:6px}",
      ".dsh-md-input{flex:1;min-width:0;height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-default,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;outline:0}",
      ".dsh-md-input:focus{border-color:var(--dsw-alias-state-business-primary,#3370ff)}",
      ".dsh-md-primary{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 14px;border:0;border-radius:8px;background:var(--dsw-alias-state-business-primary,#3370ff);color:#fff;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap}",
      ".dsh-md-primary:hover:enabled{filter:brightness(1.06)}",
      ".dsh-md-primary:disabled{opacity:.45;cursor:default}",
      ".dsh-md-primary.is-sm{height:26px;padding:0 10px;font-size:12px}",
      ".dsh-md-ghost{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-default,rgba(0,0,0,.1));border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);font-size:12px;cursor:pointer;white-space:nowrap}",
      ".dsh-md-ghost:hover:enabled{background:var(--dsw-alias-bg-layer-2,#f2f3f5);color:var(--dsw-alias-label-primary,#1f2329)}",
      ".dsh-md-ghost:disabled{opacity:.5;cursor:default}",
      ".dsh-md-ghost.is-block{height:30px}",
      ".dsh-md-error{margin:0;font-size:12px;color:var(--dsw-alias-label-error,#e34d59)}",
      ".dsh-md-empty-meta{margin:4px 0 0;font-size:11px;color:var(--dsw-alias-label-caption,#aeb4bf)}",
      ".dsh-md-foot{display:flex;align-items:center;gap:12px;flex:none;height:26px;padding:0 12px;border-top:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.06));font-size:11px;color:var(--dsw-alias-label-tertiary,#767c87);background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dsh-md-foot-item{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dsh-md-foot-item.is-dim{color:var(--dsw-alias-label-caption,#aeb4bf)}",
      ".dsh-md-foot-item.is-error{color:var(--dsw-alias-label-error,#e34d59)}",
      ".dsh-md-foot-grow{flex:1}",
      ".dsh-md-card{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.08));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);min-width:0}",
      ".dsh-md-card-head{display:flex;align-items:center;gap:8px;min-width:0}",
      ".dsh-md-card-ico{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f2f3f5);color:var(--dsw-alias-label-secondary,#5f6672);flex:none}",
      ".dsh-md-card-title{font-size:12px;font-weight:600;white-space:nowrap}",
      ".dsh-md-card-grow{flex:1 1 auto;min-width:0}",
      ".dsh-md-card-url{display:flex;align-items:center;gap:10px;min-width:0}",
      ".dsh-md-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-primary,#1f2329);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-md-card-meta{font-size:11px;color:var(--dsw-alias-label-caption,#aeb4bf);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dsh-md-pill{display:inline-flex;align-items:center;gap:5px;height:18px;padding:0 7px;border-radius:999px;font-size:11px;line-height:18px;background:var(--dsw-alias-bg-layer-2,#f2f3f5);color:var(--dsw-alias-label-tertiary,#767c87);flex:none}",
      ".dsh-md-pill-dot{width:5px;height:5px;border-radius:50%;background:currentColor}",
      ".dsh-md-pill.is-running{background:rgba(43,171,99,.12);color:#1f8a4c}",
      ".dsh-md-pill.is-error{background:rgba(227,77,89,.12);color:#c9303a}",
      ".dsh-md-card-skeleton{display:flex;flex-direction:column;gap:6px}",
      ".dsh-md-skeleton-line{height:8px;border-radius:4px;background:var(--dsw-alias-bg-skeleton,var(--dsw-alias-bg-layer-2,#eef0f3));animation:dsh-md-fade 1.6s ease-in-out infinite}",
      ".dsh-md-skeleton-line.is-short{width:45%}",
      ".dsh-md-chg{display:flex;flex-direction:column;gap:6px;min-width:0}",
      ".dsh-md-chg-head{display:flex;align-items:center;gap:8px;min-width:0}",
      ".dsh-md-chg-title{font-size:12px;font-weight:600;white-space:nowrap}",
      ".dsh-md-chg-sum{font-size:11px;color:var(--dsw-alias-label-tertiary,#767c87);white-space:nowrap}",
      ".dsh-md-chg-stat{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;white-space:nowrap}",
      ".dsh-md-chg-stat.is-add{color:#1f8a4c}",
      ".dsh-md-chg-stat.is-del{color:#c9303a}",
      ".dsh-md-chg-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.08));border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dsh-md-chg-group{display:flex;flex-direction:column;border-top:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.06))}",
      ".dsh-md-chg-group:first-child{border-top:0}",
      ".dsh-md-chg-row{display:grid;grid-template-columns:16px 18px minmax(0,1fr) auto auto auto;align-items:center;gap:8px;padding:5px 8px;cursor:pointer;min-width:0}",
      ".dsh-md-chg-row:hover{background:var(--dsw-alias-bg-layer-2,#f5f6f7)}",
      ".dsh-md-chg-row.is-open{background:var(--dsw-alias-bg-layer-2,#f2f3f5)}",
      ".dsh-md-chg-row.is-off .dsh-md-chg-path{opacity:.45;text-decoration:line-through}",
      ".dsh-md-chg-box{width:13px;height:13px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-state-business-primary,#3370ff)}",
      ".dsh-md-badge{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:5px;font-size:10px;font-weight:700;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:rgba(118,124,135,.14);color:#5f6672}",
      ".dsh-md-badge.is-a{background:rgba(43,171,99,.16);color:#1f8a4c}",
      ".dsh-md-badge.is-m{background:rgba(255,136,0,.16);color:#b25c00}",
      ".dsh-md-badge.is-d{background:rgba(227,77,89,.15);color:#c9303a}",
      ".dsh-md-badge.is-r{background:rgba(51,112,255,.14);color:#2a5bd7}",
      ".dsh-md-chg-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-primary,#1f2329);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:ltr}",
      ".dsh-md-chg-bin{font-size:10px;color:var(--dsw-alias-label-caption,#aeb4bf);border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.1));border-radius:4px;padding:0 4px;line-height:14px}",
      ".dsh-md-chg-diff{margin:0;padding:6px 0;max-height:260px;overflow:auto;background:var(--dsw-alias-bg-layer-2,#f7f8fa);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.55}",
      ".dsh-md-chg-line{padding:0 10px;white-space:pre;color:var(--dsw-alias-label-secondary,#5f6672)}",
      ".dsh-md-chg-line.is-add{background:rgba(43,171,99,.12);color:#1a6b3e}",
      ".dsh-md-chg-line.is-del{background:rgba(227,77,89,.11);color:#a4272f}",
      ".dsh-md-chg-line.is-hunk{color:#2a5bd7;background:rgba(51,112,255,.07)}",
      ".dsh-md-chg-line.is-meta{color:var(--dsw-alias-label-caption,#aeb4bf)}",
      ".dsh-md-chg-diff-msg{margin:0;padding:6px 10px;font-size:11px;color:var(--dsw-alias-label-caption,#aeb4bf)}",
      ".dsh-md-chg-empty{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary,#767c87)}",
      ".dsh-md-chg-foot{margin:0;font-size:11px;color:var(--dsw-alias-label-caption,#aeb4bf)}",
      ".dsh-md-ghost.is-xs{height:22px;padding:0 8px;font-size:11px}",
      ".dsh-md-wb{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-size:12px}",
      ".dsh-md-wb-head{display:flex;align-items:center;gap:8px;padding:10px 12px;flex:none;border-bottom:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.06))}",
      ".dsh-md-wb-title{font-size:13px;font-weight:600}",
      ".dsh-md-wb-body{flex:1 1 auto;min-height:0;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:12px}",
      ".dsh-md-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary,#767c87);cursor:pointer;flex:none}",
      ".dsh-md-icon-btn:hover{background:var(--dsw-alias-bg-layer-2,#f2f3f5);color:var(--dsw-alias-label-primary,#1f2329)}",
      ".dsh-md-step{display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.08));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);min-width:0}",
      ".dsh-md-step.is-active{border-color:var(--dsw-alias-state-business-primary,#3370ff)}",
      ".dsh-md-step.is-done .dsh-md-step-no{background:rgba(43,171,99,.14);color:#1f8a4c}",
      ".dsh-md-step-head{display:flex;align-items:center;gap:8px;min-width:0}",
      ".dsh-md-step-no{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex:none;border-radius:50%;background:var(--dsw-alias-bg-layer-2,#f2f3f5);color:var(--dsw-alias-label-tertiary,#767c87);font-size:11px;font-weight:600}",
      ".dsh-md-step-title{font-size:12px;font-weight:600;white-space:nowrap}",
      ".dsh-md-step-aside{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#767c87);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-md-qr{display:flex;gap:12px;align-items:flex-start;min-width:0}",
      ".dsh-md-qr-img{width:164px;height:164px;flex:none;border-radius:8px;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.08));background:#fff;object-fit:contain}",
      ".dsh-md-qr-fallback{width:164px;height:164px;flex:none;display:flex;align-items:center;justify-content:center;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f2f3f5);font-size:11px;color:var(--dsw-alias-label-error,#e34d59);text-align:center}",
      ".dsh-md-qr-side{display:flex;flex-direction:column;gap:6px;min-width:0;align-items:flex-start}",
      ".dsh-md-qr-title{font-size:12px;font-weight:600}",
      ".dsh-md-link{font-size:11px;color:var(--dsw-alias-state-business-primary,#3370ff);text-decoration:none;cursor:pointer}",
      ".dsh-md-link:hover{text-decoration:underline}",
      ".dsh-md-field{display:flex;flex-direction:column;gap:4px;min-width:0}",
      ".dsh-md-field-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#767c87)}",
      ".dsh-md-field-label-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px}",
      ".dsh-md-hint-inline{margin:0;font-weight:400;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}",
      ".dsh-md-input-row{display:flex;align-items:center;gap:8px}",
      ".dsh-md-input-row .dsh-md-input{flex:1;min-width:0}",
      ".dsh-md-inline-btn{flex:none;white-space:nowrap}",
      ".dsh-md-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}",
      ".dsh-md-chip{max-width:140px;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.08));border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);font-size:11px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-md-chip:hover{background:var(--dsw-alias-bg-layer-2,#f2f3f5);color:var(--dsw-alias-label-primary,#1f2329)}",
      ".dsh-md-locals{display:flex;flex-direction:column;gap:6px;min-width:0}",
      ".dsh-md-local{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:2px 8px;padding:6px 8px;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.08));border-radius:8px;min-width:0}",
      ".dsh-md-local-current{border-color:var(--dsw-alias-state-business-primary,#3370ff);background:var(--dsw-alias-bg-layer-2,#f5f6f7)}",
      ".dsh-md-local-main{display:flex;align-items:center;gap:6px;min-width:0}",
      ".dsh-md-local-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-md-local-path{grid-column:1/-1;font-size:11px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-md-local .dsh-md-inline-btn{grid-row:1;grid-column:2}",
      ".dsh-md-project{display:flex;align-items:center;gap:8px;min-width:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f5f6f7)}",
      ".dsh-md-project-name{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-md-path{max-width:100%}",
      ".dsh-md-hint{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-caption,#aeb4bf)}",
      ".dsh-md-warn{margin:0;padding:6px 8px;border-radius:7px;background:rgba(255,171,0,.12);color:#a56800;font-size:11px;line-height:1.6}",
      ".dsh-md-grow{flex:1 1 auto;min-width:0}",
      ".dsh-md-task{display:flex;flex-direction:column;gap:6px;min-width:0}",
      ".dsh-md-task-head{display:flex;align-items:center;gap:8px}",
      ".dsh-md-log{margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f5f6f7);color:var(--dsw-alias-label-secondary,#5f6672);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.6;max-height:168px;overflow:auto;white-space:pre-wrap;word-break:break-all}",
      ".dsh-md-log.is-result{max-height:220px;color:var(--dsw-alias-label-primary,#1f2329)}",
      ".dsh-md-sidebar .dsh-md-seg,.dsh-md-sidebar .dsh-md-chip{display:none}",
      "@keyframes dsh-md-spin{to{transform:rotate(360deg)}}",
      "@keyframes dsh-md-fade{0%,100%{opacity:.55}50%{opacity:1}}",
      ".dsh-md{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}",
      ".dsh-md-wb{background:linear-gradient(180deg,#ffffff 0%,#ffffff 40%,#fbfcfd 100%);letter-spacing:.01em}",
      ".dsh-md-wb-body{gap:10px;padding:14px 14px 18px}",
      ".dsh-md-wb-body::-webkit-scrollbar,.dsh-md-log::-webkit-scrollbar,.dsh-md-chg-diff::-webkit-scrollbar{width:8px;height:8px}",
      ".dsh-md-wb-body::-webkit-scrollbar-thumb,.dsh-md-log::-webkit-scrollbar-thumb,.dsh-md-chg-diff::-webkit-scrollbar-thumb{background:rgba(15,23,42,.16);border-radius:999px;border:2px solid transparent;background-clip:padding-box}",
      ".dsh-md-wb-body::-webkit-scrollbar-thumb:hover,.dsh-md-log::-webkit-scrollbar-thumb:hover,.dsh-md-chg-diff::-webkit-scrollbar-thumb:hover{background:rgba(15,23,42,.28);background-clip:padding-box}",
      ".dsh-md-wb-body::-webkit-scrollbar-track,.dsh-md-log::-webkit-scrollbar-track,.dsh-md-chg-diff::-webkit-scrollbar-track{background:transparent}",
      ".dsh-md ::selection{background:rgba(51,112,255,.18)}",
      ".dsh-md-wb-head{padding:11px 14px;gap:8px;background:linear-gradient(180deg,#ffffff,#fcfdff);box-shadow:0 1px 0 rgba(16,24,40,.03)}",
      ".dsh-md-wb-title{font-size:13px;font-weight:650;letter-spacing:.2px}",
      ".dsh-md-wb-chip{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:999px;background:rgba(51,112,255,.09);color:#2a5bd7;font-size:10px;font-weight:600;letter-spacing:.2px}",
      ".dsh-md-icon-btn{width:28px;height:28px;border-radius:9px;transition:background .14s ease,color .14s ease}",
      ".dsh-md-step{padding:12px 13px 13px;gap:10px;border-radius:12px;border:1px solid rgba(16,24,40,.08);box-shadow:0 1px 2px rgba(16,24,40,.04);transition:box-shadow .16s ease,border-color .16s ease,transform .16s ease}",
      ".dsh-md-step:hover{box-shadow:0 2px 8px rgba(16,24,40,.06)}",
      ".dsh-md-step.is-active{border-color:rgba(51,112,255,.35);box-shadow:0 0 0 3px rgba(51,112,255,.07),0 2px 10px rgba(51,112,255,.08);background:linear-gradient(180deg,rgba(51,112,255,.03),rgba(255,255,255,0) 42%),#fff}",
      ".dsh-md-step.is-done{border-color:rgba(43,171,99,.3)}",
      ".dsh-md-step-no{width:20px;height:20px;font-size:11px;font-weight:650;background:rgba(16,24,40,.06)}",
      ".dsh-md-step.is-active .dsh-md-step-no{background:var(--dsw-alias-state-business-primary,#3370ff);color:#fff;box-shadow:0 1px 3px rgba(51,112,255,.45)}",
      ".dsh-md-step.is-done .dsh-md-step-no{background:rgba(43,171,99,.16);color:#1f8a4c}",
      ".dsh-md-step-title{font-size:12.5px;font-weight:650;letter-spacing:.2px}",
      ".dsh-md-step-aside{font-size:11px;color:var(--dsw-alias-label-caption,#aeb4bf)}",
      ".dsh-md-card{border-radius:12px;border-color:rgba(16,24,40,.08);box-shadow:0 1px 2px rgba(16,24,40,.04)}",
      ".dsh-md-project{border-radius:10px;border:1px solid rgba(16,24,40,.06);background:linear-gradient(180deg,rgba(16,24,40,.03),rgba(16,24,40,.015))}",
      ".dsh-md-local{border-radius:10px;border-color:rgba(16,24,40,.08);transition:border-color .14s ease,background .14s ease,transform .14s ease}",
      ".dsh-md-local:hover{border-color:rgba(51,112,255,.35);background:#fff;transform:translateY(-1px)}",
      ".dsh-md-local-current{border-color:rgba(51,112,255,.5);box-shadow:0 0 0 3px rgba(51,112,255,.07)}",
      ".dsh-md-local-name{font-weight:650}",
      ".dsh-md-primary{height:32px;border-radius:9px;font-weight:600;letter-spacing:.2px;background:linear-gradient(180deg,#3d7bff,#2f6bf0);box-shadow:0 1px 2px rgba(47,107,240,.35),inset 0 1px 0 rgba(255,255,255,.18);transition:filter .14s ease,box-shadow .14s ease,transform .1s ease}",
      ".dsh-md-primary:hover:enabled{filter:brightness(1.05);box-shadow:0 3px 10px rgba(47,107,240,.32),inset 0 1px 0 rgba(255,255,255,.18)}",
      ".dsh-md-primary:active:enabled{transform:translateY(1px);box-shadow:0 1px 2px rgba(47,107,240,.3)}",
      ".dsh-md-primary.is-sm{height:27px;border-radius:8px;padding:0 11px}",
      ".dsh-md-ghost{border-radius:9px;border-color:rgba(16,24,40,.1);font-weight:500;transition:background .14s ease,border-color .14s ease,color .14s ease}",
      ".dsh-md-ghost:hover:enabled{border-color:rgba(16,24,40,.16)}",
      ".dsh-md-ghost.is-xs{height:22px;border-radius:7px}",
      ".dsh-md-input{height:32px;border-radius:9px;border-color:rgba(16,24,40,.12);transition:border-color .14s ease,box-shadow .14s ease}",
      ".dsh-md-input:hover{border-color:rgba(16,24,40,.2)}",
      ".dsh-md-input:focus{border-color:var(--dsw-alias-state-business-primary,#3370ff);box-shadow:0 0 0 3px rgba(51,112,255,.14)}",
      ".dsh-md-input::placeholder{color:#aeb4bf}",
      ".dsh-md-chip{background:rgba(16,24,40,.03)}",
      ".dsh-md-chip:hover{border-color:rgba(51,112,255,.3);color:#2a5bd7}",
      ".dsh-md-chg-list{border-radius:12px;border-color:rgba(16,24,40,.08);box-shadow:0 1px 2px rgba(16,24,40,.04)}",
      ".dsh-md-chg-row{padding:6px 10px;gap:9px;transition:background .12s ease}",
      ".dsh-md-chg-row:hover{background:rgba(51,112,255,.045)}",
      ".dsh-md-chg-row.is-open{background:rgba(16,24,40,.045)}",
      ".dsh-md-badge{width:19px;height:19px;border-radius:6px;font-size:10px;font-weight:700;box-shadow:inset 0 0 0 1px rgba(16,24,40,.05)}",
      ".dsh-md-chg-path{font-size:12px;letter-spacing:0}",
      ".dsh-md-chg-title{font-size:12.5px;font-weight:650;letter-spacing:.2px}",
      ".dsh-md-pill.is-warn{background:rgba(255,171,0,.14);color:#a56800}",
      ".dsh-md-chg-diff{border-radius:10px;margin:2px 8px 8px;padding:6px 0;box-shadow:inset 0 0 0 1px rgba(16,24,40,.05)}",
      ".dsh-md-chg-line{padding:1px 10px}",
      ".dsh-md-chg-line.is-add{background:rgba(43,171,99,.14)}",
      ".dsh-md-chg-line.is-del{background:rgba(227,77,89,.13)}",
      ".dsh-md-chg-box{accent-color:#2f6bf0}",
      ".dsh-md-empty{gap:9px;padding:22px 16px;border:1px dashed rgba(16,24,40,.12);border-radius:12px;background:linear-gradient(180deg,rgba(16,24,40,.018),rgba(16,24,40,0))}",
      ".dsh-md-empty-title{font-size:14px;font-weight:650;letter-spacing:.2px}",
      ".dsh-md-empty-text{font-size:12.5px;line-height:1.65}",
      ".dsh-md-empty-meta{font-size:11px}",
      ".dsh-md-pill{border-radius:999px;font-weight:550;letter-spacing:.2px}",
      ".dsh-md-pill.is-running{box-shadow:0 0 0 3px rgba(43,171,99,.1)}",
      ".dsh-md-hint{line-height:1.65}",
      ".dsh-md-warn{border-radius:9px;box-shadow:inset 0 0 0 1px rgba(255,171,0,.25)}",
      ".dsh-md-error{font-weight:500}",
      ".dsh-md-log{border-radius:10px;box-shadow:inset 0 0 0 1px rgba(16,24,40,.05);line-height:1.65}",
      ".dsh-md-bar{padding:9px 12px;gap:9px;background:linear-gradient(180deg,#ffffff,#fcfdff);box-shadow:0 1px 0 rgba(16,24,40,.03)}",
      ".dsh-md-title{letter-spacing:.2px}",
      ".dsh-md-foot{background:#fcfdff;letter-spacing:.2px}",
      ".dsh-md-card-title{letter-spacing:.2px}",
      "@media (prefers-reduced-motion: reduce){.dsh-md-step,.dsh-md-primary,.dsh-md-ghost,.dsh-md-input,.dsh-md-local,.dsh-md-chg-row{transition:none}}",
    ].join("\n");
    // #endregion

    // #region registration
    function apply(ctx) {
      pluginCtx = ctx;
      var locale = ctx.locale;

      ctx.effect(function () {
        var style = document.createElement("style");
        style.dataset.plugin = "dsh-miaoda";
        style.textContent = CSS;
        document.head.appendChild(style);
        return function () {
          try {
            style.remove();
          } catch (error) {
            /* document may already be gone */
          }
        };
      }, "dsh-miaoda: preview styles");

      ctx.slots.inject("conversation.view", function () {
        return ctx.slots.register(
          {
            name: "conversation.view",
            id: VIEW_ID,
            order: 30,
            label: function () {
              return tr(locale, "viewLabel");
            },
            inject: function () {
              return { locale: locale };
            },
          },
          PreviewSurface,
        );
      });

      ctx.slots.inject("tool.call.toolview", function () {
        return ctx.slots.register(
          {
            name: "tool.call.toolview",
            key: "miaoda_dev",
            inject: function () {
              return { locale: locale };
            },
          },
          MiaodaDevCard,
        );
      });

      ctx.inject(["sidebarRightTabs"], function (owner) {
        var tabs = typeof owner.get === "function" ? owner.get("sidebarRightTabs") : owner.sidebarRightTabs;
        if (!tabs || typeof tabs.register !== "function") return;
        owner.effect(function () {
          return tabs.register({
            id: SIDEBAR_TAB_ID,
            kind: SIDEBAR_KIND,
            priority: "extension",
            title: function () {
              return tr(locale, "tabTitle");
            },
            guide: [
              {
                order: 120,
                title: function () {
                  return tr(locale, "tabGuide");
                },
              },
            ],
          });
        }, "dsh-miaoda: preview tab type");
        owner.slots.inject("sidebar.right.pane.tab", function () {
          return owner.slots.register(
            {
              name: "sidebar.right.pane.tab",
              key: SIDEBAR_TAB_ID,
              inject: function () {
                return { locale: locale, inSidebar: true };
              },
            },
            PreviewSurface,
          );
        });
        owner.effect(function () {
          return tabs.register({
            id: WB_TAB_ID,
            kind: WB_KIND,
            priority: "extension",
            title: function () {
              return wt(locale, "wbTabTitle");
            },
            guide: [
              {
                order: 110,
                title: function () {
                  return wt(locale, "wbTabGuide");
                },
              },
            ],
          });
        }, "dsh-miaoda: workbench tab type");
        owner.slots.inject("sidebar.right.pane.tab", function () {
          return owner.slots.register(
            {
              name: "sidebar.right.pane.tab",
              key: WB_TAB_ID,
              inject: function () {
                return { locale: locale, inSidebar: true };
              },
            },
            WorkbenchPanel,
          );
        });
      });
    }
    // #endregion

    var inject = ["slots", "locale"];
    exports.name = "dsh-miaoda";
    exports.inject = inject;
    exports.apply = apply;
    exports.__internals = {
      ROUTE: ROUTE,
      VIEW_ID: VIEW_ID,
      SIDEBAR_TAB_ID: SIDEBAR_TAB_ID,
      SIDEBAR_KIND: SIDEBAR_KIND,
      WB_ROUTE: WB_ROUTE,
      WB_TAB_ID: WB_TAB_ID,
      WB_KIND: WB_KIND,
      normalizeUrl: normalizeUrl,
      parseDevText: parseDevText,
      blockPhase: blockPhase,
      resultText: resultText,
      displayPath: displayPath,
      effectiveUrl: effectiveUrl,
      previewState: state,
      workbenchState: wbState,
    };

    return module.exports;
  },
});
