/**
 * dsh-open-obsidian — settings panel smoke test.
 *
 *   node test/panel.mjs
 *
 * Renders lib/client.js in Node with a fake window/__ModuleLoader__, a fake
 * document, a fake fetch and a minimal React shim, then checks both the panel's
 * shape and the two behaviours that were reported as broken:
 *
 *   1. every control saves itself (the switches used to be unsaved drafts, so a
 *      refresh or a page switch reloaded the server value and the switch looked
 *      like it had turned itself back on);
 *   2. "测试打开" targets the FIRST ENABLED vault, not the first row of the list.
 *
 * It also pins the layout the user asked for: iOS-style switch rows at the top
 * (now three of them — 自动打开 / 已打开就跳过 / 静默打开), the decision line, and
 * the 工作原理 text as plain small print (not collapsed).
 *
 * A crash or a wrong handler here would otherwise only show up after a DSH
 * restart, inside the real settings page.
 */
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT = fileURLToPath(new URL("../lib/client.js", import.meta.url));
const VAULT_OFF = "C:\\Users\\x\\Documents\\vault-off";
const VAULT_ON = "C:\\Users\\x\\Documents\\vault-on";

// ------------------------------------------------------------- fake browser

const insertedCss = [];
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: "", appendChild() {} }),
  head: { appendChild: (element) => insertedCss.push(String(element.textContent)) },
};
let loaded = null;
globalThis.window = {
  __ModuleLoader__: { load(spec) { loaded = spec; } },
};

const fetchCalls = [];
globalThis.fetch = (url, options) => {
  fetchCalls.push({
    url: String(url),
    method: (options && options.method) || "GET",
    body: options && options.body ? String(options.body) : null,
  });
  return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
};
const callsTo = (url, method) =>
  fetchCalls.filter((call) => call.url === url && call.method === method);
const resetCalls = () => { fetchCalls.length = 0; };

// --------------------------------------------------------------- fake React
// Hook order in the panel component:
// 0 loading, 1 enabled, 2 vaults, 3 command, 4 skipOpen, 5 silentOpen,
// 6 writeLock, 7 busy, 8 message, 9 error, 10 lastDecision, 11 logPath.
//
// ⚠️ These indices mirror the React.useState call order in lib/client.js. When a
// switch is inserted in the middle (writeLock was, in 0.11.0), every index after
// it shifts — reading a stale index silently yields the wrong value, which looks
// like a broken panel rather than a stale test. Re-check this list whenever a
// state hook is added or removed.
const HOOK_VALUES = {
  0: false,
  1: true,
  2: [
    { path: VAULT_OFF, open: false, enabled: false },
    { path: VAULT_ON, open: true, enabled: true },
  ],
  3: "",
  4: true,
  5: true,
  6: true,
  7: false,
  8: null,
  9: null,
  10: {
    at: "2026-10-04T15:00:00.000Z",
    kind: "open",
    vault: VAULT_ON,
    reason: "user-message",
  },
  11: "C:\\Users\\x\\.dsh\\logs\\dsh-open-obsidian\\decisions.log",
};

/** Index of the `lastDecision` hook, named so it cannot drift silently. */
const HOOK_LAST_DECISION = 10;
/** Index of the `busy` hook, whose setter carries error/message state in tests. */
const HOOK_ERROR = 9;
let hookIndex = 0;
const setterCalls = [];
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity) };
  },
  useState(initial) {
    const index = hookIndex++;
    const value = Object.prototype.hasOwnProperty.call(HOOK_VALUES, index)
      ? HOOK_VALUES[index]
      : initial;
    return [value, (next) => setterCalls.push({ index, value: next })];
  },
  useEffect() {},
};
const errorMessages = () =>
  setterCalls.filter((call) => call.index === HOOK_ERROR).map((call) => String(call.value));

// ------------------------------------------------------------ load the panel

await import(pathToFileURL(CLIENT).href);
if (loaded === null) {
  console.error("FAIL  client bundle never called window.__ModuleLoader__.load");
  process.exit(1);
}
const bundle = loaded.factory((id) => {
  if (id === "react") return React;
  throw new Error(`unexpected require("${id}")`);
});
let Panel = null;
bundle.apply({
  slots: {
    inject(_key, callback) { callback(); },
    register(_spec, factory) { Panel = factory; return () => {}; },
  },
});

// ------------------------------------------------------------------ helpers

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

function flatten(node, out = []) {
  if (node === null || node === undefined || typeof node !== "object") return out;
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  return out;
}
/**
 * Match by class NAME, not by the whole className string. Components add
 * modifier classes ("obs-pill ok", "obs-sw on", "obs-card plain"), so an exact
 * `=== name` comparison misses exactly the elements that carry state — which is
 * the interesting half.
 */
const hasClass = (node, name) => {
  const cls = node && node.props && node.props.className;
  return typeof cls === "string" && cls.split(/\s+/).includes(name);
};
const byClass = (nodes, name) => nodes.filter((node) => hasClass(node, name));
const textsOf = (nodes) =>
  nodes.flatMap((node) => (node.children ?? []).filter((child) => typeof child === "string"));
const buttonNamed = (nodes, prefix) =>
  nodes.find(
    (node) =>
      node.type === "button" &&
      (node.children ?? []).some((child) => typeof child === "string" && child.startsWith(prefix))
  );

/**
 * Render the panel the way React would.
 *
 * Two things this shim must get right, both learned the hard way on 2026-10-09
 * when the panel was rebuilt out of small components (Card / Row / Pill /
 * Switch / Sec …):
 *
 *  1. NESTED function elements must be expanded, not just the top one. React
 *     renders <Card>…</Card> on its own; a shim that stops at the top element
 *     sees {type: Function} nodes and every byClass() lookup silently returns
 *     empty — the CSS and DOM were fine, the test just could not see inside.
 *
 *  2. Children live in `node.children` in THIS shim (createElement puts them
 *     there), whereas a real component reads `props.children`. So when invoking
 *     a function component the two must be joined, or the component renders
 *     with no children at all and everything below it disappears.
 */
function expand(node, depth = 0) {
  if (depth > 40 || node === null || typeof node !== "object") return node;

  const ownChildren = (node.children ?? []).map((child) => expand(child, depth + 1));

  if (typeof node.type === "function") {
    const props = { ...(node.props ?? {}) };
    if (ownChildren.length > 0) props.children = ownChildren;
    return expand(node.type(props), depth + 1);
  }

  if (ownChildren.length === 0) return node;
  return { ...node, children: ownChildren };
}

function renderPanel() {
  hookIndex = 0;
  let tree = Panel();
  if (tree !== null && typeof tree === "object" && typeof tree.type === "function") {
    hookIndex = 0;
    tree = tree.type(tree.props);
  }
  return expand(tree);
}

/**
 * Pull the "recent decision" sentence the panel would display for a given
 * decision record — by rendering with that record injected as the lastDecision
 * hook value. describeDecision lives inside the component's closure, so this is
 * the only honest way to test it.
 */
function describeViaPanel(decision) {
  const saved = HOOK_VALUES[HOOK_LAST_DECISION];
  HOOK_VALUES[HOOK_LAST_DECISION] = decision;
  try {
    const tree = renderPanel();
    const texts = textsOf(flatten(tree));
    // The rendered sentence contains the vault path too; the vault path also
    // appears on its own in the vault list, so pick the text that has the "·"
    // separator describeDecision builds.
    const line = texts.find((t) => t.includes("·") && t.includes(decision.vault));
    return line ?? "";
  } finally {
    HOOK_VALUES[HOOK_LAST_DECISION] = saved;
  }
}

// ------------------------------------------------------------------ scenarios

let nodes = [];
let renderError = null;
try {
  nodes = flatten(renderPanel());
} catch (error) {
  renderError = error;
}
check("面板渲染不报错", renderError === null, renderError ? String(renderError.message) : "");

if (nodes.length > 0) {
  const switches = byClass(nodes, "obs-sw");
  const rows = byClass(nodes, "obs-row");
  const pills = byClass(nodes, "obs-pill");
  const cards = byClass(nodes, "obs-card");
  const paths = byClass(nodes, "obs-path");
  const labels = [...flatten(nodes[0])]
    .filter((n) => n.props && n.props.role === "switch")
    .map((n) => n.props["aria-label"]);
  const texts = textsOf(nodes);
  const detailsNodes = nodes.filter((node) => node.type === "details");
  const insideDetails = new Set();
  for (const details of detailsNodes) {
    for (const inner of flatten(details)) insideDetails.add(inner);
  }

  // The panel ships four switches (auto-open, skip-if-open, silent-open, write
  // lock). Assert the exact set by name rather than a count: a count goes stale
  // every time a switch is added, and it never says which one went missing.
  const EXPECTED_SWITCHES = [
    "自动打开 Obsidian",
    "目标库已打开时跳过",
    "静默打开新窗口",
    "写锁：一次只让一个对话写",
  ];
  check("四个设置都是开关行", rows.length >= 4 && switches.length === EXPECTED_SWITCHES.length,
    `rows=${rows.length} switches=${switches.length}`);
  check(
    "开关后面跟着名字",
    labels.length === EXPECTED_SWITCHES.length &&
      EXPECTED_SWITCHES.every((name, i) => labels[i] && labels[i].startsWith(name)),
    JSON.stringify(labels)
  );
  check(
    "开关是 role=switch 的按钮（可点击/可无障碍）",
    switches.length === EXPECTED_SWITCHES.length &&
      switches.every((b) => b.type === "button" && b.props.role === "switch" &&
        typeof b.props["aria-checked"] === "string")
  );
  check(
    "页头有一排状态胶囊（先讲现状）",
    pills.length >= 3 &&
      pills.every((p) => typeof p.props.className === "string") &&
      texts.some((t) => t.startsWith("自动打开：")),
    `pills=${pills.length}`
  );
  check(
    "分组用卡片，且不止一张",
    cards.length >= 3,
    `cards=${cards.length}`
  );
  check(
    "旧的括号说明已清掉",
    !texts.some((text) => text.includes("（已启用）") || text.includes("（开："))
  );

  const firstSwitchIndex = nodes.indexOf(switches[0]);
  const firstVaultIndex = nodes.findIndex(
    (node) => node.props && node.props.className === "obs-sess"
  );
  check(
    "开关排在库列表前面",
    firstSwitchIndex !== -1 && firstVaultIndex !== -1 && firstSwitchIndex < firstVaultIndex,
    `switch@${firstSwitchIndex} vault@${firstVaultIndex}`
  );

  check(
    "最近一次动作可读化显示",
    texts.some((text) => text.includes("打开（你在这个库的对话里发了第一条消息）"))
  );
  check(
    "日志按钮在位，且日志路径出现在「文件位置」里",
    texts.includes("打开日志文件") &&
      texts.some((t) => t.endsWith("decisions.log"))
  );
  // A silent-open decision logs kind="silent-open" with reason="ok"/"failed", so
  // the panel must key on the PAIR — keying on reason alone rendered the raw
  // "动作：ok" instead of a sentence.
  const silentOk = describeViaPanel({ at: "2026-10-08T01:46:09.000Z", kind: "silent-open", vault: VAULT_ON, reason: "ok" });
  const silentBad = describeViaPanel({ at: "2026-10-08T01:46:09.000Z", kind: "silent-open", vault: VAULT_ON, reason: "failed" });
  check(
    "静默打开的记录被翻成人话（不是「动作：ok」）",
    silentOk.includes("静默打开") && !silentOk.includes("动作：") &&
      silentBad.includes("没能静默") && !silentBad.includes("动作："),
    `ok=「${silentOk}」 failed=「${silentBad}」`
  );

  // 工作原理：0.9.x 是平铺的，一段占 220px，小窗口下会把面板顶出可视区
  // （实测：面板 1059px / 可视 808px，底部的「测试」「高级选项」看不到）。
  // 2026-10-09 收进折叠里 —— 这条断言跟着改成"必须折叠"，盯的就是这个回归。
  const principleFold = detailsNodes.find((d) => hasClass(d, "obs-fold"));
  const principleTexts = textsOf(flatten(principleFold));
  check(
    "「工作原理」收进折叠里（不再平铺占掉半屏）",
    principleFold !== undefined &&
      principleTexts.some((text) => text.includes("工作原理")) &&
      principleTexts.some((text) => text.startsWith("① ")) &&
      principleTexts.some((text) => text.startsWith("② ")),
    principleFold === undefined ? "找不到工作原理" : `cls=${principleFold.props.className}`
  );
  // 两个折叠块：高级选项 + 工作原理。多一个是回归（说明又有大段文字摊平了）。
  check(
    "折叠块只有两个：高级选项 + 工作原理",
    detailsNodes.length === 2 &&
      detailsNodes.filter((d) => hasClass(d, "obs-advanced")).length === 1 &&
      detailsNodes.filter((d) => hasClass(d, "obs-fold")).length === 1,
    `details=${detailsNodes.length}（${detailsNodes.map((d) => d.props.className).join(",")}）`
  );

  // ---- 「高级选项」展开后不再跟「测试打开」糊成一片。
  // 测试按钮待在自己的卡片里，高级选项是面板直接的一级子块 —— 结构上互不
  // 包含，视觉上框线天然分界。0.9.0 起用统一的分组卡片（Card/Sec/Row），
  // 这条断言盯的仍是"两块不共处一张卡"。
  const advanced = detailsNodes.find((d) => hasClass(d, "obs-advanced"));
  const advancedInner = advanced ? new Set(flatten(advanced)) : new Set();
  const testBtnInCard = buttonNamed(nodes, "测试打开");
  check(
    "「高级选项」自己是带框的一整块，内容锁在框内",
    advanced !== undefined &&
      advanced.props.className === "obs-advanced" &&
      (advanced.children ?? []).some(
        (child) => child && child.props && child.props.className === "obs-advanced-body"
      ) &&
      advancedInner.size > 0,
    advanced ? `cls=${advanced.props.className}` : "找不到折叠块"
  );
  check(
    "「测试打开」不在高级选项里面（两块彻底分开）",
    testBtnInCard !== undefined && !advancedInner.has(testBtnInCard)
  );
  const advancedIndex = nodes.indexOf(advanced);
  const testIndex = testBtnInCard ? nodes.indexOf(testBtnInCard) : -1;
  check(
    "测试块排在高级选项上面，各自成块",
    testIndex !== -1 && advancedIndex !== -1 && testIndex < advancedIndex,
    `test@${testIndex} advanced@${advancedIndex}`
  );
  // 测试按钮必须待在一张 card 里，而高级选项是面板的一级子块。
  check(
    "「测试」自成一张卡、「高级选项」是面板一级子块（不共处同一张卡）",
    testBtnInCard !== undefined &&
      cards.some((c) => flatten(c).includes(testBtnInCard)) &&
      advanced !== undefined &&
      (nodes[0].children ?? []).includes(advanced),
    `inCard=${cards.some((c) => flatten(c).includes(testBtnInCard))} advancedTopLevel=${advanced ? (nodes[0].children ?? []).includes(advanced) : false}`
  );
  check(
    "每个行为开关都有说明小字（左说明右控件的行）",
    rows.every((row) =>
      (row.children ?? []).some(
        (child) => child && child.props && child.props.className === "obs-lab"
      ) &&
      (row.children ?? []).some(
        (child) => child && child.props && child.props.className === "obs-ctl"
      )
    )
  );
  check(
    "分组卡样式已注入（settings-card 底 + 圆角 + 投影）",
    insertedCss.join("\n").includes(".obs-card {") &&
      insertedCss.join("\n").includes("settings-card-fill")
  );
  check(
    "高级选项折叠卡样式已注入（展开后内容带内边距）",
    insertedCss.join("\n").includes(".obs-advanced {") &&
      insertedCss.join("\n").includes(".obs-advanced[open] > summary {") &&
      insertedCss.join("\n").includes(".obs-advanced-body {")
  );
  check(
    "开关样式已注入（轨道/滑块/选中态）",
    insertedCss.join("\n").includes(".obs-sw {") &&
      insertedCss.join("\n").includes(".obs-sw.on")
  );
  check(
    "状态胶囊 / 统计格 / 路径行 / 代码块底 的样式都在",
    insertedCss.join("\n").includes(".obs-pill.ok") &&
      insertedCss.join("\n").includes(".obs-stats") &&
      insertedCss.join("\n").includes(".obs-pathval") &&
      insertedCss.join("\n").includes(".obs-tail")
  );

  // ---- 控件自己保存，不再依赖「保存设置」按钮
  check(
    "「保存设置」按钮已移除（改成自动保存）",
    buttonNamed(nodes, "保存设置") === undefined
  );

  resetCalls();
  // 开关现在是 role=switch 的按钮：点它就是"切一下"，不再读 e.target.checked
  switches[0].props.onClick();
  await tick();
  const settingsPosts = callsTo("/dsh-open-obsidian/settings", "POST");
  check(
    "关掉开关会立刻存下去",
    settingsPosts.length === 1 && settingsPosts[0].body.includes('"enabled":false'),
    `posts=${settingsPosts.length}`
  );

  resetCalls();
  const vaultRow = byClass(nodes, "obs-sess")[0];
  const vaultInput = (vaultRow.children ?? []).find((child) => child.type === "input");
  vaultInput.props.onChange({ target: { checked: true } });
  await tick();
  const vaultPosts = callsTo("/dsh-open-obsidian/settings", "POST");
  check(
    "勾选知识库也会立刻存下去",
    vaultPosts.length === 1 && vaultPosts[0].body.includes("vault-off"),
    `posts=${vaultPosts.length}`
  );

  // ---- 修复②：测试打开用「首个已启用的库」
  resetCalls();
  const testButton = buttonNamed(nodes, "测试打开");
  check("测试按钮存在", testButton !== undefined, testButton ? "" : "找不到按钮");
  if (testButton !== undefined) {
    testButton.props.onClick();
    await tick();
    const testPosts = callsTo("/dsh-open-obsidian/test", "POST");
    const target = testPosts.length === 1 ? JSON.parse(testPosts[0].body).path : null;
    check(
      "测试打开的是「首个已启用的库」（不是列表第一行）",
      testPosts.length === 1 && target === VAULT_ON,
      `target=${target}（列表第一行是 ${VAULT_OFF}）`
    );
  }

  // ---- 没有任何库启用时：不发测试请求，并说明原因
  setterCalls.length = 0;
  HOOK_VALUES[2] = [{ path: VAULT_OFF, open: false, enabled: false }];
  const emptyNodes = flatten(renderPanel());
  resetCalls();
  const emptyTestButton = buttonNamed(emptyNodes, "测试打开");
  if (emptyTestButton !== undefined) emptyTestButton.props.onClick();
  await tick();
  check(
    "没有库启用时不发测试请求并给出原因",
    callsTo("/dsh-open-obsidian/test", "POST").length === 0 &&
      errorMessages().some((message) => message.includes("没有已启用的知识库")),
    errorMessages().join(" / ")
  );
}

const failed = results.filter((result) => !result.ok);
console.log(`\nSUMMARY ${JSON.stringify({ total: results.length, failed: failed.length })}`);
if (failed.length > 0) console.log("failed: " + failed.map((result) => result.name).join(" | "));
process.exit(failed.length === 0 ? 0 : 1);
