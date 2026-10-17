// dsh-open-obsidian — host half.
//
// When a conversation starts inside an Obsidian vault folder, launch (or
// focus) Obsidian on that vault. Everything runs harness-side, outside the
// model loop, so it costs zero tokens.
//
// Vault recognition: Obsidian marks a vault with a `.obsidian` folder at its
// root, and keeps a registry of every vault it has opened at
// `%APPDATA%\obsidian\obsidian.json`. The plugin walks up from the session's
// working directory to resolve the vault root (each workspace opens ITS OWN
// vault), and the browser half lists the registry catalog with one enable
// toggle per vault. Only vaults whose path is in the enabled `vaultPaths`
// set trigger; a workspace that is not inside an Obsidian vault never
// triggers.
//
// Trigger paths (all deduplicated / throttled, nothing runs per message):
//   1. the first direct human `user/message` of a session whose working
//      directory sits inside an enabled vault — the ONLY human-intent
//      trigger. Decided ONCE per session: launch, or skip when the vault is
//      already open (`skipWhenAlreadyOpen`, on by default, so the harness
//      never steals focus). "Already open" is never taken from Obsidian's
//      registry flag alone: that flag survives an unclean exit, so a running
//      Obsidian showing ANOTHER vault can still carry a stale flag for this
//      one. See isVaultReallyOpen.
//      DSH lifecycle events are deliberately NOT triggers. Up to 0.6.4 a
//      `session/created` listener also launched Obsidian, but that event
//      fires on every session PUBLICATION — GUI load, reconnect after a page
//      reload, and harness boot restoring the last workspace — so Obsidian
//      opened although the user had touched nothing. Removed in 0.7.0.
//   2. write-time ensure: each enabled vault root is watched with `fs.watch`
//      (recursive; `.obsidian`, `.git` and `.trash` churn filtered out, as is
//      any event without a usable filename). A change launches Obsidian only
//      while the agent has been WORKING in that vault — an agent-side session
//      event within ENSURE_ACTIVITY_WINDOW_MS — and Obsidian is not running.
//      Unrelated file churn (sync clients, editors, git maintenance) can
//      therefore never open Obsidian by itself. Checks are async and
//      throttled (30s while running, 10s while down; launch cooldown 30s), so
//      the watcher costs nothing when idle and never spawns process checks
//      per message.
//   3. silent open (0.8.0): when Obsidian is ALREADY running, the window this
//      launch creates is a SECOND window, and Windows would drop the user into
//      it. A 7 KB helper (bin/dsh-open-obsidian-silent.exe, source in src/) is
//      started instead of Obsidian: it records which window the user is in,
//      starts Obsidian itself, waits for the new window, and sends it to the
//      bottom of the Z order with SetWindowPos(HWND_BOTTOM|SWP_NOACTIVATE) —
//      fully visible, no focus taken — then hands the foreground back if the
//      launch took it anyway. Deliberately NOT used on a cold start (the window
//      coming up IS the point) nor for the 测试打开 button (the user is watching
//      for the result). Toggle: `silentOpen`.
//
// Settings: composed from the composition entry (cordis.patch.yml) as the
// base layer plus a versioned user settings file
// (DSH_HOME/storages/dsh-open-obsidian.json) written by the browser half
// through these routes:
//   GET  /dsh-open-obsidian/settings  → effective settings + vault catalog
//        (each vault's `open` flag is confirmed against a RUNNING Obsidian,
//         so the panel cannot show a permanent "打开中" for a closed vault)
//   POST /dsh-open-obsidian/settings  → save { enabled, vaultPaths,
//                                            skipWhenAlreadyOpen, silentOpen,
//                                            command }
//   POST /dsh-open-obsidian/test      → { path? } launch-test a vault
//   POST /dsh-open-obsidian/reveal-log → show the decision log in Explorer
// Changes take effect immediately (the file is re-read at every trigger).
//
// Launch mechanism: the `obsidian://open?path=<url-encoded folder>` URI is
// passed DIRECTLY to the Obsidian executable (resolved from the registered
// protocol handler, with known-path fallbacks) — no `cmd start` /
// ShellExecute, so cold starts cannot trigger Windows "cannot find" error
// dialogs. A custom `command` can override the launch entirely; `{vault}` in
// it is replaced with the resolved vault root folder.
//
// Every launch / skip decision is appended to
// DSH_HOME/logs/dsh-open-obsidian/decisions.log (bounded, best effort), so an
// unexpected open can always be traced back to its trigger afterwards.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";

const name = "dsh-open-obsidian";

/** This plugin's own folder — home of the compiled silent-open helper
 *  (lib/index.js sits one level below it). */
const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** Absolute path of the compiled helper: window lister + silent opener. */
function silentOpenHelperPath() {
  return join(PLUGIN_DIR, "bin", "dsh-open-obsidian-silent.exe");
}

/**
 * Test seam. The behaviour suite fakes Obsidian as a copy of cmd.exe (it owns a
 * console window whose title stands in for a vault window). The compiled helper
 * only reports windows of processes literally named "Obsidian", so under test
 * it must be skipped and the tasklist path used instead — otherwise the suite
 * would silently stop exercising the code the plugin really runs.
 */
const PROBE_DISABLE_HELPER = process.env.DSH_OPEN_OBSIDIAN_NO_HELPER === "1";

const inject = ["webServer"];

const Config = z.object({
  // Master switch: when false the plugin never opens Obsidian.
  enabled: z.boolean().default(true),
  // The set of ENABLED vault root folders (each must be an Obsidian vault).
  // Only sessions whose working directory is inside one of these folders
  // trigger — the resolved vault is still detected by the `.obsidian`
  // marker, so a listed folder that is not an Obsidian vault never triggers.
  // Empty = no vault enabled (the plugin then never triggers). Enforced as of
  // 0.7.1: an empty list used to mean "every vault", which silently turned
  // "uncheck all vaults" into "trigger on all of them".
  vaultPaths: z.array(z.string()).default([]),
  // When true (default), a trigger is skipped when the target vault is
  // ALREADY open in a running Obsidian — the harness never yanks focus to
  // Obsidian for a vault the user already has up. When false, the launch
  // runs regardless (the URI just focuses the existing vault window).
  skipWhenAlreadyOpen: z.boolean().default(true),
  // 0.8.0 — silent open. When a launch happens while Obsidian is ALREADY
  // running and the target vault has no window yet, Obsidian creates a SECOND
  // window. Windows normally raises a freshly created window to the front,
  // which drops the user out of whatever they were typing in. With this on,
  // the plugin watches for that new window and pushes it directly BEHIND the
  // window the user is working in, without activating it. It never touches a
  // window that already existed, and it never runs when Obsidian is being
  // started from scratch (there the window appearing IS the point).
  silentOpen: z.boolean().default(true),
  // Optional custom launch command (run detached through the shell). `{vault}`
  // is replaced with the resolved vault root folder. When empty, the plugin
  // builds and runs the obsidian:// URI itself.
  command: z.string().default(""),
  // Write lock: at most ONE top-level conversation may write a given vault at
  // a time. Two mechanisms work together:
  //   - the lock itself (turn/start → turn/end) decides who may write;
  //   - a `tools/pre-execute` gate refuses a non-holder's write BEFORE it runs,
  //     so the tool never executes and the caller sees an ordinary tool error.
  // The gate is the part that cannot be ignored: it does not ask the model to
  // stop, it stops the call. The text notices are kept as a courtesy so the
  // caller understands why, and as a way to wake the next writer.
  writeLock: z.boolean().default(true),
  // Extra safety net: when the holder goes quiet for this many minutes the
  // lock is treated as abandoned so one dead/stuck conversation cannot freeze
  // a vault forever. Set to 0 to disable the takeover entirely.
  writeLockStaleMinutes: z.number().default(30),
});

/** Settings file format version; bump when the schema semantics change. */
const SETTINGS_VERSION = 3;

/** Obsidian's own vault registry (%APPDATA%/obsidian/obsidian.json). */
const OBSIDIAN_REGISTRY_FILE = (() => {
  const appData =
    typeof process !== "undefined" &&
    typeof process.env.APPDATA === "string" &&
    process.env.APPDATA.length > 0
      ? process.env.APPDATA
      : join(homedir(), "AppData", "Roaming");
  return join(appData, "obsidian", "obsidian.json");
})();

/** The harness home (DSH_HOME or ~/.dsh). */
const DSH_HOME_DIR =
  typeof process !== "undefined" &&
  typeof process.env.DSH_HOME === "string" &&
  process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), ".dsh");

/** User settings file, next to the harness's other storages (~/.dsh/storages). */
const SETTINGS_FILE = join(DSH_HOME_DIR, "storages", "dsh-open-obsidian.json");

/** Decision log: one bounded line per launch / skip decision. */
const DECISION_LOG_FILE = join(
  DSH_HOME_DIR,
  "logs",
  "dsh-open-obsidian",
  "decisions.log"
);

/** Best-effort append to the bounded decision log. Never throws. */
function appendDecisionLog(message) {
  try {
    mkdirSync(dirname(DECISION_LOG_FILE), { recursive: true });
    const stat = existsSync(DECISION_LOG_FILE)
      ? statSync(DECISION_LOG_FILE)
      : null;
    if (stat !== null && stat.size > DECISION_LOG_MAX_BYTES) {
      writeFileSync(DECISION_LOG_FILE, "", "utf8");
    }
    appendFileSync(
      DECISION_LOG_FILE,
      new Date().toISOString() + " " + message + "\n",
      "utf8"
    );
  } catch {}
}

/**
 * The most recent decision line worth showing in the settings panel: an open,
 * a skip, an ignored write, or a silent-open outcome. Read from the tail of the
 * (bounded) decision log, so the panel can answer "why did it open / why did
 * nothing happen?" without the user digging through the file. Returns null when
 * there is nothing readable.
 */
function readLastDecision() {
  try {
    if (!existsSync(DECISION_LOG_FILE)) return null;
    const lines = readFileSync(DECISION_LOG_FILE, "utf8").split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const match =
        /^(\S+)\s+\[dsh-open-obsidian\]\s+(open|skip|ensure ignored|silent-open)\s+vault=(.*?)\s+reason=(\S+)/.exec(
          lines[i]
        );
      if (match !== null) {
        return {
          at: match[1],
          kind: match[2],
          vault: match[3],
          reason: match[4],
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Write-time ensure throttles: re-check at most every 30s while Obsidian
 * runs, every 10s while it is down; relaunch at most every 30s. */
const ENSURE_RUNNING_TTL_MS = 30_000;
const ENSURE_STOPPED_TTL_MS = 10_000;
const ENSURE_LAUNCH_COOLDOWN_MS = 30_000;

/** A vault file change may relaunch Obsidian only while the agent has been
 * working in that vault inside this window (agent-side session event). */
const ENSURE_ACTIVITY_WINDOW_MS = 120_000;

/** Session event types that prove the agent itself is working in that vault. */
const AGENT_ACTIVITY_TYPES = new Set([
  "turn/start",
  "step/start",
  "assistant/message",
  "assistant/attempt",
  "tool/call",
  "tool/result",
]);

/** Vault sub-paths whose churn is never a reason to open Obsidian: Obsidian's
 * own state, git plumbing, and Obsidian's trash. Compared case-insensitively
 * per path segment. */
const IGNORED_PATH_SEGMENTS = new Set([".obsidian", ".git", ".trash"]);

/**
 * Silent open: how long the helper program keeps watching for the window a
 * launch creates. A second Obsidian window takes a while to appear (the process
 * starts, Electron boots, the vault loads), and how long varies. Past this the
 * helper gives up and writes why into its state file, which the plugin copies
 * into the decision log — it never sits there forever.
 */
const SILENT_WINDOW_TIMEOUT_MS = 15_000;

/** Decision log cap; the file is reset once it grows past this. */
const DECISION_LOG_MAX_BYTES = 512 * 1024;

/** Pick only the known settings keys (drops anything unexpected). */
function pickSettings(value) {
  const out = {};
  if (typeof value?.enabled === "boolean") out.enabled = value.enabled;
  if (Array.isArray(value?.vaultPaths)) {
    out.vaultPaths = value.vaultPaths
      .map((v) => String(v).trim())
      .filter((v) => v.length > 0);
  }
  if (typeof value?.skipWhenAlreadyOpen === "boolean") {
    out.skipWhenAlreadyOpen = value.skipWhenAlreadyOpen;
  }
  if (typeof value?.silentOpen === "boolean") out.silentOpen = value.silentOpen;
  if (typeof value?.command === "string") out.command = value.command;
  return out;
}

/** Read the user settings file; null when absent or unparsable. */
function readUserSettings() {
  try {
    if (!existsSync(SETTINGS_FILE)) return null;
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Cached effective settings. Keyed by the settings file's mtime, so a write
 * is picked up immediately while per-event listeners stay cheap. */
let settingsCache = { at: 0, mtimeMs: -1, value: null };

/** Persist a validated settings object. Returns true on success. */
function writeUserSettings(value) {
  try {
    mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify(value, null, 2) + "\n", "utf8");
    settingsCache = { at: 0, mtimeMs: -1, value: null };
    return true;
  } catch {
    return false;
  }
}

/**
 * Read Obsidian's vault registry: every vault Obsidian has opened, with its
 * current "open" flag. Sorted by path; [] when the registry is unreadable.
 */
function readObsidianRegistry() {
  try {
    if (!existsSync(OBSIDIAN_REGISTRY_FILE)) return [];
    const raw = JSON.parse(readFileSync(OBSIDIAN_REGISTRY_FILE, "utf8"));
    const vaults = raw?.vaults;
    if (vaults === null || typeof vaults !== "object") return [];
    return Object.values(vaults)
      .filter((v) => v && typeof v.path === "string" && v.path.length > 0)
      .map((v) => ({ path: v.path, open: v.open === true }))
      .sort((a, b) => a.path.localeCompare(b.path));
  } catch {
    return [];
  }
}

/** Case-insensitive Windows path equality. */
function samePath(a, b) {
  const x = normalizePath(a);
  const y = normalizePath(b);
  return x !== null && y !== null && x === y;
}

/** Normalize a Windows path for case-insensitive comparison. */
function normalizePath(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/** True when `cwd` equals `vault` or is a subfolder of `vault`. */
function cwdMatches(cwd, vault) {
  const c = normalizePath(cwd);
  const v = normalizePath(vault);
  if (c === null || v === null) return false;
  return c === v || c.startsWith(v + "\\");
}

/**
 * Walk up from `startDir` to the nearest folder containing `.obsidian`
 * (Obsidian's vault marker). Returns that folder, or null when the start
 * directory is not inside any Obsidian vault.
 */
function findVaultRoot(startDir) {
  if (typeof startDir !== "string" || startDir.length === 0) return null;
  let dir = startDir.replace(/\//g, "\\");
  for (;;) {
    if (existsSync(join(dir, ".obsidian"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached the drive root
    dir = parent;
  }
}

/** Whether the vault at `vaultDir` is flagged open in Obsidian's registry. */
function isVaultOpen(vaultDir) {
  const target = normalizePath(vaultDir);
  if (target === null) return false;
  return readObsidianRegistry().some(
    (v) => v.open && normalizePath(v.path) === target
  );
}

/** Cached Obsidian executable path (null = not resolved yet). */
let obsidianExeCache = null;

/**
 * When resolution FAILED, remember that too: the `reg query` inside
 * resolveObsidianExe is this plugin's only SYNCHRONOUS spawn, so a machine
 * where Obsidian cannot be located must not re-run it (up to the timeout, on
 * the harness event loop) on every launch attempt. Bounded, so a later
 * install is still picked up without restarting the harness.
 */
const EXE_RESOLVE_MISS_TTL_MS = 5 * 60_000;
let obsidianExeMissAt = 0;

/**
 * Extract the executable path from a `reg query` value line. Handles both
 * `"E:\x\Obsidian.exe" "%1"` and unquoted forms.
 */
function extractExeFromRegValue(text) {
  const quoted = /"([^"]+\.exe)"/i.exec(text);
  if (quoted) return quoted[1];
  const line = /REG_SZ\s+([^\r\n]+)/i.exec(text);
  if (!line) return null;
  const token = line[1].trim().replace(/^"|"$/g, "").split(/\s+/)[0];
  return token.length > 0 ? token : null;
}

/**
 * Resolve the Obsidian executable path: first from the registered
 * `obsidian://` protocol handler (HKCU), then from known install
 * locations. Returns null when nothing exists on disk.
 */
function resolveObsidianExe() {
  if (obsidianExeCache !== null) return obsidianExeCache;
  if (
    obsidianExeMissAt > 0 &&
    Date.now() - obsidianExeMissAt < EXE_RESOLVE_MISS_TTL_MS
  ) {
    // Recently not found: skip the probe entirely (see EXE_RESOLVE_MISS_TTL_MS).
    return null;
  }
  const candidates = [];
  try {
    // Synchronous BY DESIGN (a launch must know the exe before spawning) but
    // bounded: 2s timeout, and the outcome — found or not — is cached.
    const result = spawnSync(
      "reg",
      ["query", "HKCU\\Software\\Classes\\obsidian\\shell\\open\\command", "/ve"],
      { encoding: "utf8", timeout: 2000, windowsHide: true }
    );
    if (!result.error && result.status === 0 && result.stdout) {
      const exe = extractExeFromRegValue(result.stdout);
      if (exe !== null && !candidates.includes(exe)) candidates.push(exe);
    }
  } catch {}
  const local = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Obsidian", "Obsidian.exe")
    : "";
  const pf = process.env.ProgramFiles
    ? join(process.env.ProgramFiles, "Obsidian", "Obsidian.exe")
    : "";
  const pf86 = process.env["ProgramFiles(x86)"]
    ? join(process.env["ProgramFiles(x86)"], "Obsidian", "Obsidian.exe")
    : "";
  for (const p of [local, pf, pf86]) {
    if (p.length > 0 && !candidates.includes(p)) candidates.push(p);
  }
  for (const p of candidates) {
    if (existsSync(p)) {
      obsidianExeCache = p;
      obsidianExeMissAt = 0;
      return p;
    }
  }
  obsidianExeMissAt = Date.now();
  return null;
}

/**
 * Canonicalize a vault path to the exact case Obsidian accepts. Obsidian's
 * vault lookup is case-sensitive: a normalized (lowercased) path in the URI
 * makes it answer "Vault not found". Prefer the exact path string from
 * Obsidian's own registry; fall back to the on-disk canonical case.
 */
function canonicalVaultPath(vaultDir) {
  const norm = normalizePath(vaultDir);
  if (norm === null) return vaultDir;
  for (const v of readObsidianRegistry()) {
    if (normalizePath(v.path) === norm) return v.path;
  }
  try {
    const real = realpathSync(vaultDir);
    if (typeof real === "string" && real.length > 0) return real;
  } catch {}
  return vaultDir;
}

/**
 * Last field of a `tasklist /FO CSV` row — the window title when `/V` is used.
 * Titles contain commas (and sometimes quotes), so this parses from the RIGHT
 * instead of splitting the whole line.
 */
function lastCsvField(line) {
  const trimmed = line.replace(/\s+$/, "");
  if (!trimmed.endsWith('"')) return "";
  const end = trimmed.length - 1;
  const sep = trimmed.lastIndexOf('","', end - 1);
  const raw = trimmed.slice(sep === -1 ? 0 : sep + 3, end);
  return raw.replace(/^"+/, "").trim();
}

/**
 * Async, non-blocking probe of a running Obsidian and every window it owns.
 * Reports `running` plus the readable window titles (`titles: null` = no window
 * information at all, i.e. the enumeration failed). Never blocks the event loop.
 *
 * 0.8.0 — this used to shell out to `tasklist /V`. That was WRONG in a way that
 * only shows up once the user has TWO vaults open: tasklist prints only ONE
 * window title per process, so with "alpha" and "beta" open in the same
 * Obsidian process, "beta"'s title was simply invisible, the vault was judged
 * closed, and it got opened (and focus-pulled) again — the user's original
 * complaint, still reproducible after the window-title fix.
 *   Measured 2026-10-08: one pid owned both windows; tasklist listed only
 *   "alpha". The silent-open helper enumerates windows with EnumWindows instead,
 *   which sees both, so it is also the window lister now.
 *
 * tasklist remains the fallback: it still answers "is Obsidian running at all"
 * when the helper binary is missing, and in that case a single title is enough
 * (with one window there is nothing to miss).
 */
function probeObsidian(callback) {
  probeObsidianViaHelper((fromHelper) => {
    if (fromHelper !== null) {
      callback(fromHelper);
      return;
    }
    probeObsidianViaTasklist(callback);
  });
}

/** The helper's `list` mode: every visible Obsidian window, one per line. */
function probeObsidianViaHelper(callback) {
  if (PROBE_DISABLE_HELPER) {
    callback(null);
    return;
  }
  const helper = silentOpenHelperPath();
  if (!existsSync(helper)) {
    callback(null);
    return;
  }
  const outFile = join(
    DSH_HOME_DIR,
    "storages",
    "dsh-open-obsidian-windows.txt"
  );
  let child;
  try {
    child = spawn(helper, ["list", outFile], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    callback(null);
    return;
  }
  child.on("error", () => callback(null));
  child.on("close", (code) => {
    if (code !== 0) {
      callback(null);
      return;
    }
    let text = "";
    try {
      text = readFileSync(outFile, "utf8");
    } catch {
      callback(null);
      return;
    }
    const titles = [];
    let processes = 0;
    let failed = false;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("#proc ")) {
        processes += 1;
        continue;
      }
      if (line.startsWith("#error")) {
        failed = true;
        continue;
      }
      const tab = line.indexOf("\t");
      if (tab <= 0) continue;
      processes += 1;
      const title = line.slice(tab + 1).trim();
      if (title.length > 0 && !titles.includes(title)) titles.push(title);
    }
    if (failed) {
      callback(null);
      return;
    }
    callback({
      running: processes > 0,
      // Obsidian up but showing no window of its own: no title evidence either
      // way, which is what `null` means to isVaultReallyOpen.
      titles: titles.length > 0 ? titles : null,
      via: "helper",
    });
  });
}

/** Fallback probe: one `tasklist` spawn. Sees at most one title per process. */
function probeObsidianViaTasklist(callback) {
  let child;
  try {
    child = spawn(
      "tasklist",
      ["/FI", "IMAGENAME eq Obsidian.exe", "/NH", "/FO", "CSV", "/V"],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch {
    callback({ running: false, titles: null });
    return;
  }
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.on("error", () => callback({ running: false, titles: null }));
  child.on("close", () => {
    const rows = output
      .split(/\r?\n/)
      .filter((line) => /^"Obsidian\.exe"/i.test(line));
    if (rows.length === 0) {
      callback({ running: false, titles: null });
      return;
    }
    const titles = [];
    for (const row of rows) {
      const title = lastCsvField(row);
      if (title.length > 0 && title !== "N/A" && !titles.includes(title)) {
        titles.push(title);
      }
    }
    callback({ running: true, titles: titles.length > 0 ? titles : null });
  });
}

/** The vault's folder name — the name Obsidian puts in a window title. */
function vaultFolderName(vaultDir) {
  const folder = String(vaultDir)
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop();
  return typeof folder === "string" && folder.length > 0 ? folder : null;
}

/**
 * Obsidian's own tail on every window title: " - Obsidian <version>". The
 * version part arrived with Obsidian 1.13; older builds ended at " - Obsidian".
 *
 * 0.8.0 — THE bug this plugin had carried since 1.13 landed. The comparison
 * below was written when a title really was "<note> - <vault>" or "<vault>",
 * so "AGENTS - beta - Obsidian 1.14.4" matched NOTHING. A vault that was open
 * on screen was judged closed, the session trigger launched it again, and the
 * window the user was reading got yanked to the front — the "已经开着还再弹
 * 一次" complaint. The same misjudgement made the settings panel show a wrong
 * "打开中" tag and made a vault that WAS up look untouched.
 */
const OBSIDIAN_TITLE_SUFFIX = /\s+-\s+obsidian(?:\s+v?\d[\w.\-]*)?$/i;

/** One window title with Obsidian's own " - Obsidian <version>" tail removed. */
function stripObsidianTitleSuffix(title) {
  return title.trim().replace(OBSIDIAN_TITLE_SUFFIX, "").trim();
}

/**
 * Whether ONE window title shows `folder` (a vault folder name): the title is
 * the vault name alone, or "<something> - <vault name>". Same suffix rule the
 * title-list matcher uses, just for a single window — the silent-open watchdog
 * needs to decide about one window at a time.
 */
function titleShowsVault(title, folder) {
  const needle = folder.toLowerCase();
  const t = stripObsidianTitleSuffix(String(title)).toLowerCase();
  return t === needle || t.endsWith(" - " + needle);
}

/**
 * Whether Obsidian's own window titles prove that `vaultDir` is the vault on
 * screen. Obsidian titles a vault window "<note name> - <vault name>", or just
 * the vault name when no note is open — plus the " - Obsidian <version>" tail
 * that is stripped first. The match is deliberately a SUFFIX (not a
 * substring): a note merely NAMED like another vault — "beta" open inside the
 * "alpha" vault titles the window "beta - alpha" — must not be mistaken for
 * that vault being open. Returns null when there is no title information to
 * judge by.
 */
function titlesShowVault(titles, vaultDir) {
  if (titles === null) return null;
  const folder = vaultFolderName(vaultDir);
  if (folder === null) return null;
  const needle = folder.toLowerCase();
  return titles.some((title) => {
    const t = stripObsidianTitleSuffix(title).toLowerCase();
    return t === needle || t.endsWith(" - " + needle);
  });
}

/**
 * Whether the target vault is REALLY open right now.
 *
 * Obsidian's registry (`%APPDATA%/obsidian/obsidian.json`) keeps `open: true`
 * after an unclean exit, so a running Obsidian showing a DIFFERENT vault can
 * still carry a stale flag for this one. Trusting that flag alone both showed
 * a permanent "打开中" in the settings panel and made the plugin skip a vault
 * it should have opened. The flag is therefore accepted only while Obsidian's
 * window titles agree; when no title is readable, the flag decides as before.
 *
 * Note the asymmetry: a wrong "open" verdict costs the user a vault that never
 * opens, while a wrong "closed" verdict only re-focuses a window that is
 * already up — so when in doubt, launch.
 */
function isVaultReallyOpen(probe, vaultDir) {
  if (!probe.running) return false;
  if (!isVaultOpen(vaultDir)) return false;
  const shown = titlesShowVault(probe.titles, vaultDir);
  return shown === null ? true : shown;
}

/** True when the socket peer is a loopback address. */
function isLoopback(address) {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

/** Read a JSON request body (bounded). */
function readJsonBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        resolve(text.length === 0 ? {} : JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/**
 * ── Write lock ────────────────────────────────────────────────────────────
 *
 * Purpose: allow only ONE top-level conversation to write a given Obsidian
 * vault at a time.
 *
 * Why: a vault synced by a file-sync client (Nutstore, Dropbox, …) can lose
 * data when two writers touch it at once — the client merges the two versions
 * by splicing their contents, which shows up as duplicated blocks, two
 * headings glued into one, or counts concatenated into nonsense. Full
 * prevention means "never write concurrently"; that is what this module does.
 *
 * Design notes (every one of these is a deliberate trade-off):
 *
 *   1. The lock is held for a TURN, not for a single file write.
 *      A conversation writes many times within one turn (create a note,
 *      update an index, commit). Releasing after each file write would let
 *      two conversations interleave inside the same turn, which is worse.
 *      So: acquire on turn/start, release on turn/end.
 *
 *   2. Who writes is decided by the lock; the gate is what makes it stick.
 *      Arrival order across sessions is not observable — each conversation only
 *      sees the current lock state, so two sessions checking at the same moment
 *      both believe they arrived first. Instead: whoever holds it keeps it, and
 *      a conversation that actually tries to write is refused at that moment
 *      (see note 4) and only then queued. The next holder is the one that
 *      waited longest among those that genuinely wanted to write.
 *
 *   3. Only top-level conversations participate, never subagents.
 *      A subagent is part of its parent conversation's turn, so treating it
 *      as a separate competitor would let a conversation block its own
 *      helper.
 *
 *   4. Enforced at the tool call, not asked for.
 *      Since 0.12.0 the lock also exposes a `tools/pre-execute` gate that
 *      returns `{ kind: 'deny', reason }` for a non-holder's write into a
 *      locked vault. The tool never runs, so no bytes are written; the caller
 *      sees an ordinary tool error. An advisory message alone proved too weak
 *      — a conversation that never reads its inbox mid-turn kept writing.
 *      The gate fails OPEN on anything it cannot parse (unknown tool, missing
 *      path, internal error): a missed write only loses a guard, while a
 *      wrongly refused call stalls real work.
 *
 *   5. It must self-heal.
 *      If the holder disappears, or a turn hangs past the staleness window,
 *      the lock has to be reclaimable — otherwise one dead conversation
 *      locks the vault forever.
 */

/** A lock older than this is treated as abandoned (holder likely gone). */
const WRITE_LOCK_STALE_MS = 30 * 60_000;

/** After a release, wait this long before waking the next writer — gives the
 *  previous holder time to finish committing and the sync client time to settle. */
const WRITE_LOCK_HANDOFF_DELAY_MS = 3_000;

/** Producer tag stamped into the message source. Never impersonate `user`. */
const WRITE_LOCK_SOURCE = "open-obsidian-writelock";

/**
 * A session id shortened for display in notices and logs.
 *
 * ⚠️ Every session id starts with `session-`, so slicing from index 0 yields
 * exactly that 8-character prefix and nothing else — a notice then reads
 * "another conversation is writing (session-)" and names nobody. Strip the
 * prefix BEFORE shortening. (Observed in a live host: both notices, and the
 * gate's own error text, all showed a bare "session-".)
 */
function shortSessionId(id) {
  const bare = typeof id === "string" && id.startsWith("session-")
    ? id.slice("session-".length)
    : String(id ?? "");
  return bare.length > 8 ? bare.slice(0, 8) : bare;
}

/**
 * Build a COMPLETE, well-formed user-role message.
 *
 * ⚠️ Never hand a bare string to followup(): the inbox's mutate() does not
 * type-check what it inserts (it only looks for a duplicate message.id, and a
 * string's .id is undefined), so a string gets appended verbatim and the UI
 * then reads a message object with no id/content — that is what broke two
 * session logs and blanked the session list. Fill in every field:
 *   id      — randomUUID (same as the official createUserMessage)
 *   role    — always 'user' (the user-role slot is separate from *who* spoke)
 *   content — must be an array of { type:'text', text }
 *   source  — our own stamp; **never kind:'user'**, which is how DSH decides
 *             "a human said this" (goal completion requires real human input),
 *             so claiming it would inherit authority the plugin does not have.
 *
 * Same shape as dsh-self-restart's makeWakeMessage, which is proven in use.
 *
 * @param {string} text message body (caller guarantees non-empty)
 * @returns {object} a message object safe to insert (deep-frozen)
 */
function makeLockMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text: String(text ?? "") }],
    source: {
      kind: WRITE_LOCK_SOURCE,
      producer: name,
    },
  });
}

/** Recursively freeze (the official createUserMessage deep-freezes too; an
 *  inserted message should be read-only afterwards). */
function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

/**
 * Deliver one message into a session — the only place this feature writes
 * into a conversation.
 *
 * Order (same as the official dsh-schedule reminder delivery and
 * dsh-self-restart's wake-up):
 *   ① sessionController.resolveAgent(sessionId) — locate and activate it
 *   ② agent.followup(message) / agent.steer(message) — into its inbox;
 *      **delivered from this line on**
 *   ③ sessions.flush(agent.session) — confirm it reached disk (affects the log
 *      wording only)
 *
 * ⚠️ 通道选择（2026-10-16 加）：`followup` 进 next-turn，对方要**等这一轮跑完**
 *    才读到；`steer` 进 next-step，对方**下一步就读到**。写锁的「轮到你了」
 *    必须走 steer —— 实测（2026-10-16 16:42 那条）走 followup 的通知排了
 *    19 分钟才被读到，内容早已不成立。没有 steer 的旧宿主/测试替身退回
 *    followup：宁可慢，也不要把消息丢掉。
 *
 * ⚠️ Error semantics: throws only while the message has NOT reached the inbox
 *    (steps ①②). Once delivery succeeds it returns normally even when flush
 *    gives no receipt — retrying at that point would deliver a duplicate
 *    instruction to the same session, which is worse than not delivering.
 *
 * @param {string} mode 'steer' = next-step (preferred), anything else = followup
 * @returns {Promise<{ok:boolean, detail:string, messageId:string|null,
 *          agent:object|null}>} never throws; failures are reported in the
 *          return value. `messageId` + `agent` are only for retraction review.
 */
async function deliverToSession(services, sessionId, text, mode = "steer") {
  const { sessionController, sessions } = services;
  if (!sessionController || typeof sessionController.resolveAgent !== "function") {
    return { ok: false, detail: "sessionController unavailable", messageId: null, agent: null };
  }
  let agent;
  try {
    const resolved = await sessionController.resolveAgent(sessionId);
    agent =
      resolved && typeof resolved.followup === "function"
        ? resolved
        : (resolved?.agent ?? null);
  } catch (error) {
    return {
      ok: false,
      detail: `resolveAgent failed: ${String(error?.message ?? error).slice(0, 120)}`,
      messageId: null,
      agent: null,
    };
  }
  if (!agent || typeof agent.followup !== "function") {
    return {
      ok: false,
      detail: "resolveAgent returned no usable agent",
      messageId: null,
      agent: null,
    };
  }
  const message = makeLockMessage(text);
  if (
    !message.id ||
    message.role !== "user" ||
    !Array.isArray(message.content) ||
    message.content.length === 0
  ) {
    return {
      ok: false,
      detail: "refusing to deliver a malformed message",
      messageId: null,
      agent: null,
    };
  }
  // 通道：优先 steer（next-step，下一步读到）；宿主没有 steer 就退回 followup。
  const channel =
    mode === "steer" && typeof agent.steer === "function" ? "steer" : "followup";
  try {
    if (channel === "steer") agent.steer(message);
    else agent.followup(message);
  } catch (error) {
    return {
      ok: false,
      detail: `${channel} failed: ${String(error?.message ?? error).slice(0, 120)}`,
      messageId: null,
      agent: null,
    };
  }
  // It is in the inbox now. A missing flush receipt only changes the wording —
  // never re-deliver from here.
  if (sessions && typeof sessions.flush === "function") {
    try {
      const ok = await sessions.flush(agent.session);
      if (!ok) {
        return {
          ok: true,
          detail: `delivered via ${channel} (no flush receipt)`,
          messageId: message.id,
          agent,
        };
      }
    } catch (error) {
      return {
        ok: true,
        detail: `delivered via ${channel} (flush threw: ${String(error?.message ?? error).slice(0, 80)})`,
        messageId: message.id,
        agent,
      };
    }
  }
  return {
    ok: true,
    detail: `delivered via ${channel} and confirmed on disk`,
    messageId: message.id,
    agent,
  };
}

/**
 * 撤回一条**还没被领走**的通知（2026-10-16 加）。
 *
 * 用 `agent.inbox.remove(messageId)`，它内部走的是官方 `Inbox.remove`：
 *   - 找不到该 id（已被领走 / 已消费）→ 返回 false，**无副作用**；
 *   - 找不到（消息已经被领进本轮）→ 返回 false。
 * 所以这里只做一件事：**尝试**删；删不掉就当没这回事，绝不补偿、绝不重发。
 *
 * ⚠️ 为什么需要它（用户 2026-10-16 的原话："提示还没生效、但锁已经转移回来了
 *    可以继续写了，能不能把那条插进去的撤掉"）：
 *     通知投出去到目标**真正读到**之间总有延迟（steer 是下一步，仍不是瞬时）。
 *     这期间持有者可能已经放锁、甚至目标自己已经重新拿到锁 —— 那条"你被拦了、
 *     请重做"的通知就变成了假消息，读到它反而会误导对方重复写一遍。
 *     所以交接成功时，连同这条通知一起撤掉。
 *
 * ⚠️ 边界（必须知道，别把它当保证）：这是**尽力而为**的撤回，不是"一定撤回"：
 *    - 消息已经进模型上下文（对方正在读）→ 撤不掉，也没有"撤回"语义；
 *    - 走 followup 通道的旧宿主 → 排在 next-turn，能撤，但对方可能已经读了；
 *    - 撤回**只影响收件箱**，一旦被领取成为会话账本里的一条就不可改（官方
 *      `updateQueue` 同样只对"still-pending"有效）。
 *   ⇒ 因此通知文案本身必须**自证过时**（见 goAheadText 的"先核对再动手"），
 *     撤回只是第二道防线。
 *
 * @returns {boolean} 是否真的删掉了（false = 已被领走/本来就没有）
 */
function retractQueuedNotice(agent, messageId) {
  if (!agent || typeof agent.inbox?.remove !== "function") return false;
  if (typeof messageId !== "string" || messageId.length === 0) return false;
  try {
    return agent.inbox.remove(messageId) === true;
  } catch {
    return false;
  }
}

/**
 * Distinctive headers for the two notices, so "wait" and "go ahead" can never
 * be confused. Also used for exact matching in tests and logs — do NOT match on
 * body wording: the "wait" notice itself contains the phrase used by the "go"
 * notice, so body matching hits both (learned the hard way).
 */
const WRITE_LOCK_WAIT_TAG = "【写锁·等你让位】";
const WRITE_LOCK_GO_TAG = "【写锁·轮到你了】";

/**
 * Tools that can modify a file, and how to find out what they touch.
 *
 * `write` / `edit` carry the target in `arguments.file_path`. Shell tools do
 * not, so the command text itself has to be inspected — see
 * `shellWriteTargetsVault`, which is deliberately conservative in the other
 * direction: a shell command only counts as a write when BOTH a vault path
 * appears AND a write-ish operator/keyword appears.
 */
const FILE_WRITE_TOOLS = new Set(["write", "edit"]);
const SHELL_TOOLS = new Set(["bash", "pwsh", "powershell", "sh", "shell", "cmd"]);

/**
 * Shell operators / commands that can create or modify files. Kept narrow on
 * purpose: a false positive blocks legitimate work, which is worse than
 * letting a rare exotic write through (the lock still logs it).
 *
 * ⚠️ Do NOT list multi-word git subcommands here (e.g. "git commit"). A shell
 * command routinely separates them — `git -C "<vault>" commit -m x` is the
 * normal form — so a joined literal never matches. Git write subcommands are
 * matched separately by GIT_WRITE_SUBCOMMANDS below. This was a real bug: the
 * `git commit` case silently passed the gate.
 */
const SHELL_WRITE_MARKERS = [
  ">",
  ">>",
  "rm ",
  "rmdir",
  "del ",
  "erase ",
  "mv ",
  "move ",
  "cp ",
  "copy ",
  "rename",
  "sed -i",
  "tee ",
  "touch ",
  "mkdir",
  "new-item",
  "set-content",
  "add-content",
  "out-file",
  "remove-item",
];

/**
 * Git subcommands that change the working tree, the index, or history. Matched
 * as a WORD anywhere in a command that also mentions the vault, so both
 * `git commit` and `git -C "<vault>" commit` are caught.
 */
const GIT_WRITE_SUBCOMMANDS = [
  "add",
  "am",
  "apply",
  "checkout",
  "cherry-pick",
  "clean",
  "commit",
  "config",
  "filter-branch",
  "merge",
  "mv",
  "pull",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
  "update-index",
];

/** True when the command runs a git write subcommand. */
function looksLikeGitWrite(command) {
  if (!/\bgit\b/.test(command)) return false;
  return GIT_WRITE_SUBCOMMANDS.some((sub) =>
    new RegExp(`\\bgit\\b[^\\n;|&]*\\b${sub}\\b`).test(command)
  );
}

/** Does this filesystem path point at (or inside) the given vault root? */
function pathInsideVault(candidate, vaultRoot) {
  const c = collapseDotSegments(normalizePath(candidate));
  const v = collapseDotSegments(normalizePath(vaultRoot));
  if (c === null || v === null) return false;
  if (c === v) return true;
  return c.startsWith(v.endsWith("\\") ? v : v + "\\");
}

/**
 * Is this a relative path (no drive letter, no leading slash)?
 *
 * ⚠️ This distinction is the difference between the gate working and not
 * working at all. Tool calls routinely carry RELATIVE paths — the agent's cwd
 * is the vault, so it writes `10-知识/x.md`, not the full path. An earlier
 * version of this gate only accepted paths that contained the absolute vault
 * root, so every relative write slipped through: observed live as a
 * conversation writing and committing into a vault another session held the
 * lock on, with no `gate BLOCKED` line at all.
 */
function isRelativePath(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  if (/^[a-zA-Z]:[\\/]/.test(candidate)) return false; // C:\… or C:/…
  if (candidate.startsWith("\\\\")) return false; // UNC \\server\share
  if (candidate.startsWith("/") || candidate.startsWith("\\")) return false;
  return true;
}

/**
 * Collapse `.` and `..` segments in a normalised path.
 *
 * ⚠️ Required, not cosmetic: `pathInsideVault` is a prefix test, so a path like
 * `<vault>\..\elsewhere.md` still STARTS WITH the vault path and would be
 * reported as inside it. Without this step `..` both hides real writes and
 * catches innocent ones. Windows paths are compared case-insensitively, so this
 * runs on the already-normalised (lower-cased, backslash) form.
 */
function collapseDotSegments(normalized) {
  if (typeof normalized !== "string" || normalized.length === 0) return normalized;
  const isUnc = normalized.startsWith("\\\\");
  const parts = normalized.split("\\");
  const out = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      // Never climb past the root / drive letter.
      if (out.length > 0 && !/^[a-z]:$/.test(out[out.length - 1])) out.pop();
      continue;
    }
    out.push(part);
  }
  const joined = out.join("\\");
  return isUnc ? "\\\\" + joined : joined;
}

/** Join a possibly-relative path onto a base directory, then normalise. */
function resolveAgainst(base, candidate) {
  const raw = String(candidate ?? "");
  if (!isRelativePath(raw)) return collapseDotSegments(normalizePath(raw));
  const sep = "\\";
  const joined = base.replace(/[\\/]+$/, "") + sep + raw;
  return collapseDotSegments(normalizePath(joined));
}

/**
 * Decide whether one tool call would write inside `vaultRoot`.
 *
 * `cwd` is the calling session's working directory; it is what makes RELATIVE
 * paths resolvable. It must be treated as authoritative for a relative path
 * pair: a relative path resolved outside the vault is somebody else's business.
 *
 * Returns the matched path/command for logging, or null when the call is not a
 * write into this vault. Never throws: an unparseable call is treated as "not
 * a write" (fail open — the lock must never block work it cannot understand).
 */
function writeTargetInVault(exec, vaultRoot, cwd) {
  const name = typeof exec?.name === "string" ? exec.name : "";
  const args = exec?.arguments;
  if (args === null || typeof args !== "object") return null;
  const base = typeof cwd === "string" && cwd.length > 0 ? cwd : vaultRoot;

  if (FILE_WRITE_TOOLS.has(name)) {
    const target = args.file_path ?? args.path;
    if (typeof target !== "string" || target.length === 0) return null;
    // Resolve relative to the session cwd (the vault, in practice); keep the
    // original text for the notice, since that is what the caller recognises.
    const absolute = resolveAgainst(base, target);
    if (absolute !== null && pathInsideVault(absolute, vaultRoot)) return target;
    return null;
  }

  if (SHELL_TOOLS.has(name)) {
    const command = args.command ?? args.script ?? args.cmd;
    if (typeof command !== "string" || command.length === 0) return null;
    const lower = command.toLowerCase();
    const vaultKey = normalizePath(vaultRoot);
    if (vaultKey === null) return null;
    const vaultSlash = vaultKey.replace(/\\/g, "/");
    const mentionsVault = lower.includes(vaultKey) || lower.includes(vaultSlash);

    // Does the command name some OTHER absolute path? If it does and the vault
    // is not among them, it is working elsewhere — e.g. writing a file in a
    // sibling folder while its cwd happens to be the vault. Blocking that would
    // be over-reach, so it passes.
    //
    // Rationale for the asymmetry: a MISSED write only loses a guard (the lock
    // still logs it), while a wrongly refused command stalls real work. So the
    // gate resolves ambiguity in favour of letting the call through.
    const namedPaths = command.match(/[a-zA-Z]:[\\/][^\s"';|&)>]*/g) ?? [];
    const namesOtherAbsolute =
      namedPaths.length > 0 &&
      !namedPaths.some((p) => pathInsideVault(p, vaultRoot));

    const cwdKey = normalizePath(base);
    const runsInsideVault = cwdKey !== null && pathInsideVault(cwdKey, vaultRoot);
    // A shell command can write into the vault WITHOUT naming it: git runs in
    // the session cwd, so a plain `git add -A; git commit` writes vault files
    // while the text never mentions a path. That is only inferred when the
    // command names no absolute path of its own.
    const inferredFromCwd = runsInsideVault && !namesOtherAbsolute && namedPaths.length === 0;

    if (!mentionsVault && !inferredFromCwd) return null;
    // ...and must look like it writes. Reads (cat/type/git log/search) pass.
    const byMarker = SHELL_WRITE_MARKERS.some((marker) => lower.includes(marker));
    if (!byMarker && !looksLikeGitWrite(lower)) return null;
    if (!mentionsVault && namesOtherAbsolute) return null;
    return command.slice(0, 200);
  }

  return null;
}

/**
 * A SHORT human-readable description of what the refused call was trying to
 * do, for the notice and the log.
 *
 * For `write`/`edit` that is the file path. For a shell command it is NOT the
 * command text: a real call carries the whole script (a test run against the
 * live host produced a 200-character dump of a multi-line pwsh script, which is
 * both unreadable and, in a log line, unparseable). Report only the first
 * sensible line, and make clear it is a shell command.
 */
function summarizeTarget(exec, target) {
  const name = typeof exec?.name === "string" ? exec.name : "";
  const raw = String(target ?? "").replace(/\s+/g, " ").trim();
  if (raw.length === 0) return "（写文件）";
  if (!SHELL_TOOLS.has(name)) {
    // A path — show its last two segments, which is what identifies it.
    const parts = raw.split(/[\\/]+/).filter((p) => p.length > 0);
    const tail = parts.slice(-2).join("/");
    return tail.length > 0 ? tail : raw.slice(0, 80);
  }
  // A shell command — one line, capped, marked as shell so nobody reads it as
  // the file being written.
  const firstLine = raw.split(/[\r\n]/)[0] ?? "";
  const shown = firstLine.length > 60 ? firstLine.slice(0, 60) + "…" : firstLine;
  return `shell 命令 ${shown}`;
}

/**
 * The text a blocked caller receives. Delivered through the ordinary tool-error
 * channel, so it appears to the model as `Error: <this text>` and the tool
 * never runs.
 *
 * Two things this text must accomplish, because a blocked conversation may be
 * mid-turn and has no other way to learn them:
 *   1. say that NOTHING was written (otherwise the caller may believe a partial
 *      write happened and try to "fix" it);
 *   2. say what to do next — stop this turn, wait for the go-ahead notice.
 */
function writeBlockedReason(holderLabel, target) {
  return (
    WRITE_LOCK_WAIT_TAG +
    " 这次写入已被阻止（**没有写入任何内容**）。\n\n" +
    "另一个对话正在写这个库" +
    (holderLabel ? `（${holderLabel}）` : "") +
    "，现在轮不到你。被阻止的操作：" +
    (typeof target === "string" && target.length > 0 ? target : "（写文件）") +
    "\n\n请这样做：\n" +
    "1. **不要再重试这次写入**，也不要换个工具绕过去（那样还会被拦）\n" +
    "2. 把你想做的事写在回复里（否则下一轮会忘）\n" +
    "3. **结束这一轮**；等收到抬头为「" +
    WRITE_LOCK_GO_TAG +
    "」的消息后再继续\n\n" +
    "如果你已经写了一半：停下即可，**不要回滚**。\n" +
    "（这个库若由网盘同步，两个对话同时写会被拼坏——所以这是硬性阻止，不是提醒。）"
  );
}

/**
 * Body sent to the next writer once the lock frees up.
 *
 * ⚠️ This message must NOT read as an approval or a confirmation. Three
 * misreadings to rule out explicitly, because this arrives as an ordinary user
 * message and the model has no other context to correct them:
 *   1. "my blocked write went through / was approved" — it did NOT run at all;
 *   2. "I already did this work" — the blocked call did not run, so it must redo it;
 *   3. ⚠️ **"I was blocked at all"** — added 2026-10-16, and it is the one that
 *      actually bit us. The hand-off can arrive AFTER the target already wrote
 *      successfully: the target was handed the lock, its write went through, and
 *      only then did it read a notice telling it to redo work that is already on
 *      disk. Writing it again is exactly the duplication this vault must avoid.
 *      So the notice now orders the reader to VERIFY FIRST (git status / git log
 *      / mtime) and forbids redoing anything already committed.
 *
 * (The delivery is best-effort retracted when the lock changes hands again before
 *  the notice is claimed — see retractPendingNotice — but a retraction cannot be
 *  guaranteed, so the text itself has to carry the check.)
 */
function goAheadText() {
  return (
    WRITE_LOCK_GO_TAG +
    " · 来自 dsh-open-obsidian 插件，不是使用者发的\n\n" +
    "**这不是「批准」或「授权」，只是排队轮到你了。**\n" +
    "这个库现在没有别人在写。\n\n" +
    "⚠️ **动手前必须先核对（这一步不能省）**：这条通知是排队时发出的，到你读到时" +
    "可能已经过时 —— 你可能**根本没被拦过**，或者那件活你**早就做完了**。\n" +
    "先看一眼：`git status` + `git log --oneline -2`。\n" +
    "- **工作区干净、你打算做的事已经在盘上/已在提交里 → 不要重做**，" +
    "结束这一轮即可（照字面重做一遍＝把同一批内容写第二遍，正是本库最怕的并发重复写入）。\n" +
    "- **确实有改动没落盘、或你上一次真的没写进去 → 才重新执行**：\n" +
    "  1. 回头看你自己上一轮的回复，找到当时被拦下、没能完成的那件事\n" +
    "  2. **重新执行**它（被拦下的那次工具调用没有生效，不是只差最后一步）\n" +
    "  3. 若你已经忘了要做什么，就以你上一轮回复里写下的打算为准\n\n" +
    "（佐证可查 `~\\.dsh\\logs\\dsh-open-obsidian\\decisions.log`：搜你自己的 session 短号，" +
    "有 `gate BLOCKED` 才是真被拦；只有 `queued / handoff / release / acquire` 就是没被拦。）"
  );
}

function apply(ctx, config) {
  /** Session ids already decided (opened or skipped) — one decision per session. */
  const launched = new Set();
  /** sessionId -> { root, cwd } | null : vault resolution cache (settings-free). */
  const sessionVault = new Map();
  /** normalized vault root -> { at, cwd }: last AGENT activity in that vault. */
  const vaultActivity = new Map();
  /** fs.FSWatcher per enabled vault root (normalized path -> watcher). */
  const watchers = new Map();
  /** Write-time ensure state. */
  let lastEnsureCheckAt = 0;
  let lastEnsureLaunchAt = 0;
  let lastCheckRunning = false;
  let lastIdleSkipLogAt = 0;
  /** PID of the Obsidian main process we spawned last (0 = unknown/other launch path). */
  let lastSpawnedPid = 0;
  /** Set once the plugin fiber is disposed: stops boot work and watcher callbacks. */
  let disposed = false;

  /**
   * 写锁状态：normalized 库根 -> WriteLockEntry。见文件上方「写锁」总说明。
   * 只在 turn/start、turn/end、session/disposed 时被动，不逐条消息更新 ——
   * 因此开销恒定，与消息条数无关。
   */
  const writeLocks = new Map();

  /** sessionController / sessions 服务句柄（比插件晚就位，动态注入）。 */
  const services = { sessionController: null, sessions: null };

  /** 交接定时器（放锁后延迟叫醒下一个），dispose 时要清掉。 */
  let handoffTimer = null;

  /** 取（或建）一个库的锁状态。 */
  function lockOf(vaultKey) {
    let entry = writeLocks.get(vaultKey);
    if (entry === undefined) {
      entry = {
        holder: null,
        since: 0,
        waiters: [],
        passTo: null,
        passAt: 0,
        // 持有者的显示名。存这里是为了让闸门能报出"是谁在写"——闸门手上
        // 只有调用方的 agent，拿不到持有者的 session，没法现算。
        holderLabel: null,
        // 已投出、尚未被领取的「轮到你了」通知：{ target, messageId, agent, at }。
        // 它的作用只有一个 —— 让交接失效时能把这条还没生效的提示**撤回**
        // （2026-10-16 加）。null 表示没有待撤回的通知。
        // 见 retractPendingNotice / retractQueuedNotice。
        notice: null,
      };
      writeLocks.set(vaultKey, entry);
    }
    return entry;
  }

  /**
   * 撤回"该会话手上那条还没被领取的「轮到你了」通知"。
   *
   * ⚠️ 只在**交接已经失效**时调用（放锁往下传、或被他人接管）。因为撤回意味着
   *    那条"现在轮到你写、去重做被拦下的事"不再成立；若在仍然成立时撤回，
   *    持有者就会拿着锁却不知道自己可以写，库会被锁到 30 分钟 stale 超时才放。
   */
  function retractPendingNotice(vaultKey, entry, reason) {
    const notice = entry.notice;
    if (!notice) return;
    entry.notice = null;
    const removed = retractQueuedNotice(notice.agent, notice.messageId);
    record(
      `writelock vault=${vaultKey} notice-retracted target=${notice.target} reason=${reason} removed=${removed}`
    );
  }

  /**
   * 持有者是否仍然有效。超过 WRITE_LOCK_STALE_MS 即视为失效——防一轮卡死
   * 把整个库锁死（宁可偶尔放过，也不要把库永久锁上）。
   */
  function holderAlive(entry) {
    if (entry.holder === null) return false;
    return Date.now() - entry.since <= WRITE_LOCK_STALE_MS;
  }

  /**
   * 尝试让 `sessionId` 取得 `vaultKey` 的写锁。
   * @returns {{granted:boolean, holder:string|null}}
   */
  function tryAcquire(vaultKey, sessionId, label) {
    const entry = lockOf(vaultKey);
    if (entry.holder === sessionId) return { granted: true, holder: sessionId };
    if (holderAlive(entry)) return { granted: false, holder: entry.holder };

    const inherited = entry.holder;
    // 抢到锁就说明**上一条还没被领取的通知已经失效**（原持有者或 stale 持有者
    // 那条"轮到你了"不再成立）——先撤回，再接管。见 retractPendingNotice。
    retractPendingNotice(vaultKey, entry, "taken-over");
    entry.holder = sessionId;
    entry.holderLabel = label ?? shortSessionId(sessionId);
    entry.since = Date.now();
    entry.passTo = null;
    entry.passAt = 0;
    entry.waiters = entry.waiters.filter((w) => w.id !== sessionId);
    if (inherited !== null) {
      record(
        `writelock vault=${vaultKey} took-over from=${inherited} by=${sessionId} reason=stale`
      );
    } else {
      record(
        `writelock vault=${vaultKey} acquire by=${sessionId}` +
          (label ? ` label=${label}` : "")
      );
    }
    return { granted: true, holder: sessionId };
  }

  /**
   * 释放 `sessionId` 持有的锁，并把下一个记进 passTo（延迟叫醒）。
   * 非持有者调用时无副作用。返回被交接给谁（null = 队列为空）。
   */
  function releaseLock(vaultKey, sessionId) {
    const entry = lockOf(vaultKey);
    if (entry.holder !== sessionId) return null;
    // 放锁 = 那条"轮到你了"对**本人**已经用不上了（他这一轮已经结束）。
    // 若它还没被领取，撤回它：否则这个人下一轮开头会读到一条"现在轮到你写"
    // 的陈旧通知，而那时锁早已交给别人。见 retractPendingNotice。
    retractPendingNotice(vaultKey, entry, "released");
    entry.holder = null;
    entry.holderLabel = null;
    entry.since = 0;
    // ⚠️ 这里**只 peek、不 shift**：交接是"延迟叫醒"，真正通知出去之前
    //    目标必须还留在队列里。第一版用了 shift()，于是 scheduleHandoff 的
    //    tick 去队列里核对目标时找不到它，误判成"已离开"直接跳过 ——
    //    表现就是"等待提示发了、放行提示永远不来"。
    //    移除由 tick 在投递成功/失败后负责（dequeueWaiter）。
    const next = entry.waiters[0] ?? null;
    if (next === null) {
      entry.passTo = null;
      entry.passAt = 0;
      record(`writelock vault=${vaultKey} release by=${sessionId} queue=empty`);
      return null;
    }
    entry.passTo = next.id;
    entry.passAt = Date.now() + WRITE_LOCK_HANDOFF_DELAY_MS;
    record(
      `writelock vault=${vaultKey} release by=${sessionId} handoff-to=${next.id} in=${WRITE_LOCK_HANDOFF_DELAY_MS}ms`
    );
    return next.id;
  }

  /**
   * 排进等待队列（已在则只更新时间）。返回位次（1 = 下一个）。
   *
   * `label` 记在队列项上：交接时目标会成为新的持有者，而闸门要报"是谁在写"；
   * 闸门手上只有调用方的 agent，拿不到持有者的 session，所以名字得在这时存下。
   */
  function enqueueWaiter(vaultKey, sessionId, label) {
    const entry = lockOf(vaultKey);
    const existing = entry.waiters.find((w) => w.id === sessionId);
    if (existing !== undefined) {
      existing.at = Date.now();
      if (typeof label === "string" && label.length > 0) existing.label = label;
    } else {
      entry.waiters.push({
        id: sessionId,
        at: Date.now(),
        label: typeof label === "string" && label.length > 0
          ? label
          : shortSessionId(sessionId),
      });
    }
    return entry.waiters.findIndex((w) => w.id === sessionId) + 1;
  }

  /** 从等待队列移除（会话结束时用，免得给死会话发消息）。 */
  function dequeueWaiter(vaultKey, sessionId) {
    const entry = lockOf(vaultKey);
    const before = entry.waiters.length;
    entry.waiters = entry.waiters.filter((w) => w.id !== sessionId);
    if (entry.passTo === sessionId) {
      entry.passTo = null;
      entry.passAt = 0;
    }
    return before !== entry.waiters.length;
  }

  /** 会话显示名（日志与提示文案用）。拿不到就退回 id 的短形式。 */
  function sessionLabel(session) {
    const cwd = session?.header?.cwd;
    if (typeof cwd === "string" && cwd.length > 0) {
      const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]+/);
      const tail = parts[parts.length - 1];
      if (typeof tail === "string" && tail.length > 0) return tail;
    }
    return shortSessionId(String(session?.id ?? ""));
  }

  /**
   * 一轮开始：该会话想写这个库，先抢锁。
   *
   * 抢到 → 记一笔，什么都不发（正常路径，零打扰）。
   * 抢不到 → **什么都不做**（2026-10-16 改）：既不排队，也不发消息。
   *
   * ⚠️ 为什么"抢不到"不再排队（这是本轮最要紧的一处修正）：
   *    原来只要开轮没抢到锁就排进等待队列，于是**开一轮（干活）**被当成了
   *    **想写（排队）**。实测踩到（2026-10-16 的一次会话）：它 16:33 开轮，
   *    整轮都在搜资料、读文件、一个字节都没写，却被排进队列；持有者 16:42 放锁
   *    时点名把它叫起来，还投了一条"你之前被拦下了、请重做"的通知 —— 而它
   *    从头到尾**没有被拦过**（决策日志里一条 `gate BLOCKED` 都没有）。
   *    通知又排了一整轮，19 分钟后才被读到，那时它早已自己写完、提交完了。
   *
   *    公平的顺序应当由"谁先真想写"决定，所以排队挪到**闸门真正拒绝它的那一刻**
   *    （见 tools/pre-execute 里的 enqueueWaiter）：那一刻它确实想写、确实被挡了，
   *    它才是真正的等待者。开一轮只是想干活的人，不该占着队列、也不该被叫起来。
   *
   *    代价（故意接受的）：一个人可能开轮很早、但直到几分钟后才第一次尝试写；
   *    那就按他**第一次被拦**的时刻排队。这与"谁先到"略有出入，但比"谁先开轮
   *    谁先写"更贴近真实意图，而且避免了给没想写的人发通知。
   */
  function onTurnStart(session, entry) {
    const settings = effective();
    if (!settings.writeLock) return;
    const vaultKey = normalizePath(entry.root);
    if (vaultKey === null) return;
    const id = String(session?.id ?? "");
    if (id.length === 0) return;

    // 持有者自己开新轮：顺手续期自己的锁（since 只在 turn 边界更新）。
    tryAcquire(vaultKey, id, sessionLabel(session));
  }

  /**
   * 一轮结束：放锁，并把下一个排上（延迟叫醒）。
   *
   * ⚠️ 只有**持有者**的 turn/end 才放锁；等待者的轮次结束不该动锁。
   */
  function onTurnEnd(session, entry) {
    const settings = effective();
    if (!settings.writeLock) return;
    const vaultKey = normalizePath(entry.root);
    if (vaultKey === null) return;
    const id = String(session?.id ?? "");
    if (id.length === 0) return;
    const entryState = lockOf(vaultKey);
    if (entryState.holder !== id) return;
    const next = releaseLock(vaultKey, id);
    if (next !== null) scheduleHandoff(vaultKey);
  }

  /**
   * 延迟叫醒下一个：等 WRITE_LOCK_HANDOFF_DELAY_MS 再发「轮到你了」。
   *
   * 为什么要延迟：持有者刚 turn/end 时，它的提交/落盘可能还在收尾，
   * 立刻让下一个写会撞上（同步客户端也刚在动）。这个延迟是刻意的。
   *
   * ⚠️ 用单一 timer 扫描全部库，且**每次都重新核对状态**（而不是闭包记住
   *    当时的决定）—— 期间可能又有人抢到、或等待者已经关掉。
   */
  function scheduleHandoff(vaultKey) {
    if (handoffTimer !== null) return; // 已有扫描在跑，它会把新状态一起处理
    const tick = () => {
      handoffTimer = null;
      if (disposed) return;
      const now = Date.now();
      let pending = false;
      for (const [key, entryState] of writeLocks) {
        if (entryState.passTo === null) continue;
        if (now < entryState.passAt) {
          pending = true;
          continue;
        }
        const target = entryState.passTo;
        entryState.passTo = null;
        entryState.passAt = 0;
        // 重新核对：这段时间里可能已被别人接管
        if (entryState.holder !== null) {
          record(`writelock vault=${key} handoff-canceled target=${target} reason=taken`);
          continue;
        }
        const waiter = entryState.waiters.find((w) => w.id === target);
        if (waiter === undefined) {
          // 已不在队列（被移除或已自行离开）
          record(`writelock vault=${key} handoff-skip target=${target} reason=gone`);
          continue;
        }
        deliverToSession(services, target, goAheadText(), "steer").then((result) => {
          if (result.ok) {
            // ★ 交接成功 = 目标**即刻成为持有者**，而不是"等它下一轮自己来抢"。
            //   为什么这样定：
            //     ① 队列顺序得到尊重 —— 不然 B 被叫醒后、C 也可能同时来抢，
            //        谁先到谁拿，队列形同虚设；
            //     ② 目标已经在它自己那一轮里被拦过了，它再来时应当直接被放行。
            //   它若一去不回（窗口被关掉），由两处兜底：30 分钟的 stale 超时，
            //   以及 session/disposed 事件（会话销毁即释放）。
            const st = lockOf(key);
            st.waiters = st.waiters.filter((w) => w.id !== target);
            st.holder = target;
            // 等待者的显示名在排队时就记下了，交接后直接沿用（闸门要报"是谁在写"）。
            st.holderLabel = waiter.label ?? shortSessionId(target);
            st.since = Date.now();
            // 记住这条通知"发给了谁、消息 id 是什么"——它是唯一可能被撤回的对象。
            // 走 steer（next-step）：排在下一步，目标通常几秒内就读到；万一它
            // 一直没被领取、而锁又被别人接管/又转手，撤回就能把它抹掉，避免
            // 对方读到一条早已不成立的通知。见 retractPendingNotice。
            st.notice = {
              target,
              messageId: result.messageId,
              agent: result.agent,
              at: Date.now(),
            };
            record(`writelock vault=${key} handoff-done holder=${target} ${result.detail}`);          } else {
            record(`writelock vault=${key} go-notice-FAILED id=${target} ${result.detail}`);
            // 发不出去（会话没了）→ 踢出队列，让后面的人有机会
            dequeueWaiter(key, target);
            const st = lockOf(key);
            if (st.waiters.length > 0) {
              st.passTo = st.waiters[0].id;
              st.passAt = Date.now();
              scheduleHandoff(key);
            }
          }
        });
      }
      if (pending && !disposed) handoffTimer = setTimeout(tick, 1000);
    };
    handoffTimer = setTimeout(tick, WRITE_LOCK_HANDOFF_DELAY_MS);
    if (typeof handoffTimer.unref === "function") handoffTimer.unref();
  }

  /** Record one decision line (also mirrored to the harness console). */
  function record(message) {
    appendDecisionLog("[dsh-open-obsidian] " + message);
  }

  /** Cheap liveness probe: kill(pid, 0) without spawning anything. */
  function isProcessAlive(pid) {
    if (typeof pid !== "number" || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  }

  /**
   * Silent open: push the window this launch creates to the bottom of the Z
   * order — fully visible and clickable, just not in the user's way — and, if
   * Obsidian took the foreground anyway, hand the foreground straight back to
   * whatever the user was working in.
   *
   * Why a separate tiny program (bin/dsh-open-obsidian-silent.exe, 7 KB, built
   * from src/silent-open-helper.cs) instead of doing this in the plugin:
   *   - Windows refuses foreground/Z-order changes coming from a background
   *     process that does not own the window. The helper thread-attaches to the
   *     target thread to get inside that guard. Measured on this machine:
   *     cross-process SetWindowPos is accepted, the foreground is not stolen,
   *     and SetForegroundWindow from the helper does work.
   *   - It has to be WATCHING for the moment the new window appears, and it has
   *     to already be running before Obsidian creates it — otherwise the window
   *     is up, and the user is already looking at it, before anything can
   *     react. It can therefore start Obsidian itself, making that gap as small
   *     as the OS allows.
   *   - Measured: the helper is ready in ~0.45 s. The Node side is not: the
   *     plugin's own probe alone spawns tasklist and waits, by which time the
   *     window has long since appeared and taken the foreground.
   *
   * Why "bottom of the Z order" and NOT "minimised": Microsoft documents
   * ShowWindow(SW_MINIMIZE) as minimising the window AND activating the next
   * top-level window in the Z order — it moves the foreground away from the
   * user by itself. Sent to the bottom, the new window is still there in full,
   * ready when they want it.
   *
   * Safety rules, all deliberate:
   *   - only runs when Obsidian was ALREADY running and silentOpen is on. On a
   *     cold start the window coming up IS the point, so no helper is used;
   *   - the helper is told which windows already existed and never touches one
   *     of them; it only moves a window that appeared afterwards AND whose
   *     title names the vault we just asked for;
   *   - if anything does not line up it does nothing at all and writes why,
   *     which lands in the decision log.
   */

  /**
   * Start the silent-open helper for one launch. Returns true when the helper
   * process was started (it then owns the launch); false when it is
   * unavailable, in which case the caller falls back to a normal visible
   * launch.
   */
  function startSilentOpen(vaultDir, exe, uri) {
    const helper = silentOpenHelperPath();
    if (!existsSync(helper)) {
      record(`silent-open vault=${vaultDir} reason=helper-missing`);
      return false;
    }
    const folder = vaultFolderName(vaultDir);
    if (folder === null) return false;
    const stateFile = join(
      DSH_HOME_DIR,
      "storages",
      "dsh-open-obsidian-silent.json"
    );
    try {
      writeFileSync(stateFile, JSON.stringify({ phase: "starting" }), "utf8");
    } catch {
      return false;
    }
    try {
      const child = spawn(
        helper,
        [stateFile, "0:0", folder, String(SILENT_WINDOW_TIMEOUT_MS), exe, uri],
        { detached: true, stdio: "ignore", windowsHide: true }
      );
      child.on("error", (error) => {
        ctx.logger.warn(
          "dsh-open-obsidian: silent-open helper failed to start: %s",
          error.message
        );
      });
      child.unref();
    } catch (error) {
      record(
        `silent-open vault=${vaultDir} reason=helper-spawn-failed detail=${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
    watchSilentResult(stateFile, vaultDir);
    return true;
  }

  /** Mirror the helper's verdict into the decision log (bounded, best effort). */
  function watchSilentResult(stateFile, vaultDir) {
    const giveUpAt = Date.now() + SILENT_WINDOW_TIMEOUT_MS + 5000;
    function check() {
      if (disposed || Date.now() > giveUpAt) return;
      let state = null;
      try {
        state = JSON.parse(readFileSync(stateFile, "utf8"));
      } catch {}
      if (state !== null && state.phase === "done") {
        const detail = state.ok
          ? `moved=true${state.restored ? " focus-restored=true" : ""}`
          : `detail=${String(state.why ?? "unknown")}`;
        record(
          `silent-open vault=${vaultDir} reason=${state.ok ? "ok" : "failed"} ${detail}`
        );
        return;
      }
      setTimeout(check, 400);
    }
    check();
  }


  /**
   * One-time settings migration: pre-v2 files used "empty vaultPaths = all
   * vaults". Seed the enabled set from the Obsidian registry so the plugin
   * keeps working out of the box, then persist the versioned shape.
   *
   * The seeding is keyed on the file's OWN version, not on "the version we
   * want". Since v2 an empty list legitimately means "nothing is enabled", so
   * re-seeding a v2 file that the user had deliberately cleared would silently
   * re-enable every vault — which is exactly what bumping to v3 once did here.
   */
  function migrateSettings() {
    try {
      const user = readUserSettings();
      if (user !== null && user.version === SETTINGS_VERSION) return;
      // A file with no version predates the versioned shape and carries the old
      // "empty = all vaults" meaning. A fresh install (user === null) is seeded
      // too, so the plugin works out of the box.
      const legacyEmptyMeansAll =
        user === null || typeof user.version !== "number" || user.version < 2;
      let vaultPaths = Array.isArray(user?.vaultPaths)
        ? user.vaultPaths.map(String).filter((v) => v.length > 0)
        : [];
      if (vaultPaths.length === 0 && legacyEmptyMeansAll) {
        vaultPaths = readObsidianRegistry().map((v) => v.path);
      }
      const seeded = {
        version: SETTINGS_VERSION,
        enabled: user?.enabled === undefined ? true : !!user.enabled,
        vaultPaths,
        skipWhenAlreadyOpen: user?.skipWhenAlreadyOpen ?? true,
        silentOpen: user?.silentOpen ?? true,
        command: typeof user?.command === "string" ? user.command : "",
        writeLock: user?.writeLock === undefined ? true : !!user.writeLock,
      };
      writeUserSettings(seeded);
      ctx.logger.info(
        "dsh-open-obsidian: settings migrated to v%d (%d vault(s) enabled)",
        SETTINGS_VERSION,
        seeded.vaultPaths.length
      );
    } catch (error) {
      ctx.logger.warn(
        "dsh-open-obsidian: settings migration failed: %s",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Current effective settings: yaml defaults, then the user file on top.
   * Cached by the settings file's mtime (1s TTL) — this is consulted on every
   * session event, so it must not re-read the file each time.
   */
  function effective() {
    const now = Date.now();
    let mtimeMs = -1;
    try {
      mtimeMs = existsSync(SETTINGS_FILE)
        ? statSync(SETTINGS_FILE).mtimeMs
        : -1;
    } catch {
      mtimeMs = -1;
    }
    if (
      settingsCache.value !== null &&
      settingsCache.mtimeMs === mtimeMs &&
      now - settingsCache.at < 1000
    ) {
      return settingsCache.value;
    }
    const user = readUserSettings();
    let resolved;
    try {
      resolved = Config({ ...config, ...(user ?? {}) });
    } catch (error) {
      if (user !== null) {
        ctx.logger.warn(
          "dsh-open-obsidian: settings file invalid (%s), falling back to defaults",
          error instanceof Error ? error.message : String(error)
        );
      }
      resolved = Config(config);
    }
    settingsCache = { at: now, mtimeMs, value: resolved };
    return resolved;
  }

  /**
   * Cached vault resolution for one session: { root, cwd } when the session is
   * a top-level conversation whose cwd sits inside an Obsidian vault, else
   * null. Deliberately settings-free (the allow-list is applied at use time),
   * so enabling a vault later still takes effect.
   */
  function resolveSession(session) {
    const id = session?.id;
    if (typeof id !== "string" || id.length === 0) return null;
    if (sessionVault.has(id)) return sessionVault.get(id);
    let entry = null;
    const header = session?.header;
    if (header) {
      // Skip subagent child sessions — only top-level conversations count.
      const isChild =
        header.origin === "subagent" || (header.delegationDepth ?? 0) > 0;
      const cwd = header.cwd;
      if (!isChild && typeof cwd === "string" && cwd.length > 0) {
        // The `.obsidian` marker is always required, so a workspace that is
        // not an Obsidian vault never resolves.
        const root = findVaultRoot(cwd);
        if (root !== null) entry = { root, cwd };
      }
    }
    sessionVault.set(id, entry);
    return entry;
  }

  /**
   * Whether the current settings allow acting on this session's vault: the
   * allow-list is matched against the session cwd, so subfolder entries work
   * as "only this part of the vault"; an EMPTY list means nothing is enabled,
   * so nothing triggers.
   *
   * 0.7.1: an empty list used to mean "any vault", which turned "uncheck every
   * vault" into "trigger on ALL vaults" — the exact opposite of what the panel
   * promises.
   */
  function isAllowed(entry, settings) {
    if (!settings.enabled) return false;
    const vaultPaths = settings.vaultPaths ?? [];
    return vaultPaths.some((v) => cwdMatches(entry.cwd, v));
  }

  /**
   * Actually spawn the launch (no dedup) — shared by all trigger paths.
   * Preferred: spawn the Obsidian executable DIRECTLY with the obsidian://
   * URI as its argument (same call the registered protocol handler makes),
   * which bypasses `cmd start` / ShellExecute entirely and can never pop a
   * Windows "cannot find" dialog on cold start. Falls back to the shell URI
   * only when the executable cannot be resolved.
   */
  /**
   * Actually spawn the launch (no dedup) — shared by all trigger paths.
   * Preferred: spawn the Obsidian executable DIRECTLY with the obsidian://
   * URI as its argument (same call the registered protocol handler makes),
   * which bypasses `cmd start` / ShellExecute entirely and can never pop a
   * Windows "cannot find" dialog on cold start. Falls back to the shell URI
   * only when the executable cannot be resolved.
   *
   * `obsidianRunning` is what the caller's own probe just reported. It decides
   * whether this launch gets the silent-open treatment (see below).
   */
  function spawnLaunch(vaultDir, settings, obsidianRunning) {
    // Always canonicalize before building the URI / command: Obsidian's vault
    // lookup is case-sensitive and rejects lowercased paths with
    // "Vault not found".
    vaultDir = canonicalVaultPath(vaultDir);
    const custom = String(settings.command || "").trim();
    if (custom.length > 0) {
      const child = spawn(custom.replaceAll("{vault}", vaultDir), {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        shell: true,
      });
      child.on("error", (error) => {
        ctx.logger.warn(`dsh-open-obsidian: launch failed: ${error.message}`);
      });
      child.unref();
      return;
    }
    const uri = "obsidian://open?path=" + encodeURIComponent(vaultDir);
    const exe = resolveObsidianExe();
    if (exe !== null) {
      // Silent open, and ONLY when Obsidian was already running (the caller
      // knows that from its own probe). Then the window this launch creates is
      // a SECOND window the user did not ask to be dropped into, and the helper
      // starts Obsidian itself so it is already watching when that window
      // appears. On a cold start there is no window to preserve and the whole
      // point is that Obsidian's window comes up — the helper is not used.
      if (obsidianRunning && settings.silentOpen !== false) {
        if (startSilentOpen(vaultDir, exe, uri)) return;
      }
      // NOTE: no `windowsHide` here — on Windows that flag seeds the child's
      // first top-level window with SW_HIDE (STARTUPINFO.wShowWindow), so a
      // GUI app like Obsidian would come up with an invisible main window.
      const child = spawn(exe, [uri], {
        detached: true,
        stdio: "ignore",
      });
      // Remember the spawned Obsidian main process so the write-time ensure
      // can cheaply probe its liveness (kill(pid, 0), no new process spawn)
      // and detect that Obsidian has been closed mid-conversation.
      lastSpawnedPid = typeof child.pid === "number" && child.pid > 0 ? child.pid : 0;
      child.on("error", (error) => {
        if (error.code === "ENOENT") obsidianExeCache = null;
        ctx.logger.warn(
          `dsh-open-obsidian: direct launch failed (${exe}): ${error.message}`
        );
      });
      child.unref();
      return;
    }
    // Last resort: shell `start` with the URI (protocol handler).
    const child = spawn('cmd.exe /c start "" "' + uri + '"', {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: true,
    });
    child.on("error", (error) => {
      ctx.logger.warn(`dsh-open-obsidian: launch failed: ${error.message}`);
    });
    child.unref();
  }

  /**
   * Session trigger launch: deduplicated per session id. The caller marks the
   * session as decided BEFORE the async Obsidian check, so `launch` must not
   * test the same key again — doing so silently swallowed every session
   * trigger up to 0.6.4.
   */
  function launch(vaultDir, key, settings, reason, obsidianRunning) {
    record(`open vault=${vaultDir} reason=${reason} key=${key}`);
    ctx.logger.info(
      "dsh-open-obsidian: opening vault %s (%s, %s)",
      vaultDir,
      reason,
      key
    );
    spawnLaunch(vaultDir, settings, obsidianRunning);
  }

  /**
   * Human trigger: the first direct human message of a session inside an
   * enabled vault. The check is async (never blocks the event loop); both
   * outcomes mark the session as decided, so every later message costs a
   * single Set lookup.
   */
  function triggerOpen(session, entry, settings) {
    if (launched.has(session.id)) return;
    if (!isAllowed(entry, settings)) return;
    launched.add(session.id);
    probeObsidian((probe) => {
      if (settings.skipWhenAlreadyOpen && isVaultReallyOpen(probe, entry.root)) {
        record(
          `skip vault=${entry.root} reason=already-open key=${session.id}`
        );
        ctx.logger.info(
          "dsh-open-obsidian: vault %s already open — trigger skipped for session %s",
          entry.root,
          session.id
        );
        return;
      }
      launch(entry.root, session.id, settings, "user-message", probe.running);
    });
  }

  /**
   * Write-time ensure: called on vault file changes. Opens Obsidian only while
   * the AGENT has been working in that vault recently (agent-side session
   * event inside ENSURE_ACTIVITY_WINDOW_MS), Obsidian is not running, and the
   * check/launch throttles allow it. Background churn from other programs —
   * sync clients, editors, git maintenance, Obsidian itself — can therefore
   * never open Obsidian on its own.
   */
  function scheduleEnsure(vaultDir) {
    if (disposed) return;
    const norm = normalizePath(vaultDir);
    if (norm === null) return;
    const activity = vaultActivity.get(norm);
    const now = Date.now();
    const idle =
      activity === undefined ||
      now - activity.at > ENSURE_ACTIVITY_WINDOW_MS;
    if (idle) {
      // Nothing is running in this vault: stay out of the way. Logged at most
      // once a minute so vault churn cannot flood the decision log.
      if (now - lastIdleSkipLogAt > 60_000) {
        lastIdleSkipLogAt = now;
        record(
          `ensure ignored vault=${vaultDir} reason=no-recent-agent-activity window=${ENSURE_ACTIVITY_WINDOW_MS / 1000}s`
        );
      }
      return;
    }
    const settings = effective();
    if (!isAllowed({ root: vaultDir, cwd: activity.cwd }, settings)) return;
    // Cheap stale-"running" detection: the Obsidian main process we spawned
    // is gone (user closed it mid-conversation). kill(pid, 0) costs no new
    // process, so this lets the next write re-check immediately instead of
    // waiting out the 30s running-TTL.
    if (lastCheckRunning && lastSpawnedPid > 0 && !isProcessAlive(lastSpawnedPid)) {
      lastCheckRunning = false;
      lastEnsureCheckAt = 0;
    }
    const ttl = lastCheckRunning ? ENSURE_RUNNING_TTL_MS : ENSURE_STOPPED_TTL_MS;
    if (now - lastEnsureCheckAt < ttl) return;
    lastEnsureCheckAt = now;
    probeObsidian((probe) => {
      const running = probe.running;
      lastCheckRunning = running;
      if (running) return;
      if (now - lastEnsureLaunchAt < ENSURE_LAUNCH_COOLDOWN_MS) return;
      lastEnsureLaunchAt = now;
      record(`open vault=${vaultDir} reason=agent-write`);
      ctx.logger.info(
        "dsh-open-obsidian: vault %s changed while the agent is writing — launching",
        vaultDir
      );
      // `running` is false here (the check above returned otherwise), i.e. this
      // is a cold start — no silent open, the window coming up is the point.
      spawnLaunch(vaultDir, settings, false);
    });
  }

  /**
   * Whether one fs.watch event is vault-content churn worth acting on. Events
   * without a usable filename are unclassifiable, so they are ignored rather
   * than treated as content changes.
   */
  function isIgnoredChange(filename) {
    if (typeof filename !== "string" || filename.length === 0) return true;
    return filename
      .split(/[\\/]+/)
      .some((part) => IGNORED_PATH_SEGMENTS.has(part.toLowerCase()));
  }

  /**
   * (Re)build the vault watchers from the enabled set. Obsidian's own state
   * (`.obsidian`), git plumbing (`.git`) and Obsidian's trash (`.trash`) are
   * filtered at event time, so only real vault-content changes are considered.
   */
  function syncWatchers(settings) {
    if (disposed) return;
    // normalized key -> real-case path (canonical, so launches and logs use
    // the exact case Obsidian accepts).
    const want = new Map();
    for (const p of settings.vaultPaths ?? []) {
      const norm = normalizePath(p);
      if (norm === null) continue;
      want.set(norm, canonicalVaultPath(p));
    }
    for (const [key, watcher] of watchers) {
      if (!want.has(key)) {
        try {
          watcher.close();
        } catch {}
        watchers.delete(key);
      }
    }
    for (const [key, real] of want) {
      if (watchers.has(key)) continue;
      try {
        const watcher = watch(real, { recursive: true }, (_event, filename) => {
          if (isIgnoredChange(filename)) return;
          scheduleEnsure(real);
        });
        watcher.on("error", (error) => {
          ctx.logger.warn(
            "dsh-open-obsidian: watcher error for %s: %s",
            real,
            error instanceof Error ? error.message : String(error)
          );
          try {
            watcher.close();
          } catch {}
          watchers.delete(key);
        });
        watchers.set(key, watcher);
        ctx.logger.info(
          "dsh-open-obsidian: watching vault %s for write-time ensure",
          real
        );
      } catch (error) {
        ctx.logger.warn(
          "dsh-open-obsidian: cannot watch %s: %s",
          real,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  }

  // Boot: migrate settings, then register the vault watchers. Deferred so the
  // plugin mount stays cheap, and skipped when the fiber is already disposed.
  queueMicrotask(() => {
    if (disposed) return;
    migrateSettings();
    syncWatchers(effective());
  });

  // ── 写锁需要的两个服务（动态注入）─────────────────────────────────────
  // sessionController.resolveAgent(id)  —— 按会话 id 找到 agent（睡着的会醒）
  // sessions.flush(session)             —— 投递后拿"已落盘"回执
  // ⚠️ 这两个服务比插件晚就位（实测同类服务晚过 20 秒），所以**不能**在挂载时
  //    一次性取；拿不到就先留 null，写锁想发消息时发现为空就只记日志
  //    （锁本身照常工作，只是没通知到）。dsh-self-restart 同款做法。
  if (typeof ctx.inject === "function") {
    try {
      ctx.inject(["sessionController"], (scope) => {
        services.sessionController = scope?.sessionController ?? null;
        record(
          `writelock services sessionController=${services.sessionController ? "ready" : "missing"}`
        );
      });
    } catch (error) {
      ctx.logger.warn(
        "dsh-open-obsidian: sessionController inject failed: %s",
        error instanceof Error ? error.message : String(error)
      );
    }
    try {
      ctx.inject(["sessions"], (scope) => {
        services.sessions = scope?.sessions ?? null;
      });
    } catch (error) {
      ctx.logger.warn(
        "dsh-open-obsidian: sessions inject failed: %s",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  // Teardown: close every watcher so a reload / stop / disable leaves nothing
  // behind that could still launch Obsidian.
  ctx.effect(
    () => () => {
      disposed = true;
      if (handoffTimer !== null) {
        try {
          clearTimeout(handoffTimer);
        } catch {}
        handoffTimer = null;
      }
      for (const watcher of watchers.values()) {
        try {
          watcher.close();
        } catch {}
      }
      watchers.clear();
      sessionVault.clear();
      vaultActivity.clear();
      writeLocks.clear();
    },
    "dsh-open-obsidian: vault watchers"
  );

  function json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(body);
  }

  // Settings read/write + launch-test routes for the browser half.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/dsh-open-obsidian/settings",
        handler: async (req, res) => {
          if (req.method === "GET" || req.method === "HEAD") {
            const s = effective();
            const enabledPaths = (s.vaultPaths ?? []).map(normalizePath);
            // "open" must mean "open RIGHT NOW": Obsidian's registry flag
            // survives an unclean exit, which is why the panel used to show a
            // permanent "打开中" for a vault that had long been closed.
            const probe = await new Promise((resolve) =>
              probeObsidian(resolve)
            );
            const vaults = readObsidianRegistry().map((v) => ({
              path: v.path,
              open: isVaultReallyOpen(probe, v.path),
              enabled: enabledPaths.some(
                (p) => p !== null && p === normalizePath(v.path)
              ),
            }));
            json(res, 200, {
              version: SETTINGS_VERSION,
              enabled: s.enabled,
              vaultPaths: s.vaultPaths,
              skipWhenAlreadyOpen: s.skipWhenAlreadyOpen,
              silentOpen: s.silentOpen,
              command: s.command,
              writeLock: s.writeLock,
              saved: readUserSettings() !== null,
              obsidianRunning: probe.running,
              logPath: DECISION_LOG_FILE,
              lastDecision: readLastDecision(),
              vaults,
            });
            return;
          }
          if (req.method === "POST") {
            if (!isLoopback(req.socket?.remoteAddress ?? "")) {
              json(res, 403, { error: "仅允许本机访问" });
              return;
            }
            let body;
            try {
              body = await readJsonBody(req, 64 * 1024);
            } catch {
              json(res, 400, { error: "无效的 JSON 请求体" });
              return;
            }
            const merged = { ...effective(), ...pickSettings(body) };
            try {
              const validated = Config(merged);
              const toSave = {
                version: SETTINGS_VERSION,
                enabled: validated.enabled,
                vaultPaths: validated.vaultPaths,
                skipWhenAlreadyOpen: validated.skipWhenAlreadyOpen,
                silentOpen: validated.silentOpen,
                command: validated.command,
                writeLock: validated.writeLock,
              };
              if (!writeUserSettings(toSave)) {
                json(res, 500, { error: "设置写入失败（无权访问存储文件）" });
                return;
              }
              // Saving settings is a good moment to forget a failed Obsidian
              // lookup, so a just-installed / just-moved Obsidian is found.
              obsidianExeMissAt = 0;
              syncWatchers(effective());
              json(res, 200, {
                ok: true,
                settings: {
                  enabled: validated.enabled,
                  vaultPaths: validated.vaultPaths,
                  skipWhenAlreadyOpen: validated.skipWhenAlreadyOpen,
                  silentOpen: validated.silentOpen,
                  command: validated.command,
                },
              });
            } catch (error) {
              json(
                res,
                400,
                { error: error instanceof Error ? error.message : String(error) }
              );
            }
            return;
          }
          res.writeHead(405);
          res.end();
        },
      }),
    "dsh-open-obsidian: settings routes"
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/dsh-open-obsidian/test",
        handler: async (req, res) => {
          if (req.method !== "POST") {
            res.writeHead(405);
            res.end();
            return;
          }
          if (!isLoopback(req.socket?.remoteAddress ?? "")) {
            json(res, 403, { error: "仅允许本机访问" });
            return;
          }
          let body;
          try {
            body = await readJsonBody(req, 64 * 1024);
          } catch {
            json(res, 400, { error: "无效的 JSON 请求体" });
            return;
          }
          const s = effective();
          if (!s.enabled) {
            json(res, 400, { error: "自动打开已关闭，请先在设置中启用" });
            return;
          }
          const target =
            typeof body?.path === "string" && body.path.trim().length > 0
              ? body.path.trim()
              : (s.vaultPaths ?? [])[0];
          if (!target) {
            json(res, 400, {
              error: "未提供测试路径：请先在列表中勾选至少一个库，或提交 path 参数",
            });
            return;
          }
          if (findVaultRoot(target) === null) {
            json(res, 400, {
              error: "该路径不是 Obsidian 库（未找到 .obsidian 标记）",
            });
            return;
          }
          record(`open vault=${target} reason=manual-test key=test`);
          // `obsidianRunning=false` keeps this launch VISIBLE on purpose: the
          // button is pressed by a user who is watching for the result, so a
          // silent open (window sent to the back) would look like nothing
          // happened. Silent open is for launches the user did NOT ask for.
          spawnLaunch(target, s, false);
          json(res, 200, { ok: true, opened: target });
        },
      }),
    "dsh-open-obsidian: test route"
  );

  // Panel convenience: show the decision log in Explorer, with the file
  // selected when it exists. Loopback-only like the other write-ish routes.
  // Opens a GUI app, so `windowsHide` stays OFF here for the same reason the
  // Obsidian launch leaves it off.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/dsh-open-obsidian/reveal-log",
        handler: async (req, res) => {
          if (req.method !== "POST") {
            res.writeHead(405);
            res.end();
            return;
          }
          if (!isLoopback(req.socket?.remoteAddress ?? "")) {
            json(res, 403, { error: "仅允许本机访问" });
            return;
          }
          try {
            mkdirSync(dirname(DECISION_LOG_FILE), { recursive: true });
          } catch {}
          const target = existsSync(DECISION_LOG_FILE)
            ? DECISION_LOG_FILE
            : dirname(DECISION_LOG_FILE);
          try {
            const child = spawn("explorer.exe", ["/select," + target], {
              detached: true,
              stdio: "ignore",
            });
            child.on("error", () => {});
            child.unref();
            json(res, 200, { ok: true, opened: target });
          } catch (error) {
            json(res, 500, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
    "dsh-open-obsidian: reveal-log route"
  );

  // The ONLY automatic trigger: a direct human message in a session whose
  // working directory is inside an enabled vault. Session publication
  // (`session/created` — GUI load, reconnect after a page reload, harness boot
  // restoring the last workspace) is deliberately NOT a trigger: it used to
  // open Obsidian although the user had touched nothing, so it was removed in
  // 0.7.0. Agent-side events only arm the write-time ensure.
  ctx.on("session/event", (session, event) => {
    try {
      const entry = resolveSession(session);
      if (entry === null) return;
      const type = event?.type;
      if (type === "user/message") {
        // Human input only: harness-injected and plugin messages are ignored.
        if (event.data?.source?.kind !== "user") return;
        const s = effective();
        if (!s.enabled) return;
        triggerOpen(session, entry, s);
        return;
      }
      if (AGENT_ACTIVITY_TYPES.has(type)) {
        const norm = normalizePath(entry.root);
        if (norm !== null) {
          vaultActivity.set(norm, { at: Date.now(), cwd: entry.cwd });
        }
      }
      // ── 写锁：按"轮"持有，不按"次"────────────────────────────────────
      // turn/start 抢锁；turn/end 放锁并把下一个排上。见文件上方「写锁」。
      // ⚠️ 只有顶层对话参与（resolveSession 已滤掉子代理），且只用
      //    turn 边界——不碰 tool/call，所以开销与消息条数无关。
      if (type === "turn/start") {
        onTurnStart(session, entry);
        return;
      }
      if (type === "turn/end") {
        onTurnEnd(session, entry);
        return;
      }
    } catch (error) {
      ctx.logger.warn(
        "dsh-open-obsidian: session/event handler failed: %s",
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  /**
   * ── The hard gate ───────────────────────────────────────────────────────
   *
   * Refuses a write into a locked vault BEFORE the tool runs. This is the part
   * of the write lock that cannot be ignored: the earlier notice-based design
   * only *asked* the caller to stop, and a caller that never reads its inbox
   * mid-turn simply kept writing (observed in a live host: one conversation
   * re-acquired the lock three times in a row while another waited).
   *
   * Returning `{ kind: "deny", reason }` makes the harness build an ordinary
   * tool-error result — `{ content:[{type:'text',text:'Error: '+reason}],
   * isError:true }` — through its own standard helper. So to the model this is
   * indistinguishable from the tool itself failing, which is exactly what we
   * want: no special-casing, and no risk of it reading a "special" error as a
   * prompt to retry harder.
   *
   * Deliberately fail-OPEN everywhere. A gate that blocks work it does not
   * understand is worse than one that occasionally misses a write — the notice
   * plus the vault's own commit discipline still cover the gap.
   */
  ctx.on("tools/pre-execute", async (exec, next) => {
    try {
      const settings = effective();
      if (!settings.writeLock) return next();

      const agent = exec?.agent;
      const sessionId = agent?.session?.id ?? agent?.id;
      if (typeof sessionId !== "string" || sessionId.length === 0) return next();

      // Subagents are part of their parent's turn, so they never compete for
      // the lock — and must never be blocked by it (a conversation blocking
      // its own helper would deadlock the work it is holding the lock for).
      const header = agent?.session?.header;
      if (header) {
        const isChild =
          header.origin === "subagent" || (header.delegationDepth ?? 0) > 0;
        if (isChild) return next();
      }

      // Which vault is this session working in? Unresolved => not our business.
      const entry = resolveSession(agent.session);
      if (entry === null) return next();

      // Does this call actually write into that vault?
      // The session cwd is passed in because tool calls routinely use RELATIVE
      // paths (`10-知识/x.md`) — without the cwd they cannot be resolved at all,
      // and every relative write would slip through. See isRelativePath.
      const target = writeTargetInVault(exec, entry.root, entry.cwd);
      if (target === null) return next();

      const vaultKey = normalizePath(entry.root);
      if (vaultKey === null) return next();
      const lock = lockOf(vaultKey);

      // The holder writes freely.
      if (lock.holder === sessionId) {
        // ★ 持有者**已经成功写进来**了 → 那条「轮到你、去重做」的通知已无意义，
        //   趁它还没被领取赶紧撤回（2026-10-16 加）。
        //   为什么必要：被拦下的会话在被交接、读到通知之前，完全可能自己又写成功
        //   （锁已交到它手上，闸门放行）。它若随后再读到"你之前被拦下、请重做"，
        //   就会把同一批内容写第二遍 —— 这正是本库最怕的重复写入。
        if (lock.notice && lock.notice.target === sessionId) {
          retractPendingNotice(vaultKey, lock, "holder-wrote");
        }
        return next();
      }

      // 库现在空着：**由第一个真正动手写的人当场认领**（2026-10-16 加）。
      //   原来这里是"空着就放行、不认领"，于是被拦下的等待者在持有者放锁后的
      //   3 秒交接窗口里自己重试会成功（锁空着），紧接着还照样收到交接通知，
      //   被叫去做一件它已经做完的事 —— 重复写入。
      //   现在改成认领：`tryAcquire` 会顺带清掉 passTo，那条**还没投出**的
      //   「轮到你了」自然就不发了（见 scheduleHandoff）。
      if (lock.holder === null) {
        const claimed = tryAcquire(vaultKey, sessionId, sessionLabel(agent.session));
        if (claimed.granted) {
          // 它若正排在队里，认领即出队：它已经在写了，不必再等交接。
          dequeueWaiter(vaultKey, sessionId);
          record(`writelock gate claim-on-write vault=${vaultKey} by=${sessionId}`);
        }
        return next();
      }

      // Holder has gone quiet past the staleness window: reclaim rather than
      // block forever. (0 disables takeover.)
      const staleMinutes = Number(settings.writeLockStaleMinutes);
      const staleMs =
        Number.isFinite(staleMinutes) && staleMinutes > 0
          ? staleMinutes * 60_000
          : Number.POSITIVE_INFINITY;
      if (Date.now() - lock.since > staleMs) {
        record(
          `writelock gate takeover-stale vault=${vaultKey} blocked-holder=${lock.holder} by=${sessionId}`
        );
        tryAcquire(vaultKey, sessionId, sessionLabel(agent.session));
        return next();
      }

      // Refuse. Give the caller something actionable instead of a bare "no".
      //
      // ★ 排队就在这一刻发生（2026-10-16 改）：直到这次真正被拒，它才被记进
      //   等待队列。这才是"想写而被挡下"的真实队列成员 —— 而不是所有在持有者
      //   持有期间开过一轮的会话（那种"开轮即排队"的旧做法会把只想读、只想
      //   查资料的人也算成等待者，然后给他们发一条"你被拦了、去重做"的假通知）。
      //   见 onTurnStart 的说明。已在队里则只更新时间，不重复入队。
      const position = enqueueWaiter(vaultKey, sessionId, sessionLabel(agent.session));
      record(
        `writelock gate BLOCKED tool=${exec?.name ?? "?"} by=${sessionId} holder=${lock.holder} target=${summarizeTarget(exec, target)}`
      );
      record(
        `writelock vault=${vaultKey} queued by=${sessionId} holder=${lock.holder} position=${position} reason=gate-denied`
      );
      return {
        kind: "deny",
        reason: writeBlockedReason(
          lock.holderLabel ?? shortSessionId(lock.holder),
          summarizeTarget(exec, target)
        ),
      };
    } catch (error) {
      // Never let a gate bug break unrelated tool calls.
      ctx.logger.warn(
        "dsh-open-obsidian: write-lock gate failed (allowing the call): %s",
        error instanceof Error ? error.message : String(error)
      );
      return next();
    }
  });

  // Cleanup: bounded dedup set and per-session caches.
  ctx.on("session/disposed", (session) => {
    const id = session?.id;
    if (typeof id !== "string") return;
    launched.delete(id);
    sessionVault.delete(id);
    // 写锁：会话没了就要把它从锁/队列里清掉，否则它会把库一直锁着
    // （持有者）或占着队列位（等待者）。
    //
    // ⚠️ 顺序有讲究：**先 dequeueWaiter，再处理持有者**。
    //    若反过来，releaseLock 会把下一个记进 passTo，紧接着的
    //    dequeueWaiter 又会把这个 passTo 清掉（它以为被移除的是自己），
    //    于是"持有者被关掉"这一路永远不会叫醒下一个人 —— 实测踩过。
    const wasHolder = [...writeLocks].some(([, s]) => s.holder === id);
    for (const [key] of writeLocks) {
      dequeueWaiter(key, id);
      const entryState = lockOf(key);
      // 该会话手上若还压着一条没被领取的通知，随会话一起清掉。
      if (entryState.notice && entryState.notice.target === id) {
        entryState.notice = null;
      }
    }
    if (wasHolder) {
      for (const [key, entryState] of writeLocks) {
        if (entryState.holder !== id) continue;
        const next = releaseLock(key, id);
        record(`writelock vault=${key} released-holder-disposed id=${id}`);
        if (next !== null) scheduleHandoff(key);
      }
    }
  });
}

export { Config, apply, inject, name };
