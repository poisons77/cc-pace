// Closes copies of cc-pace that Windows started paused and nobody ever resumed.
//
// Claude Code runs the statusline command through Git Bash and cancels a render by killing that
// bash. MSYS creates every native child suspended and resumes it a few milliseconds later; a kill
// inside that window leaves node paused forever, before one line of cc-pace has run - so the fix
// cannot live in the code that copy would have run. Each copy holds ~4 MB, and a busy machine
// collects dozens a day. A later, healthy run closes them: at most once an hour, in the background,
// so the render never waits for the process list (~1.4 s).
//
// The background job is this file run by a detached node, which runs PowerShell and waits for it. A
// detached powershell.exe started straight from node exits 0 without running its command.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);

export const REAP_EVERY_MS = 3600 * 1000;

// A copy is closed only when every test holds: it runs cc-pace (directly or through npx), it has one
// thread and that thread is suspended, it has never used CPU, it is over a minute old, and its parent
// is gone - absent, or a later process that reused the PID. Its start time is checked again right
// before the kill, so a PID reused in between is never hit.
const SWEEP = `
$all = Get-CimInstance Win32_Process
$byId = @{}
foreach ($p in $all) { $byId[$p.ProcessId] = $p }
$cutoff = (Get-Date).AddSeconds(-60)
foreach ($p in $all) {
    if ($p.Name -ne 'node.exe' -or $p.ThreadCount -ne 1) { continue }
    if ($p.UserModeTime -ne 0 -or $p.KernelModeTime -ne 0 -or $p.CreationDate -gt $cutoff) { continue }
    if ($p.CommandLine -notmatch '[\\\\/]bin[\\\\/]cc-pace\\.js|npx-cli\\.js.*claude-code-pace') { continue }
    $parent = $byId[$p.ParentProcessId]
    if ($parent -and $parent.CreationDate -lt $p.CreationDate) { continue }
    $live = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if (-not $live -or -not $live.StartTime -or [math]::Abs(($live.StartTime - $p.CreationDate).TotalSeconds) -gt 1) { continue }
    if (@($live.Threads | Where-Object { $_.WaitReason -ne 'Suspended' }).Count) { continue }
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
`;

/** The stamp holds the last sweep's own time, not an mtime: see the share.js gotcha. */
export function stampPath(configFile) {
    return join(dirname(configFile), "reap-stamp.json");
}

function lastSweep(file) {
    try {
        const at = JSON.parse(readFileSync(file, "utf8")).at;
        return typeof at === "number" ? at : 0;
    } catch {
        return 0;
    }
}

function launchSweep() {
    const child = spawn(process.execPath, [HERE], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
}

function sweep() {
    const encoded = Buffer.from(SWEEP, "utf16le").toString("base64");
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 120000,
    });
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) sweep();

/**
 * Starts the sweep when an hour has passed since the last one. Windows only: elsewhere bash does not
 * create children suspended. Returns whether a sweep was started. Never throws.
 */
export function reapStuck(configFile, { now = Date.now(), platform = process.platform, launch = launchSweep } = {}) {
    try {
        if (platform !== "win32") return false;
        const file = stampPath(configFile);
        if (now - lastSweep(file) < REAP_EVERY_MS) return false;
        // Stamped before launching: a sweep that fails should not be retried on every render.
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify({ at: now })}\n`);
        launch();
        return true;
    } catch {
        return false;
    }
}
