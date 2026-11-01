// How long the accounts in rotation last together, judged on how this person actually works.
//
// One account's window average cannot answer it: rotation makes every account's own series a run
// of bursts and stops. The pool has one burn, though - whatever the active account spends - and one
// person behind it, who sleeps. So the forecast splits in two:
//
//   level    what the pool burns per hour of work, recent hours weighted most (half-life 3 hours)
//   profile  how likely each hour of the day is to be worked, from the last two weeks
//
// and plays `level x profile` forward across the accounts. Work hours come from the prompt history
// Claude Code keeps (`history.jsonl`, timestamps only) together with the hours the pool burned, so
// the profile exists from the first render rather than after weeks of recording.
//
// Pure apart from `readActivity`; time is injected. Nothing here may throw.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { IMPLAUSIBLE_PCT_PER_SEC } from "./burn.js";

const HOUR = 3600;
const DAY = 86400;
const KEEP_DAYS = 14;
const HALF_LIFE_HOURS = 3;
// The level is an average over hours of work; fewer than this many is one burst, not a pace.
const MIN_LEVEL_HOURS = 1.5;
// The profile is hourly, so the burn is constant within an hour and the simulation steps by hours.
const STEP_SECS = HOUR;
const MAX_STEPS = 1000;
// A stop that moves by minutes with every render says nothing new; quarter hours are honest.
const STOP_ROUNDING_SECS = 900;
// The ceiling of the search for the highest sustainable level: a whole account every two hours.
const MAX_LEVEL = 50;
// The first read of the prompt history is capped; it is append-only, so the tail holds the weeks
// that matter.
const MAX_HISTORY_READ = 16 * 1024 * 1024;

const hourOf = (t) => Math.floor(t / HOUR);
const hourOfDay = (hour) => new Date(hour * HOUR * 1000).getHours();

/** Claude Code's prompt history. `CLAUDE_CONFIG_DIR` relocates it with the rest of Claude Code's state. */
export const promptHistoryPath = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "history.jsonl");

/**
 * Adds what the active account spent since the last reading to the hour it was spent in.
 *
 * Only a climb on the same account and the same window counts. A lower reading is a stale one from
 * an idle session; a new account or a rolled window starts a new baseline; a climb too steep to be
 * real means the baseline was stale - each of those moves the baseline and counts nothing.
 *
 * @param {{since?:number, last?:object, hours?:Object<string,number>}|undefined} ledger
 * @returns the same ledger when nothing changed, so the caller can skip the write.
 */
export function recordUsage(ledger, account, limit, now) {
    if (!account || !limit || typeof limit.used_percentage !== "number" || !limit.resets_at) return ledger;
    const used = limit.used_percentage;
    const prior = ledger?.last;
    const hours = { ...(ledger?.hours ?? {}) };
    const since = ledger?.since ?? now;
    const sameWindow = prior && prior.account === account && prior.resets === limit.resets_at;

    if (sameWindow && used <= prior.used) return ledger;
    const span = sameWindow ? now - prior.t : 0;
    if (sameWindow && span > 0 && (used - prior.used) / span <= IMPLAUSIBLE_PCT_PER_SEC) {
        spread(hours, used - prior.used, prior.t, now);
    }
    const oldest = hourOf(now) - KEEP_DAYS * 24;
    for (const key of Object.keys(hours)) if (Number(key) < oldest) delete hours[key];
    return { since, last: { account, used, resets: limit.resets_at, t: now }, hours };
}

/** Splits an amount across the hours between two readings, in proportion to the time in each. */
function spread(hours, amount, from, to) {
    if (to <= from) {
        hours[hourOf(to)] = (hours[hourOf(to)] ?? 0) + amount;
        return;
    }
    for (let h = hourOf(from); h <= hourOf(to); h++) {
        const share = (Math.min(to, (h + 1) * HOUR) - Math.max(from, h * HOUR)) / (to - from);
        if (share > 0) hours[h] = Math.round(((hours[h] ?? 0) + amount * share) * 1000) / 1000;
    }
}

/**
 * The hours with a prompt in them, read incrementally from the prompt history: only the bytes past
 * `offset`, and only the `timestamp` of each line - the prompts themselves are never parsed.
 *
 * @param {{offset?:number, hours?:number[]}|undefined} activity
 * @returns the same object when the file has not grown.
 */
export function readActivity(activity, file, now) {
    let fd;
    try {
        fd = openSync(file, "r");
        const size = fstatSync(fd).size;
        let offset = activity?.offset ?? 0;
        let known = activity?.hours ?? [];
        if (size < offset) {
            offset = 0;
            known = [];
        }
        if (size === offset) return activity;
        const start = Math.max(offset, size - MAX_HISTORY_READ);
        const buf = Buffer.alloc(size - start);
        readSync(fd, buf, 0, buf.length, start);
        const text = buf.toString("utf8");
        // A line still being written is left for the next read.
        const end = text.lastIndexOf("\n") + 1;
        const found = new Set(known);
        for (const m of text.slice(0, end).matchAll(/"timestamp":(\d{13})/g)) found.add(hourOf(Number(m[1]) / 1000));
        const oldest = hourOf(now) - KEEP_DAYS * 24;
        const hours = [...found].filter((h) => h >= oldest).sort((a, b) => a - b);
        return { offset: start + Buffer.byteLength(text.slice(0, end)), hours };
    } catch {
        return activity;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

/** Every hour worked: a prompt in it, or the pool burning in it. */
export function workedHours(activity, ledger) {
    const set = new Set(activity?.hours ?? []);
    for (const [h, used] of Object.entries(ledger?.hours ?? {})) if (used > 0) set.add(Number(h));
    return set;
}

/**
 * For each hour of the day, the share of recent days it was worked. Days are counted from the
 * oldest hour known, so a short history is not diluted by days nobody recorded.
 */
export function profile(worked, now) {
    const p = new Array(24).fill(0);
    const recent = [...worked].filter((h) => h > hourOf(now) - KEEP_DAYS * 24 && h <= hourOf(now));
    if (recent.length === 0) return null;
    const days = Math.max(1, Math.min(KEEP_DAYS, Math.ceil((now - Math.min(...recent) * HOUR) / DAY)));
    for (const h of recent) p[hourOfDay(h)] += 1 / days;
    return p.map((v) => Math.min(1, v));
}

/**
 * What the pool burns per hour of work, in percent of one account: worked hours newest first,
 * each weighing half as much as the one three worked hours after it. The current hour counts for
 * the part of it that has passed. Only hours since the ledger started count - before that, nothing
 * recorded what they spent. Null with less than an hour and a half of evidence.
 */
export function level(ledger, worked, now) {
    if (!ledger?.since) return null;
    const current = hourOf(now);
    const first = Math.ceil(ledger.since / HOUR);
    const hours = [...worked].filter((h) => h >= first && h <= current).sort((a, b) => b - a);
    let num = 0;
    let den = 0;
    let span = 0;
    hours.forEach((h, k) => {
        const w = 0.5 ** (k / HALF_LIFE_HOURS);
        const part = h === current ? (now - h * HOUR) / HOUR : 1;
        num += w * (ledger.hours?.[h] ?? 0);
        den += w * part;
        span += part;
    });
    return span >= MIN_LEVEL_HOURS && den > 0 ? num / den : null;
}

/**
 * The level before the ledger has enough: the active account's use this window over the hours worked
 * since it started. Null when no worked hour falls inside the window.
 */
export function windowLevel(limit, windowSecs, worked, now) {
    if (!limit || typeof limit.used_percentage !== "number" || !limit.resets_at) return null;
    const start = limit.resets_at - windowSecs;
    let span = 0;
    for (const h of worked) {
        const from = Math.max(start, h * HOUR);
        const to = Math.min(now, (h + 1) * HOUR);
        if (to > from) span += (to - from) / HOUR;
    }
    return span >= 1 ? limit.used_percentage / span : null;
}

/**
 * Plays a burn forward across the pool for one window. The burn always draws from the account with
 * room whose reset comes first - its leftover is lost at that reset - and each account refills at its
 * reset. Returns when every account is empty with a reset still ahead, or nulls when the quota lasts.
 *
 * @param {{used:number|null, resets:number|null}[]} accounts Never observed counts as full,
 *   refilling a whole window from now - the most it can hold back.
 * @param {(t:number) => number} rateAt Percent of one account per second at time `t`, held for a step.
 */
export function simulate(accounts, rateAt, windowSecs, now) {
    const lasts = { runsOutAt: null, resumesAt: null };
    const pool = accounts.map((a) => ({
        left: a.used === null ? 100 : Math.max(0, 100 - a.used),
        resets: a.resets ?? now + windowSecs,
    }));
    if (pool.length === 0) return lasts;

    let t = now;
    for (let step = 0; step < MAX_STEPS && t < now + windowSecs; step++) {
        const rate = rateAt(t);
        // Plain loops: this runs a few thousand times a render, inside the search for the edge.
        let nextReset = Infinity;
        let drawing = null;
        for (const a of pool) {
            if (a.resets < nextReset) nextReset = a.resets;
            if (a.left > 0 && (!drawing || a.resets < drawing.resets)) drawing = a;
        }
        const stepEnd = Math.min(nextReset, (Math.floor(t / STEP_SECS) + 1) * STEP_SECS);
        if (!drawing) {
            if (rate > 0) return { runsOutAt: Math.round(t), resumesAt: nextReset };
        } else if (rate > 0 && t + drawing.left / rate < stepEnd) {
            t += drawing.left / rate;
            drawing.left = 0;
            continue;
        } else if (rate > 0) {
            drawing.left -= rate * (stepEnd - t);
        }
        t = stepEnd;
        for (const a of pool) {
            if (a.resets <= t) {
                a.left = 100;
                a.resets += windowSecs;
            }
        }
    }
    return lasts;
}

/** The burn rate over time for a level: the level in the hours this person works, scaled by how often they do. */
export function burnCurve(lvl, prof, worked, now) {
    const current = hourOf(now);
    return (t) => {
        const h = hourOf(t);
        // The hour being worked right now is worked, whatever the profile says of it.
        const share = h === current && worked.has(current) ? 1 : prof[hourOfDay(h)];
        return (lvl * share) / HOUR;
    };
}

/** The highest level the pool sustains for a window from now, within a tenth of a percent an hour. */
export function sustainableLevel(accounts, prof, worked, windowSecs, now) {
    const dry = (lvl) => simulate(accounts, burnCurve(lvl, prof, worked, now), windowSecs, now).runsOutAt !== null;
    if (!dry(MAX_LEVEL)) return MAX_LEVEL;
    let lo = 0;
    let hi = MAX_LEVEL;
    while (hi - lo > 0.05) {
        const mid = (lo + hi) / 2;
        if (dry(mid)) hi = mid;
        else lo = mid;
    }
    return lo;
}

const tenth = (n) => Math.round(n * 10) / 10;

/**
 * The pool outlook from the work pattern: the level, the highest level the pool sustains, how many
 * hours a day are worked, and when the pool runs dry and refills at the current level. Null when
 * neither the ledger nor the window can give a level, or no hour has ever been worked.
 */
export function outlook({ accounts, ledger, activity, limit, windowSecs, now }) {
    const worked = workedHours(activity, ledger);
    const prof = profile(worked, now);
    if (!prof) return null;
    const lvl = level(ledger, worked, now) ?? windowLevel(limit, windowSecs, worked, now);
    if (lvl === null) return null;
    const { runsOutAt, resumesAt } = simulate(accounts, burnCurve(lvl, prof, worked, now), windowSecs, now);
    return {
        rate: tenth(lvl),
        allowed: tenth(sustainableLevel(accounts, prof, worked, windowSecs, now)),
        workHours: tenth(prof.reduce((a, b) => a + b, 0)),
        runsOutAt: runsOutAt === null ? null : Math.round(runsOutAt / STOP_ROUNDING_SECS) * STOP_ROUNDING_SECS,
        resumesAt,
    };
}
