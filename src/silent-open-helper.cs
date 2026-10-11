using System;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

/**
 * dsh-open-obsidian — silent-open helper + window lister (0.8.0)
 *
 * Two jobs, both of which need to see Obsidian's windows the way Windows sees
 * them rather than the way `tasklist` reports them:
 *
 *   list <outFile>
 *       Write every visible Obsidian window as "<pid>\t<title>" per line.
 *       The plugin uses this INSTEAD of `tasklist /V`, which prints only ONE
 *       window title per process. With two vaults open (one Obsidian process,
 *       two windows) the second vault's title was simply invisible, so an open
 *       vault was judged closed and reopened — the "已经开着还再弹一次"
 *       complaint, still reproducible after the title-suffix fix. Measured
 *       2026-10-08: one pid owned both the "alpha" and "beta" windows; tasklist
 *       listed only "alpha".
 *
 *   <stateFile> <unused> <folder> <timeoutMs> <launchExe> <launchArg>
 *       Own the launch of one vault and keep the window it creates out of the
 *       user's way (see below).
 *
 * Why a separate compiled program rather than a few lines in the plugin:
 *   - Windows refuses foreground changes made by a background process that does
 *     not own the window. AttachThreadInput is how a helper gets inside that
 *     guard; there is no Node-side equivalent without a native module.
 *   - It has to be WATCHING before the window appears. Waiting for it in Node
 *     costs a tasklist spawn per poll, by which time Obsidian has already taken
 *     the foreground. This program is ready in a fraction of a second and polls
 *     the Win32 API directly.
 *
 * Measured lesson that shaped the silent-open design (2026-10-07, live trace):
 * Obsidian does NOT take the foreground when its window is created — it takes
 * it a moment LATER, while the vault is still loading. A single "did it steal
 * focus?" check right after the window appeared therefore missed it, and the
 * user was left staring at a stolen window for ~3.7 s. The stance below is
 * consequently not a one-shot fix-up but a short watch: assert the Z-order,
 * watch the foreground, and hand it straight back while the launch settles.
 *
 * Second measured lesson (2026-10-08): a MINIMISED window reports a tiny
 * GetWindowRect (a minimised vault window measured 158x26 while minimised). Filtering
 * candidates by raw rect size silently discarded it, which both hid an open
 * vault from the plugin and could have hidden the very window being looked for.
 * Window size is therefore taken from the window's NORMAL placement, and a
 * minimised vault window counts as open — it is open, just not on screen.
 *
 * Exit codes: 0 always (verdicts go to the state/out file as text or JSON).
 */
public class SilentOpenHelper
{
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int m);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT p);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    // --- WinEvent hook: the only way to react to a focus change the instant it
    //     happens. Polling cannot help, because by the time any poll notices,
    //     the focus is already gone. ---
    delegate void WinEventProc(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc cb, uint pid, uint tid, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);
    [DllImport("user32.dll")] static extern bool PeekMessage(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint msg, IntPtr w, IntPtr l);

    const uint PM_REMOVE = 0x0001;

    /** Non-blocking check for a queued hook message. */
    static bool PeekMessageAvailable(out MSG msg)
    {
        return PeekMessage(out msg, IntPtr.Zero, 0, 0, PM_REMOVE);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG
    {
        public IntPtr hwnd; public uint message; public IntPtr wParam, lParam;
        public uint time; public int ptX, ptY;
    }

    const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    const uint WM_QUIT = 0x0012;

    /**
     * The hook callback, anchor and window set are held in STATIC fields on
     * purpose. Windows keeps only a native function pointer to an out-of-context
     * hook; if the managed delegate is not strongly referenced for as long as the
     * hook lives, the GC can collect it and the hook then stops firing silently.
     * (Measured 2026-10-08: focus steals grew to 2.0-3.6 s and the helper still
     * reported stoleFocus=false.)
     */
    static WinEventProc hookSelf;
    static IntPtr hookAnchor = IntPtr.Zero;
    static HashSet<IntPtr> hookOwned = new HashSet<IntPtr>();

    static void SetHookTarget(IntPtr anchor, HashSet<IntPtr> owned)
    {
        hookAnchor = anchor;
        hookOwned = owned;
    }

    static void HookOnForeground(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
    {
        try
        {
            if (hwnd == IntPtr.Zero || !hookOwned.Contains(hwnd)) return;
            ForceForeground(hookAnchor);
        }
        catch { }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)]
    struct WINDOWPLACEMENT
    {
        public int length, flags, showCmd;
        public POINT ptMinPosition, ptMaxPosition;
        public RECT rcNormalPosition;
    }

    const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOACTIVATE = 0x0010;
    static readonly IntPtr HWND_BOTTOM = new IntPtr(1);

    /** Titles Windows gives its own invisible input scaffolding. */
    static readonly HashSet<string> SCAFFOLDING = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "Default IME", "MSCTFIME UI", "OleMainThreadWndName", "CiceroUIWndFrame",
    };

    static string Title(IntPtr h)
    {
        var sb = new StringBuilder(512);
        int n = GetWindowTextW(h, sb, 512);
        return n > 0 ? sb.ToString() : "";
    }

    /** The window's real (restored) size, so a minimised window is not misjudged. */
    static void NormalSize(IntPtr h, out int w, out int hgt)
    {
        var p = new WINDOWPLACEMENT();
        p.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
        if (GetWindowPlacement(h, ref p))
        {
            w = p.rcNormalPosition.Right - p.rcNormalPosition.Left;
            hgt = p.rcNormalPosition.Bottom - p.rcNormalPosition.Top;
            if (w > 0 && hgt > 0) return;
        }
        RECT r;
        if (GetWindowRect(h, out r)) { w = r.Right - r.Left; hgt = r.Bottom - r.Top; return; }
        w = 0; hgt = 0;
    }

    /** A real, user-facing window — not Windows' input scaffolding. */
    static bool IsRealWindow(IntPtr h)
    {
        if (!IsWindowVisible(h)) return false;
        string t = Title(h);
        if (t.Length == 0 || SCAFFOLDING.Contains(t)) return false;
        int w, hgt;
        NormalSize(h, out w, out hgt);
        return w > 200 && hgt > 200;
    }

    static List<IntPtr> RealWindows()
    {
        var list = new List<IntPtr>();
        EnumWindows((h, l) => { if (IsRealWindow(h)) list.Add(h); return true; }, IntPtr.Zero);
        return list;
    }

    static HashSet<uint> ObsidianPids()
    {
        var pids = new HashSet<uint>();
        foreach (var p in Process.GetProcessesByName("Obsidian"))
        {
            try { pids.Add((uint)p.Id); } catch { }
        }
        return pids;
    }

    /// <summary>
    /// Give `anchor` the foreground. Returns whether it actually took.
    /// Attaches to the threads that own the foreground: without that, Windows
    /// silently refuses the request from a background process.
    /// </summary>
    static bool ForceForeground(IntPtr anchor)
    {
        if (anchor == IntPtr.Zero) return false;
        if (GetForegroundWindow() == anchor) return true;

        uint unused = 0;
        uint anchorThread = GetWindowThreadProcessId(anchor, out unused);
        IntPtr fg = GetForegroundWindow();
        uint fgThread = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out unused) : 0;
        uint self = GetCurrentThreadId();

        bool ok = false;
        bool attachedFg = false, attachedAnchor = false;
        try
        {
            if (fgThread != 0 && fgThread != self) attachedFg = AttachThreadInput(fgThread, self, true);
            if (anchorThread != 0 && anchorThread != self) attachedAnchor = AttachThreadInput(anchorThread, self, true);
            BringWindowToTop(anchor);
            ok = SetForegroundWindow(anchor);
            if (!ok) ok = SetForegroundWindow(anchor);
        }
        catch { }
        finally
        {
            try { if (attachedAnchor) AttachThreadInput(anchorThread, self, false); } catch { }
            try { if (attachedFg) AttachThreadInput(fgThread, self, false); } catch { }
        }
        return ok && GetForegroundWindow() == anchor;
    }

    public static int Main(string[] args)
    {
        if (args.Length >= 2 && args[0] == "list") return List(args[1]);
        return SilentOpen(args);
    }

    /**
     * Write the window inventory. Protocol (both line kinds, one per line):
     *   #proc <pid>          one per running Obsidian process (proves it is up,
     *                        even when it currently shows no usable window)
     *   <pid>\t<title>       one per visible Obsidian window
     * The "#proc" lines exist so the plugin can tell "Obsidian is not running"
     * from "Obsidian is running but has no window" — an empty file alone cannot
     * express that, and guessing it wrong makes the plugin treat a closed vault
     * as open (or vice versa). Never throws.
     */
    static int List(string outFile)
    {
        var lines = new StringBuilder();
        try
        {
            var pids = ObsidianPids();
            foreach (var pid in pids) lines.Append("#proc ").Append(pid).Append('\n');
            foreach (var h in RealWindows())
            {
                // GetWindowThreadProcessId RETURNS the thread id and writes the
                // PROCESS id to its out parameter. Using the return value here
                // (as this did at first) compares thread ids against process
                // ids, so no window ever matched its own process and the list
                // came back empty — while every window still looked fine in a
                // per-window diagnostic.
                uint pid = 0;
                GetWindowThreadProcessId(h, out pid);
                if (!pids.Contains(pid)) continue;
                string t = Title(h).Replace("\t", " ").Replace("\r", " ").Replace("\n", " ");
                lines.Append(pid).Append('\t').Append(t).Append('\n');
            }
        }
        catch (Exception e)
        {
            lines.Append("#error ").Append(e.GetType().Name).Append('\n');
        }
        try { System.IO.File.WriteAllText(outFile, lines.ToString(), new UTF8Encoding(false)); }
        catch { return 3; }
        return 0;
    }

    static int SilentOpen(string[] args)
    {
        // args: <stateFile> <unused> <folder> <timeoutMs> <launchExe> <launchArg>
        if (args.Length < 4) return 2;
        string stateFile = args[0];
        string folder = args[2];
        int timeoutMs = 15000;
        int.TryParse(args[3], out timeoutMs);
        if (timeoutMs <= 0) timeoutMs = 15000;

        var sw = Stopwatch.StartNew();

        // 1. The window to protect: whatever the user is in right now.
        IntPtr anchor = GetForegroundWindow();

        // 2. Windows that already exist: never touch these.
        var before = new HashSet<IntPtr>(RealWindows());

        // 3. Own the launch, so the gap to "new window appears" is as small as
        //    the OS allows.
        if (args.Length >= 6)
        {
            try
            {
                var psi = new ProcessStartInfo(args[4]);
                psi.Arguments = args[5];
                psi.UseShellExecute = false;
                Process.Start(psi);
            }
            catch { }
        }

        // 4. Watch from the instant the launch starts.
        //
        //    The window to watch for is NOT only the finished "<note> - <vault>"
        //    one. Obsidian first shows a bare, untitled window (measured title:
        //    just "Obsidian") and only later retitles it to the vault; that
        //    untitled window is the one that grabs the foreground first. Waiting
        //    specifically for the vault title therefore MISSED the first steal
        //    entirely (measured: a 94 ms steal with the helper not watching).
        //    So: any new, real window that appears after the launch belongs to
        //    it — treat it as the target straight away, and keep watching for
        //    more new ones (Obsidian can create a second window when it switches
        //    to the requested vault).
        string want = folder.ToLowerInvariant();
        var owned = new HashSet<IntPtr>();
        IntPtr firstNew = IntPtr.Zero;
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            foreach (var h in RealWindows())
            {
                if (before.Contains(h) || owned.Contains(h)) continue;
                owned.Add(h);
                if (firstNew == IntPtr.Zero) firstNew = h;
            }
            // Prefer a window that already proves it is the right vault.
            foreach (var h in owned)
            {
                if (Title(h).ToLowerInvariant().Contains(want))
                {
                    firstNew = h;
                    break;
                }
            }
            if (firstNew != IntPtr.Zero && Title(firstNew).ToLowerInvariant().Contains(want)) break;
            if (owned.Count > 0 && sw.ElapsedMilliseconds > 1200) break;
            System.Threading.Thread.Sleep(10);
        }
        IntPtr target = firstNew;
        if (target == IntPtr.Zero)
        {
            Write(stateFile, "{\"phase\":\"done\",\"ok\":false,\"why\":\"no-new-window\",\"ms\":" + sw.ElapsedMilliseconds + "}");
            return 0;
        }

        // 5. Settle it — and do it from an EVENT HOOK, not a poll.
        //
        //    Measured repeatedly on this machine: polling (even at 1 ms) left a
        //    94-124 ms steal in 2 of 3 runs. The reason is structural, not a
        //    matter of a shorter sleep: a poll can only notice that the focus is
        //    ALREADY gone, and every millisecond between Obsidian taking it and
        //    the poll noticing is time the user sees their window change.
        //    EVENT_SYSTEM_FOREGROUND fires *when* the foreground changes, so the
        //    focus can be handed back immediately instead of up to a tick later.
        //    The hook delegate MUST be kept in a field for the whole run: Windows
        //    holds only a native pointer to it, so a local that looks unused can
        //    be collected at any GC, after which the hook silently stops firing
        //    and nothing gives the focus back. (Measured 2026-10-08: with the
        //    delegate left local and the loop trusting it, steals grew to
        //    2.0-3.6 s and the helper still reported stoleFocus=false.)
        //    The loop below therefore ALSO checks the foreground every pass and
        //    never depends on the hook alone.
        bool moved = false, sawSteal = false, restoredOk = false;
        int attempts = 0;
        long settleUntil = sw.ElapsedMilliseconds + 6000;

        var anchorRef = anchor;
        SetHookTarget(anchor, owned);
        hookSelf = HookOnForeground;
        IntPtr hookHandle = IntPtr.Zero;
        try
        {
            hookHandle = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND,
                IntPtr.Zero, hookSelf, 0, 0, WINEVENT_OUTOFCONTEXT);
        }
        catch { }

        // Push the windows down first so they are out of the way before
        // Obsidian tries to raise them.
        foreach (var h in owned)
        {
            if (SetWindowPos(h, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE))
            {
                moved = true;
            }
        }

        while (sw.ElapsedMilliseconds < settleUntil)
        {
            // New windows can still appear (Obsidian switches to the requested
            // vault by opening another one); adopt and push them down.
            foreach (var h in RealWindows())
            {
                if (!before.Contains(h) && owned.Add(h))
                {
                    SetWindowPos(h, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
                    moved = true;
                }
            }

            MSG msg;
            while (PeekMessageAvailable(out msg))
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }

            // Authoritative check, run every pass regardless of the hook: this
            // is what actually guarantees the focus comes back.
            if (owned.Contains(GetForegroundWindow()))
            {
                sawSteal = true;
                attempts++;
                if (ForceForeground(anchor)) restoredOk = true;
            }
            System.Threading.Thread.Sleep(1);
        }

        if (hookHandle != IntPtr.Zero)
        {
            try { UnhookWinEvent(hookHandle); } catch { }
        }
        hookSelf = null;
        hookOwned = new HashSet<IntPtr>();

        // Final pass: never leave the foreground on any window we opened.
        if (owned.Contains(GetForegroundWindow())) ForceForeground(anchor);

        bool clean = !owned.Contains(GetForegroundWindow());
        Write(stateFile,
            "{\"phase\":\"done\",\"ok\":" + (moved && clean ? "true" : "false")
            + ",\"moved\":" + (moved ? "true" : "false")
            + ",\"windowsOwned\":" + owned.Count
            + ",\"stoleFocus\":" + (sawSteal ? "true" : "false")
            + ",\"restored\":" + (restoredOk ? "true" : "false")
            + ",\"attempts\":" + attempts
            + ",\"finalForegroundIsTarget\":" + (owned.Contains(GetForegroundWindow()) ? "true" : "false")
            + ",\"ms\":" + sw.ElapsedMilliseconds + "}");
        return 0;
    }

    static void Write(string file, string json)
    {
        try { System.IO.File.WriteAllText(file, json); } catch { }
    }
}
