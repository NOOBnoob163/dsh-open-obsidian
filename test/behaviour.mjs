/**
 * dsh-open-obsidian — behaviour regression suite.
 *
 *   node test/behaviour.mjs
 *
 * Run it from an INSTALLED copy — e.g.
 *   cd %USERPROFILE%\.dsh\profiles\desktop\plugins\dsh-open-obsidian
 *   node test\behaviour.mjs
 * The plugin's dependency (@deepseek-ai/schemastery) is installed per profile,
 * so this file cannot run from the workspace source bundle in
 * dsh-plugin-migration\packages\... , which has no node_modules of its own.
 *
 * Everything here runs against the REAL plugin module (lib/index.js) with all
 * of its outside world faked:
 *
 *   - a temp DSH_HOME, so the settings file and the decision log under test are
 *     throwaway (your real ~/.dsh is never touched);
 *   - a temp %APPDATA%, so "Obsidian's vault registry" is a file we control;
 *   - two temp vaults (real folders carrying a `.obsidian` marker);
 *   - a fake `Obsidian.exe` — a copy of cmd.exe started with `start /min` so it
 *     owns a console window whose title we set. That title is exactly what the
 *     plugin reads to decide whether a vault is already on screen.
 *
 * The settings' launch command is redirected to a marker file, so a "launch"
 * assertion never starts your real Obsidian.
 *
 * Windows only (the plugin is). Exit code 0 = all scenarios passed.
 */
import { spawn } from "node:child_process";
import {
  copyFileSync,
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

const PLUGIN = fileURLToPath(new URL("../lib/index.js", import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), "dsh-obsidian-test-"));
const DSH_HOME = join(ROOT, "dshhome");
const APPDATA_FAKE = join(ROOT, "appdata");
const VAULT_ONE = join(ROOT, "vault-one");
const VAULT_TWO = join(ROOT, "vault-two");
const MARKER = join(ROOT, "launched.txt");
const SETTINGS = join(DSH_HOME, "storages", "dsh-open-obsidian.json");
const REGISTRY = join(APPDATA_FAKE, "obsidian", "obsidian.json");
const LOG = join(DSH_HOME, "logs", "dsh-open-obsidian", "decisions.log");
const FAKE_EXE = join(ROOT, "fakeobs", "Obsidian.exe");

/**
 * The settings version under test is read from the plugin itself, so this suite
 * cannot silently drift out of sync when the plugin bumps it. (It was written
 * as a literal 2, which made every later version look like "a legacy file that
 * needs migrating".)
 */
const SETTINGS_VERSION = (() => {
  const source = readFileSync(PLUGIN, "utf8");
  const m = /const SETTINGS_VERSION = (\d+)/.exec(source);
  if (m === null) throw new Error("cannot read SETTINGS_VERSION from the plugin");
  return Number(m[1]);
})();

process.env.DSH_HOME = DSH_HOME;
process.env.APPDATA = APPDATA_FAKE;
// The fake Obsidian is a renamed cmd.exe, so the compiled helper (which reports
// windows of processes literally named "Obsidian") cannot see it. Point the
// plugin at its tasklist fallback, which is what the fakes were built around.
process.env.DSH_OPEN_OBSIDIAN_NO_HELPER = "1";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let importSeq = 0;

// ------------------------------------------------------------------ fixtures

for (const vault of [VAULT_ONE, VAULT_TWO]) {
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
}
mkdirSync(dirname(FAKE_EXE), { recursive: true });
copyFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), FAKE_EXE);

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}
function writeSettings(overrides = {}) {
  writeJson(SETTINGS, {
    version: SETTINGS_VERSION,
    enabled: true,
    vaultPaths: [VAULT_ONE],
    skipWhenAlreadyOpen: true,
    silentOpen: false,
    command: `echo {vault}> "${MARKER}"`,
    ...overrides,
  });
}
function writeRegistry(vaults) {
  const out = { vaults: {} };
  vaults.forEach((vault, index) => {
    out.vaults[`id${index}`] = vault.open
      ? { path: vault.path, ts: 1, open: true }
      : { path: vault.path, ts: 1 };
  });
  writeJson(REGISTRY, out);
}

const resetLog = () => rmSync(LOG, { force: true });
const readLog = () => (existsSync(LOG) ? readFileSync(LOG, "utf8") : "");
const resetMarker = () => rmSync(MARKER, { force: true });
const markerText = () => (existsSync(MARKER) ? readFileSync(MARKER, "utf8") : "");

// ------------------------------------------------------- fake Obsidian process

const fakePids = [];
function tasklistRows() {
  return new Promise((resolve) => {
    const child = spawn(
      "tasklist",
      ["/FI", "IMAGENAME eq Obsidian.exe", "/NH", "/FO", "CSV", "/V"],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
    );
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("close", () => {
      resolve(
        out
          .split(/\r?\n/)
          .filter((line) => /^"Obsidian\.exe"/i.test(line))
          .map((line) => {
            const trimmed = line.replace(/\s+$/, "");
            const end = trimmed.length - 1;
            const sep = trimmed.lastIndexOf('","', end - 1);
            return {
              pid: Number(trimmed.split('","')[1]),
              title: trimmed.slice(sep + 3, end),
            };
          })
      );
    });
    child.on("error", () => resolve([]));
  });
}

/**
 * `cmd /k` exits immediately without a console, so the fake is started through
 * `start "" /min`, which gives it a (minimized) console window; `title` then
 * labels that window. `start` reports no pid, so it is looked up by title.
 */
async function startFake(title) {
  const launcher = spawn(
    "cmd.exe",
    ["/c", "start", "\"\"", "/min", FAKE_EXE, "/k", "title " + title],
    { windowsHide: true, stdio: "ignore" }
  );
  await new Promise((resolve) => launcher.on("close", resolve));
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(250);
    const hit = (await tasklistRows()).find((row) => row.title === title);
    if (hit !== undefined) {
      fakePids.push(hit.pid);
      return hit.pid;
    }
  }
  throw new Error(`fake Obsidian process with title "${title}" never appeared`);
}
async function stopFakes() {
  const pids = fakePids.splice(0);
  for (const pid of pids) {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/F", "/PID", String(pid)], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("close", resolve);
      killer.on("error", resolve);
    });
  }
  if (pids.length > 0) await sleep(700);
}

// ------------------------------------------------------------- plugin driving

function makeCtx() {
  const routes = [];
  const handlers = new Map();
  const disposers = [];
  return {
    routes,
    handlers,
    disposers,
    ctx: {
      logger: { info() {}, warn() {}, error() {} },
      effect(fn) {
        const disposer = fn();
        if (typeof disposer === "function") disposers.push(disposer);
      },
      on(event, fn) { handlers.set(event, fn); },
      webServer: { register(route) { routes.push(route); return () => {}; } },
    },
  };
}
const fakeRes = () => ({
  status: 0,
  body: "",
  writeHead(status) { this.status = status; },
  end(chunk) { if (chunk) this.body += chunk.toString(); },
});

let current = null;
async function boot(settings, vaults) {
  writeSettings(settings);
  writeRegistry(vaults);
  resetLog();
  resetMarker();
  const environment = makeCtx();
  const module = await import(pathToFileURL(PLUGIN).href + "?suite=" + (importSeq += 1));
  module.apply(environment.ctx, {
    enabled: true,
    vaultPaths: [],
    skipWhenAlreadyOpen: true,
    command: "",
  });
  await sleep(250);
  current = { ...environment, module };
}
const routeNamed = (path) => current.routes.find((route) => route.path === path);
async function getSettings() {
  const res = fakeRes();
  await routeNamed("/dsh-open-obsidian/settings").handler(
    { method: "GET", socket: { remoteAddress: "127.0.0.1" } },
    res
  );
  return JSON.parse(res.body);
}
async function postRoute(path, remoteAddress, body = {}) {
  const res = fakeRes();
  await routeNamed(path).handler(
    { method: "POST", socket: { remoteAddress }, on() {}, destroy() {} },
    res
  );
  return { status: res.status, payload: res.body.length > 0 ? JSON.parse(res.body) : null };
}
function fireUserMessage(vault, id) {
  current.handlers.get("session/event")(
    { id, header: { origin: "user", cwd: vault, delegationDepth: 0 } },
    { type: "user/message", data: { source: { kind: "user" } } }
  );
}
function teardown() {
  for (const dispose of current.disposers) {
    try { dispose(); } catch {}
  }
}

// ------------------------------------------------------------------ assertions

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
}
/**
 * Some scenarios need a precondition the machine itself must provide — above
 * all "no Obsidian is running anywhere". If the user happens to have Obsidian
 * open, that precondition is unavailable and the scenario must be reported as
 * skipped rather than silently failing (or worse, passing by accident).
 */
function skip(name, why) {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name}   (${why})`);
}
/** Real (non-fake) Obsidian processes currently running. */
async function realObsidianRunning() {
  const rows = await tasklistRows();
  return rows.some((row) => !fakePids.includes(row.pid));
}
const openOf = (payload, path) => (payload.vaults.find((v) => v.path === path) ?? {}).open;

// ------------------------------------------------------------------ scenarios

console.log(`plugin: ${PLUGIN}\ntemp:   ${ROOT}\n`);

// 1. No Obsidian process: the panel must not claim a vault is open, even though
//    Obsidian's registry still carries a stale `open: true`. This scenario needs
//    the machine to have no Obsidian of its own running — probeObsidian looks at
//    every Obsidian.exe, not just the fake ones, so a real instance invalidates
//    the precondition (the fake cannot be distinguished from it by IMAGENAME).
await stopFakes();
if (await realObsidianRunning()) {
  skip("未运行时不再显示「打开中」", "本机真的开着 Obsidian，无法造出「没在跑」的前提");
} else {
  await boot({}, [{ path: VAULT_ONE, open: true }, { path: VAULT_TWO, open: false }]);
  const noProcess = await getSettings();
  check(
    "未运行时不再显示「打开中」",
    openOf(noProcess, VAULT_ONE) === false && noProcess.obsidianRunning === false,
    `open=${openOf(noProcess, VAULT_ONE)} running=${noProcess.obsidianRunning}`
  );
  teardown();
}

// 2. Obsidian running with that vault on screen: the marker comes back.
await startFake("vault-one");
await boot({}, [{ path: VAULT_ONE, open: true }]);
const processOnVaultOne = await getSettings();
check(
  "真在跑且窗口是该库时显示「打开中」",
  openOf(processOnVaultOne, VAULT_ONE) === true && processOnVaultOne.obsidianRunning === true,
  `open=${openOf(processOnVaultOne, VAULT_ONE)} running=${processOnVaultOne.obsidianRunning}`
);
teardown();

// 3. ... and a trigger is skipped, so focus is not stolen.
await boot({}, [{ path: VAULT_ONE, open: true }]);
fireUserMessage(VAULT_ONE, "skip-confirmed");
await sleep(2000);
check(
  "确认真打开时跳过、不抢焦点",
  !existsSync(MARKER) && /reason=already-open/.test(readLog()),
  `marker=${existsSync(MARKER)}`
);
teardown();

// 4. Stale flag + another vault on screen: must launch (the old "never opens my
//    other vault" bug).
await stopFakes();
await startFake("vault-two");
await boot({}, [{ path: VAULT_ONE, open: true }]);
fireUserMessage(VAULT_ONE, "stale-flag");
await sleep(2000);
check(
  "陈旧标记不再导致「该开不开」",
  existsSync(MARKER) && /reason=user-message/.test(readLog()),
  `marker=${existsSync(MARKER)}`
);
teardown();

// 5. A NOTE named like the other vault ("vault-one - vault-two") is not that
//    vault being open: the suffix rule must still launch.
await stopFakes();
await startFake("vault-one - vault-two");
await boot({}, [{ path: VAULT_ONE, open: true }]);
const noteCollision = await getSettings();
fireUserMessage(VAULT_ONE, "note-collision");
await sleep(2000);
check(
  "笔记名撞库名时不误判为已打开",
  openOf(noteCollision, VAULT_ONE) === false &&
    existsSync(MARKER) &&
    /reason=user-message/.test(readLog()),
  `open=${openOf(noteCollision, VAULT_ONE)} marker=${existsSync(MARKER)}`
);
teardown();

// 5b. THE 0.8.0 REGRESSION. Obsidian 1.13 put a version number in every window
//     title, so a real title reads "<note> - <vault> - Obsidian 1.14.4". The
//     matcher used to compare against "<note> - <vault>" and matched nothing,
//     so a vault that was open on screen was judged closed: it was launched
//     again and the user's window was yanked to the front. This is the exact
//     title shape measured on the user's machine (2026-10-07).
await stopFakes();
await startFake("AGENTS - vault-one - Obsidian 1.14.4");
await boot({}, [{ path: VAULT_ONE, open: true }]);
const versionTitle = await getSettings();
fireUserMessage(VAULT_ONE, "version-suffix");
await sleep(2000);
check(
  "标题带 Obsidian 版本号时仍认得出「已打开」（0.8.0 回归）",
  openOf(versionTitle, VAULT_ONE) === true &&
    !existsSync(MARKER) &&
    /reason=already-open/.test(readLog()),
  `open=${openOf(versionTitle, VAULT_ONE)} marker=${existsSync(MARKER)} log=${JSON.stringify(readLog().trim().slice(-90))}`
);
teardown();

// 5c. The older title shape (no version number, as before Obsidian 1.13) must
//     keep working — the fix must not trade one broken case for another.
await stopFakes();
await startFake("AGENTS - vault-one - Obsidian");
await boot({}, [{ path: VAULT_ONE, open: true }]);
const noVersionTitle = await getSettings();
check(
  "旧式标题（无版本号）仍然认得出「已打开」",
  openOf(noVersionTitle, VAULT_ONE) === true,
  `open=${openOf(noVersionTitle, VAULT_ONE)}`
);
teardown();

// 5d. A DIFFERENT vault open, with the version-suffixed title: must still
//     launch (the suffix strip must not turn every title into a match).
await stopFakes();
await startFake("AGENTS - vault-two - Obsidian 1.14.4");
await boot({}, [{ path: VAULT_ONE, open: true }]);
fireUserMessage(VAULT_ONE, "other-vault-versioned");
await sleep(2000);
check(
  "另一个库开着（带版本号标题）时该开还得开",
  existsSync(MARKER) && /reason=user-message/.test(readLog()),
  `marker=${existsSync(MARKER)}`
);
teardown();

// 6. Nothing checked in the panel = nothing triggers (it used to mean EVERY
//    vault triggers).
await stopFakes();
await boot({ vaultPaths: [] }, [{ path: VAULT_ONE, open: false }]);
fireUserMessage(VAULT_ONE, "empty-list");
await sleep(1500);
check(
  "一个库都不勾选时完全不触发",
  !existsSync(MARKER) && !/reason=user-message|reason=agent-write/.test(readLog()),
  `marker=${existsSync(MARKER)} log=${JSON.stringify(readLog().trim())}`
);
teardown();

// 7. Regression: the ordinary path still launches, with the vault path passed
//    through to the launch command.
await boot({}, [{ path: VAULT_ONE, open: false }]);
fireUserMessage(VAULT_ONE, "normal-launch");
await sleep(2000);
check(
  "常规触发仍然打开（并传对库路径）",
  existsSync(MARKER) && /reason=user-message/.test(readLog()) && markerText().includes(VAULT_ONE),
  `marker=${existsSync(MARKER)} vaultPassed=${markerText().includes(VAULT_ONE)}`
);

// 8. The settings payload carries what the panel shows: log path + last
//    decision, in the shape the panel renders.
const withDecision = await getSettings();
const last = withDecision.lastDecision;
check(
  "面板能拿到日志路径与最近一次动作",
  typeof withDecision.logPath === "string" &&
    withDecision.logPath.endsWith("decisions.log") &&
    last !== null &&
    last.kind === "open" &&
    last.reason === "user-message" &&
    last.vault === VAULT_ONE,
  `logPath=${withDecision.logPath} last=${JSON.stringify(last)}`
);

// 9. The reveal-log route exists and refuses non-loopback callers. (A loopback
//    call would open Explorer, so it is deliberately not exercised here.)
const refused = await postRoute("/dsh-open-obsidian/reveal-log", "10.0.0.5");
check(
  "打开日志接口存在且拒绝非本机调用",
  routeNamed("/dsh-open-obsidian/reveal-log") !== undefined &&
    refused.status === 403 &&
    typeof refused.payload?.error === "string",
  `status=${refused.status}`
);
teardown();

// ------------------------------------------------------------------- teardown

await stopFakes();
rmSync(ROOT, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\nSUMMARY ${JSON.stringify({ total: results.length, failed: failed.length })}`);
if (failed.length > 0) {
  console.log("failed: " + failed.map((r) => r.name).join(" | "));
}
process.exit(failed.length === 0 ? 0 : 1);
