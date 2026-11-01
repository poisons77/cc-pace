// Turns a Claude Code statusline payload into the rendered line.
// Pure with respect to time and git: both are injected, so the whole renderer is snapshot-testable.

import { palette } from "./colors.js";
import { computePace, paceLevel, WINDOW_SECS } from "./pace.js";
import { cause, clock, duration, label, LABELS, percent, ratio as fmtRatio } from "./format.js";
import { stateFlags } from "./git.js";
import { DEFAULTS } from "./config.js";

export { LABELS, label };

const SEGMENT_ALIASES = {
    session: "five_hour",
    weekly: "seven_day",
    opus: "seven_day_opus",
    sonnet: "seven_day_sonnet",
};

function isBucket(value) {
    return value && typeof value.used_percentage === "number";
}

/**
 * Known buckets keep their curated order; anything new Claude Code starts sending is appended
 * rather than dropped, so the tool degrades forward.
 */
export function bucketKeys(rateLimits) {
    const known = Object.keys(LABELS).filter((k) => isBucket(rateLimits[k]));
    const extra = Object.keys(rateLimits).filter(
        (k) => !(k in LABELS) && isBucket(rateLimits[k]),
    );
    return [...known, ...extra];
}

function usedTone(c, pct, cfg) {
    if (pct >= cfg.usedDanger) return c.red;
    if (pct >= cfg.usedWarn) return c.yellow;
    return c.green;
}

function paceTone(c, level) {
    if (level === "danger") return c.red;
    if (level === "warn") return c.yellow;
    return c.green;
}

/** The pace to render beside a bucket, or null where it has none or is too early to mean anything. */
function bucketPace(key, limit, cfg, now) {
    const windowSecs = WINDOW_SECS[key];
    if (!cfg.paceOn.includes(key) || !windowSecs) return null;
    const p = computePace(limit, windowSecs, now, { minElapsedPct: cfg.minElapsedPct });
    return p?.reliable ? p : null;
}

function renderBucket(key, limit, { c, cfg, now, payload }) {
    const p = bucketPace(key, limit, cfg, now);
    const level = p ? paceLevel(p.ratio, cfg) : null;
    if (cfg.hideCalm && limit.used_percentage < cfg.usedWarn && (level === null || level === "ok")) {
        return "";
    }

    // Labels in the terminal's own colour; grey is kept for what is secondary - the time left and
    // the separators.
    let out = `${label(key)}: ${usedTone(c, limit.used_percentage, cfg)(percent(limit.used_percentage))}`;

    if (limit.resets_at) {
        const left = limit.resets_at - now;
        if (left > 0) out += c.dim(` (${duration(left)})`);
    }

    if (!p) return out;

    const tone = paceTone(c, level);
    out += ` ${tone(fmtRatio(p.ratio))}`;

    const showEta =
        cfg.eta === "always"
            ? p.depletesAt !== null
            : cfg.eta === "never"
              ? false
              : p.depletesBeforeReset;
    if (showEta) out += ` ${tone(clock(p.depletesAt, now))}`;

    // Over budget, the line names what is doing the burning: the model and its settings.
    const why = level === "danger" ? cause(payload) : "";
    if (why) out += ` ${c.magenta(why)}`;

    return out;
}

/** How full this conversation's context window is. Per session: one session's figure is not a share of anything. */
function renderMemory(payload, { c, cfg }) {
    const pct = payload?.context_window?.used_percentage;
    if (typeof pct !== "number") return "";
    if (cfg.hideCalm && pct < cfg.memoryWarn) return "";
    const tone = pct >= cfg.memoryDanger ? c.red : pct >= cfg.memoryWarn ? c.yellow : c.green;
    return `Memory: ${tone(percent(pct))}`;
}

/** This session's share of the cost every open session burned over the last hour. */
function renderShare(share, { c }) {
    if (typeof share !== "number") return "";
    return `This chat: ${c.cyan(percent(share))} of burn`;
}

function renderGit(git, { c, cfg }) {
    if (!git) return "";
    const flags = stateFlags(git, { ascii: cfg.ascii });
    return `${c.cyan(git.branch)} ${flags ? c.yellow(`[${flags}]`) : c.green("[clean]")}`;
}

/**
 * @param {object} payload Claude Code statusline JSON.
 * @param {object} opts
 * @param {boolean} [opts.color]
 * @param {object} [opts.config]
 * @param {number} [opts.now] Unix seconds.
 * @param {object|null} [opts.git] Result of readGit(), or null.
 * @param {{burn?: string|null, rotation?: string|null, share?: number|null}} [opts.notes] What the
 *   `burn`, `rotation` and `share` segments show; the CLI computes them, since all three keep state
 *   on disk.
 * @returns {string}
 */
export function render(payload, { color = true, config = DEFAULTS, now, git = null, notes = {} } = {}) {
    const cfg = { ...DEFAULTS, ...config };
    const c = palette(color);
    const nowSecs = now ?? Math.floor(Date.now() / 1000);
    const rateLimits = payload?.rate_limits || {};
    const ctx = { c, cfg, now: nowSecs, payload };

    const parts = [];
    for (const name of cfg.segments) {
        if (name === "limits") {
            for (const key of bucketKeys(rateLimits)) parts.push(renderBucket(key, rateLimits[key], ctx));
            continue;
        }
        if (name === "git") parts.push(renderGit(git, ctx));
        else if (name === "memory") parts.push(renderMemory(payload, ctx));
        else if (name === "share") parts.push(renderShare(notes.share, ctx));
        else if (name === "burn") parts.push(notes.burn ? c.red(notes.burn) : "");
        else if (name === "rotation") parts.push(notes.rotation ? c.yellow(notes.rotation) : "");
        else {
            const key = SEGMENT_ALIASES[name] || name;
            if (isBucket(rateLimits[key])) parts.push(renderBucket(key, rateLimits[key], ctx));
        }
    }
    // Defaults are in force, so the user's settings are not: say so rather than ignore them silently.
    if (cfg.configError) parts.push(c.yellow("! config"));

    return parts.filter(Boolean).join(c.dim(cfg.separator));
}

/**
 * Machine-readable view of the same numbers, for people composing their own statusline.
 */
export function metrics(payload, { config = DEFAULTS, now } = {}) {
    const cfg = { ...DEFAULTS, ...config };
    const nowSecs = now ?? Math.floor(Date.now() / 1000);
    const rateLimits = payload?.rate_limits || {};
    const out = { now: nowSecs, limits: {} };

    for (const key of bucketKeys(rateLimits)) {
        const limit = rateLimits[key];
        const p = WINDOW_SECS[key]
            ? computePace(limit, WINDOW_SECS[key], nowSecs, { minElapsedPct: cfg.minElapsedPct })
            : null;
        out.limits[key] = {
            label: label(key),
            // The API sends floats such as 7.000000000000001; keep the precision that matters
            // and drop the binary noise.
            used_percentage: Number(limit.used_percentage.toFixed(2)),
            resets_at: limit.resets_at ?? null,
            seconds_until_reset: limit.resets_at ? limit.resets_at - nowSecs : null,
            elapsed_percentage: p ? Number(p.elapsedPct.toFixed(2)) : null,
            pace_ratio: p ? Number(p.ratio.toFixed(3)) : null,
            pace_level: p ? paceLevel(p.ratio, cfg) : null,
            // False while the window is too young for the ratio and ETA to be meaningful.
            pace_reliable: p ? p.reliable : null,
            depletes_at: p ? p.depletesAt : null,
            depletes_before_reset: p ? p.depletesBeforeReset : null,
            safe_rate_percent_per_day: p?.safeRatePerDay != null ? Number(p.safeRatePerDay.toFixed(2)) : null,
        };
    }
    return out;
}
