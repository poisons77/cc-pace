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
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

/** Written by cc-account on every switch - the only reliable source of account identity. */
function activeAccount(store) {
    try {
        const file = join(store, "rotation-state.json");
        return JSON.parse(readFileSync(file, "utf8")).active ?? null;
    } catch {
        return null;
    }
}

/** When the active account last changed, or null when cc-account has never published one. */
function switchedAt(store) {
    try {
        const file = join(store, "rotation-state.json");
        const stamp = JSON.parse(readFileSync(file, "utf8")).switchedAt;
        return typeof stamp === "number" ? stamp : null;
    } catch {
        return null;
    }
}

function readState(file) {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return {};
    }
}

function writeState(file, state) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Pure decision: what should happen for this payload, given who is active and what we remember.
 *
 * @returns {{action: "to-fallback"|"to-primary", target: string, primaryResetsAt: number|null}|null}
 */
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
 */
export function watchedBuckets(rule) {
    const fallbackAt = typeof rule?.at === "number" ? rule.at : 95;
    const num = (value, fallback) => (typeof value === "number" ? value : fallback);
    if (rule?.buckets && !Array.isArray(rule.buckets) && typeof rule.buckets === "object") {
        return Object.entries(rule.buckets).map(([key, spec]) => {
            if (!spec || typeof spec !== "object") return { key, at: num(spec, fallbackAt) };
            const entry = { key, at: num(spec.at, fallbackAt) };
            // Both halves are required: a bar with no window, or a window with no bar, describes
            // nothing. Keeping them off the entry leaves the plain shape byte-identical.
            if (typeof spec.lateAt === "number" && typeof spec.lateWithinSecs === "number") {
                entry.lateAt = spec.lateAt;
                entry.lateWithinSecs = spec.lateWithinSecs;
            }
            return entry;
        });
    }
    if (Array.isArray(rule?.buckets) && rule.buckets.length) {
        return rule.buckets.map((key) => ({ key, at: fallbackAt }));
    }
    return [{ key: rule?.bucket ?? "five_hour", at: fallbackAt }];
}

/**
 * Windows at or over their own threshold, with a reset still in the future.
 *
 * A reset already in the past marks a payload rendered before the window rolled over: acting on
 * it would flee a window that has just refilled, and would store an expired reset so the return
 * fires immediately. Such readings are treated as unreadable rather than exhausted.
 */
function exhausted(limits, rule, now) {
    return watchedBuckets(rule)
        .map((bucket) => ({ ...bucket, limit: limits?.[bucket.key] }))
        .filter(({ limit, at, lateAt, lateWithinSecs }) => {
            if (!limit || typeof limit.used_percentage !== "number") return false;
            if (!(limit.resets_at > now)) return false;
            const near = lateWithinSecs !== undefined && limit.resets_at - now <= lateWithinSecs;
            return limit.used_percentage >= (near ? lateAt : at);
        });
}

/**
 * What the payload said about each account, kept from the renders where it was the active one.
 *
 * The payload describes one account, so this is the only way the others are ever known. It is
 * stale on utilization and exact on when the window rolls over - and staleness barely costs
 * anything, because an account nobody is using does not climb. What ages out is the reset, and a
 * reset in the past is the strongest possible answer: the window has refilled.
 */
function observe(state, active, limits, rule, now) {
    if (!active || !limits) return state;
    const buckets = {};
    for (const { key } of watchedBuckets(rule)) {
        const limit = limits[key];
        if (limit && typeof limit.used_percentage === "number" && limit.resets_at) {
            buckets[key] = { used: limit.used_percentage, resets: limit.resets_at };
        }
    }
    if (Object.keys(buckets).length === 0) return state;

    const prior = state.seen?.[active];
    const same =
        prior && JSON.stringify(prior.buckets) === JSON.stringify(buckets);
    if (same) return state;
    return { ...state, seen: { ...state.seen, [active]: { at: now, buckets } } };
}

/**
 * How much room an account has left, as the tightest of its watched windows.
 *
 * A window whose reset has passed counts as empty rather than as last seen: that is the one fact
 * time improves rather than degrades. Never observed counts as wide open - assuming the worst of
 * an unknown account would strand you on a spent one for no reason.
 */
function headroom(seen, rule, now) {
    let worst = 100;
    for (const { key, at, lateAt, lateWithinSecs } of watchedBuckets(rule)) {
        const bucket = seen?.buckets?.[key];
        if (!bucket) continue;
        const rolled = bucket.resets <= now;
        const near = !rolled && lateWithinSecs !== undefined && bucket.resets - now <= lateWithinSecs;
        const bar = near ? lateAt : at;
        worst = Math.min(worst, bar - (rolled ? 0 : bucket.used));
    }
    return worst;
}

/**
 * Peers of equal worth: leave whichever account you are on once it is spent, for whichever peer
 * has room. There is no reserve to protect and nothing to come back to, so the only question is
 * where to go next - and the ledger above is what answers it before the move rather than after.
 */
function decideAmong({ limits, rule, active, state, now }) {
    const accounts = rule.accounts;
    if (!accounts.includes(active)) return null;

    const over = exhausted(limits, rule, now);
    if (over.length === 0) return null;

    const roomy = accounts
        .filter((name) => name !== active)
        .map((name) => ({ name, room: headroom(state?.seen?.[name], rule, now) }))
        .filter(({ room }) => room > 0);
    if (roomy.length === 0) return null;

    // Most room first, so a switch buys the longest stretch before the next one.
    const target = roomy.sort((a, b) => b.room - a.room)[0].name;
    return { action: "to-peer", target, because: over.map((entry) => entry.key) };
}

export function decide({ limits, rule, active, state, now }) {
    if (!active) return null;
    if (Array.isArray(rule?.accounts) && rule.accounts.length > 1) {
        return decideAmong({ limits, rule, active, state, now });
    }
    if (!rule?.primary || !rule?.fallback) return null;

    const grace = typeof rule.returnGraceSeconds === "number" ? rule.returnGraceSeconds : 60;

    if (active === rule.primary) {
        const over = exhausted(limits, rule, now);
        if (over.length === 0) return null;
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

/** What the payload said about the windows that forced a move, for the log line. */
const readingsOf = (over) =>
    over.map(({ key, limit }) => `${key}:${Math.round(limit.used_percentage)}%`).join(",");

/**
 * Evaluates the rule and switches when due. Returns the action taken, or null.
 */
export function runRotation(limits, rule, configFile, nowSecs = Math.floor(Date.now() / 1000)) {
    try {
        const peers = Array.isArray(rule?.accounts) && rule.accounts.length > 1;
        if (!peers && (!rule?.primary || !rule?.fallback)) return null;

        const store = rule.store || join(homedir(), ".claude-accounts");
        const file = statePath(configFile);
        const stored = readState(file);
        const active = activeAccount(store);

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
            state = landed
                ? { ...stored, phase: "idle", lastAction: stored.action, completedAt: nowSecs, failed: null }
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
        const settling = nowSecs - (switchedAt(store) ?? 0) < SETTLE_SECS;
        if (settling) {
            const text = display(rule, state, nowSecs, { active });
            if (state.display !== text) writeState(file, { ...state, display: text });
            return null;
        }

        // A render that only files a reading still has something new to save, and the checks below
        // compare against the post-observation state - so the change is tracked here or not at all.
        const observed = observe(state, active, limits, rule, nowSecs);
        const filed = observed !== state;
        state = observed;

        const hit = decide({ limits, rule, active, state, now: nowSecs });

        if (!hit) {
            let next = state;
            if (peers) {
                // Nowhere with room is the one thing the bar must say plainly, so it is recorded
                // rather than recomputed: the renderer never sees the payload.
                const stuck = exhausted(limits, rule, nowSecs).length > 0;
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
                const capped = exhausted(limits, rule, nowSecs).length > 0;
                if (state.fallbackExhausted !== capped) next = { ...state, fallbackExhausted: capped };
            }
            const text = display(rule, next, nowSecs, { active });
            if (filed || next !== state || next.display !== text) {
                writeState(file, { ...next, display: text });
            }
            return null;
        }

        // A switch that failed leaves the account still over its bar, so the next render decides to
        // move again - once per keystroke, against a target that is not answering. Hold off long
        // enough that a broken command costs a line in the log instead of a spawn storm.
        if (state.failed?.target === hit.target && nowSecs - state.failed.at < RETRY_SECS) {
            const text = display(rule, state, nowSecs, { active });
            if (filed || state.display !== text) writeState(file, { ...state, display: text });
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
            read: readingsOf(exhausted(limits, rule, nowSecs)),
        });

        const bin = rule.command || "cc-account";
        launch(`${bin} use ${hit.target}`);
        return hit.action;
    } catch {
        return null;
    }
}
