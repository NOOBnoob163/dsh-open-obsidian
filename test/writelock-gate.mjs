/**
 * dsh-open-obsidian — write-lock gate regression suite.
 *
 *   node test\writelock-gate.mjs
 *
 * Runs against the REAL module (lib/index.js) with the outside world faked:
 * a temp DSH_HOME, a temp %APPDATA%, one temp vault, and captured handlers.
 *
 * What it proves, in order of importance:
 *   1. a non-holder's write into a locked vault is DENIED (the tool never runs);
 *   2. the denial is an ordinary `{kind:'deny', reason}` — nothing special, so
 *      the harness renders it through its normal tool-error path;
 *   3. the gate FAILS OPEN: reads, other vaults, the holder itself, unlocked
 *      vaults, subagents, disabled setting, stale locks and unknown tools all
 *      pass through untouched;
 *   4. the go-ahead notice cannot be misread as an approval.
 *
 * Windows only. Exit code 0 = all scenarios passed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.platform !== "win32") {
  console.error("dsh-open-obsidian is Windows-only; this suite needs Windows.");
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_MAIN = join(dirname(HERE), "lib", "index.js");

const root = mkdtempSync(join(tmpdir(), "dsh-obsidian-gate-"));
const dshHome = join(root, "dshhome");
const appData = join(root, "appdata");
const vaultOne = join(root, "vault-one");
const vaultTwo = join(root, "vault-two");
process.env.DSH_HOME = dshHome;
process.env.APPDATA = appData;

for (const d of [
  dshHome,
  join(dshHome, "storages"),
  join(appData, "obsidian"),
  vaultOne,
  join(vaultOne, ".obsidian"),
  vaultTwo,
  join(vaultTwo, ".obsidian"),
]) {
  mkdirSync(d, { recursive: true });
}
writeFileSync(
  join(appData, "obsidian", "obsidian.json"),
  JSON.stringify({
    vaults: {
      aaaa1111: { path: vaultOne, ts: Date.now(), open: false },
      bbbb2222: { path: vaultTwo, ts: Date.now(), open: false },
    },
  }),
  "utf8"
);
function saveSettings(extra = {}) {
  writeFileSync(
    join(dshHome, "storages", "dsh-open-obsidian.json"),
    JSON.stringify({
      version: 3,
      enabled: true,
      vaultPaths: [vaultOne, vaultTwo],
      skipWhenAlreadyOpen: true,
      silentOpen: false,
      command: "",
      writeLock: true,
      ...extra,
    }),
    "utf8"
  );
}
saveSettings();

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
}

// ── fake ctx ─────────────────────────────────────────────────────────────
const handlers = new Map();
const injectors = new Map();
const disposeFns = [];
const fakeCtx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(fn) {
    const d = fn();
    if (typeof d === "function") disposeFns.push(d);
  },
  on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push(fn);
  },
  inject(names, fn) {
    for (const n of names) injectors.set(n, fn);
  },
  webServer: { register: () => () => {} },
};

const plugin = await import(pathToFileURL(PLUGIN_MAIN).href);
plugin.apply(fakeCtx, plugin.Config({}));
injectors.get("sessionController")?.({
  sessionController: {
    async resolveAgent(id) {
      return { session: { id }, followup() {} };
    },
  },
});
injectors.get("sessions")?.({ sessions: { async flush() { return true; } } });

// ── helpers ──────────────────────────────────────────────────────────────
const fire = (type, session, data = {}) => {
  for (const fn of handlers.get("session/event") ?? []) fn(session, { type, data });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let turn = 0;

function mkSession(id, cwd, { child = false } = {}) {
  return {
    id,
    header: {
      cwd,
      origin: child ? "subagent" : "user",
      delegationDepth: child ? 1 : 0,
    },
  };
}

/** Run the gate for one synthetic tool call; returns the decision object. */
async function runGate(session, name, args) {
  let nextCalls = 0;
  const exec = { name, arguments: args, agent: { session }, callId: `call-${name}` };
  const fns = handlers.get("tools/pre-execute") ?? [];
  let decision;
  for (const fn of fns) {
    decision = await fn(exec, async () => {
      nextCalls += 1;
      return { kind: "allow" };
    });
  }
  return { decision, nextCalls };
}
const denied = (r) => r.decision?.kind === "deny";
const passedThrough = (r) => r.nextCalls > 0 && !denied(r);

const A = mkSession("session-AAAA-1111", vaultOne); // holder
const B = mkSession("session-BBBB-2222", vaultOne); // latecomer
const OTHER = mkSession("session-CCCC-3333", vaultTwo); // different vault

console.log("plugin:", PLUGIN_MAIN);
console.log("temp:  ", root);
console.log("");

// A takes the lock by opening a turn.
turn += 1;
fire("turn/start", A, { turn });
await sleep(50);

// ── 1. the core: a non-holder's write is refused ─────────────────────────
{
  const r = await runGate(B, "write", {
    file_path: join(vaultOne, "10-知识", "某笔记.md"),
    content: "x",
  });
  check("非持有者写本库 → 被拒绝", denied(r), `kind=${r.decision?.kind ?? "(none)"}`);
  check(
    "  拒绝走的是普通 deny（不是特殊错误类型）",
    r.decision?.kind === "deny" &&
      typeof r.decision?.reason === "string" &&
      r.decision.reason.length > 0 &&
      r.decision.info === undefined,
    r.decision?.info === undefined ? "无 info 字段（与普通工具错误一致）" : "⚠️ 带了 info"
  );
  check(
    "  拒绝文案说明了「没有写入任何内容」",
    typeof r.decision?.reason === "string" &&
      r.decision.reason.includes("没有写入任何内容"),
    ""
  );
  check(
    "  拒绝文案给了下一步（结束这一轮 / 等放行）",
    typeof r.decision?.reason === "string" &&
      r.decision.reason.includes("结束这一轮") &&
      r.decision.reason.includes("轮到你了"),
    ""
  );
  check(
    "  ★ 报出了「是谁在写」，而不是空白的 session-",
    typeof r.decision?.reason === "string" &&
      !r.decision.reason.includes("（session-）") &&
      !/正在写这个库（\s*）/.test(r.decision.reason),
    (() => {
      const m = /正在写这个库（([^）]*)）/.exec(r.decision?.reason ?? "");
      return m ? `显示为「${m[1]}」` : "（没匹配到括号）";
    })()
  );
}

// edit is a write too
{
  const r = await runGate(B, "edit", {
    file_path: join(vaultOne, "0-杂学.md"),
    old_string: "a",
    new_string: "b",
  });
  check("非持有者的 edit → 同样被拒绝", denied(r));
}

// ── 2. fail-open cases ───────────────────────────────────────────────────
{
  const r = await runGate(B, "read", { file_path: join(vaultOne, "任意.md") });
  check("读操作 → 放行", passedThrough(r), `next=${r.nextCalls}`);
}
{
  // ★ Regression: tool calls routinely carry RELATIVE paths, because the
  //   session cwd is the vault. An earlier gate only matched absolute paths
  //   that contained the vault root, so every relative write slipped through
  //   (observed live: a conversation wrote and committed into a locked vault,
  //   leaving no gate log line at all).
  const r = await runGate(B, "write", {
    file_path: "10-知识/2-杂学/物理/某笔记.md",
    content: "x",
  });
  check("★ 相对路径写本库 → 必须被拒绝", denied(r), `kind=${r.decision?.kind ?? "(none)"}`);
}
{
  const r = await runGate(B, "edit", {
    file_path: "00-索引/2-标签总表.md",
    old_string: "a",
    new_string: "b",
  });
  check("★ 相对路径的 edit → 必须被拒绝", denied(r));
}
{
  // ★ Regression: `git add -A; git commit` runs IN the vault cwd, so it writes
  //   vault files while its text never names a path. It must still be caught.
  const r = await runGate(B, "pwsh", {
    command: 'git add -A; git commit -m "x"',
  });
  check("★ 不带路径的 git add -A/commit（cwd 即本库）→ 必须被拒绝", denied(r));
}
{
  // A relative path that resolves OUTSIDE the vault is somebody else's file.
  const r = await runGate(B, "write", {
    file_path: "..\\outside\\elsewhere.md",
    content: "x",
  });
  check("相对路径但在库外 → 放行", passedThrough(r));
}
{
  const r = await runGate(B, "write", {
    file_path: join(vaultTwo, "别处的文件.md"),
    content: "x",
  });
  check("写【另一个】库 → 放行（各有各的锁）", passedThrough(r));
}
{
  const r = await runGate(A, "write", {
    file_path: join(vaultOne, "持有者自己的.md"),
    content: "x",
  });
  check("持有者自己写 → 放行（不能卡住自己）", passedThrough(r));
}
{
  const C = mkSession("session-DDDD-4444", vaultOne, { child: true });
  const r = await runGate(C, "write", {
    file_path: join(vaultOne, "子代理的活.md"),
    content: "x",
  });
  check("子代理写 → 放行（它是本对话的家务活）", passedThrough(r));
}
{
  const r = await runGate(B, "mystery_tool", { whatever: 1 });
  check("认不出的工具 → 放行（宁可漏拦，不可乱拦）", passedThrough(r));
}
{
  const r = await runGate(B, "write", { content: "没有 file_path" });
  check("没有 file_path 的 write → 放行（无法判断，fail open）", passedThrough(r));
}

// ── 3. shell tool handling ───────────────────────────────────────────────
{
  const r = await runGate(B, "pwsh", {
    command: `Get-Content "${join(vaultOne, "某笔记.md")}"`,
  });
  check("shell 里的【读】命令 → 放行", passedThrough(r), "纯 Get-Content");
}
{
  const r = await runGate(B, "pwsh", {
    command: `Set-Content -Path "${join(vaultOne, "某笔记.md")}" -Value hi`,
  });
  check("shell 里的【写】命令 → 拒绝", denied(r));
}
{
  // A multi-line script must NOT be dumped into the notice (a live run put a
  // 200-character slice of a whole pwsh script on the "blocked operation" line,
  // which is unreadable and names no file).
  const longScript = [
    `$repo='${vaultOne}'`,
    "$f = Join-Path $repo 'x.md'",
    "Write-Output '=== doing things ==='",
    "Set-Content -LiteralPath $f -Value 'hi' -Encoding utf8",
    "Write-Output 'done'",
  ].join("\n");
  const r = await runGate(B, "pwsh", { command: longScript });
  const reason = r.decision?.reason ?? "";
  check("shell 里的多行脚本 → 拒绝", denied(r));
  check(
    "  ★ 多行脚本只摘要成一行（不倾倒整段）",
    denied(r) && reason.length < 700 && !reason.includes("=== doing things ==="),
    `长度=${reason.length}`
  );
  check(
    "  ★ 摘要标明这是 shell 命令",
    denied(r) && reason.includes("shell 命令"),
    ""
  );
}
{
  const r = await runGate(B, "pwsh", {
    command: `git -C "${vaultOne}" commit -m "x"`,
  });
  check("shell 里对本库的 git commit → 拒绝", denied(r));
}
{
  const r = await runGate(B, "pwsh", {
    command: `git -C "${vaultOne}" log --oneline`,
  });
  check("shell 里对本库的 git log（只读）→ 放行", passedThrough(r));
}
{
  const r = await runGate(B, "pwsh", {
    command: `Set-Content -Path "${join(root, "库外面.txt")}" -Value hi`,
  });
  check("shell 写【库外】文件 → 放行", passedThrough(r));
}

// ── 4. settings switch off ───────────────────────────────────────────────
{
  saveSettings({ writeLock: false });
  await sleep(1100); // settings cache TTL is 1s
  const r = await runGate(B, "write", {
    file_path: join(vaultOne, "关掉开关后.md"),
    content: "x",
  });
  check("关掉 writeLock 开关后 → 完全不拦", passedThrough(r));
  saveSettings();
  await sleep(1100);
}

// ── 5. unlocked vault is free ────────────────────────────────────────────
{
  // B opens a turn while A holds vaultOne → B is queued, not holder.
  turn += 1;
  fire("turn/start", B, { turn });
  await sleep(80);
  const r = await runGate(OTHER, "write", {
    file_path: join(vaultTwo, "无锁库.md"),
    content: "x",
  });
  check("没有任何人持锁的库 → 随便写", passedThrough(r));
}

// ── 6. the go-ahead notice is not an approval ────────────────────────────
{
  // A releases; B should be woken with the "go" text.
  const delivered = [];
  injectors.get("sessionController")({
    sessionController: {
      async resolveAgent(id) {
        return {
          session: { id },
          followup(m) { delivered.push({ id, text: m?.content?.[0]?.text ?? "", via: "followup" }); },
          steer(m) { delivered.push({ id, text: m?.content?.[0]?.text ?? "", via: "steer" }); },
          inbox: { remove() { return false; } },
        };
      },
    },
  });
  turn += 1;
  fire("turn/end", A, { turn });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !delivered.some((d) => d.id === B.id && d.text.startsWith("【写锁·轮到你了】"))) {
    await sleep(100);
  }
  const go = delivered.find((d) => d.id === B.id && d.text.startsWith("【写锁·轮到你了】"));
  check("放行后，等待者收到「轮到你了」", go !== undefined);
  check(
    "  放行文案明确说「这不是批准」",
    go !== undefined && go.text.includes("这不是「批准」"),
    ""
  );
  check(
    "  放行文案要求「先核对再决定要不要重做」",
    go !== undefined &&
      go.text.includes("动手前必须先核对") &&
      go.text.includes("不要重做"),
    ""
  );
  check(
    "  ★ 放行文案点了「不是每次都要重做」（防止重复写入）",
    go !== undefined && go.text.includes("根本没被拦过"),
    ""
  );
  check(
    "  放行文案仍要求「重新执行」（真被拦下的那件）",
    go !== undefined && go.text.includes("重新执行"),
    ""
  );
  check(
    "  ★ 放行通知走的是 steer（next-step，不是排队 followup）",
    delivered.some((d) => d.id === B.id && d.via === "steer"),
    ""
  );
}

// ── summary ──────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log("");
console.log(`SUMMARY ${JSON.stringify({ total: results.length, failed: failed.length })}`);

for (const fn of disposeFns) {
  try { fn(); } catch {}
}
try { rmSync(root, { recursive: true, force: true }); } catch {}
// Explicit exit: apply() installed fs.watch, so the loop would not drain.
process.exit(failed.length === 0 ? 0 : 1);
