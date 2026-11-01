// This session's share of the account's recent burn.
//
// `rate_limits` describes the whole account, so every open session shows the same Session and
// Weekly numbers and none of them can say how much of that it caused. What each session does report
// is its own running cost. Recording it per session and comparing the last hour's spend across all
// of them answers "how much of the burn is this chat" - and the shares of all open sessions add up
// to 100%. Cost stands in for quota: both grow with the tokens a session sends and receives.
//
// One file per session, written only by that session, so twenty concurrent renders never lose each
// other's samples. Nothing here may throw: a missing or corrupt file degrades to "no opinion".

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const WINDOW_SECS = 3600;           // "recent" burn
const KEEP = 120;                   // samples per session
const FORGET_SECS = 86400;          // a session file untouched this long is deleted

export const sessionsDir = (configFile) => join(dirname(configFile), "sessions");

/** session_id comes from the payload; keep only characters that are safe in a file name. */
export const fileName = (id) => `${String(id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80)}.json`;

function readSamples(file) {
    try {
        const samples = JSON.parse(readFileSync(file, "utf8"));
        return Array.isArray(samples) ? samples.filter((s) => typeof s?.t === "number" && typeof s?.c === "number") : [];
    } catch {
        return [];
    }
}

/**
 * Cost spent inside the window: the newest reading minus the last one from before the window, or
 * minus the oldest inside it when the session started within the hour.
 */
export function spent(samples, now, windowSecs = WINDOW_SECS) {
    const inside = samples.filter((s) => s.t <= now && now - s.t <= windowSecs);
    if (inside.length === 0) return 0;
    const before = samples.filter((s) => now - s.t > windowSecs).pop();
    const base = before ?? inside[0];
    return Math.max(0, inside[inside.length - 1].c - base.c);
}

/**
 * Append this render's cost when it moved, keeping the window plus the one reading just before it
 * that `spent` uses as the baseline.
 */
export function record(samples, cost, now, windowSecs = WINDOW_SECS) {
    const last = samples[samples.length - 1];
    const next = last && last.c === cost ? samples : [...samples, { t: now, c: cost }];
    const firstInside = next.findIndex((s) => now - s.t <= windowSecs);
    const keepFrom = Math.max(firstInside <= 0 ? 0 : firstInside - 1, next.length - KEEP);
    // The same array back when nothing moved, so the caller can skip the write.
    return keepFrom === 0 ? next : next.slice(keepFrom);
}

/**
 * This session's percentage of the cost all sessions spent in the window, or null when there is
 * nothing to compare: alone, a session is trivially 100% of its own burn.
 */
export function shareOf(own, others) {
    const burning = others.filter((value) => value > 0);
    const total = own + burning.reduce((a, b) => a + b, 0);
    if (burning.length === 0 || total <= 0) return null;
    return (own / total) * 100;
}

/**
 * Records this render's cost for this session and returns its share of the recent burn, or null.
 */
export function update(configFile, payload, now = Math.floor(Date.now() / 1000)) {
    try {
        const id = payload?.session_id;
        const cost = payload?.cost?.total_cost_usd;
        if (!id || typeof cost !== "number") return null;

        const dir = sessionsDir(configFile);
        const own = fileName(id);
        const before = readSamples(join(dir, own));
        const samples = record(before, cost, now);
        if (samples !== before) {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, own), JSON.stringify(samples));
        }

        // Ages come from the readings themselves, on the same clock as `now`, rather than from
        // file times on another one.
        const others = [];
        for (const name of readdirSync(dir)) {
            if (name === own || !name.endsWith(".json")) continue;
            const file = join(dir, name);
            const theirs = readSamples(file);
            const last = theirs[theirs.length - 1];
            if (!last || now - last.t > FORGET_SECS) {
                rmSync(file, { force: true });
                continue;
            }
            others.push(spent(theirs, now));
        }
        return shareOf(spent(samples, now), others);
    } catch {
        return null;
    }
}
