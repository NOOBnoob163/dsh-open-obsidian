# Changelog

All notable changes to this plugin are documented here.
The format loosely follows [Keep a Changelog](https://keepachangelog.com/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.14.0] — 2026-10-16

### Fixed
- **★ 只想干活、没打算写的会话，会被当成等待者、还会收到一条假的「轮到你了」。**
  旧的排队时机是"一开轮没抢到锁就入队"，于是**开一轮**被当成了**想写**。实测：
  2026-10-16 的一次会话 16:25 开轮，整轮只在搜资料、读文件、一个字节没写，
  却被排进队列；持有者 16:42 放锁时点名把它叫起来，投了一条"你之前被拦下了、
  请重做"的通知 —— 而它**从头到尾没有被拦过**（决策日志里一条 `gate BLOCKED` 都没有）。
  通知又排了整整一轮，19 分钟后才被读到。
  **改法**：排队从 `turn/start` 挪到 `tools/pre-execute` **真正拒绝它的那一刻**。
  只有"想写而被挡下"的会话才进队列、才收通知；开一轮只是干活的人不再被打扰。
  （代价，故意接受：排队顺序由"谁先开轮"变成"谁先真被拦"。）
- **★ 通知走 `followup`（next-turn）会排一整轮，读到时常已过时。**
  16:42 投出的那条，目标那一轮一直跑到 17:01 才结束，19 分钟后才读到。
  **改法**：「轮到你了」改走 `agent.steer()`（next-step）——目标**下一步**就读到。
  宿主没有 `steer` 时自动退回 `followup`（宁可慢，不丢消息）。
- **★ 被交接的会话可能已经自己写成功了，那条通知就成了假消息。**
  通知投出到被读到之间有延迟（`steer` 是下一步，仍非瞬时）；这期间它可能已经
  拿到锁、写成功。它若再读到"请重做"，就会把同一批内容写第二遍 —— 正是本库最怕的
  重复写入。**改法**：两处撤回 + 文案自证。
  ① 持有者**成功写进来**时，撤回该会话手上还没被领取的通知（`gate-holder-wrote`）；
  ② 锁被他人接管 / 原持有者放锁时，撤回其尚未领取的通知（`taken-over` / `released`）；
  ③ 通知文案改为**先核对再决定**：`git status` + `git log --oneline -2`，
     工作区干净、活已在盘上 → **不要重做**；并点明"你可能根本没被拦过"，
     附上"搜自己的 session 短号、有 `gate BLOCKED` 才是真被拦"的判据。
- **★ 空锁期间的 3 秒交接窗口里，等待者自己重试会成功、随后仍收到放行通知。**
  原来"锁空着就放行、不认领"，于是它自己重试就写进去了，紧接着通知又叫它重做一遍。
  **改法**：闸门里空锁改由**第一个真正动手写的会话当场认领**（`claim-on-write`），
  认领会清掉 `passTo`，那条**还没投出**的通知自然就不发了。

### Notes
- 撤回只覆盖**还没被领取**的通知（`Inbox.remove` 对已被领取/已进账本的消息无副作用地
  返回 `false`）。它是**尽力而为的第二道防线**，不是保证；所以文案本身必须能自证过时。
  官方 `updateQueue` 同样只对 "still-pending" 有效，这是同一层的边界，不是本插件的限制。
- 清掉一处删「请让位通知」时留下的死代码：`WriteLockEntry.notified` 字段早已不存在，
  却在三处仍被 `entryState.notified.delete(...)` 触碰（加了 `!== undefined` 守卫才没炸）。
- `test/writelock.mjs` 19/19、`test/writelock-gate.mjs` 32/32、`test/behaviour.mjs` 12/12。
  写锁套件新增断言：开轮不入队、真被拦才入队、通知走 `steer`、持有者写成功后撤回、
  C 不入队不被打扰。门禁套件新增：放行文案要求"先核对"、点明"不是每次都要重做"、
  断言通道是 `steer`。

## [0.13.1] — 2026-10-14

### Fixed
- **Two ways a write could slip past the gate entirely.** Both were found in a
  live host, after a blocked conversation nevertheless wrote and committed into
  a vault another session held the lock on, leaving no `gate BLOCKED` line at
  all. The gate had been letting these through silently:
  - **Relative paths were never matched.** Tool calls routinely carry
    `10-知识/x.md` rather than the absolute path, because the session cwd *is*
    the vault. The gate only accepted paths that contained the absolute vault
    root, so every relative write passed. Relative paths are now resolved
    against the session cwd before the containment test.
  - **Commands that write the cwd were never matched.** `git add -A; git commit`
    writes vault files while naming no path anywhere in its text — it works
    because the shell's cwd is the vault. That no longer passes: when the cwd is
    inside the vault and the command is a write and it names no absolute path of
    its own, it counts as a vault write. This is also what let one session's
    `git add -A` commit *another* session's in-flight edits.
- **`..` defeated the containment test.** `pathInsideVault` is a prefix test, so
  `<vault>\..\elsewhere.md` still starts with the vault path and was reported as
  inside it. Dot segments are now collapsed before comparison, which fixes both
  directions: `..` can no longer hide a real write, and can no longer cause an
  innocent one to be refused.

### Changed
- The shell rule is deliberately asymmetric: a command that names its own
  absolute path somewhere outside the vault is allowed through even when the cwd
  is the vault. Rationale in the code — a missed write only loses a guard (the
  lock still logs it), while a wrongly refused command stalls real work, so
  ambiguity resolves in favour of letting the call through.

### Notes
- Gate suite 30/30 (four new scenarios cover both holes and the `..` case).
  Behaviour 12/12, write-lock 11/11. Panel suite: same 7 pre-existing failures.
- Found by comparing what the other conversation actually did (its session log
  shows `write` with a relative `file_path`, and a bare `git add -A`) against
  the gate's own decision log, which recorded nothing for either.

## [0.13.0] — 2026-10-14

### Changed
- **The "please stand down" message is gone.** With the write gate in place, the
  notice that was sent to a blocked writer was the weaker mechanism in every way
  that mattered:
  - it arrived a turn late, so a caller that never read its inbox mid-turn kept
    writing (a live host showed a holder re-acquiring the lock three times while
    another waited ~3.5 minutes);
  - by the time it was read, the situation it described could already be stale —
    it could name a holder that had since released, and in one observed case it
    did exactly that;
  - it duplicated what the gate now says **at the moment of the write**, which is
    both immediate and accurate.
  Queuing is unchanged (that is what makes the hand-off fair); only the notice is
  removed. `blockedText` was deleted with it so no one mistakes it for live code.

### Fixed
- **Notices named nobody.** Every session id begins with `session-`, so the
  "another conversation is writing (…)" placeholder sliced from index 0 produced
  exactly that prefix and nothing else — the reader learned only `session-`. Ids
  are now shortened *after* stripping the prefix, and the vault folder name is
  preferred when it is known.
- **The gate's "blocked operation" line dumped whole scripts.** A denied shell
  call put up to 200 characters of a multi-line pwsh script into the notice and
  the log, naming no file. Shell targets are now summarised to a single capped
  line and labelled `shell 命令 …`, so it reads as a command rather than as the
  file being written; paths show their last two segments.
- **A crash in the hand-off path.** The hand-off reached for a variable from an
  unrelated scope (`next`), which threw `ReferenceError` the moment a lock was
  handed over. The waiter record is now read from the queue before delivery. The
  suite caught this only because the hand-off scenarios assert behaviour.

### Added
- `test/writelock-gate.mjs` now also asserts the two display fixes (a non-empty
  holder name; a one-line shell summary) and a multi-line script case.

### Notes
- Verified in a live host before this release: the gate refused a real write into
  a locked vault (`gate BLOCKED tool=pwsh`), and the target file was never
  created — zero bytes written, no partial state.
- Behaviour suite 12/12, write-lock suite 11/11, gate suite 26/26. The panel
  suite still reports the same 7 pre-existing failures (unchanged).
- The write-lock suite's expectations for the removed notice were rewritten to
  assert the queue instead of the message, so the suite no longer depends on a
  mechanism that no longer exists.

## [0.12.0] — 2026-10-14

### Added
- **A hard gate in front of the write lock.** The 0.11.0 lock only *asked* a
  non-holder to stop, by sending it a message. In a live host that proved too
  weak: a conversation that never reads its inbox mid-turn kept writing, and one
  was observed re-acquiring the lock three times while another waited ~3.5
  minutes. The lock now also refuses the write itself:
  - `tools/pre-execute` returns `{ kind: 'deny', reason }` for a non-holder's
    write into a locked vault, so **the tool never runs** — no bytes are written;
  - the reason travels the harness's ordinary tool-error path
    (`{ content:[{type:'text',text:'Error: '+reason}], isError:true }`), built by
    the harness's own helper, so to the model it is indistinguishable from the
    tool failing by itself. No `info` field is supplied, keeping the shape
    identical;
  - the reason states plainly that **nothing was written** and what to do next
    (stop this turn, wait for the go-ahead notice) — a caller that assumed a
    partial write had landed would try to "repair" it.
- `writeLockStaleMinutes` setting (default 30). A lock held longer than this is
  treated as abandoned and may be taken over, so one dead conversation cannot
  freeze a vault. Set 0 to disable takeover.
- `test/writelock-gate.mjs` — 22 scenarios: denial of write/edit/shell writes,
  and fail-open for reads, other vaults, the holder itself, subagents, unknown
  tools, missing `file_path`, read-only shell commands, out-of-vault shell
  writes, the off switch and unlocked vaults.

### Changed
- The go-ahead notice no longer reads as an approval. It now opens with
  "this is not an approval", states explicitly that the earlier blocked write
  **never happened** (the tool was stopped; no file changed) and therefore the
  caller must **redo** the work — otherwise a model can read the wake-up as
  "my write succeeded" or "I already did this".
- Shell write detection no longer lists joined git subcommands. `git commit`
  never matched the natural `git -C "<vault>" commit` form because the two words
  are separated; git subcommands are now matched as words anywhere in the
  command. Found by the new suite.

### Notes
- The gate **fails open everywhere** on purpose: an unparseable call, an unknown
  tool, or an internal error all let the call through. Blocking work the plugin
  does not understand would be worse than occasionally missing a write.
- Subagents never participate and are never blocked — a conversation must not be
  stopped by its own helper.
- Behaviour suite 12/12, write-lock suite 11/11, gate suite 22/22. The panel
  suite still reports the same 7 pre-existing failures as before this release
  (unchanged; see 0.11.0 notes).

## [0.11.0] — 2026-10-14

### Added
- **Write lock: only one conversation may write a vault at a time.** Vaults synced by a
  file-sync client lose data when two writers touch them at once — the client splices the two
  versions together, which surfaces as duplicated blocks, two headings glued into one, or
  counts concatenated into nonsense. The plugin now serializes writers per vault:
  - the lock is held for a **turn** (acquired on `turn/start`, released on `turn/end`), not per
    file write — a conversation writes many times inside one turn, and releasing between those
    writes would let two conversations interleave;
  - a latecomer is queued and sent a notice telling it to stop and end its turn;
  - when the holder releases, the conversation that has waited longest is woken and made the
    new holder, so queue order is preserved;
  - only top-level conversations participate — subagents are part of their parent's turn, so a
    conversation can never be blocked by its own helper;
  - it self-heals: a lock older than 30 minutes is treated as abandoned, and a holder whose
    session is disposed releases the lock immediately.
  - New setting `writeLock` (default `true`), shown in the settings panel.
- `test/writelock.mjs` — 11 scenarios covering acquire, block, queue order, hand-off, per-vault
  isolation, holder-disposal recovery and the off switch, all against the real module with fake
  services.

### Changed
- The settings panel gained a fourth switch row (write lock); its hint explains that a second
  conversation is asked to stand down rather than being hard-blocked.

### Notes
- **The lock is advisory.** A plugin cannot abort a tool call before it runs, so it can only
  send a message asking the conversation to stop. A vault that uses this feature should require
  obeying that message in its own agent instructions; otherwise the notices are informational
  only. This is stated in the module header so it cannot be mistaken for a hard block.
- Two bugs were found by the new suite and fixed before release: the hand-off target was removed
  from the queue before it was woken (so wake-ups never fired), and the holder-disposal path
  cleared the pending hand-off. Both now have regression scenarios.
- The two notices carry distinct leading tags (`【写锁·等你让位】` / `【写锁·轮到你了】`) so code
  and tests match on the tag rather than body wording — the "wait" notice quotes the "go"
  notice's phrasing, so body matching would hit both.
- **Verified in a live host:** after a restart, the decision log shows
  `writelock services sessionController=ready` followed by `writelock vault=… acquire by=…`,
  so the service injection and the acquire path both work outside the test harness.
- Behaviour suite passes (12/12); write-lock suite passes (11/11).
- **Known pre-existing issue, not introduced here:** `test/panel.mjs` reports 7 failures against
  the current `lib/client.js`. Running that suite with the pre-write-lock copies of both files
  produces the same 7 failures by name, so the panel suite and the shipped panel have drifted
  apart. Three of the seven are hard-coded "three switches" expectations that this release
  necessarily invalidates (now four); the other four concern the "recent action" / log-button
  area, which this release does not touch. Worth a separate fix-up pass.

## [0.10.0] — 2026-10-11

### Added
- **`dsh.bundle` declaration, so the plugin installs and activates in one command** —
  `dsh plugin add github:NOOBnoob163/dsh-open-obsidian` now mounts it automatically; the
  hand-written `insert` block in a profile's `cordis.patch.yml` is no longer required.
  (It still works that way if you prefer to mount it by hand.)
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
