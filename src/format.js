// Short human formats. Everything here is pure.

import { modelOf } from "./pace.js";

// Display names for the account-wide windows, in the order they render. Both the limit segments
// and the burn warning name a bucket from here, so one bucket reads the same wherever it appears.
export const LABELS = {
    five_hour: "Session",
    seven_day: "Week",
};

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Curated name for an account-wide window, the model's name for a model-specific one
 * (`seven_day_fable` -> "Fable"), and a humanised key for anything else Claude Code starts sending.
 */
export function label(key) {
    if (LABELS[key]) return LABELS[key];
    const model = modelOf(key);
    if (model) return capitalise(model.replace(/_/g, " "));
    return key.replace(/_/g, " ");
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Compact "time from now" - the statusline has no room for full words.
 * 2d1h / 4h37m / 12m / now
 */
export function duration(secs) {
    if (secs <= 0) return "now";
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d > 0) return `${d}d${h}h`;
    if (h > 0) return `${h}h${m}m`;
    return `${m}m`;
}

/** Whole local days between two instants, counted by calendar date rather than elapsed hours. */
function dayOffset(target, reference) {
    const a = new Date(target.getFullYear(), target.getMonth(), target.getDate());
    const b = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
    return Math.round((a - b) / 86400000);
}

/**
 * Local 24h clock, dated relative to now: "today 18:39", "tomorrow 04:15", "Fri 16:26",
 * "Sat 14 16:15".
 *
 * A weekday name is precise but needs a moment's thought - "Wed 18:39" reads as a future date even
 * when Wednesday is today. Within a day either side, the relative word is unambiguous; within six
 * days either side, the weekday is. A week or more away, the weekday is today's or recurs, so the
 * day of the month goes beside it: a pool forecast played across a whole window lands there.
 */
export function clock(unixSecs, nowSecs = Math.floor(Date.now() / 1000), DateImpl = Date) {
    const d = new DateImpl(unixSecs * 1000);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");

    const offset = dayOffset(d, new DateImpl(nowSecs * 1000));
    const weekday = Math.abs(offset) < 7 ? DAYS[d.getDay()] : `${DAYS[d.getDay()]} ${d.getDate()}`;
    const day = { 0: "today", 1: "tomorrow", "-1": "yesterday" }[offset] ?? weekday;
    return `${day} ${hh}:${mm}`;
}

export function percent(value) {
    return `${Math.round(value)}%`;
}

/** Token counts as the eye reads them: 950, 270k, 2.4m. */
export function tokens(value) {
    if (value < 1000) return String(Math.round(value));
    if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
    return `${(value / 1_000_000).toFixed(1)}m`;
}

export function ratio(value) {
    return `${value.toFixed(2)}x`;
}

// A model below this share of the session's spend is left out of the mix.
const MIX_FLOOR_PCT = 5;

// Effort levels as the line spells them; any other level is shown as sent.
const EFFORT = { medium: "med" };

/**
 * What the session is burning with: "Opus 5/high+ +fast", the `+` right after the effort marking
 * thinking. Shown beside a ratio that is over budget, it turns "too fast" into a cause and so into
 * an action. Every field is optional.
 *
 * With `mix` - each model's share of the session's spend, subagents included - and a second model
 * worth naming, the shares follow: "Opus 5.5/med+ 71% · Sonnet 5.5 29%". The settings describe the
 * main conversation's model only; the payload has none for a subagent's.
 */
export function cause(payload, mix = []) {
    const name = payload?.model?.display_name || payload?.model?.id;
    if (typeof name !== "string" || !name) return "";
    let out = name;
    const effort = payload?.effort?.level;
    if (typeof effort === "string" && effort) out += `/${EFFORT[effort] ?? effort}`;
    if (payload?.thinking?.enabled === true) out += "+";
    if (payload?.fast_mode === true) out += " +fast";

    const named = (mix ?? []).filter((m) => m.share >= MIX_FLOOR_PCT);
    if (named.length < 2) return out;
    const main = named.find((m) => m.model === payload?.model?.id);
    const others = named.filter((m) => m !== main).map((m) => `${m.name} ${percent(m.share)}`);
    return [main ? `${out} ${percent(main.share)}` : out, ...others].join(" · ");
}
