// Short human formats. Everything here is pure.

// Display names for the rate-limit buckets, in the order they render. Both the limit segments and
// the wall segment name a bucket from here, so one bucket reads the same wherever it appears.
export const LABELS = {
    five_hour: "Session",
    seven_day: "Weekly",
    seven_day_opus: "Opus",
    seven_day_sonnet: "Sonnet",
};

/** Curated name for a known bucket; a humanised key for anything Claude Code starts sending. */
export function label(key) {
    return LABELS[key] || key.replace(/_/g, " ");
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
 * Local 24h clock, dated relative to now: "today 18:39", "tomorrow 04:15", "Fri 16:26".
 *
 * A weekday name is precise but needs a moment's thought - "Wed 18:39" reads as a future date even
 * when Wednesday is today. Within a day either side, the relative word is unambiguous; beyond that
 * the weekday is, because a rate-limit window never spans more than a week.
 */
export function clock(unixSecs, nowSecs = Math.floor(Date.now() / 1000), DateImpl = Date) {
    const d = new DateImpl(unixSecs * 1000);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");

    const offset = dayOffset(d, new DateImpl(nowSecs * 1000));
    const day = { 0: "today", 1: "tomorrow", "-1": "yesterday" }[offset] ?? DAYS[d.getDay()];
    return `${day} ${hh}:${mm}`;
}

export function percent(value) {
    return `${Math.round(value)}%`;
}

export function ratio(value) {
    return `${value.toFixed(2)}x`;
}
