// Turns a Claude Code statusline payload into the rendered line.
// Pure with respect to time and git: both are injected, so the whole renderer is snapshot-testable.

import { palette } from "./colors.js";
import { computePace, modelOf, paceLevel, windowSecs } from "./pace.js";
import { cause, clock, duration, label, LABELS, percent, ratio as fmtRatio, tokens } from "./format.js";
import { stateFlags } from "./git.js";
import { DEFAULTS } from "./config.js";

export { LABELS, label };

const SEGMENT_ALIASES = {
    session: "five_hour",
    weekly: "seven_day",
};

/** A segment name to a bucket key: an alias, the key itself, or a model's weekly window ("fable"). */
function segmentKey(name, rateLimits) {
    if (SEGMENT_ALIASES[name]) return SEGMENT_ALIASES[name];
    return name in rateLimits ? name : `seven_day_${name}`;
}

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
    const secs = windowSecs(key);
    if (!cfg.paceOn.includes(key) || !secs) return null;
    const p = computePace(limit, secs, now, { minElapsedPct: cfg.minElapsedPct });
    return p?.reliable ? p : null;
}

function renderBucket(key, limit, { c, cfg, now, payload, notes }) {
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
    const why = level === "danger" ? cause(payload, notes.mix) : "";
    if (why) out += ` ${c.magenta(why)}`;

    return out;
}

/**
 * Before a large conversation's prompt cache goes cold, a warning: past its TTL the next turn
 * re-sends the whole conversation as cache writes - after a break, one turn can cost more than an
 * hour of work. Empty while the cache is warm with time to spare, or the conversation is small.
 */
function cacheWarning(payload, { c, cfg, now }) {
    const pc = payload?.prompt_cache;
    const size = pc?.recache_tokens_if_cold;
    if (!pc?.caching_observed || typeof size !== "number" || size < cfg.cacheWarnTokens) return "";
    if (typeof pc.expires_at !== "number") return "";
    const left = pc.expires_at - now;
    if (left <= 0) return c.red(`cold, next turn re-sends ${tokens(size)}`);
    if (left <= cfg.cacheWarnSecs) return c.yellow(`cold in ${duration(left)} (${tokens(size)})`);
    return "";
}

/**
 * This conversation's context: how full it is - what the prompt cache holds, and what `/compact`
 * clears - then the cold-cache warning. Per session: one session's figure is not a share of anything.
 */
function renderCache(payload, ctx) {
    const { c, cfg } = ctx;
    const pct = payload?.context_window?.used_percentage;
    const warning = cacheWarning(payload, ctx);
    const calm = typeof pct !== "number" || (cfg.hideCalm && pct < cfg.memoryWarn);
    if (calm && !warning) return "";
    const tone = pct >= cfg.memoryDanger ? c.red : pct >= cfg.memoryWarn ? c.yellow : c.green;
    return ["Cache:", calm ? "" : tone(percent(pct)), warning].filter(Boolean).join(" ");
}

/**
 * Whether the accounts in rotation together last, only with two or more. From the work pattern it
 * is one instruction: a green up arrow and how much faster the pool allows (`↑40%`), or a red down
 * arrow and how much to ease off (`↓25%`) with when it stops and for how long (`stop Fri 19:15
 * -36h`). Without one yet, the burn against what the pool sustains (N accounts sustain N.0x), then
 * the stop or `ok`.
 */
function poolOutlook(forecast, { c, cfg, now }) {
    if (!forecast || !(forecast.sustainable >= 2)) return "";
    const gap =
        typeof forecast.resumesAt === "number" ? ` -${Math.round((forecast.resumesAt - forecast.runsOutAt) / 3600)}h` : "";
    const stop = typeof forecast.runsOutAt === "number" ? ` stop ${clock(forecast.runsOutAt, now)}${gap}` : "";
    if (forecast.rate > 0 && typeof forecast.allowed === "number") {
        const margin = Math.round((forecast.allowed / forecast.rate - 1) * 100);
        if (margin < 0) return c.red(`${cfg.ascii ? "v" : "↓"}${-margin}%${stop}`);
        return c.green(`${cfg.ascii ? "^" : "↑"}${Math.min(margin, 999)}%`);
    }
    if (typeof forecast.burn !== "number") return "";
    const pace = `${fmtRatio(forecast.burn)}/${forecast.sustainable.toFixed(1)}x`;
    return stop ? c.red(`${pace}${stop}`) : c.green(`${pace} ok`);
}

/**
 * The burn across sessions and accounts: this session's share of what every open session spent in
 * the last hour, then whether the accounts in rotation last.
 */
function renderPool(notes, ctx) {
    const share = typeof notes.share === "number" ? ctx.c.cyan(percent(notes.share)) : "";
    const outlook = poolOutlook(notes.pool, ctx);
    return share || outlook ? `Pool: ${[share, outlook].filter(Boolean).join(" ")}` : "";
}

// Segment names from before two pairs merged: the share joined the pool, the memory the cache.
const MERGED_SEGMENTS = { share: "pool", memory: "cache" };

/** The segments to render, in order, with merged names folded in and each drawn once. */
export function segmentNames(segments) {
    return [...new Set(segments.map((name) => MERGED_SEGMENTS[name] ?? name))];
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
 * @param {{burn?: string|null, rotation?: string|null, share?: number|null, mix?: object[]|null, pool?: object|null, chain?: string[]}} [opts.notes]
 *   What the `burn`, `rotation`, `pool` and `chain` segments show, and the model mix named beside
 *   an over-budget ratio; the CLI computes them, since all of them keep state on disk.
 * @returns {string}
 */
export function render(payload, { color = true, config = DEFAULTS, now, git = null, notes = {} } = {}) {
    const cfg = { ...DEFAULTS, ...config };
    const c = palette(color);
    const nowSecs = now ?? Math.floor(Date.now() / 1000);
    const rateLimits = payload?.rate_limits || {};
    const ctx = { c, cfg, now: nowSecs, payload, notes };

    const parts = [];
    for (const name of segmentNames(cfg.segments)) {
        if (name === "limits") {
            // A model's own window (Opus, Sonnet, Fable, whatever comes next) only on request: the
            // account-wide windows are the ones that stop work.
            for (const key of bucketKeys(rateLimits)) {
                if (modelOf(key) && !cfg.showModelWindows) continue;
                parts.push(renderBucket(key, rateLimits[key], ctx));
            }
            continue;
        }
        if (name === "git") parts.push(renderGit(git, ctx));
        else if (name === "cache") parts.push(renderCache(payload, ctx));
        else if (name === "pool") parts.push(renderPool(notes, ctx));
        else if (name === "burn") parts.push(notes.burn ? c.red(notes.burn) : "");
        else if (name === "rotation") parts.push(notes.rotation ? c.yellow(notes.rotation) : "");
        // The chained statusline keeps its own colours; its lines join the line like segments.
        else if (name === "chain") parts.push(...(notes.chain ?? []));
        else {
            const key = segmentKey(name, rateLimits);
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
        const secs = windowSecs(key);
        const p = secs ? computePace(limit, secs, nowSecs, { minElapsedPct: cfg.minElapsedPct }) : null;
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
