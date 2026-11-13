// Primary/fallback account rotation.
//
// The pattern this serves: a smaller plan whose short window fills fast, paired with a larger one
// held in reserve. Burn the primary, move to the fallback when it runs dry, and come back the
// moment the primary's window resets - so the fallback is only ever used for the gap.
//
//   on primary,  used% >= at          -> switch to fallback, remember the primary's reset time
//   on fallback, clock passes reset   -> switch back to primary
//
// Neither trigger needs a latch: performing one makes the other's condition false. That is
// deliberate - a latch keyed on the reset timestamp cannot fire twice in the same window, which
// breaks re-entry after a return.
//
// Nothing here may throw or block: this runs inside a synchronous statusline render.

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { computePace, WINDOW_SECS, windowSecs as windowLength } from "./pace.js";
import { historyPath, projectWall, readHistory } from "./burn.js";
import { outlook, promptHistoryPath, readActivity, recordUsage, simulate } from "./pool.js";

// A switch takes a second or two; without a cooldown every render in that gap would spawn again.
const COOLDOWN_SECS = 45;

const statePath = (configFile) => join(dirname(configFile), "rotation-state.json");

/**
 * How long after a switch the payload is treated as unreadable.
 *
 * `rate_limits` arrives with the last API response, so for a render or two after a switch it still
 * describes the *previous* account. Judging on it inverts the decision: a manual move off a spent
 * account is read as the account just arrived at being spent, and the switch is undone - which
 * hands the next render the same stale evidence, and the pair ping-pongs.
 */
const SETTLE_SECS = 120;

// How long a target that did not answer is left alone before it is tried again.
const RETRY_SECS = 300;

// A login that stops refreshing within this margin is treated as already gone: switching into it
// would land on an account that logs out mid-turn. Fixed, not a setting: it is the same hour
// cc-account shows as its red alert, so both tools draw the line in one place.
const LOGIN_MARGIN_SECS = 3600;

// The published ranking is rewritten at least this often, so a reader can tell a stable ranking
// from one nobody has refreshed.
const RANKING_REFRESH_SECS = 600;

/**
 * What cc-account publishes on every switch, save, renewal and session start - the only reliable
 * source of account identity. One read: `active`, when it last changed, and when each login stops
 * refreshing (`null` when unknown).
 */
function published(store) {
    try {
        const doc = JSON.parse(readFileSync(join(store, "rotation-state.json"), "utf8"));
        return {
            active: doc.active ?? null,
            switchedAt: typeof doc.switchedAt === "number" ? doc.switchedAt : null,
            logins: doc.logins && typeof doc.logins === "object" ? doc.logins : {},
        };
    } catch {
        return { active: null, switchedAt: null, logins: {} };
    }
}

/** A known expiry inside the margin. Unknown (`null` or missing) is allowed, as cc-account cannot always tell. */
function loginDead(logins, name, now) {
    const expires = logins?.[name];
    return typeof expires === "number" && expires - now < LOGIN_MARGIN_SECS;
}

/**
 * The saved state: `{}` when there is none yet, null when the file exists but cannot be read.
 * The caller must not write over a null: the file holds the only readings of every account not
 * live right now, and saving a fresh state in its place loses them.
 */
function readState(file) {
    let text;
    try {
        text = readFileSync(file, "utf8");
    } catch (error) {
        return error?.code === "ENOENT" ? {} : null;
    }
    try {
        const state = JSON.parse(text);
        return state && typeof state === "object" ? state : null;
    } catch {
        return null;
    }
}

/**
 * The text the last decision published, shown as-is. It reflects the previous render, which for a
 * status line redrawn on every turn is current enough, and keeps the engine off the render path.
 */
export function readDisplay(configFile) {
    const text = readState(statePath(configFile))?.display;
    return typeof text === "string" && text ? text : null;
}

/**
 * Every session renders and writes this file, so a write lands whole or not at all: written beside
 * it, then renamed over it. A reader never sees half a file.
 */
function writeState(file, state) {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
    try {
        renameSync(temp, file);
    } catch (error) {
        rmSync(temp, { force: true });
        throw error;
    }
}

/**
 * Every watched window, paired with the percentage that forces a move.
 *
 * Thresholds differ by window because the windows differ in worth. A 5-hour window refills the
 * same day, so leaving a few percent behind costs almost nothing - but a weekly window is the
 * scarce resource on a large plan, and every percent abandoned there is gone for days.
 *
 * Accepts four shapes:
 *   bucket: "five_hour"                        one window, at `at`
 *   buckets: ["five_hour", "seven_day"]        several, all at `at`
 *   buckets: { five_hour: 95, seven_day: 99 }  per-window thresholds
 *   buckets: { seven_day: { at: 95, lateAt: 99, lateWithinSecs: 129600 } }
 *
 * The last shape raises the bar as the window nears its reset. Percent abandoned early in a
 * window is percent unavailable for days, so the move happens at `at`; once the refill is close
 * the same percent is nearly worthless, and `lateAt` drains the account instead of fleeing it.
 *
 * Given an `account`, its entry in `rule.perAccount` overrides the shared bars field by field:
 *   perAccount: { work: { seven_day: 80 } }                     weekly at 80, late bar as shared
 *   perAccount: { work: { seven_day: { lateAt: false } } }      no late bar for this account
 * The windows watched stay the shared ones; an override for an unwatched window is ignored.
 */
export function watchedBuckets(rule, account) {
    const fallbackAt = typeof rule?.at === "number" ? rule.at : 95;
    const num = (value, fallback) => (typeof value === "number" ? value : fallback);
    const own = account === undefined ? null : rule?.perAccount?.[account];
    const entryOf = (key, spec) => {
        const override = own?.[key];
        const merged = {
            ...(spec && typeof spec === "object" ? spec : { at: spec }),
            ...(override && typeof override === "object" ? override : typeof override === "number" ? { at: override } : {}),
        };
        const entry = { key, at: num(merged.at, fallbackAt) };
        // Both halves are required: a bar with no window, or a window with no bar, describes
        // nothing. Keeping them off the entry leaves the plain shape byte-identical.
        if (typeof merged.lateAt === "number" && typeof merged.lateWithinSecs === "number") {
            entry.lateAt = merged.lateAt;
            entry.lateWithinSecs = merged.lateWithinSecs;
        }
        return entry;
    };
    if (rule?.buckets && !Array.isArray(rule.buckets) && typeof rule.buckets === "object") {
        return Object.entries(rule.buckets).map(([key, spec]) => entryOf(key, spec));
    }
    const keys = Array.isArray(rule?.buckets) && rule.buckets.length ? rule.buckets : [rule?.bucket ?? "five_hour"];
    return keys.map((key) => entryOf(key, fallbackAt));
}

/**
 * Windows of `account` at or over their own threshold, with a reset still in the future.
 *
 * A reset already in the past marks a payload rendered before the window rolled over: acting on
 * it would flee a window that has just refilled, and would store an expired reset so the return
 * fires immediately. Such readings are treated as unreadable rather than exhausted.
 *
 * With `rule.switchAheadSecs`, a window under its bar also counts when the recent burn rate reaches
 * 100% within that many seconds, before the reset. A switch fires only on a render, and a long
 * subagent run can burn the last few percent between two renders - after which the turn dies on the
 * limit and the switch has to be made by hand. Such entries carry `burn: true`.
 */
function exhausted(limits, rule, account, now, history) {
    const ahead = typeof rule?.switchAheadSecs === "number" ? rule.switchAheadSecs : null;
    return watchedBuckets(rule, account)
        .map((bucket) => ({ ...bucket, limit: limits?.[bucket.key] }))
        .filter(({ limit }) => limit && typeof limit.used_percentage === "number" && limit.resets_at > now)
        .map((entry) => {
            const { key, limit, at, lateAt, lateWithinSecs } = entry;
            const near = lateWithinSecs !== undefined && limit.resets_at - now <= lateWithinSecs;
            if (limit.used_percentage >= (near ? lateAt : at)) return entry;
            if (ahead === null) return null;
            const wall = projectWall(limit, history?.[key], now);
            return wall?.beforeReset && wall.secondsToWall <= ahead ? { ...entry, burn: true } : null;
        })
        .filter(Boolean);
}

// Two readings of one window carry the same reset, give or take the payload's jitter.
const SAME_WINDOW_SECS = 300;

// How far past another account's last reading a stale copy of its payload can still have climbed:
// turns in flight at the switch finish on the account being left, after it was last filed.
const STALE_CLIMB_PCT = 2;

const sameWindow = (a, b) => Math.abs(a - b) <= SAME_WINDOW_SECS;

/** Each watched window the payload describes with a reset still ahead: `{ key, used, resets }`. */
function liveReadings(limits, rule, now) {
    return watchedBuckets(rule).flatMap(({ key }) => {
        const limit = limits?.[key];
        if (!limit || typeof limit.used_percentage !== "number" || !(limit.resets_at > now)) return [];
        return [{ key, used: limit.used_percentage, resets: limit.resets_at }];
    });
}

/**
 * Whether the payload describes another account than the active one.
 *
 * A session's `rate_limits` come from its own last API response, and a session left idle since a
 * switch keeps the account it last spoke to - for days, if it stays idle. Taken as the active
 * account's, such a payload can flee an account that is not spent, and files that account as about
 * to refill: once that stale reset passes it ranks as a fresh week and is switched into while
 * nearly spent.
 *
 * A window cannot move before its reset, so a reading outside the active account's own saved,
 * still running window belongs to some other account - or to a reset granted early. It is taken as
 * another account's only when it also falls in that account's saved window, at no more than that
 * account could have reached since it was left. Anything else - a first reading, a new week, two
 * accounts that happen to share a reset - is taken as the active account's.
 *
 * Except on the account rotation has just landed on, whose first reading decides whether to stop
 * and ask: there, any reading in another account's saved window waits for the next one, since the
 * account just left is over its bar by definition and its numbers would read as this one spent.
 */
function foreignPayload(state, active, limits, rule, now) {
    const verifying = state.verify === active;
    return liveReadings(limits, rule, now).some(({ key, used, resets }) => {
        const own = state.seen?.[active]?.buckets?.[key];
        if (own && own.resets > now && sameWindow(own.resets, resets)) return false;
        if (!verifying && (!own || own.resets <= now)) return false;
        return Object.entries(state.seen ?? {}).some(([name, seen]) => {
            const other = seen?.buckets?.[key];
            return name !== active && other && sameWindow(other.resets, resets) && used <= other.used + STALE_CLIMB_PCT;
        });
    });
}

/**
 * What the payload said about each account, kept from the renders where it was the active one.
 *
 * The payload describes one account, so this is the only way the others are ever known. It is
 * stale on utilization and exact on when the window rolls over - and staleness barely costs
 * anything, because an account nobody is using does not climb. What ages out is the reset, and a
 * reset in the past is the strongest possible answer: the window has refilled.
 *
 * Use within a window only climbs, so a lower reading of the window already saved is a stale
 * payload and the saved one stands. A reading whose reset has passed describes a window already
 * gone and is not filed.
 */
function observe(state, active, limits, rule, now) {
    if (!active || !limits) return state;
    const prior = state.seen?.[active]?.buckets;
    const buckets = {};
    for (const { key, used, resets } of liveReadings(limits, rule, now)) {
        const saved = prior?.[key];
        const climbed = saved && sameWindow(saved.resets, resets) ? Math.max(saved.used, used) : used;
        buckets[key] = { used: climbed, resets };
    }
    if (Object.keys(buckets).length === 0) return state;

    if (JSON.stringify(prior) === JSON.stringify(buckets)) return state;
    return { ...state, seen: { ...state.seen, [active]: { at: now, buckets } } };
}

/**
 * Room under its own bar for each watched window seen of an account, with when it resets.
 *
 * A window whose reset has passed counts as empty rather than as last seen: that is the one fact
 * time improves rather than degrades.
 */
function windowRooms(seen, rule, account, now) {
    return watchedBuckets(rule, account).flatMap(({ key, at, lateAt, lateWithinSecs }) => {
        const bucket = seen?.buckets?.[key];
        if (!bucket) return [];
        const rolled = bucket.resets <= now;
        const near = !rolled && lateWithinSecs !== undefined && bucket.resets - now <= lateWithinSecs;
        const bar = near ? lateAt : at;
        return [{ room: bar - (rolled ? 0 : bucket.used), resets: bucket.resets }];
    });
}

/**
 * How much room an account has left, as the tightest of its watched windows. Never observed counts
 * as wide open - assuming the worst of an unknown account would strand you on a spent one for no
 * reason.
 */
function headroom(seen, rule, account, now) {
    return Math.min(100, ...windowRooms(seen, rule, account, now).map((w) => w.room));
}

/**
 * When a spent account gets room again: the latest reset among the windows holding it over its
 * bar, since every one of them has to clear. Null when nothing holds it.
 */
function freeAt(seen, rule, account, now) {
    const over = windowRooms(seen, rule, account, now).filter((w) => w.room <= 0);
    return over.length ? Math.max(...over.map((w) => w.resets)) : null;
}

/**
 * Quota an account will lose at its weekly reset if nobody uses it: elapsed% - used%, the tightest
 * across the watched weekly windows. Unused quota is gone at the reset, so an account at 60% whose
 * week ends in two hours should be drained before one at 40% with six days left.
 *
 * A window whose reset has passed has refilled: its reset moves forward by whole windows and it
 * counts as unused. Only windows a week or longer count - a 5-hour window refills the same day and
 * loses nothing worth ranking on. Null when nothing weekly is watched or ever seen.
 */
/**
 * A seen window as it stands now: one whose reset has passed has refilled, so its reset moves
 * forward by whole windows and it counts as unused. Null when never seen.
 */
function current(bucket, windowSecs, now) {
    if (!bucket || typeof bucket.resets !== "number") return null;
    if (bucket.resets > now) return { used: bucket.used, resets: bucket.resets };
    return { used: 0, resets: bucket.resets + Math.ceil((now - bucket.resets + 1) / windowSecs) * windowSecs };
}

function spare(seen, rule, now) {
    let tightest = null;
    for (const { key } of watchedBuckets(rule)) {
        const windowSecs = windowLength(key);
        if (!(windowSecs >= WINDOW_SECS.seven_day)) continue;
        const reading = current(seen?.buckets?.[key], windowSecs, now);
        if (!reading) continue;
        const { used, resets } = reading;
        const p = computePace({ used_percentage: used, resets_at: resets }, windowSecs, now);
        if (!p) continue;
        const value = p.elapsedPct - used;
        tightest = tightest === null ? value : Math.min(tightest, value);
    }
    return tightest;
}

const rotationAccounts = (rule) =>
    Array.isArray(rule?.accounts) && rule.accounts.length > 1 ? rule.accounts : [rule?.primary, rule?.fallback].filter(Boolean);

/**
 * Every account, best first: eligible ones before the rest, then the most quota a reset would
 * waste, then the most room. Eligible means room left under its bars and a login that will not
 * stop refreshing within the margin.
 */
function rankAccounts(rule, state, logins, now) {
    return rotationAccounts(rule)
        .map((name) => {
            const room = headroom(state?.seen?.[name], rule, name, now);
            const reason = loginDead(logins, name, now) ? "login" : room > 0 ? null : "spent";
            return {
                name,
                eligible: reason === null,
                reason,
                room,
                spare: spare(state?.seen?.[name], rule, now),
                // Only a spent account frees on its own; a dead login waits for a re-login.
                freeAt: reason === "spent" ? freeAt(state?.seen?.[name], rule, name, now) : null,
            };
        })
        .sort((a, b) => b.eligible - a.eligible || (b.spare ?? 0) - (a.spare ?? 0) || b.room - a.room);
}

/**
 * The ranking as cc-account reads it from this engine's state file: `cc-account rotate` takes the
 * first eligible account that is not active while `at` is under six hours old.
 */
function publishedRanking(ranked, now) {
    return {
        at: now,
        accounts: ranked.map(({ name, eligible, reason, room, spare: s, freeAt: free }) => ({
            name,
            eligible,
            reason,
            room: Math.round(room),
            spare: s === null ? null : Math.round(s),
            freeAt: free,
        })),
    };
}

/** Rewritten when its content changes, or once it is old enough to look abandoned. */
function rankingDue(prior, next, now) {
    if (!prior || !Array.isArray(prior.accounts)) return true;
    if (now - (prior.at ?? 0) >= RANKING_REFRESH_SECS) return true;
    return JSON.stringify(prior.accounts) !== JSON.stringify(next.accounts);
}

/** The window the pool is judged on: the weekly one when watched, since that is the scarce one. */
function poolWindow(rule) {
    return watchedBuckets(rule).some((b) => b.key === "seven_day") ? "seven_day" : "five_hour";
}

/**
 * Files what the pool spent and when this person worked, for the forecast. Returns the same state
 * when neither moved, so an unchanged render writes nothing.
 */
function trackPool(state, active, limits, rule, now) {
    const ledger = recordUsage(state.ledger, rotationAccounts(rule).includes(active) ? active : null, limits?.[poolWindow(rule)], now);
    const activity = readActivity(state.activity, promptHistoryPath(), now);
    if (ledger === state.ledger && activity === state.activity) return state;
    return { ...state, ledger, activity };
}

/**
 * Whether the accounts in rotation, together, last at the current burn - published for cc-account
 * beside the ranking. The judgement stays here; cc-account only displays it.
 *
 * `burn` is the active account's window pace and `sustainable` how many accounts can be drawn on:
 * each refills once per window, so N of them sustain N.0x. An account whose login is about to stop
 * refreshing is not counted. `rate` and `allowed` are the pool's burn per hour of work and the most
 * it sustains, and the stop and refill are played forward from them over the hours this person
 * works; without a work pattern yet, from `burn` held around the clock.
 */
function forecast(rule, state, logins, limits, now) {
    const window = poolWindow(rule);
    const secs = WINDOW_SECS[window];
    const names = rotationAccounts(rule).filter((name) => !loginDead(logins, name, now));

    const p = computePace(limits?.[window], secs, now);
    const burn = p?.reliable ? Number(p.ratio.toFixed(2)) : null;

    const accounts = names.map((name) => {
        const seen = current(state?.seen?.[name]?.buckets?.[window], secs, now);
        return { name, used: seen ? Math.round(seen.used) : null, resets: seen?.resets ?? null };
    });
    const work = outlook({ accounts, ledger: state?.ledger, activity: state?.activity, limit: limits?.[window], windowSecs: secs, now });
    const flat = () => (burn > 0 ? simulate(accounts, () => (burn * 100) / secs, secs, now) : { runsOutAt: null, resumesAt: null });
    const { runsOutAt, resumesAt } = work ?? flat();
    return {
        at: now,
        window,
        burn,
        sustainable: names.length,
        rate: work?.rate ?? null,
        allowed: work?.allowed ?? null,
        workHours: work?.workHours ?? null,
        accounts,
        unknown: accounts.filter((a) => a.used === null).map((a) => a.name),
        runsOutAt,
        resumesAt,
    };
}

/** Two forecasts that say the same thing, whenever each was made. */
function sameForecast(a, b) {
    const { at: _a, ...restA } = a ?? {};
    const { at: _b, ...restB } = b ?? {};
    return JSON.stringify(restA) === JSON.stringify(restB);
}

/** The forecast the last decision published, for the status line. */
export function readForecast(configFile) {
    const f = readState(statePath(configFile))?.forecast;
    return f && typeof f === "object" ? f : null;
}

/**
 * Peers of equal worth: leave whichever account you are on once it is spent, for the best-ranked
 * peer. There is no reserve to protect and nothing to come back to, so the only question is where
 * to go next - and the ledger above is what answers it before the move rather than after.
 */
function decideAmong({ limits, rule, active, state, now, logins, history }) {
    if (!rule.accounts.includes(active)) return null;

    const over = exhausted(limits, rule, active, now, history);
    if (over.length === 0) return null;

    const target = rankAccounts(rule, state, logins, now).find((a) => a.eligible && a.name !== active);
    if (!target) return null;
    return { action: "to-peer", target: target.name, because: over.map((entry) => entry.key) };
}

/**
 * The question rotation is waiting on, or null. One stands while its account is live and still over
 * a bar; leaving that account - a manual `use` or `rotate` - is the answer.
 *
 * The first reading of an account rotation just landed on raises one when it is already over its
 * bar: the saved reading that chose it was wrong, and moving on by itself would trust the next
 * saved reading just as blindly.
 */
function pendingQuestion(state, active, over, now) {
    if (over.length === 0) return null;
    if (state.verify === active) {
        const used = Math.round(Math.max(...over.map((entry) => entry.limit.used_percentage)));
        return { reason: "spent", on: active, name: active, used, at: now };
    }
    return state.ask?.on === active ? state.ask : null;
}

/**
 * With `rule.askIfUnreadSecs`, whether an account was last read longer ago than that, or never.
 * A saved reading cannot see use made elsewhere - claude.ai, another machine - so past this age
 * the switch waits for a person instead of trusting it.
 */
function unread(rule, seen, now) {
    if (typeof rule?.askIfUnreadSecs !== "number") return false;
    return typeof seen?.at !== "number" || now - seen.at > rule.askIfUnreadSecs;
}

/**
 * Pure decision: what should happen for this payload, given who is active and what we remember.
 * `logins` is cc-account's published expiry per account; `history` the burn history, read only
 * when `rule.switchAheadSecs` is set.
 *
 * @returns {{action: "to-fallback"|"to-primary"|"to-peer", target: string, primaryResetsAt?: number|null}|null}
 */
export function decide({ limits, rule, active, state, now, logins = {}, history = null }) {
    if (!active) return null;
    if (Array.isArray(rule?.accounts) && rule.accounts.length > 1) {
        return decideAmong({ limits, rule, active, state, now, logins, history });
    }
    if (!rule?.primary || !rule?.fallback) return null;

    const grace = typeof rule.returnGraceSeconds === "number" ? rule.returnGraceSeconds : 60;

    if (active === rule.primary) {
        const over = exhausted(limits, rule, active, now, history);
        if (over.length === 0) return null;
        if (loginDead(logins, rule.fallback, now)) return null;
        // Blocked until the longest of the exhausted windows frees: a 5-hour window clears in
        // hours, a weekly one in days, and returning before then would just bounce straight back.
        const blockedUntil = Math.max(...over.map((entry) => entry.limit.resets_at));
        return {
            action: "to-fallback",
            target: rule.fallback,
            primaryResetsAt: blockedUntil,
            because: over.map((entry) => entry.key),
        };
    }

    if (active === rule.fallback) {
        const resetsAt = state?.primaryResetsAt;
        if (!resetsAt) return null;
        if (now < resetsAt + grace) return null;
        if (loginDead(logins, rule.primary, now)) return null;
        return { action: "to-primary", target: rule.primary, primaryResetsAt: null };
    }

    return null;
}

/** What the status bar should show, if anything. Never spawns. */
export function status(rule, state, now) {
    const peers = Array.isArray(rule?.accounts) && rule.accounts.length > 1;
    if (!peers && !rule?.primary) return null;
    if (state?.phase === "switching" && now - (state.firedAt ?? 0) < COOLDOWN_SECS) {
        return { kind: "switching", target: state.target };
    }
    if (peers) {
        // Spent, with every peer still inside the window that emptied it. The countdown is to the
        // first one that frees, which is the only move available.
        if (state?.held) {
            const secs = (state.held.at ?? 0) - now;
            if (secs > 0) return { kind: "held", secondsUntilFree: secs, target: state.held.name };
            return { kind: "held", secondsUntilFree: 0, target: state.held.name };
        }
        return null;
    }
    if (state?.primaryResetsAt) {
        const secs = state.primaryResetsAt + (rule.returnGraceSeconds ?? 60) - now;
        if (secs > 0) return { kind: "waiting", secondsUntilReturn: secs, target: rule.primary };
    }
    return null;
}

const shortTime = (secs) => {
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d > 0) return `${d}d${h}h`;
    return h > 0 ? `${h}h${m}m` : `${m}m`;
};

// U+27F3 renders as a missing glyph in common terminal fonts, so the marks below stay within
// characters those fonts actually carry. `ascii: true` drops to plain text for the rest.
const GLYPHS = {
    unicode: { to: "→", back: "↩", done: "✓", warn: "!" },
    ascii: { to: "->", back: "<-", done: "ok", warn: "!" },
};

/**
 * The rendered form of `status`, written into the state file so every renderer can display it
 * with a single field read instead of reimplementing the formatting.
 */
export function display(rule, state, now, { active } = {}) {
    const g = rule?.ascii ? GLYPHS.ascii : GLYPHS.unicode;
    const s = status(rule, state, now);

    if (s?.kind === "switching") return `${g.to} switching to ${s.target}`;

    // A switch that did not happen is worth more of the bar than any receipt: it is the only sign
    // the account tool is unreachable, since the command runs detached with its output discarded.
    if (state?.failed && now - state.failed.at < RETRY_SECS) {
        return `${g.warn} switch to ${state.failed.target} failed`;
    }

    // Rotation has stopped and waits for a person: nothing else on the bar matters more.
    if (state?.ask?.on === active) {
        const { reason, name, used, readAt } = state.ask;
        if (reason === "spent") return `${g.warn} ${name} already at ${used}% · pick an account`;
        const age = typeof readAt === "number" ? `last read ${shortTime(now - readAt)} ago` : "never read";
        return `${g.warn} ${name} ${age} · switch?`;
    }

    if (s?.kind === "held") {
        const left = shortTime(s.secondsUntilFree);
        return `${g.warn} all limited · ${s.target} in ${left}`;
    }

    if (s?.kind === "waiting" && active === rule.fallback) {
        const left = shortTime(s.secondsUntilReturn);
        // Both sides capped: there is nowhere better to move, so say so rather than counting
        // down to a switch that would only bounce back.
        if (state?.fallbackExhausted) {
            return `${g.warn} both limited · ${s.target} in ${left}`;
        }
        return `${g.back} ${s.target} in ${left}`;
    }

    // Both receipts are claims about where you are, so they hold only while that is still true.
    // A manual switch inside the two minutes makes the account named here the one you just left.
    const fresh = now - (state?.completedAt ?? 0) < 120;
    if (fresh && state?.lastAction === "to-peer" && active === state.target) {
        return `${g.done} on ${state.target}`;
    }
    if (fresh && state?.lastAction === "to-primary" && active === rule.primary) {
        return `${g.done} back on ${rule.primary}`;
    }
    if (fresh && state?.lastAction === "to-fallback" && active === rule.fallback) {
        return `${g.done} on ${rule.fallback}`;
    }
    return null;
}

function launch(command) {
    spawn(command, { shell: true, detached: true, stdio: "ignore", windowsHide: true }).unref();
}

/**
 * One line per decision that changed something, appended beside the state file.
 *
 * The state file holds only the present, so a switch nobody watched leaves nothing to read
 * afterwards but file timestamps. Transitions are rare - a handful a day - so this stays small
 * without pruning, and it is the difference between reconstructing a switch and reading it.
 *
 * Best effort by contract: a statusline must render whether or not the disk cooperates.
 */
function logEvent(configFile, rule, event, fields = {}) {
    try {
        if (rule?.log === false) return;
        const file = rule?.log || join(dirname(configFile), "rotate.log");
        const parts = Object.entries(fields)
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([key, value]) => `${key}=${value}`);
        appendFileSync(file, `${new Date().toISOString()} ${event} ${parts.join(" ")}\n`.trim() + "\n");
    } catch {
        /* the bar renders regardless */
    }
}

/** What the payload said about the windows that forced a move, for the log line. `~burn` marks a projected wall. */
const readingsOf = (over) =>
    over.map(({ key, limit, burn }) => `${key}:${Math.round(limit.used_percentage)}%${burn ? "~burn" : ""}`).join(",");

/**
 * Evaluates the rule and switches when due. Returns the action taken, or null.
 */
export function runRotation(limits, rule, configFile, nowSecs = Math.floor(Date.now() / 1000)) {
    try {
        // Switched off from cc-account's menu: no decision, no spawn, no status and no filing.
        if (rule?.enabled === false) return null;
        const peers = Array.isArray(rule?.accounts) && rule.accounts.length > 1;
        if (!peers && (!rule?.primary || !rule?.fallback)) return null;

        const store = rule.store || join(homedir(), ".claude-accounts");
        const file = statePath(configFile);
        const stored = readState(file);
        // Mid-write by another session, or damaged: skip this render rather than replace it.
        if (stored === null) return null;
        const { active, switchedAt, logins } = published(store);
        // Read-only here: the status line writes the history on every render.
        const history = typeof rule.switchAheadSecs === "number" ? readHistory(historyPath(configFile)) : null;

        // Clear the in-flight marker as soon as the switch lands, rather than waiting out the
        // cooldown - otherwise a short window could expire before the next decision is allowed.
        let state = stored;
        if (stored.phase === "switching") {
            const landed = active && active === stored.target;
            if (!landed && nowSecs - (stored.firedAt ?? 0) < COOLDOWN_SECS) {
                writeState(file, { ...stored, display: display(rule, stored, nowSecs, { active }) });
                return null;
            }
            // The switch runs detached with its output discarded, so the account tool publishing
            // the target is the only evidence it worked. Without this split a switch that never
            // happened is recorded as one that did, and the bar reports a move you did not make.
            // A peer is chosen on what was saved of it, which is days old; its first reading as the
            // live account is the check the move itself could not make.
            state = landed
                ? { ...stored, phase: "idle", lastAction: stored.action, completedAt: nowSecs, failed: null, verify: peers ? stored.target : null }
                : {
                      ...stored,
                      phase: "idle",
                      lastAction: null,
                      completedAt: nowSecs,
                      failed: { target: stored.target, at: nowSecs },
                  };
            writeState(file, state);
            logEvent(configFile, rule, landed ? "land" : "fail", {
                target: stored.target,
                active,
                after: `${nowSecs - (stored.firedAt ?? nowSecs)}s`,
            });
        }

        // The account changed too recently for this payload to describe it. Render, decide nothing -
        // and record nothing, because filing these readings under the new account would write the
        // account you just left into the ledger as though it were the one you arrived at.
        // A session idle since a switch still holds another account's numbers: the same rule applies.
        const settling = nowSecs - (switchedAt ?? 0) < SETTLE_SECS;
        if (settling || foreignPayload(state, active, limits, rule, nowSecs)) {
            const text = display(rule, state, nowSecs, { active });
            if (state.display !== text) writeState(file, { ...state, display: text });
            return null;
        }

        // A render that only files a reading still has something new to save, and the checks below
        // compare against the post-observation state - so the change is tracked here or not at all.
        let observed = trackPool(observe(state, active, limits, rule, nowSecs), active, limits, rule, nowSecs);
        const ranking = publishedRanking(rankAccounts(rule, observed, logins, nowSecs), nowSecs);
        const outlook = forecast(rule, observed, logins, limits, nowSecs);
        // The forecast moves with the burn, more often than the ranking; each is rewritten when its
        // own content moves, and both whenever the ranking is.
        const rankingMoved = rankingDue(observed.ranking, ranking, nowSecs);
        const outlookMoved = rankingMoved || !sameForecast(observed.forecast, outlook);
        if (rankingMoved || outlookMoved) {
            observed = {
                ...observed,
                ranking: rankingMoved ? ranking : observed.ranking,
                forecast: outlookMoved ? outlook : observed.forecast,
            };
        }
        const filed = observed !== state;
        const over = exhausted(limits, rule, active, nowSecs, history);
        const asked = peers ? pendingQuestion(state, active, over, nowSecs) : state.ask ?? null;
        state = { ...observed, verify: null, ask: asked };

        let hit = asked ? null : decide({ limits, rule, active, state, now: nowSecs, logins, history });
        if (hit && peers && unread(rule, state.seen?.[hit.target], nowSecs)) {
            const readAt = state.seen?.[hit.target]?.at ?? null;
            state = { ...state, ask: { reason: "unread", on: active, name: hit.target, readAt, at: nowSecs } };
            hit = null;
        }
        const raised = state.ask && state.ask !== observed.ask ? state.ask : null;
        const changed =
            filed || (observed.verify ?? null) !== null || JSON.stringify(observed.ask ?? null) !== JSON.stringify(state.ask);
        if (raised) {
            logEvent(configFile, rule, "ask", {
                reason: raised.reason,
                on: raised.on,
                target: raised.name,
                read: raised.reason === "spent" ? readingsOf(over) : raised.readAt === null ? "never" : `${shortTime(nowSecs - raised.readAt)}-ago`,
            });
        }

        if (!hit) {
            let next = state;
            if (peers) {
                // Nowhere with room is the one thing the bar must say plainly, so it is recorded
                // rather than recomputed: the renderer never sees the payload. A pending question
                // is not "nowhere": somewhere may have room, and the answer decides.
                const stuck = over.length > 0 && !state.ask;
                const soonest = rule.accounts
                    .filter((name) => name !== active)
                    .flatMap((name) =>
                        Object.values(state.seen?.[name]?.buckets ?? {}).map((b) => ({
                            name,
                            at: b.resets,
                        })),
                    )
                    .filter(({ at }) => at > nowSecs)
                    .sort((a, b) => a.at - b.at)[0];
                const held = stuck && soonest ? soonest : null;
                if (JSON.stringify(state.held ?? null) !== JSON.stringify(held)) {
                    next = { ...state, held };
                }
            }
            // `primaryResetsAt` means "we fled the primary, return at T". Standing on the primary
            // makes it answered, however we got here - a manual `use`, a login, or our own return.
            // Left set it outlives its window and fires against the next visit to the fallback,
            // days later.
            if (!peers && active === rule.primary && state.primaryResetsAt) {
                next = { ...state, primaryResetsAt: null };
            }
            if (!peers && active === rule.fallback) {
                // While parked here, watch this account too: if it is also capped there is nowhere
                // to move, and the status line should say that instead of promising a switch.
                const capped = over.length > 0;
                if (state.fallbackExhausted !== capped) next = { ...state, fallbackExhausted: capped };
            }
            const text = display(rule, next, nowSecs, { active });
            if (changed || next !== state || next.display !== text) {
                writeState(file, { ...next, display: text });
            }
            return null;
        }

        // A switch that failed leaves the account still over its bar, so the next render decides to
        // move again - once per keystroke, against a target that is not answering. Hold off long
        // enough that a broken command costs a line in the log instead of a spawn storm.
        if (state.failed?.target === hit.target && nowSecs - state.failed.at < RETRY_SECS) {
            const text = display(rule, state, nowSecs, { active });
            if (changed || state.display !== text) writeState(file, { ...state, display: text });
            return null;
        }

        const switching = {
            phase: "switching",
            target: hit.target,
            action: hit.action,
            firedAt: nowSecs,
            // For a to-fallback hit this is the latest reset among the exhausted buckets, so a
            // weekly cap holds the return for days rather than hours.
            primaryResetsAt: hit.primaryResetsAt,
            // The ledger survives the switch: it is how the account being left is judged when it
            // becomes a candidate again.
            seen: state.seen,
            // cc-account reads the ranking during the switch too, so it survives like the ledger.
            ranking: state.ranking,
            forecast: state.forecast,
            ledger: state.ledger,
            activity: state.activity,
            because: hit.because ?? null,
            fallbackExhausted: false,
            held: null,
        };
        writeState(file, { ...switching, display: display(rule, switching, nowSecs, { active }) });
        logEvent(configFile, rule, "fire", {
            action: hit.action,
            from: active,
            target: hit.target,
            because: hit.because?.join(",") ,
            read: readingsOf(over),
        });

        const bin = rule.command || "cc-account";
        launch(`${bin} use ${hit.target}`);
        return hit.action;
    } catch {
        return null;
    }
}
