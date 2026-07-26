// Burn-pace math. Pure and time-injectable so it is testable without clock mocking.

export const WINDOW_SECS = {
    five_hour: 5 * 3600,
    seven_day: 7 * 86400,
    seven_day_opus: 7 * 86400,
    seven_day_sonnet: 7 * 86400,
};

/**
 * A rate-limit window starts exactly `windowSecs` before it resets, so the budget pace is simply
 * "used% should track elapsed%". Anything above 1 is spending faster than the window can afford.
 *
 * @param {{used_percentage:number, resets_at:number}} limit
 * @param {number} windowSecs Length of the limit window in seconds.
 * @param {number} nowSecs Unix seconds.
 * @returns {null|{ratio:number, elapsedPct:number, usedPct:number, depletesAt:number|null,
 *                 depletesBeforeReset:boolean, safeRatePerDay:number|null, resetsAt:number}}
 */
export function computePace(limit, windowSecs, nowSecs) {
    if (!limit || typeof limit.used_percentage !== "number" || !limit.resets_at) return null;

    const usedPct = limit.used_percentage;
    const startsAt = limit.resets_at - windowSecs;
    const elapsed = nowSecs - startsAt;
    if (elapsed <= 0) return null;

    const elapsedPct = (elapsed / windowSecs) * 100;
    const ratio = elapsedPct === 0 ? 0 : usedPct / elapsedPct;

    // Project the current average rate forward to the moment usage would hit 100%.
    let depletesAt = null;
    if (usedPct > 0) depletesAt = startsAt + Math.round((elapsed * 100) / usedPct);

    // Budget still on the table, spread evenly across whatever time is left.
    const remainingSecs = limit.resets_at - nowSecs;
    const safeRatePerDay =
        remainingSecs > 0 ? Math.max(0, 100 - usedPct) / (remainingSecs / 86400) : null;

    return {
        usedPct,
        elapsedPct,
        ratio,
        depletesAt,
        depletesBeforeReset: depletesAt !== null && depletesAt < limit.resets_at,
        safeRatePerDay,
        resetsAt: limit.resets_at,
    };
}

/**
 * @returns {"ok"|"warn"|"danger"}
 */
export function paceLevel(ratio, { warn = 0.95, danger = 1.1 } = {}) {
    if (ratio > danger) return "danger";
    if (ratio >= warn) return "warn";
    return "ok";
}
