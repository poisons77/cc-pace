// Optional escape hatch: run a command when a rate-limit bucket crosses a threshold.
//
// cc-pace stays a renderer - it runs whatever command you configure and never learns what that
// command does. Nothing here may throw or block: the statusline is a synchronous render path.
//
// Config (in cc-pace's config.json):
//   "onThreshold": {
//     "bucket": "five_hour",              // any bucket in the payload
//     "at": 95,                           // used_percentage, inclusive
//     "run": "cc-account rotate"          // shell command
//   }

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** One command per window: the latch key includes the reset time, so it clears on its own. */
function latchPath(configFile) {
    return join(dirname(configFile), "threshold-state.json");
}

function readLatch(file) {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return {};
    }
}

/**
 * Decide whether the configured command should run for this payload.
 *
 * @returns {{run: string, key: string}|null}
 */
export function evaluate(limits, rule) {
    if (!rule?.run || !rule.bucket || typeof rule.at !== "number") return null;

    const bucket = limits?.[rule.bucket];
    if (!bucket || typeof bucket.used_percentage !== "number") return null;
    if (bucket.used_percentage < rule.at) return null;

    // Without a reset time there is no window to latch against; firing once per render would
    // spawn a command on every keystroke, so skip rather than guess.
    if (!bucket.resets_at) return null;

    return { run: rule.run, key: `${rule.bucket}:${bucket.resets_at}` };
}

/** Fire and forget - the statusline must not wait for whatever this starts. */
function launch(command) {
    const child = spawn(command, {
        shell: true,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
    });
    child.unref();
}

/**
 * Runs the configured command at most once per rate-limit window. Never throws.
 */
export function runThresholdHook(limits, rule, configFile) {
    try {
        const hit = evaluate(limits, rule);
        if (!hit) return null;

        const file = latchPath(configFile);
        const latch = readLatch(file);
        if (latch.lastKey === hit.key) return null;

        // Latch before launching: a command that fails should not re-fire every render.
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify({ lastKey: hit.key, firedAt: new Date().toISOString() })}\n`);

        launch(hit.run);
        return hit.key;
    } catch {
        return null;
    }
}
