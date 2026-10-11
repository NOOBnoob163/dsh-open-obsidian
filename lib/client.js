/**
 * dsh-open-obsidian — Browser half.
 *
 * Settings section "Obsidian 助手" in the 设置 page: master switch, one
 * enable toggle per detected Obsidian vault (read from Obsidian's own
 * registry), custom launch command, save + launch-test buttons. Talks to
 * the Host through the plain webServer routes /dsh-open-obsidian/* (same
 * origin). Loaded at page boot via the dsh.client roster, so it survives
 * refresh.
 *
 * Dark-mode safe: all colors come from the --dsw-alias-* tokens with
 * contrast that holds in both palettes (no white-on-white: buttons are
 * outline style, text uses label-primary).
 */
window.__ModuleLoader__.load({
  id: "dsh-open-obsidian",
  factory: (require) => {
    try {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
      var React = require("react");

      if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="dsh-open-obsidian"]') === null) {
        var style = document.createElement("style");
        style.dataset.plugin = "dsh-open-obsidian";
        style.dataset.pluginCss = "dsh-open-obsidian";
        style.textContent = [
          /**
           * 版面 —— 2026-10-09 照 DSH 设置页的统一视觉语言重做
           *
           * 值一律走 var(--dsw-*)，不自己配色、不自己定圆角。
           *
           * 跟前一版（0.9.0 那种"一区块一卡片"）的关键差别：
           *   · 页头用**状态胶囊**（带小圆点）先说清"现在什么情况"，
           *     不是让人从一堆小字里自己读
           *   · 每个分组一张 Card，组内标题走 Sec（竖条用**主题色**，不是灰的）
           *   · 设置行统一 Row：左"名称+说明" / 右控件
           *   · 开关是 <button role=switch>，
           *     不再是藏起来的 checkbox + 伪元素轨道
           *   · 状态信息用淡彩胶囊 / 统计格，路径用等宽小字 + 复制按钮
           */
          '.obs-panel { display: flex; flex-direction: column; gap: 12px; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.6; --obs-accent: var(--dsw-alias-link, #4176e6); }',

          /* 页头：状态胶囊一排 */
          '.obs-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }',
          '.obs-headline { flex: 1 1 auto; min-width: 0; }',
          '.obs-name { font-weight: 600; font-size: 14.5px; letter-spacing: .01em; }',
          '.obs-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-top: 1px; }',

          /* 状态胶囊：淡彩底 + 同色字 + 前面一个小圆点 */
          '.obs-pill { display: inline-flex; align-items: center; gap: 6px; flex: none; font-size: 11.5px; font-weight: 500; padding: 2px 9px; border-radius: 999px; border: 1px solid transparent; white-space: nowrap; }',
          '.obs-pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }',
          '.obs-pill.ok { color: var(--dsw-alias-state-success-primary, #22c55e); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 15%, transparent); }',
          '.obs-pill.warn { color: var(--dsw-alias-state-warn-primary, #f59e0b); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 15%, transparent); }',
          '.obs-pill.off { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.12)); }',

          /* 分组卡片：跟 DSH 设置页的卡片一个长相 */
          '.obs-card { border: 1px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l3, rgba(127,127,127,.22))); background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, transparent)); border-radius: var(--dsw-radius-lg, 16px); padding: 4px 14px 10px; box-shadow: var(--dsw-elevation-soft, none); }',
          '.obs-card.plain { padding: 12px 14px; }',

          /* 分组标题：前面一小段主题色竖条 */
          '.obs-sec { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 12.5px; letter-spacing: .02em; padding: 12px 0 6px; }',
          '.obs-sec::before { content: ""; width: 3px; height: 12px; border-radius: 2px; background: var(--obs-accent); opacity: .85; flex: none; }',
          '.obs-sec:first-child { padding-top: 4px; }',
          '.obs-sec-meta { margin-left: auto; flex: none; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 400; white-space: nowrap; }',

          /* 一行设置：左标签、右控件 */
          '.obs-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 11px 0; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.12)); }',
          '.obs-row:last-child { border-bottom: 0; }',
          '.obs-row.top { align-items: flex-start; }',
          '.obs-lab { flex: 1 1 auto; min-width: 0; }',
          '.obs-labname { font-weight: 500; color: var(--dsw-alias-label-primary); }',
          '.obs-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.55; margin-top: 2px; }',
          '.obs-ctl { flex: none; display: flex; align-items: center; gap: 8px; }',

          /* 滑动开关：<button role=switch>，跟 DSH 设置页同一套尺寸/配色 */
          '.obs-sw { position: relative; flex: none; width: 38px; height: 21px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.45)); background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.18)); cursor: pointer; padding: 0; transition: background .15s ease, border-color .15s ease; }',
          '.obs-sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 15px; height: 15px; border-radius: 50%; background: var(--dsw-alias-switch-thumb, #fff); box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .15s ease; }',
          '.obs-sw.on { background: var(--dsw-alias-brand-primary, #4a6cf7); border-color: transparent; }',
          '.obs-sw.on::after { transform: translateX(17px); }',
          '.obs-sw[disabled] { opacity: .5; cursor: default; }',
          '.obs-sw:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }',

          /* 知识库清单：一个框装所有行、行间发丝线。
             名字和路径**同一行**（路径跟在后面、窄了就折行）—— 之前排成两行，
             3 个库就吃掉 321px，整块面板比窗口还高，底下要滚才看得见。 */
          '.obs-list { display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2)); border-radius: var(--dsw-radius-md, 12px); overflow: hidden; }',
          '.obs-sess { display: flex; align-items: center; gap: 9px; padding: 8px 11px; }',
          '.obs-sess + .obs-sess { border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.12)); }',
          '.obs-sess:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.06)); }',
          '.obs-sess input[type=checkbox] { flex: none; margin: 0; width: 15px; height: 15px; accent-color: var(--obs-accent); cursor: pointer; }',
          '.obs-sessmain { flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }',
          '.obs-sessname { flex: none; font-weight: 500; }',
          '.obs-sessmeta { min-width: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; word-break: break-all; font-family: ui-monospace, Consolas, "Courier New", monospace; }',
          '.obs-empty { padding: 14px 12px; color: var(--dsw-alias-label-secondary); font-size: 12px; text-align: center; }',

          /* 行尾小标签（打开中 / 已设自定义命令） */
          '.obs-tag { flex: none; font-size: 11px; font-weight: 500; padding: 1px 8px; border-radius: 999px; border: 1px solid transparent; white-space: nowrap; }',
          '.obs-tag.on { color: var(--dsw-alias-state-success-primary, #22c55e); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 14%, transparent); }',
          '.obs-tag.manual { color: var(--obs-accent); background: color-mix(in srgb, var(--obs-accent) 14%, transparent); }',
          '.obs-tag.warn { color: var(--dsw-alias-state-warn-primary, #f59e0b); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 14%, transparent); }',
          '.obs-tag.off { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.12)); }',

          /* 统计格：一个大数字 + 一行小标签，横向并排 */
          '.obs-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(86px, 1fr)); gap: 8px; padding-bottom: 10px; }',
          '.obs-stat { min-width: 0; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14)); background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.07)); border-radius: var(--dsw-radius-md, 12px); padding: 9px 12px; }',
          '.obs-statnum { font-size: 19px; font-weight: 600; line-height: 1.25; font-variant-numeric: tabular-nums; }',
          '.obs-statlbl { color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 1.4; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
          '.obs-stat.muted .obs-statnum { color: var(--dsw-alias-label-secondary); opacity: .55; font-weight: 500; }',

          /* 输入框 */
          '.obs-input { box-sizing: border-box; width: 100%; height: 32px; font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm, 8px); padding: 0 10px; }',
          '.obs-input:focus { outline: none; border-color: var(--obs-accent); }',
          '.obs-input::placeholder { color: var(--dsw-alias-label-secondary); opacity: .7; }',

          /* 按钮：分主次。行内上下留白收窄，卡片本身已经有间距了 */
          '.obs-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 2px 0 6px; }',
          '.obs-btn { border: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35)); background: var(--dsw-alias-bg-layer-2, transparent); color: inherit; border-radius: var(--dsw-radius-sm, 8px); padding: 5px 13px; font: inherit; font-size: 12.5px; cursor: pointer; transition: background .12s ease, border-color .12s ease; }',
          '.obs-btn:hover:not([disabled]) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.09)); }',
          '.obs-btn.primary { background: var(--dsw-static-deepseek-500, #4176e6); border-color: transparent; color: #fff; font-weight: 500; }',
          '.obs-btn.primary:hover:not([disabled]) { background: var(--dsw-static-deepseek-450, #5686fe); }',
          '.obs-btn[disabled] { opacity: .5; cursor: default; }',
          '.obs-ok { color: var(--dsw-alias-state-success-primary, #22c55e); font-size: 12px; }',
          '.obs-err { color: var(--dsw-alias-state-error-primary, #d0453f); font-size: 12px; white-space: pre-wrap; }',

          /* 代码块那种底的文字区（最近一次动作 / 日志尾巴）。
             max-height 收在 96px：它通常只有一两行，给 150px 会白占半屏。 */
          '.obs-tail { white-space: pre-wrap; font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; line-height: 1.55; max-height: 96px; overflow: auto; background: var(--dsw-alias-markdown-code-block, rgba(127,127,127,.08)); border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14)); border-radius: var(--dsw-radius-sm, 8px); padding: 8px 10px; margin: 2px 0 6px; color: var(--dsw-alias-label-secondary); }',

          /* 文件位置：一直摊开，每条带一个"复制" */
          '.obs-paths { display: flex; flex-direction: column; }',
          '.obs-path { display: flex; align-items: center; gap: 8px; padding: 4px 0; }',
          '.obs-pathlbl { flex: none; width: 68px; color: var(--dsw-alias-label-secondary); font-size: 12px; }',
          '.obs-pathval { flex: 1 1 auto; min-width: 0; font-family: ui-monospace, Consolas, "Courier New", monospace; font-size: 11.5px; line-height: 1.5; word-break: break-all; user-select: all; color: var(--dsw-alias-label-secondary); }',
          '.obs-copy { flex: none; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); background: transparent; color: var(--dsw-alias-label-secondary); border-radius: var(--dsw-radius-xs, 4px); padding: 1px 7px; font: inherit; font-size: 11px; cursor: pointer; }',
          '.obs-copy:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }',

          /* 折叠块（原理说明 / 日志尾巴） */
          '.obs-fold { margin-top: 6px; }',
          '.obs-fold > summary { cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 12px; list-style: none; display: flex; align-items: center; gap: 6px; padding: 3px 0; }',
          '.obs-fold > summary::-webkit-details-marker { display: none; }',
          '.obs-fold > summary::before { content: "▸"; font-size: 10px; transition: transform .12s ease; }',
          '.obs-fold[open] > summary::before { transform: rotate(90deg); }',
          '.obs-fold > summary:hover { color: var(--dsw-alias-label-primary); }',
          '.obs-foldbody { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; }',

          /* 高级选项：整块一个折叠卡 */
          '.obs-advanced { border: 1px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l1)); border-radius: var(--dsw-radius-lg, 16px); background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2)); margin-top: 4px; }',
          '.obs-advanced > summary { display: flex; align-items: center; gap: 8px; padding: 11px 14px; cursor: pointer; list-style: none; font-weight: 600; font-size: 12.5px; letter-spacing: .02em; }',
          '.obs-advanced > summary::-webkit-details-marker { display: none; }',
          '.obs-advanced > summary::before { content: "▸"; font-size: 10px; color: var(--dsw-alias-label-secondary); transition: transform .12s ease; flex: none; }',
          '.obs-advanced[open] > summary::before { transform: rotate(90deg); }',
          '.obs-advanced[open] > summary { border-bottom: 1px solid var(--dsw-alias-border-l1); }',
          '.obs-advanced > summary:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }',
          '.obs-advanced-body { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; }',
          '.obs-adv-flag { margin-left: auto; font-weight: 400; font-size: 11px; color: var(--dsw-alias-state-warn-primary); border: 1px solid currentColor; border-radius: 999px; padding: 0 7px; white-space: nowrap; }',

          /* 结尾说明：平铺小字 */
          '.obs-note { display: flex; flex-direction: column; gap: 4px; color: var(--dsw-alias-label-secondary); font-size: 12px; }',
          '.obs-note-lead { font-weight: 500; color: var(--dsw-alias-label-primary); }'
        ].join("\n");
        document.head.appendChild(style);
      }

      /** Pending debounce timer for the custom-command field (auto-save). */
      var commandSaveTimer = null;

      /** Windows 打开的日志尾巴定时器（面板卸载时清掉）。 */
      var tailTimer = null;

      /**
       * 复制到剪贴板。
       *
       * 【踩过的坑，写在这里免得再犯】写入剪贴板要求**文档处于聚焦状态**；
       * 无焦点的窗口里 `navigator.clipboard.writeText` 会静默不落定
       * （promise 一直挂着，不报错也不成功）。所以这里两条路都试：
       * 先走异步 API，失败就退回到老的 execCommand 路子。
       */
      function copyText(text, onDone) {
        var finish = function (ok) { if (typeof onDone === "function") onDone(ok); };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(
              function () { finish(true); },
              function () { finish(fallbackCopy(text)); }
            );
            return;
          }
        } catch (e) { /* 落到下面的兜底 */ }
        finish(fallbackCopy(text));
      }

      function fallbackCopy(text) {
        try {
          var ta = document.createElement("textarea");
          ta.value = text;
          ta.setAttribute("readonly", "");
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          var ok = document.execCommand && document.execCommand("copy");
          document.body.removeChild(ta);
          return !!ok;
        } catch (e) {
          return false;
        }
      }

      function ObsidianSettingsPanel() {
        var loading = React.useState(true);
        var setLoading = loading[1];
        var enabled = React.useState(true);
        var setEnabled = enabled[1];
        var vaults = React.useState([]);
        var setVaults = vaults[1];
        var command = React.useState("");
        var setCommand = command[1];
        var skipOpen = React.useState(true);
        var setSkipOpen = skipOpen[1];
        var silentOpen = React.useState(true);
        var setSilentOpen = silentOpen[1];
        var busy = React.useState(false);
        var setBusy = busy[1];
        var message = React.useState(null);
        var setMessage = message[1];
        var error = React.useState(null);
        var setError = error[1];
        var lastDecision = React.useState(null);
        var setLastDecision = lastDecision[1];
        var logPath = React.useState("");
        var setLogPath = logPath[1];

        React.useEffect(function () {
          var cancelled = false;
          fetch("/dsh-open-obsidian/settings", { headers: { accept: "application/json" } })
            .then(function (r) { return r.json(); })
            .then(function (j) {
              if (cancelled) return;
              applyPayload(j);
              setLoading(false);
            })
            .catch(function (err) {
              if (cancelled) return;
              setError("读取设置失败：" + (err && err.message ? err.message : String(err)));
              setLoading(false);
            });
          return function () { cancelled = true; };
        }, []);

        function refresh() {
          setBusy(true); setMessage(null); setError(null);
          fetch("/dsh-open-obsidian/settings", { headers: { accept: "application/json" } })
            .then(function (r) { return r.json(); })
            .then(function (j) {
              applyPayload(j);
              setMessage("列表已刷新");
              setBusy(false);
            })
            .catch(function (err) {
              setError("刷新失败：" + (err && err.message ? err.message : String(err)));
              setBusy(false);
            });
        }

        /** Take every editable + status field from one /settings payload. */
        function applyPayload(j) {
          setEnabled(!!j.enabled);
          setVaults(Array.isArray(j.vaults) ? j.vaults : []);
          setSkipOpen(typeof j.skipWhenAlreadyOpen === "boolean" ? j.skipWhenAlreadyOpen : true);
          setSilentOpen(typeof j.silentOpen === "boolean" ? j.silentOpen : true);
          setCommand(typeof j.command === "string" ? j.command : "");
          applyStatus(j);
        }

        /** Re-read the whole payload without touching the message line. */
        function reloadQuiet() {
          fetch("/dsh-open-obsidian/settings", { headers: { accept: "application/json" } })
            .then(function (r) { return r.json(); })
            .then(applyPayload)
            .catch(function () {});
        }

        /**
         * Every control saves itself. A switch that needed a separate "save"
         * button read as broken: flip it off, click 刷新 (or leave the page and
         * come back), and the panel reloaded the still-unchanged server value —
         * the switch appeared to turn itself back on. `patch` carries only the
         * field that changed; everything else is sent as it currently stands.
         */
        function applyPatch(patch) {
          setMessage(null); setError(null);
          var payload = {
            enabled: enabled[0],
            vaultPaths: vaults[0].filter(function (v) { return v.enabled; }).map(function (v) { return v.path; }),
            skipWhenAlreadyOpen: skipOpen[0],
            silentOpen: silentOpen[0],
            command: command[0]
          };
          Object.keys(patch).forEach(function (key) { payload[key] = patch[key]; });
          fetch("/dsh-open-obsidian/settings", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload)
          })
            .then(function (r) { return r.json(); })
            .then(function (j) {
              if (j && j.ok) { setMessage("已保存，立即生效"); reloadStatus(); }
              else { setError((j && j.error) || "保存失败，已还原成后台里的设置"); reloadQuiet(); }
            })
            .catch(function (err) {
              setError("保存失败：" + (err && err.message ? err.message : String(err)) + "（已还原）");
              reloadQuiet();
            });
        }

        /** Facts the panel shows but never edits: last decision + log file. */
        function applyStatus(j) {
          setLastDecision(j && j.lastDecision && typeof j.lastDecision === "object" ? j.lastDecision : null);
          setLogPath(j && typeof j.logPath === "string" ? j.logPath : "");
        }

        /** Re-read only the status facts (after a save / a test launch). */
        function reloadStatus() {
          fetch("/dsh-open-obsidian/settings", { headers: { accept: "application/json" } })
            .then(function (r) { return r.json(); })
            .then(applyStatus)
            .catch(function () {});
        }

        /** Plain-language rendering of one decision-log line. */
        var REASON_TEXT = {
          "user-message": "打开（你在这个库的对话里发了第一条消息）",
          "agent-write": "打开（AI 正在这个库里写东西，而 Obsidian 没开）",
          "already-open": "跳过（这个库本来就开着，不抢你的焦点）",
          "no-recent-agent-activity": "没动作（库里有文件变动，但 AI 没在干活）",
          "manual-test": "打开（你点了下面的测试按钮）",
          "silent-open-ok": "静默打开（新窗口放在你当前窗口后面，没抢焦点）",
          "silent-open-failed": "打开时没能静默（窗口可能闪了一下，原因见日志）"
        };

        function describeDecision(decision) {
          if (!decision || typeof decision !== "object") return null;
          var when = "";
          var t = Date.parse(decision.at);
          if (!isNaN(t)) {
            var dt = new Date(t);
            when = (dt.getMonth() + 1) + "-" + dt.getDate() + " " +
              ("0" + dt.getHours()).slice(-2) + ":" + ("0" + dt.getMinutes()).slice(-2);
          }
          // A silent-open line logs kind="silent-open" with reason="ok"/"failed",
          // so it is keyed on the pair, not on reason alone.
          var key = decision.kind === "silent-open"
            ? (decision.reason === "ok" ? "silent-open-ok" : "silent-open-failed")
            : decision.reason;
          var why = REASON_TEXT[key] || ("动作：" + decision.reason);
          return (when ? when + " · " : "") + why + " ｜ " + decision.vault;
        }

        /** Show the decision log in Explorer (the panel's troubleshooting door). */
        function revealLog() {
          setMessage(null); setError(null);
          fetch("/dsh-open-obsidian/reveal-log", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}"
          })
            .then(function (r) { return r.json(); })
            .then(function (j) {
              if (j && j.ok) setMessage("已在文件管理器里定位到日志文件");
              else setError((j && j.error) || "打开日志失败");
            })
            .catch(function (err) {
              setError("打开日志失败：" + (err && err.message ? err.message : String(err)));
            });
        }

        function toggleVault(index, checked) {
          var next = vaults[0].map(function (v, i) {
            return i === index ? { path: v.path, open: v.open, enabled: checked } : v;
          });
          setVaults(next);
          applyPatch({
            vaultPaths: next.filter(function (v) { return v.enabled; }).map(function (v) { return v.path; })
          });
        }

        /** The command field saves itself a moment after typing stops. */
        function onCommandChange(value) {
          setCommand(value);
          if (commandSaveTimer !== null) clearTimeout(commandSaveTimer);
          commandSaveTimer = setTimeout(function () {
            commandSaveTimer = null;
            applyPatch({ command: value });
          }, 800);
        }

        /**
         * Launch-test the FIRST ENABLED vault. It used to test the first row of
         * the list regardless of the tick boxes, so it could open a vault the
         * user had deliberately switched off.
         */
        function testOpen() {
          var target = vaults[0].filter(function (v) { return v.enabled; })[0];
          if (!target) {
            setMessage(null);
            setError("没有已启用的知识库：请先勾选至少一个库（勾上立即生效），再点测试。");
            return;
          }
          setBusy(true); setMessage(null); setError(null);
          fetch("/dsh-open-obsidian/test", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: target.path })
          })
            .then(function (r) { return r.json(); })
            .then(function (j) {
              if (j && j.ok) { setMessage("测试成功，已打开：" + j.opened); reloadStatus(); }
              else setError((j && j.error) || "测试失败");
              setBusy(false);
            })
            .catch(function (err) {
              setError("测试失败：" + (err && err.message ? err.message : String(err)));
              setBusy(false);
            });
        }

        if (loading[0]) {
          return React.createElement("div", { className: "obs-panel" }, "加载中…");
        }

        var enabledCount = vaults[0].filter(function (v) { return v.enabled; }).length;
        var hasCustomCommand = command[0].trim().length > 0;

        /** 滑动开关：<button role=switch>，跟 DSH 设置页同一写法。
         *  不用藏起来的 checkbox —— 那个在测试里还得摸 DOM 才点得到。 */
        function Switch(props) {
          return React.createElement("button", {
            type: "button",
            role: "switch",
            "aria-checked": props.checked ? "true" : "false",
            "aria-label": props.label,
            className: "obs-sw" + (props.checked ? " on" : ""),
            disabled: props.disabled || undefined,
            onClick: function () { if (!props.disabled) props.onChange(!props.checked); }
          });
        }

        /** 一行设置：左边"名称 + 说明"，右边控件。 */
        function Row(props) {
          return React.createElement("div", { className: "obs-row" + (props.top ? " top" : ""), key: props.key },
            React.createElement("div", { className: "obs-lab" },
              React.createElement("div", { className: "obs-labname" }, props.label),
              props.hint ? React.createElement("div", { className: "obs-hint" }, props.hint) : null
            ),
            React.createElement("div", { className: "obs-ctl" }, props.children)
          );
        }

        /** 状态胶囊：淡彩底 + 小圆点。 */
        function Pill(props) {
          return React.createElement("span", { className: "obs-pill " + (props.tone || "off") }, props.text);
        }

        /** 分组卡片：跟 DSH 设置页的卡片一个长相。 */
        function Card(props) {
          return React.createElement("div", { className: "obs-card" + (props.plain ? " plain" : ""), key: props.key },
            props.children);
        }

        /** 分组标题（前面带一竖条主题色），右侧可挂一句统计文字。 */
        function Sec(props) {
          return React.createElement("div", { className: "obs-sec" },
            props.text,
            props.meta ? React.createElement("span", { className: "obs-sec-meta" }, props.meta) : null
          );
        }

        /** 统计格：stats = [{ label, value, muted }] */
        function StatGrid(props) {
          var items = Array.isArray(props.stats) ? props.stats : [];
          return React.createElement("div", { className: "obs-stats" },
            items.map(function (it, i) {
              var has = it.value !== undefined && it.value !== null;
              return React.createElement("div", { className: "obs-stat" + (has ? "" : " muted"), key: it.label + i },
                React.createElement("div", { className: "obs-statnum" }, has ? String(it.value) : "—"),
                React.createElement("div", { className: "obs-statlbl" }, it.label)
              );
            })
          );
        }

        /** 文件位置：等宽小字 + 一键复制。 */
        function PathRow(props) {
          return React.createElement("div", { className: "obs-path" },
            React.createElement("span", { className: "obs-pathlbl" }, props.label),
            React.createElement("span", { className: "obs-pathval" }, props.value || "（未知）"),
            props.value
              ? React.createElement("button", {
                  type: "button", className: "obs-copy",
                  onClick: function () { copyText(props.value, props.onDone); }
                }, "复制")
              : null
          );
        }

        var decisionLine = describeDecision(lastDecision[0]) ||
          "还没有记录（插件还没触发过打开或跳过）";

        /* 页头那排胶囊要说的三件事：
           总开关 / 管着几个库 / 目标库现在开着吗。 */
        var runningVaults = vaults[0].filter(function (v) { return v.open; });
        var enabledVaults = vaults[0].filter(function (v) { return v.enabled; });
        var pillEnabled = enabled[0]
          ? { tone: "ok", text: "自动打开：开" }
          : { tone: "off", text: "自动打开：关" };
        var pillVaults = enabledCount === 0
          ? { tone: "warn", text: "一个库都没勾" }
          : { tone: "off", text: "管着 " + enabledCount + " / " + vaults[0].length + " 个库" };
        var pillOpen = runningVaults.length === 0
          ? { tone: "off", text: "Obsidian 里没开着你的库" }
          : { tone: "ok", text: "正开着 " + runningVaults.length + " 个" };

        return React.createElement("div", { className: "obs-panel" },

          /* ⓪ 页头：状态胶囊先说清现状 */
          React.createElement("div", { className: "obs-head" },
            React.createElement(Pill, { tone: pillEnabled.tone, text: pillEnabled.text }),
            React.createElement(Pill, { tone: pillVaults.tone, text: pillVaults.text }),
            React.createElement(Pill, { tone: pillOpen.tone, text: pillOpen.text })
          ),

          /* ① 行为开关 —— 三行 Row 装进一张卡 */
          React.createElement(Card, { key: "c-switches" },
            React.createElement(Sec, { text: "打开行为" }),
            React.createElement(Row, {
              label: "自动打开 Obsidian",
              hint: "在这个库的对话里发第一条消息时，帮你把库打开"
            }, React.createElement(Switch, {
              checked: enabled[0], disabled: busy[0], label: "自动打开 Obsidian",
              onChange: function (v) { setEnabled(v); applyPatch({ enabled: v }); }
            })),
            React.createElement(Row, {
              label: "目标库已打开时跳过",
              hint: "已经开着就不动你的窗口"
            }, React.createElement(Switch, {
              checked: skipOpen[0], disabled: busy[0], label: "目标库已打开时跳过",
              onChange: function (v) { setSkipOpen(v); applyPatch({ skipWhenAlreadyOpen: v }); }
            })),
            React.createElement(Row, {
              label: "静默打开新窗口",
              hint: "新窗口放到你当前窗口后面，不抢焦点"
            }, React.createElement(Switch, {
              checked: silentOpen[0], disabled: busy[0], label: "静默打开新窗口",
              onChange: function (v) { setSilentOpen(v); applyPatch({ silentOpen: v }); }
            }))
          ),

          /* ② 知识库清单 */
          React.createElement(Card, { key: "c-vaults" },
            React.createElement(Sec, {
              text: "检测到的知识库",
              meta: "共 " + vaults[0].length + " 个 · 已启用 " + enabledCount + " 个"
            }),
            React.createElement("div", { className: "obs-hint", style: { marginBottom: "8px" } },
              "勾上的才会触发 —— 取消勾选就是「别碰这个库」。在该库文件夹（或其子目录）开始对话时才会检查。"),
            React.createElement("div", { className: "obs-list" },
              vaults[0].length === 0
                ? React.createElement("div", { className: "obs-empty" },
                    "未检测到 Obsidian 库：请先在 Obsidian 中打开过至少一个库，然后点下面的「刷新列表」。")
                : vaults[0].map(function (v, i) {
                    return React.createElement("label", { key: v.path, className: "obs-sess" },
                      React.createElement("input", {
                        type: "checkbox",
                        checked: v.enabled,
                        onChange: function (e) { toggleVault(i, e.target.checked); }
                      }),
                      React.createElement("span", { className: "obs-sessmain" },
                        React.createElement("span", { className: "obs-sessname" }, v.path.split(/[\\/]/).pop()),
                        React.createElement("span", { className: "obs-sessmeta" }, v.path)
                      ),
                      v.open ? React.createElement("span", { className: "obs-tag on" }, "打开中") : null
                    );
                  })
            ),
            enabledCount === 0 && vaults[0].length > 0
              ? React.createElement("div", { className: "obs-err", style: { marginTop: "8px" } },
                  "现在一个库都没勾选 → 插件不会触发任何库（勾选后立即生效）。")
              : null,
            React.createElement("div", { className: "obs-actions" },
              React.createElement("button", { type: "button", className: "obs-btn", disabled: busy[0], onClick: refresh }, "刷新列表")
            )
          ),

          /* ③ 最近一次动作 —— 只读状态，用代码块底 */
          React.createElement(Card, { key: "c-status" },
            React.createElement(Sec, { text: "最近一次动作" }),
            React.createElement("div", { className: "obs-tail" }, decisionLine),
            React.createElement("div", { className: "obs-actions" },
              React.createElement("button", { type: "button", className: "obs-btn", disabled: busy[0], onClick: revealLog }, "打开日志文件")
            )
          ),

          /* ④ 测试 */
          React.createElement(Card, { key: "c-test" },
            React.createElement(Sec, { text: "测试" }),
            React.createElement("div", { className: "obs-hint", style: { marginBottom: "8px" } },
              "立即用当前设置打开第一个已启用的库。这一下是正常显示窗口的（方便你确认它真的开出来了），不会走静默。"),
            React.createElement("div", { className: "obs-actions" },
              React.createElement("button", { type: "button", className: "obs-btn primary", disabled: busy[0], onClick: testOpen }, "测试打开")
            )
          ),

          message[0] ? React.createElement("div", { className: "obs-ok" }, message[0]) : null,
          error[0] ? React.createElement("div", { className: "obs-err" }, error[0]) : null,

          /* ⑤ 高级选项 —— 整块一个折叠卡；展开的内容留在框内 */
          React.createElement("details", { className: "obs-advanced" },
            React.createElement("summary", null,
              "高级选项",
              hasCustomCommand
                ? React.createElement("span", { className: "obs-adv-flag" }, "已设自定义命令")
                : React.createElement("span", { className: "obs-sec-meta" }, "一般不用动")
            ),
            React.createElement("div", { className: "obs-advanced-body" },
              React.createElement("span", { className: "obs-hint" },
                "自定义启动命令：只决定「用什么方式把 Obsidian 打开」。"),
              React.createElement("span", { className: "obs-hint" },
                "留空就好 —— 默认方式是让系统按它自己登记的入口打开这个库，在你机器上一直可用。只有默认方式打不开、而且你确定该用哪条命令时，才把命令填进去；一旦填了，插件就完全按你写的来，不再走默认方式。"),
              React.createElement("input", {
                className: "obs-input",
                placeholder: "留空 = 用默认方式打开",
                value: command[0],
                onChange: function (e) { onCommandChange(e.target.value); }
              }),
              React.createElement("span", { className: "obs-hint" },
                "若确实要填：里面的 {vault} 会被替换成库的文件夹路径，例如 E:\\obsidian\\Obsidian.exe \"{vault}\"。这里不用点保存，停手一会儿就自动存下了。")
            )
          ),

          /* ⑥ 文件位置：一直摊开（不再叠进折叠里） */
          React.createElement(Card, { key: "c-paths", plain: true },
            React.createElement(Sec, { text: "文件位置" }),
            React.createElement(PathRow, {
              label: "决策日志",
              value: logPath[0],
              onDone: function (ok) { setMessage(ok ? "日志路径已复制" : "复制失败（窗口没有焦点时复制不了）"); }
            })
          ),

          /* ⑦ 工作原理：收进折叠里。
             写成平铺时它一段占掉 220px，手机/小窗口下会让面板被截断，
             下半截（测试、高级选项）根本看不到 —— 折起来省地方。 */
          React.createElement("details", { className: "obs-fold" },
            React.createElement("summary", null, "工作原理（看不看都行）"),
            React.createElement("div", { className: "obs-foldbody" },
              React.createElement("span", { className: "obs-hint" },
                "① 你在库（或库的子目录）的对话里发出第一条人类消息时检查一次：目标库已打开就跳过、不碰你的窗口；没打开就把对应库打开。"),
              React.createElement("span", { className: "obs-hint" },
                "② 只有当 AI 正在该库里干活（近 2 分钟内有工具调用或回复）且库内文件发生改动时，才会在 Obsidian 没运行时把它拉起。"),
              React.createElement("span", { className: "obs-hint" },
                "Obsidian 本来就开着时，新开的窗口会放到你当前窗口的后面、不抢焦点（测试按钮和「原本没开」的情况仍然正常显示）。DSH 自身事件（打开界面、恢复会话、重启）以及其它程序造成的库内改动（同步盘、编辑器、git）都不会打开 Obsidian。"),
              React.createElement("span", { className: "obs-hint" },
                "每次打开 / 跳过 / 静默的结果都会记到决策日志。全程零模型 token、零每条消息开销。")
            )
          )
        );
      }

      /**
       * Declared services. `slots` MUST be declared here: a client plugin reads
       * services through its injected context. Reaching for it with
       * ctx.get("slots") and bailing out silently left the settings page
       * unregistered — the "Obsidian 助手" page simply never appeared.
       */
      exports.inject = ["slots"];

      exports.apply = function (ctx) {
        var slots = ctx.slots || (typeof ctx.get === "function" ? ctx.get("slots") : null);
        if (!slots) {
          console.error(
            "[dsh-open-obsidian] slots service unavailable — settings section not registered"
          );
          return;
        }
        try {
          slots.inject("settings.section", function () {
            return slots.register(
              { name: "settings.section", id: "obsidian-launch", order: 40, label: "Obsidian 助手" },
              function () { return React.createElement(ObsidianSettingsPanel, null); }
            );
          });
        } catch (err) {
          console.error("[dsh-open-obsidian] client apply failed:", err);
        }
      };

      return module.exports;
    } catch (err) {
      console.error("[dsh-open-obsidian] bundle failed:", err);
      return { apply: function () {} };
    }
  }
});
