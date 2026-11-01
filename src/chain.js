// Another statusline, run beside cc-pace: the same payload on its stdin, its output joined to the line.
//
// Adopting cc-pace should not mean giving up the line someone already runs. The command starts as
// soon as the payload is read, so it runs while cc-pace does its own work, and its output is waited
// for only up to a hard timeout. Anything that goes wrong - a missing command, a non-zero exit, a
// hang - leaves cc-pace's own line alone.

import { spawn, spawnSync } from "node:child_process";

// Set for the chained command, so a chain that leads back to cc-pace does not run itself forever.
const GUARD = "CC_PACE_CHAINED";

/**
 * Stops a command that outlived its timeout, with whatever it started. On Windows killing the shell
 * leaves its child running, and a command that always hangs would leave one behind every render, so
 * `taskkill /T` takes the tree. It is waited for: started detached, it died with cc-pace before
 * reaching the tree. That costs ~100 ms, only on a render whose chain has already failed.
 */
function killTree(child) {
    if (!child?.pid) return;
    try {
        if (process.platform === "win32") {
            spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 2000 });
        } else {
            child.kill();
        }
    } catch {
        /* the line renders regardless */
    }
}

/**
 * Runs `command` through the shell with `input` on stdin. Resolves to its output lines, blank ones
 * dropped, or to [] on any failure or once `timeoutMs` passes. Never rejects.
 *
 * @returns {Promise<string[]>}
 */
export function runChain(command, input, { timeoutMs = 1000, env = process.env } = {}) {
    return new Promise((resolve) => {
        if (typeof command !== "string" || !command.trim() || env[GUARD]) return resolve([]);
        let out = "";
        let settled = false;
        let child;
        const finish = (lines) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (child) {
                child.stdout?.destroy();
                child.stdin?.destroy();
                child.unref();
            }
            resolve(lines);
        };
        const timer = setTimeout(() => {
            killTree(child);
            finish([]);
        }, timeoutMs);
        try {
            child = spawn(command, {
                shell: true,
                windowsHide: true,
                env: { ...env, [GUARD]: "1" },
                stdio: ["pipe", "pipe", "ignore"],
            });
            child.on("error", () => finish([]));
            child.stdout.on("data", (chunk) => {
                out += chunk;
            });
            child.on("close", (code) =>
                finish(code === 0 ? out.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean) : []),
            );
            child.stdin.on("error", () => {});
            child.stdin.end(input);
        } catch {
            finish([]);
        }
    });
}
