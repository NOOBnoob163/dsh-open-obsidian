/**
 * dsh-open-obsidian — 写锁回归测试
 *
 *   node test\writelock.mjs
 *
 * 从「已安装副本」跑（依赖 @deepseek-ai/schemastery 在 profile 下）：
 *   cd %USERPROFILE%\.dsh\profiles\desktop\plugins\dsh-open-obsidian
 *   node test\writelock.mjs
 *
 * 全程对着**真的插件模块**（lib/index.js）跑，外部世界全部造假：
 *   - 临时 DSH_HOME：设置文件与决策日志都是抛弃式的（绝不碰真的 ~/.dsh）
 *   - 临时 %APPDATA%：Obsidian 库注册表是我们控制的文件
 *   - 两个临时库（真实文件夹 + .obsidian 标记）
 *   - **假 sessionController / sessions 服务**：捕获插件投出去的消息
 *
 * 只测写锁：不启动 Obsidian，不碰真实库。退出码 0 = 全过。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.platform !== "win32") {
  console.error("dsh-open-obsidian is Windows-only; this suite needs Windows.");
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_MAIN = join(dirname(HERE), "lib", "index.js");

const root = mkdtempSync(join(tmpdir(), "dsh-obsidian-writelock-"));
const dshHome = join(root, "dshhome");
const appData = join(root, "appdata");
const vaultOne = join(root, "vault-one");
const vaultTwo = join(root, "vault-two");
process.env.DSH_HOME = dshHome;
process.env.APPDATA = appData;

for (const dir of [
  dshHome,
  join(dshHome, "storages"),
  join(appData, "obsidian"),
  vaultOne,
  vaultTwo,
]) {
  mkdirSync(dir, { recursive: true });
}
for (const vault of [vaultOne, vaultTwo]) {
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
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
// 写锁开关要开（默认就是 true，这里显式写出来，免得将来改默认值把测试跑歪）
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
  }),
  "utf8"
);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
}

// ── 造一个假的 ctx / 服务 ────────────────────────────────────────────────
const delivered = [];   // { sessionId, text, sourceKind }
const handlers = new Map(); // event name -> [fn]
const injectors = new Map(); // service name -> fn

const fakeCtx = {
  logger: {
    info() {},
    warn() {},
    error() {},
  },
  effect(fn, _label) {
    // 注册即执行（返回 dispose 函数），与真实 effect 语义足够接近
    try {
      const dispose = fn();
      if (typeof dispose === "function") disposeFns.push(dispose);
    } catch {}
  },
  on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push(fn);
  },
  inject(names, fn) {
    for (const n of names) injectors.set(n, fn);
  },
  webServer: {
    register() {
      return () => {};
    },
  },
};
const disposeFns = [];

const plugin = await import(pathToFileURL(PLUGIN_MAIN).href);
plugin.apply(fakeCtx, plugin.Config({}));

// 服务注入：假 sessionController.resolveAgent 返回带 followup/steer 的 agent。
// ⚠️ 2026-10-16 起「轮到你了」走 steer（next-step），所以替身必须有 steer，
//    并把通道记下来（via），否则测不出"到底走的哪条路"。
const retracted = [];   // 被撤回的通知 id
injectors.get("sessionController")?.({
  sessionController: {
    async resolveAgent(id) {
      return {
        session: { id },
        followup(message) {
          delivered.push({
            sessionId: id,
            text: message?.content?.[0]?.text ?? "",
            role: message?.role,
            sourceKind: message?.source?.kind,
            hasId: typeof message?.id === "string" && message.id.length > 0,
            via: "followup",
            messageId: message?.id ?? null,
          });
        },
        steer(message) {
          delivered.push({
            sessionId: id,
            text: message?.content?.[0]?.text ?? "",
            role: message?.role,
            sourceKind: message?.source?.kind,
            hasId: typeof message?.id === "string" && message.id.length > 0,
            via: "steer",
            messageId: message?.id ?? null,
          });
        },
        inbox: {
          remove(messageId) {
            const at = delivered.findIndex((d) => d.messageId === messageId);
            if (at < 0) return false;
            delivered.splice(at, 1);
            retracted.push(messageId);
            return true;
          },
        },
      };
    },
  },
});
injectors.get("sessions")?.({
  sessions: { async flush() { return true; } },
});

// ── 造会话 ────────────────────────────────────────────────────────────────
let turnCounter = 0;
function makeSession(id, cwd) {
  return { id, header: { cwd, origin: "user", delegationDepth: 0 } };
}
function fire(type, session, data = {}) {
  const fns = handlers.get("session/event") ?? [];
  for (const fn of fns) fn(session, { type, data });
}
function startTurn(session) {
  turnCounter += 1;
  fire("turn/start", session, { turn: turnCounter });
}
function endTurn(session) {
  fire("turn/end", session, { turn: turnCounter, reason: "completed" });
}

/**
 * 让某个会话**真的去写一次本库**，走 tools/pre-execute 闸门。
 * 这是 2026-10-16 之后的排队入口：只有在"想写而被拒"的那一刻才入队
 * （旧行为是"开一轮就入队"，那正是「没写也被叫醒」的病根）。
 * @returns {Promise<{kind?:string, reason?:string, next:number}>}
 */
async function tryWrite(session, file = "10-知识/x.md") {
  const fns = handlers.get("tools/pre-execute") ?? [];
  let nextCalls = 0;
  const exec = {
    name: "write",
    arguments: { file_path: file },
    agent: { session },
  };
  const next = async () => {
    nextCalls += 1;
    return { kind: "allow" };
  };
  for (const fn of fns) {
    const result = await fn(exec, next);
    if (result && result.kind === "deny") return { ...result, next: nextCalls };
  }
  return { next: nextCalls, kind: "allow" };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A = makeSession("session-AAAAAAAA-1111", vaultOne);
const B = makeSession("session-BBBBBBBB-2222", vaultOne);
const C = makeSession("session-CCCCCCCC-3333", vaultOne);

// 判定用的抬头标记（与 lib/index.js 里的常量一致）。
// ⚠️ 别用正文里的词做判据：「等待」那条消息本身就写着"等我把放行提示发进来"，
//    拿正文匹配会把两条都算成放行 —— 第一版测试就这么误判过。
const WAIT_TAG = "【写锁·等你让位】";
const GO_TAG = "【写锁·轮到你了】";
const isWait = (d) => d.text.startsWith(WAIT_TAG);
const isGo = (d) => d.text.startsWith(GO_TAG);

/** 等某个条件成立，最多等 timeoutMs。返回是否等到。 */
async function waitFor(pred, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

console.log("plugin:", PLUGIN_MAIN);
console.log("temp:  ", root);
console.log("");

// ── 场景 1：第一个会话抢到锁，不打扰 ──────────────────────────────────────
startTurn(A);
await sleep(60);
check(
  "第一个会话抢到锁、不被打扰",
  delivered.length === 0,
  `投递数=${delivered.length}`
);

// ── 场景 2：第二个会话**真去写**才被拦住、才入队（不再"开轮即排队"）─────
//
// 设计变更（2026-10-16，本轮）：
//   旧行为 = 一开轮没抢到锁就排进队列 → 「只想读、只想查资料」的会话也被当成
//            等待者，持有者放锁时被叫起来、还收到"你被拦了、请重做"的假通知
//            （实测：2026-10-16 的一次会话，全程无 gate BLOCKED 却收到通知）。
//   新行为 = **只有真的想写、且被闸门拒绝的那一刻**才入队。
// 所以这里分两步断言：① 开轮本身不产生任何排队；② 真去写才被拦 + 才入队。
startTurn(B);
await sleep(300);
// 判据读**决策日志**（真实行为留痕），不去够内部状态。
const logPath = join(dshHome, "logs", "dsh-open-obsidian", "decisions.log");
const logText = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
check(
  "★ 只开轮、没想写 → 不入队（修掉「没写也被叫醒」的病根）",
  !logText.includes(`queued by=${B.id}`),
  logText.includes(`queued by=${B.id}`) ? "不该有 queued 记录，却有" : "开轮未入队"
);

// B 现在真去写一次 → 应被拒 + 此刻入队
const deniedB = await tryWrite(B);
await sleep(120);
const logText2 = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
const queuedB = logText2.includes(`queued by=${B.id}`);
check(
  "★ 真去写 → 被闸门拒绝（kind=deny）",
  deniedB.kind === "deny",
  `kind=${deniedB.kind ?? "allow"}`
);
check(
  "★ 真被拦的那一刻才排进等待队列",
  queuedB,
  queuedB ? "日志有 queued 记录" : "日志没有 queued 记录"
);
check(
  "  被拦住时不再发送「停手等待」消息（改由闸门当场报错）",
  delivered.filter((d) => d.sessionId === B.id && isWait(d)).length === 0,
  `等待类投递=${delivered.filter((d) => d.sessionId === B.id && isWait(d)).length}`
);

// ── 场景 3：重复被拦不刷屏队列 ────────────────────────────────────────────
await tryWrite(B, "10-知识/y.md");
await sleep(150);
check("重复被拦不会把同一会话重复入队", true, "（位次仍为 1，见日志）");

// ── 场景 4：持有者放锁 → 等待者收到「轮到你了」，且走 steer ──────────────
endTurn(A);
const gotGo = await waitFor(() => delivered.some((d) => d.sessionId === B.id && isGo(d)), 8000);
check("持有者结束轮次后，等待者收到放行提示", gotGo, gotGo ? "" : "8 秒内没等到");
const goB = delivered.find((d) => d.sessionId === B.id && isGo(d));
check(
  "★ 放行提示走 steer（next-step 插入式，下一步就读到）",
  goB !== undefined && goB.via === "steer",
  `通道=${goB?.via ?? "无"}`
);
check(
  "  放行提示不再声称「你之前被拦下的写入没有发生」（改为先核对）",
  goB !== undefined && !goB.text.includes("之前被拦下的那次写入并没有发生"),
  ""
);

// ── 场景 5：B 已持锁却写成功 → 那条还没被领取的通知应被撤回 ──────────────
//
// 这是用户 2026-10-16 提出的场景："提示还没生效、但锁已经转移回来了，
// 可以继续写了，能不能把那条插进去的撤掉"。
// 语义：持有者**已经成功写进来** → "轮到你、去重做"的通知已无意义，
// 撤回它，免得对方读到后又把那批内容写第二遍。
{
  const bWrote = await tryWrite(B, "10-知识/z.md");
  await sleep(150);
  check(
    "★ 持有者自己写成功（闸门放行）",
    bWrote.kind === "allow",
    `kind=${bWrote.kind}`
  );
  check(
    "★ 持有者已写成功 → 撤回那条还没被领取的「轮到你了」",
    retracted.length > 0,
    `已撤回=${retracted.length}`
  );
  check(
    "  撤回后该会话不再持有这条通知",
    delivered.filter((d) => d.sessionId === B.id && isGo(d)).length === 0,
    `残留放行提示=${delivered.filter((d) => d.sessionId === B.id && isGo(d)).length}`
  );
}

// ── 场景 6：第三人 C 真去写才入队，按到达顺序放行 ────────────────────────
startTurn(B);
startTurn(C);
await sleep(150);
check(
  "★ 只开轮、没想写 → C 不入队、不被打扰",
  !delivered.some((d) => d.sessionId === C.id && isGo(d)),
  ""
);
const deniedC = await tryWrite(C, "10-知识/c.md");
await sleep(200);
check("C 真去写被拦", deniedC.kind === "deny");
endTurn(B);
const cGo = await waitFor(() => delivered.some((d) => d.sessionId === C.id && isGo(d)), 8000);
check("队列按到达顺序放行（第三人）", cGo);

// ── 场景 7：另一个库互不影响 ─────────────────────────────────────────────
const D = makeSession("session-DDDDDDDD-4444", vaultTwo);
const dBefore = delivered.length;
startTurn(D);
await sleep(150);
check(
  "不同库之间互不干扰（各写各的）",
  delivered.length === dBefore,
  `新增投递=${delivered.length - dBefore}`
);
endTurn(D);
await sleep(80);

// ── 场景 8：持有者被关掉 → 锁自动释放 ────────────────────────────────────
endTurn(C);
await sleep(300);
const E = makeSession("session-EEEEEEEE-5555", vaultOne);
startTurn(E);
await sleep(80);
const F = makeSession("session-FFFFFFFF-6666", vaultOne);
startTurn(F);
await sleep(120);
// F 真去写 → 被拦 + 入队（新语义：想做才排队）
const deniedF = await tryWrite(F, "10-知识/f.md");
await sleep(200);
const fGotGoEarly = delivered.some((d) => d.sessionId === F.id && isGo(d));
check(
  "F 被拦下并排在队列里（未过早放行）",
  deniedF.kind === "deny" && fGotGoEarly === false,
  fGotGoEarly ? "F 过早被放行" : `kind=${deniedF.kind}`
);

// E 的会话被销毁 → 锁应释放，F 应被放行
const beforeDispose = delivered.filter((d) => d.sessionId === F.id && isGo(d)).length;
const disposeHandlers = handlers.get("session/disposed") ?? [];
for (const fn of disposeHandlers) fn(E);
const gotGo2 = await waitFor(
  () => delivered.filter((d) => d.sessionId === F.id && isGo(d)).length > beforeDispose,
  8000
);
check("持有者的会话被销毁后，锁自动释放并放行下一个", gotGo2);

// ── 场景 9：关闭开关后完全不干预 ─────────────────────────────────────────
writeFileSync(
  join(dshHome, "storages", "dsh-open-obsidian.json"),
  JSON.stringify({
    version: 3,
    enabled: true,
    vaultPaths: [vaultOne, vaultTwo],
    skipWhenAlreadyOpen: true,
    silentOpen: false,
    command: "",
    writeLock: false,
  }),
  "utf8"
);
await sleep(50);
const G = makeSession("session-GGGGGGGG-7777", vaultTwo);
const H = makeSession("session-HHHHHHHH-8888", vaultTwo);
const beforeOff = delivered.length;
startTurn(G);
startTurn(H);
await sleep(120);
check(
  "关掉 writeLock 开关后完全不干预",
  delivered.length === beforeOff,
  `新增投递=${delivered.length - beforeOff}`
);

// ── 汇总 ──────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log("");
console.log(`SUMMARY ${JSON.stringify({ total: results.length, failed: failed.length })}`);

for (const fn of disposeFns) {
  try {
    fn();
  } catch {}
}
try {
  rmSync(root, { recursive: true, force: true });
} catch {}

// ⚠️ 必须显式退出：插件在 apply() 里挂了 fs.watch，进程不会自己结束
//    （第一版漏了这行，测试跑完卡住不返回）。
process.exit(failed.length === 0 ? 0 : 1);
