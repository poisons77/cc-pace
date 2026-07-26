// Short human formats. Everything here is pure.

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

/**
 * Weekday + local 24h clock, e.g. "Tue 16:26". Dates further out than a week are ambiguous, but a
 * rate-limit window never is.
 */
export function clock(unixSecs, DateImpl = Date) {
    const d = new DateImpl(unixSecs * 1000);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${DAYS[d.getDay()]} ${hh}:${mm}`;
}

export function percent(value) {
    return `${Math.round(value)}%`;
}

export function ratio(value) {
    return `${value.toFixed(2)}x`;
}
