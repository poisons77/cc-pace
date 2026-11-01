// Recent burn rate and the wall it projects.
//
// `computePace` divides total used by total elapsed, which answers "am I on budget for the whole
// window". It cannot answer "am I about to run out", because a week of idling hides a hard hour:
// the cumulative ratio stays low while the last stretch is spending fast enough to hit 100% before
// the window resets.
//
// This tracks a short trailing history of samples and derives the rate over that recent stretch,
// which is what actually predicts the wall.
//
// Nothing here may throw: a missing or corrupt history degrades to "no opinion".

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { label } from "./format.js";

const KEEP = 60;                  // samples per bucket
const MAX_AGE_SECS = 6 * 3600;    // history older than this cannot describe "recent"
const MIN_SPAN_SECS = 300;        // below this, quantised used% dominates the slope
const RECENT_WINDOW_SECS = 3600;  // how far back "recent" reaches

// How far a measured rate may be projected beyond the stretch it was measured over. Half an hour
// of samples describes half an hour of behaviour; stretching it across a day assumes work continues
// unbroken overnight, which is how a 4%/hour burst turned into "16h46m to 100%" at 28% weekly used.
// Beyond this multiple the projection says more about the extrapolation than about the usage.
const MAX_EXTRAPOLATION = 6;

// `rate_limits` reaches the status line from each session's own most recent API response, so
// sessions that have been idle carry older numbers for the same window. With many sessions open,
// the history receives readings of different vintages, all stamped with the moment they were
// recorded rather than the moment they were true.
//
// A stale reading is always *lower* than the truth (usage only climbs within a window), so it
// arrives as an implausible jump: 8% then 26% sixty seconds later. Above this rate the earlier
// sample is treated as stale - the series restarts from the newer reading rather than believing a
// slope that would drain a whole window in half an hour.
export const IMPLAUSIBLE_PCT_PER_SEC = 100 / (30 * 60);

/**
 * Drop everything up to and including the last impossible step, keeping only the trailing run of
 * samples that can describe one continuous window.
 *
 * Guarding at write time is not enough: history already on disk was written before the guard
 * existed, and a jump only becomes visible once the *next* sample arrives. Applying the same rule
 * on read makes a contaminated file heal itself instead of misprojecting for hours.
 */
export function trimImplausible(series) {
    if (!Array.isArray(series)) return [];
    let start = 0;
    for (let i = 1; i < series.length; i++) {
        const prev = series[i - 1];
        const cur = series[i];
        const span = cur.t - prev.t;
        const rolled = cur.r !== prev.r || cur.u < prev.u;
        const jumped = span > 0 && (cur.u - prev.u) / span > IMPLAUSIBLE_PCT_PER_SEC;
        if (rolled || jumped) start = i;
    }
    return start ? series.slice(start) : series;
}

/** The history lives beside the config file, so `CC_PACE_CONFIG` relocates both together. */
export const historyPath = (configFile) => join(dirname(configFile), "burn-history.json");

export function readHistory(file) {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return {};
    }
}

/**
 * Append one observation per bucket and prune. A drop in used% means the window rolled over, so
 * the earlier samples describe a different window and are discarded rather than averaged in.
 */
export function record(history, limits, now) {
    const next = {};
    for (const [key, limit] of Object.entries(limits ?? {})) {
        if (!limit || typeof limit.used_percentage !== "number") continue;
        const prior = trimImplausible(history?.[key]);
        const last = prior[prior.length - 1];

        const sameWindow = last && last.r === limit.resets_at;

        // Within one window usage only climbs, so a lower reading is a stale one from a session
        // that has been idle - not a refund and not a rollover. Discarding it keeps the series;
        // treating it as a new window would wipe the history every time an old session rendered,
        // which is why the warning kept appearing and vanishing.
        if (sameWindow && limit.used_percentage < last.u) {
            next[key] = prior;
            continue;
        }

        // A jump too steep to be real means the earlier reading was stale rather than the burn
        // being extraordinary. Keep the newer value and drop the history it would distort.
        const span = last ? now - last.t : 0;
        const jumped =
            sameWindow && span > 0 && (limit.used_percentage - last.u) / span > IMPLAUSIBLE_PCT_PER_SEC;

        const continues = sameWindow && !jumped;
        const kept = (continues ? prior : []).filter((s) => now - s.t <= MAX_AGE_SECS);

        // Collapse repeats: identical readings add no slope information.
        const changed = !kept.length || kept[kept.length - 1].u !== limit.used_percentage;
        const series = changed
            ? [...kept, { t: now, u: limit.used_percentage, r: limit.resets_at }]
            : kept;

        next[key] = series.slice(-KEEP);
    }
    return next;
}

/**
 * The recent slope together with the stretch it was measured over, or null when the history is too
 * short or too flat to support one. The span is what bounds how far the slope may be projected.
 */
export function recentSlope(rawSeries, now, { recentWindow = RECENT_WINDOW_SECS } = {}) {
    const series = trimImplausible(rawSeries);
    if (series.length < 2) return null;
    const recent = series.filter((s) => now - s.t <= recentWindow);
    const window = recent.length >= 2 ? recent : series.slice(-2);

    const first = window[0];
    const last = window[window.length - 1];
    const span = last.t - first.t;
    if (span < MIN_SPAN_SECS) return null;

    const rate = (last.u - first.u) / span;
    return rate > 0 ? { rate, span } : null;
}

/** Percent-per-second over the recent stretch, or null. */
export function recentRate(rawSeries, now, opts) {
    return recentSlope(rawSeries, now, opts)?.rate ?? null;
}

/**
 * When usage would reach 100% at the recent rate, and whether that lands before the window resets.
 *
 * @returns {null|{wallAt:number, secondsToWall:number, beforeReset:boolean, ratePerHour:number}}
 */
export function projectWall(limit, series, now, opts) {
    if (!limit || typeof limit.used_percentage !== "number" || !limit.resets_at) return null;
    const slope = recentSlope(series, now, opts);
    if (!slope) return null;

    const remaining = 100 - limit.used_percentage;
    if (remaining <= 0) return null;

    const secondsToWall = Math.round(remaining / slope.rate);

    // A wall further out than the evidence can carry is a statement about the extrapolation, not
    // about the usage. Staying quiet is the honest answer; more samples will speak for themselves.
    const maxHorizon = (opts?.maxExtrapolation ?? MAX_EXTRAPOLATION) * slope.span;
    if (secondsToWall > maxHorizon) return null;

    const wallAt = now + secondsToWall;
    return {
        wallAt,
        secondsToWall,
        beforeReset: wallAt < limit.resets_at,
        ratePerHour: slope.rate * 3600,
        measuredOverSecs: slope.span,
    };
}

export function writeHistory(file, history) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(history));
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const dayOffset = (target, reference) => {
    const a = new Date(target.getFullYear(), target.getMonth(), target.getDate());
    const b = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
    return Math.round((a - b) / 86400000);
};

// A bare "22:13" is ambiguous once the wall lands past midnight, so the day is named whenever it
// is not the current one.
const wallTime = (ts, now) => {
    const d = new Date(ts * 1000);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const offset = dayOffset(d, new Date(now * 1000));
    if (offset === 0) return hhmm;
    const day = { 1: "tomorrow", "-1": "yesterday" }[offset] ?? DAYS[d.getDay()];
    return `${day} ${hhmm}`;
};

const shortSpan = (secs) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h > 0 ? `${h}h${m}m` : `${m}m`;
};

/**
 * Records this render's observation and returns the warning to display, if any.
 *
 * Only warns when the recent rate would exhaust the window *before* it resets - the cumulative
 * ratio already covers "on budget overall", and a wall that lands after the reset is not a wall.
 *
 * The bucket is named: with more than one window watched, a bare duration leaves the reader doing
 * arithmetic to work out which one it is about.
 */
export function update(file, limits, now = Math.floor(Date.now() / 1000), opts = {}) {
    try {
        const before = readHistory(file);
        const history = record(before, limits, now);
        // Most renders repeat the last reading, which `record` collapses. Skipping the unchanged
        // write is the difference between ~1 ms and ~20 ms a render on Windows.
        if (JSON.stringify(history) !== JSON.stringify(before)) writeHistory(file, history);

        const watched = opts.buckets ?? Object.keys(limits ?? {});
        let soonest = null;
        for (const key of watched) {
            const wall = projectWall(limits?.[key], history[key], now, opts);
            if (!wall?.beforeReset) continue;
            if (!soonest || wall.secondsToWall < soonest.wall.secondsToWall) soonest = { key, wall };
        }
        if (!soonest) return null;

        return `${label(soonest.key)} ${shortSpan(soonest.wall.secondsToWall)} to 100% (${wallTime(soonest.wall.wallAt, now)})`;
    } catch {
        return null;
    }
}
