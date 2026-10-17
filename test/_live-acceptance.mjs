/**
 * 真机验收：用**真实的插件代码** + **真实的 Obsidian** + **真实的设置/注册表**
 * 跑用户要的两个场景。只把 DSH 那一层壳换成假的（logger/effect/on/webServer）。
 *
 * 注意：这里**故意不覆盖** DSH_HOME / APPDATA —— 读的就是本机真实设置与
 * 真实 Obsidian 库列表，写的就是真实的决策日志。这正是"验收"的意义。
 *
 *   node test/_live-acceptance.mjs <vaultPath> <sessionId> [waitMs]
 *
 * 场景1：库已经开着  → 期望 skip（什么都不做，不弹窗、不抢焦点）
 * 场景2：库没开、Obsidian 在跑 → 期望静默打开（新窗口出现但不抢焦点）
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const PLUGIN = join(
  homedir(),
  ".dsh", "profiles", "desktop", "plugins", "dsh-open-obsidian", "lib", "index.js"
);
const LOG = join(homedir(), ".dsh", "logs", "dsh-open-obsidian", "decisions.log");

const vaultPath = process.argv[2];
const sessionId = process.argv[3];
const waitMs = Number(process.argv[4] ?? 9000);

if (!vaultPath || !sessionId) {
  console.error("用法: node _live-acceptance.mjs <vaultPath> <sessionId> [waitMs]");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 只替换 DSH 外壳；其余一律走真实环境
function makeCtx() {
  const handlers = new Map();
  const disposers = [];
  return {
    handlers,
    ctx: {
      logger: {
        info: (...a) => console.log("  [plugin info]", ...a),
        warn: (...a) => console.log("  [plugin WARN]", ...a),
        error: (...a) => console.log("  [plugin ERROR]", ...a),
      },
      effect(fn) {
        const d = fn();
        if (typeof d === "function") disposers.push(d);
      },
      on(event, fn) { handlers.set(event, fn); },
      webServer: { register() { return () => {}; } },
    },
    disposers,
  };
}

/** 决策日志里这一轮新增的行。 */
function readLog() {
  return existsSync(LOG) ? readFileSync(LOG, "utf8") : "";
}
function logLinesFor(sessionId) {
  return readLog()
    .split(/\r?\n/)
    .filter((l) => l.includes(sessionId) || l.includes("silent-open"))
    .slice(-8);
}

const before = readLog().length;

console.log(`插件(真实): ${PLUGIN}`);
console.log(`目标库     : ${vaultPath}`);
console.log(`会话 id    : ${sessionId}`);
console.log(`等待       : ${waitMs} ms\n`);

const env = makeCtx();
const mod = await import(pathToFileURL(PLUGIN).href + "?live=" + Date.now());
mod.apply(env.ctx, { enabled: true, vaultPaths: [], skipWhenAlreadyOpen: true, silentOpen: true });

// 等插件 boot（迁移设置 + 建监听器）
await sleep(400);

// 触发：模拟"用户在这个库的会话里发出了第一条消息"
const handler = env.handlers.get("session/event");
if (!handler) {
  console.error("插件没有注册 session/event 处理器");
  process.exit(1);
}
const cwdInsideVault = vaultPath;
handler(
  { id: sessionId, header: { origin: "user", cwd: cwdInsideVault, delegationDepth: 0 } },
  { type: "user/message", data: { source: { kind: "user" } } }
);
console.log("已触发 user/message，等待插件决策…\n");

await sleep(waitMs);

console.log("=== 决策日志新增内容 ===");
const added = readLog().slice(before);
if (added.trim().length === 0) {
  console.log("  （没有新增）");
} else {
  for (const line of added.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const m = /^(\S+)\s+\[dsh-open-obsidian\]\s+(.*)$/.exec(line);
    if (m) {
      const t = new Date(m[1]).toLocaleTimeString("zh-CN", { hour12: false });
      console.log(`  ${t}  ${m[2]}`);
    } else {
      console.log(`  ${line}`);
    }
  }
}

// 收尾：关掉监听器，别让这个临时进程留东西
for (const d of env.disposers) {
  try { d(); } catch {}
}
await sleep(200);
process.exit(0);
