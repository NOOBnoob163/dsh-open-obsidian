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

  // Teardown: close every watcher so a reload / stop / disable leaves nothing
  // behind that could still launch Obsidian.
  ctx.effect(
    () => () => {
      disposed = true;
      for (const watcher of watchers.values()) {
        try {
          watcher.close();
        } catch {}
      }
      watchers.clear();
      sessionVault.clear();
      vaultActivity.clear();
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
    } catch (error) {
      ctx.logger.warn(
        "dsh-open-obsidian: session/event handler failed: %s",
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Cleanup: bounded dedup set and per-session caches.
  ctx.on("session/disposed", (session) => {
    const id = session?.id;
    if (typeof id !== "string") return;
    launched.delete(id);
    sessionVault.delete(id);
  });
}

export { Config, apply, inject, name };
