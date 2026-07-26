// Turns a Claude Code statusline payload into the rendered line.
// Pure with respect to time and git: both are injected, so the whole renderer is snapshot-testable.

import { palette } from "./colors.js";
import { computePace, paceLevel, WINDOW_SECS } from "./pace.js";
import { clock, duration, percent, ratio as fmtRatio } from "./format.js";
import { stateFlags } from "./git.js";
import { DEFAULTS } from "./config.js";

export const LABELS = {
    five_hour: "Session",
    seven_day: "Weekly",
    seven_day_opus: "Opus",
    seven_day_sonnet: "Sonnet",
};

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

export function label(key) {
    return LABELS[key] || key.replace(/_/g, " ");
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

function renderBucket(key, limit, { c, cfg, now }) {
    let out = `${c.dim(`${label(key)}:`)} ${usedTone(c, limit.used_percentage, cfg)(percent(limit.used_percentage))}`;

    if (limit.resets_at) {
        const left = limit.resets_at - now;
        if (left > 0) out += c.dim(` (${duration(left)})`);
    }

    if (!cfg.paceOn.includes(key)) return out;

    const windowSecs = WINDOW_SECS[key];
    if (!windowSecs) return out;

    const p = computePace(limit, windowSecs, now);
    if (!p) return out;

    const tone = paceTone(c, paceLevel(p.ratio, cfg));
    out += ` ${tone(fmtRatio(p.ratio))}`;

    const showEta =
        cfg.eta === "always"
            ? p.depletesAt !== null
            : cfg.eta === "never"
              ? false
              : p.depletesBeforeReset;
    if (showEta) out += ` ${tone(clock(p.depletesAt))}`;

    return out;
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
 * @returns {string}
 */
export function render(payload, { color = true, config = DEFAULTS, now, git = null } = {}) {
    const cfg = { ...DEFAULTS, ...config };
    const c = palette(color);
    const nowSecs = now ?? Math.floor(Date.now() / 1000);
    const rateLimits = payload?.rate_limits || {};

    const parts = [];
    for (const name of cfg.segments) {
        if (name === "git") {
            const seg = renderGit(git, { c, cfg });
            if (seg) parts.push(seg);
            continue;
        }
        if (name === "limits") {
            for (const key of bucketKeys(rateLimits)) {
                parts.push(renderBucket(key, rateLimits[key], { c, cfg, now: nowSecs }));
            }
            continue;
        }
        const key = SEGMENT_ALIASES[name] || name;
        if (isBucket(rateLimits[key])) {
            parts.push(renderBucket(key, rateLimits[key], { c, cfg, now: nowSecs }));
        }
    }

    return parts.join(c.dim(cfg.separator));
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
        const p = WINDOW_SECS[key] ? computePace(limit, WINDOW_SECS[key], nowSecs) : null;
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
            depletes_at: p ? p.depletesAt : null,
            depletes_before_reset: p ? p.depletesBeforeReset : null,
            safe_rate_percent_per_day: p?.safeRatePerDay != null ? Number(p.safeRatePerDay.toFixed(2)) : null,
        };
    }
    return out;
}
