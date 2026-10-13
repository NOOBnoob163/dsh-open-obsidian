# Changelog

All notable changes to this plugin are documented here.
The format loosely follows [Keep a Changelog](https://keepachangelog.com/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- **The documented install command was missing the required `--profile` argument.**
  `dsh plugin add …` exits immediately with
  `error: required option '--profile <name>' not specified`, so the one-command install could
  never succeed as written. Both the Chinese and English install sections now read
  `dsh plugin --profile desktop add github:NOOBnoob163/dsh-open-obsidian`, and a one-line note
  covers the case where `dsh` is not on PATH (the desktop app adds it through
  **Manage dsh Command… → Install**).
- The command quoted in the 0.10.0 entry below was corrected for the same reason.
- Documentation only; no runtime code changed.

## [0.10.0] — 2026-10-11

### Added
- **`dsh.bundle` declaration, so the plugin installs and activates in one command** —
  `dsh plugin --profile desktop add github:NOOBnoob163/dsh-open-obsidian` now mounts it
  automatically; the hand-written `insert` block in a profile's `cordis.patch.yml` is no longer
  required. (It still works that way if you prefer to mount it by hand.)
- `screenshots.json` plus two panel screenshots under `assets/`, so storefronts can show the
  settings panel (light and dark).
- README: a short note that the author has no programming background and the code was written
  with DSH's own AI assistant.

### Changed
- **README restructured around why the plugin exists**: opening the vault is what makes the
  user's *sync* plugin start running, so the files the agent edits actually get synced. The
  install section was rewritten for the one-command flow, and the manual route moved into a
  collapsible block. Both languages updated.

### Fixed
- README claimed the package "does **not** ship a `dsh.bundle` declaration" — true until
  0.10.0, and actively misleading after it. Corrected in both languages.

### Notes
- No runtime code changed in this release. The behaviour suite (12) and the panel suite (28)
  both still pass.
- The screenshots are rendered from the **real** `lib/client.js` (via `test/render-screenshot.mjs`,
  which drives the panel with a fake React shim and demo data), not hand-drawn, so they cannot
  drift from the shipped UI without the render script noticing. They contain no real vault
  names or paths.

## [0.9.1] — 2026-10-09

### Changed
- **Settings panel rebuilt in DSH's own design language.** Status pills in the header, grouped
  cards with a coloured bar per section, one setting per row (label + hint on the left, control
  on the right), the vault list in a single framed box, the "last action" entry rendered as a
  code block, and a new "file locations" row with copy buttons.
- Switches are now `<button role="switch">` elements rather than hidden checkboxes with
  pseudo-element tracks — matching how DSH's own settings page renders them. Verified to produce
  the exact same "on" colours as a native DSH switch.
- Panel height tightened so the whole page fits in the settings window (vault name and path on one
  line, the "how it works" text folded away, action log capped at 96 px).

### Fixed
- The panel used to overflow the settings window (1059 px of content in an 808 px viewport), so
  the **测试** button and the whole **高级选项** section started off-screen. Reduced to fit.

### Tests
- The panel suite's fake React renderer now expands nested function components the way real React
  does, and assertions match class names by substring instead of exact equality — both were
  silently wrong before (they could not see inside `Card` / `Row` / `Switch`, and `obs-pill ok`
  never equalled `obs-pill`). 28 assertions, 0 failures.

## [0.9.0] — 2026-10-08

### Changed
- **Settings panel restructured.** Every control used to be stacked flat with nothing but
  whitespace between them, so an expanded **高级选项** ran straight into the **测试** section
  below it and the two read as one block. Each section is now a bordered card of its own:
  打开行为 (three switches in one card, label left / switch right, hint underneath),
  检测到的知识库 (one box for all vaults, hairline rules between rows), 最近一次动作, 测试, and
  高级选项 (a single collapsible card; the title shows 「一般不用动」or 「已设自定义命令」).
- The borders now carry the structure, so expanding any section can no longer bleed into its
  neighbour.

### Tests
- Added 7 layout assertions to `test/panel.mjs` specifically guarding the "expanded sections
  merge into one another" regression. 25 panel assertions, 12 behaviour assertions.

## [0.8.1] — 2026-10-08

### Fixed
- **Two vaults open at once: an already-open vault was judged closed and reopened** — the
  original complaint, still reproducible after the 0.8.0 title fix. Root cause: the plugin asked
  `tasklist /V` which vault windows were open, and tasklist prints only **one window title per
  process**. Obsidian serves all vaults from a single process, so with two vaults open the second
  one's title was simply invisible; the vault was judged closed and launched again, yanking the
  user's window to the front. Windows are now enumerated through the helper binary with
  `EnumWindows`, which sees every window.
- A bug in that same helper made its window enumeration **always come back empty**:
  `GetWindowThreadProcessId` returns a *thread* id — the process id is written to its out
  parameter. The return value was being compared against process ids, so nothing ever matched.

### Added
- The helper now reports honestly whether it actually stole the foreground and how many times it
  handed it back, so this can no longer be silently mis-reported as "no focus taken".

## [0.8.0] — 2026-10-07

### Fixed
- **Window-title matching broke with Obsidian 1.13+.** Titles gained a ` - Obsidian <version>`
  tail, so `"AGENTS - <vault> - Obsidian 1.14.4"` matched nothing: a vault open on screen was
  judged closed, the session trigger launched it again, and the window the user was reading got
  yanked to the front. The same misjudgement made the panel show a wrong 打开中 tag and made a
  vault that *was* up look untouched. The suffix is now stripped before matching.

### Added
- **Silent open.** When Obsidian is already running, the extra window a launch creates is pushed
  to the bottom of the Z order by a small compiled helper
  (`bin/dsh-open-obsidian-silent.exe`, source in `src/`) — fully visible, no focus taken — and the
  foreground is handed straight back if the launch took it anyway. Deliberately **not** used on a
  cold start (there the window appearing is the point) or for the 测试打开 button (the user is
  watching for the result). Toggle: 静默打开 in the panel.
  - The helper watches for **any** newly appearing window, not just ones whose title already
    contains the vault name: Obsidian briefly shows an untitled window first, so the first
    focus grab used to happen while the helper was not even looking.
  - The watchdog asserts the Z-order and re-checks the foreground for ~6 s after the launch
    settles, rather than checking once — Obsidian takes the foreground a moment *after* the
    window is created, which made an earlier one-shot check miss it entirely.
  - Minimised windows report a tiny `GetWindowRect`, so a minimised vault window used to be
    discarded; window size is now taken from the window's normal placement and a minimised vault
    counts as open.
- The window list is now the fallback path: `tasklist` still answers "is Obsidian running at all"
  when the helper binary is missing.

## [0.7.4] — 2026-10-06

### Fixed
- Controls were unsaved drafts, so a refresh or a page switch reloaded the old value and a switch
  looked like it had re-opened itself. Every control now saves itself the moment it changes, and
  the 保存设置 button is gone.
- 测试打开 launched the first row of the vault list rather than the first **enabled** vault, so it
  could open a vault the user had switched off.

## [0.7.1] — 2026-10-06

### Fixed
- An empty `vaultPaths` used to mean "every vault", which silently turned *uncheck all vaults*
  into *trigger on all of them*. Empty now means no vault is enabled and the plugin never
  triggers.

## [0.7.0] — 2026-10-05

### Removed
- The `session/created` trigger. That event fires on every session **publication** — GUI load,
  reconnect after a page reload, and harness boot restoring the last workspace — so Obsidian
  opened although the user had touched nothing. The first human message is now the only
  human-intent trigger.

## [0.6.x] and earlier

- Initial development: vault detection via the `.obsidian` marker plus Obsidian's own registry
  (`%APPDATA%\obsidian\obsidian.json`), walking up from the session's working directory; launch
  through Obsidian's registered `obsidian://open?path=` URL protocol passed directly to
  `Obsidian.exe` (no `cmd start` / ShellExecute, so cold starts cannot raise Windows
  "cannot find" dialogs); the settings panel; and the bounded decision log.
