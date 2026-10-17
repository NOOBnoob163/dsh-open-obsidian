/**
 * 渲染设置面板成一张真实的 HTML（用于截图 / 商店预览图）
 *
 *   node test/render-screenshot.mjs [输出html路径] [主题 dark|light]
 *
 * 为什么单独做一个脚本，而不是改 panel.mjs：
 *   panel.mjs 的假 React 只把 children 挂在 node.children 上、不产生 DOM；
 *   截图需要真实 DOM + 真实 CSS。这里复用同一套「假 window/__ModuleLoader__/
 *   假 fetch」加载真实的 lib/client.js（所以画出来的就是用户界面那份代码，
 *   不是另画一张图），但把假 React 的产物**构建成真实 DOM 节点**，
 *   连插件自己注入的那段 CSS 一起写进 HTML。
 *
 * 用的是**假数据**（演示用的库名），所以截图里不会出现任何真实路径或库名。
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

const CLIENT = fileURLToPath(new URL("../lib/client.js", import.meta.url));
const outFile = process.argv[2] || "panel-preview.html";
const theme = process.argv[3] === "light" ? "light" : "dark";

// ---- 演示数据：一律用假名字，绝不用真实库名/路径 ----
const DEMO_VAULTS = [
  { path: "C:\\Users\\you\\Documents\\Notes", open: true, enabled: true },
  { path: "C:\\Users\\you\\Documents\\Research", open: false, enabled: true },
  { path: "C:\\Users\\you\\Documents\\Archive", open: false, enabled: false },
];
const DEMO_LAST = {
  at: "2026-10-11T12:34:56.000Z",
  kind: "open",
  vault: "C:\\Users\\you\\Documents\\Notes",
  reason: "user-message",
};

// ------------------------------------------------------------- 假浏览器
const insertedCss = [];
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: "", appendChild() {} }),
  head: { appendChild: (el) => insertedCss.push(String(el.textContent)) },
};
let loaded = null;
globalThis.window = { __ModuleLoader__: { load(spec) { loaded = spec; } } };

// 让面板拿到演示数据
globalThis.fetch = (url) =>
  Promise.resolve({
    json: () =>
      Promise.resolve({
        ok: true,
        enabled: true,
        vaultPaths: DEMO_VAULTS.filter((v) => v.enabled).map((v) => v.path),
        skipWhenAlreadyOpen: true,
        silentOpen: true,
        command: "",
        logPath: "C:\\Users\\you\\.dsh\\logs\\dsh-open-obsidian\\decisions.log",
        lastDecision: DEMO_LAST,
        vaults: DEMO_VAULTS,
      }),
  });

// --------------------------------------------------------------- 假 React
// 这个 shim 建的是**真实 DOM 节点**（不需要 react-dom）。
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    attributes: {},
    children: [],
    style: {},
    className: "",
    textContent: "",
    dataset: {},
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attributes[k] = v; },
    addEventListener() {},
    get classList() {
      return {
        _set: new Set(String(el.className).split(/\s+/).filter(Boolean)),
        add: (...a) => a.forEach((x) => el.classList._set.add(x)),
        remove: (...a) => a.forEach((x) => el.classList._set.delete(x)),
        contains: (x) => el.classList._set.has(x),
        toString: () => [...el.classList._set].join(" "),
      };
    },
  };
  return el;
}

// ⚠️ 这个数组必须与 lib/client.js 里 React.useState 的调用顺序一一对应。
//    0.11.0 在中间插入了 writeLock，后面每一项的位置都往后挪了一位 ——
//    不跟着改，日志路径会画成「（未知）」，而截图看上去只是"数据没给到"。
const HOOK_VALUES = [
  false,        // 0  loading   —— 渲染完成态，不是"加载中…"
  true,         // 1  enabled   —— 自动打开 = 开
  DEMO_VAULTS,  // 2  vaults
  "",           // 3  command
  true,         // 4  skipOpen
  true,         // 5  silentOpen
  true,         // 6  writeLock  —— 写锁 = 开
  false,        // 7  busy
  null,         // 8  message
  null,         // 9  error
  DEMO_LAST,    // 10 lastDecision
  "C:\\Users\\you\\.dsh\\logs\\dsh-open-obsidian\\decisions.log", // 11 logPath
];
let hookIndex = 0;
/** 每个组件实例都要从 0 开始数 hook —— 忘了重置就会串位（实测：开关全画成"关"）。 */
function resetHooks() { hookIndex = 0; }

function renderChild(child) {
  if (child === null || child === undefined || child === false || child === true) return null;
  if (typeof child === "string" || typeof child === "number") {
    const t = makeEl("#text");
    t.nodeType = 3;
    t.textContent = String(child);
    return t;
  }
  if (Array.isArray(child)) {
    const frag = makeEl("fragment");
    for (const c of child) { const r = renderChild(c); if (r) frag.appendChild(r); }
    return frag;
  }
  if (typeof child.type === "function") {
    // 展开函数组件（跟真 React 一样）。这是**嵌套组件**（Card/Row/Switch/Sec…），
    // 它们的 hook 要从 0 重新数，否则会把面板自己的 hook 值错当成它们的。
    const savedIndex = hookIndex;
    hookIndex = 0;
    const out = renderChild(child.type(child.props ?? {}));
    hookIndex = savedIndex;
    return out;
  }
  // 宿主元素
  const el = makeEl(child.type);
  const props = child.props ?? {};
  for (const [k, v] of Object.entries(props)) {
    if (k === "children" || k === "key" || k === "ref") continue;
    if (k === "className") { el.className = String(v); continue; }
    if (k === "style" && v && typeof v === "object") { Object.assign(el.style, v); continue; }
    if (k.startsWith("on") && typeof v === "function") continue; // 事件不参与静态渲染
    if (v === undefined || v === null || v === false) continue;   // 别写出 disabled="undefined"
    el.setAttribute(k, String(v));
  }
  const kids = props.children;
  if (kids !== undefined) {
    for (const c of (Array.isArray(kids) ? kids : [kids])) {
      const r = renderChild(c);
      if (r) el.appendChild(r);
    }
  }
  return el;
}

const React = {
  createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) };
    const flat = children.flat(Infinity).filter((c) => c !== undefined);
    if (flat.length === 1) merged.children = flat[0];
    else if (flat.length > 1) merged.children = flat;
    return { type, props: merged };
  },
  useState(initial) {
    const i = hookIndex++;
    const v = i < HOOK_VALUES.length ? HOOK_VALUES[i] : initial;
    return [v, () => {}];
  },
  useEffect() {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
};
globalThis.React = React;

// 加载真实的插件客户端代码
await import(pathToFileURL(CLIENT).href);
if (!loaded) { console.error("client.js 没有调用 __ModuleLoader__.load"); process.exit(1); }

// 规格是 { id, factory(require) }：跑 factory，并截获它注册到 slots 的组件。
const requireStub = (name) => {
  if (name === "react") return React;
  return {};
};
const mod = loaded.factory(requireStub);
if (!mod || typeof mod.apply !== "function") {
  console.error("factory 返回值不对：", Object.keys(mod ?? {}).join(", "));
  process.exit(2);
}

// 假 slots：把注册进来的面板函数记下来
let Panel = null;
const fakeSlots = {
  inject(_name, fn) { fn(); },
  register(_desc, component) { if (component) Panel = component; return { ok: true }; },
};
const fakeCtx = {
  slots: fakeSlots,
  get: (n) => (n === "slots" ? fakeSlots : null),
  logger: { info() {}, warn() {}, error() {} },
  effect() {},
  on() {},
};
try {
  mod.apply(fakeCtx);
} catch (e) {
  console.error("apply 抛错:", e.message);
  process.exit(3);
}
if (typeof Panel !== "function") {
  console.error("没能截获面板组件（slots.register 没被调用？）");
  process.exit(4);
}

hookIndex = 0;
let tree;
try {
  tree = renderChild({ type: Panel, props: {} });
} catch (e) {
  console.error("渲染失败:", e.message);
  process.exit(3);
}

// ------------------------------------------------------- DOM 树 → HTML 文本
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function styleStr(obj) {
  return Object.entries(obj).map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}:${v}`).join(";");
}
function toHtml(node) {
  if (!node) return "";
  if (node.nodeType === 3) return esc(node.textContent);
  if (node.tagName === "FRAGMENT") return node.children.map(toHtml).join("");
  const attrs = [];
  if (node.className) attrs.push(`class="${esc(node.className)}"`);
  for (const [k, v] of Object.entries(node.attributes)) {
    if (k === "className" || k === "style") continue;
    attrs.push(`${esc(k)}="${esc(v)}"`);
  }
  const s = styleStr(node.style);
  if (s) attrs.push(`style="${esc(s)}"`);
  const tag = node.tagName.toLowerCase();
  const inner = node.children.length ? node.children.map(toHtml).join("") : esc(node.textContent);
  return `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>${inner}</${tag}>`;
}

const panelHtml = toHtml(tree)
  // 伪元素 → 真元素（只为截图能看见；见上面 CSS 注释）
  .replace(/(<button[^>]*class="obs-sw[^"]*"[^>]*>)/g, "$1<span class=\"shotthumb\"></span>")
  .replace(/(<span[^>]*class="obs-pill[^"]*"[^>]*>)/g, "$1<span class=\"shotdot\"></span>");
const css = insertedCss.join("\n");

// DSH 的变量在独立预览里不存在，给一套演示用的兜底值
// （这**不是**在伪造设计——插件本身写的就是 var(--dsw-*, 兜底)，
//   这里补的是宿主本该提供的那些变量）
const hostVars = theme === "light"
  ? `--dsw-alias-bg-base:#ffffff;--dsw-alias-bg-elevated:#f7f7f8;--dsw-alias-bg-sunken:#f0f0f2;
     --dsw-alias-text-primary:#1a1a1c;--dsw-alias-text-secondary:#5c5c66;--dsw-alias-text-tertiary:#8a8a94;
     --dsw-alias-border-subtle:rgba(0,0,0,.10);--dsw-alias-border-strong:rgba(0,0,0,.18);
     --dsw-alias-brand-primary:#4a6cf7;--dsw-alias-bg-hover:rgba(0,0,0,.04);
     --dsw-alias-fill-secondary:rgba(0,0,0,.06);--dsw-alias-text-on-brand:#ffffff;`
  : `--dsw-alias-bg-base:#151517;--dsw-alias-bg-elevated:#1c1c1f;--dsw-alias-bg-sunken:#121214;
     --dsw-alias-text-primary:#f2f2f4;--dsw-alias-text-secondary:#a8a8b2;--dsw-alias-text-tertiary:#74747e;
     --dsw-alias-border-subtle:rgba(255,255,255,.10);--dsw-alias-border-strong:rgba(255,255,255,.20);
     --dsw-alias-brand-primary:#f9fafb;--dsw-alias-bg-hover:rgba(255,255,255,.06);
     --dsw-alias-fill-secondary:rgba(255,255,255,.08);--dsw-alias-text-on-brand:#16161a;`;

const page = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>dsh-open-obsidian · 设置面板预览</title>
<style>
  html,body{margin:0;padding:0;background:var(--dsw-alias-bg-base);}
  body{font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
       padding:18px 20px 22px;color:var(--dsw-alias-text-primary);}
  :root{${hostVars}}
  /* 面板本身会带 .obs-panel 的外边距，截图时收掉，避免大片空白 */
  .obs-panel{margin:0 !important;padding:0 !important;max-width:560px;}

  /* ── 仅截图预览用：把伪元素画的控件"补"成真元素 ──────────────
     插件的开关/圆点是用 ::before / ::after 画的，静态 HTML 里没有 DOM
     节点，所以直接截图会看不到滑块位置（开关看着全像"关"）。
     这里只补**截图用**的等价画法，插件源码一个字没改。
     ⚠️ 改插件 CSS 时这两块要跟着对一遍，否则预览会跟真实界面对不上。 */
  .obs-sw::after{ display:none !important; }
  .obs-sw{ position:relative; }
  .obs-sw > .shotthumb{
    position:absolute; top:2px; left:2px; width:15px; height:15px; border-radius:50%;
    background:var(--dsw-alias-switch-thumb,#fff); box-shadow:0 1px 2px rgba(0,0,0,.25);
    transition:none;
  }
  .obs-sw.on > .shotthumb{ left:19px; }
  .obs-pill::before{ display:none !important; }
  .obs-pill > .shotdot{
    width:6px; height:6px; border-radius:50%; background:currentColor; flex:none;
    display:inline-block; margin-right:6px;
  }
</style>
<style>${css}</style>
</head>
<body>
${panelHtml}
</body></html>`;

writeFileSync(outFile, page, "utf8");
console.log("已写出:", outFile, `(${page.length} 字符, 主题=${theme})`);
console.log("面板节点数:", (panelHtml.match(/</g) || []).length);
console.log("注入的 CSS 段数:", insertedCss.length);

// 自检：HOOK_VALUES 与 client.js 的 useState 顺序错位时，页面会照样"渲染成功"，
// 只是某些字段悄悄变成默认值（日志路径变成「（未知）」）——图就废了。
// 这里直接盯着几个"数据必须显示出来"的地方，缺一个就响亮失败。
const mustShow = [
  ["日志路径", "decisions.log"],
  ["写锁开关", "写锁：一次只让一个对话写"],
  ["库列表", "C:\\Users\\you\\Documents\\Notes"],
  ["最近一次动作", "发了第一条消息"],
];
const missing = mustShow.filter(([, needle]) => !page.includes(needle)).map(([what]) => what);
if (missing.length > 0) {
  console.error("✗ 截图内容不完整，缺:", missing.join("、"));
  console.error("  多半是 HOOK_VALUES 的顺序跟 lib/client.js 的 useState 对不上了。");
  process.exitCode = 1;
} else {
  console.log("✓ 自检通过：日志路径、写锁、库列表、最近动作都在图上");
}
