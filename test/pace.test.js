import { test } from "node:test";
import assert from "node:assert/strict";

import { computePace, paceLevel, WINDOW_SECS } from "../src/pace.js";

const NOW = 1800000000;
const WEEK = WINDOW_SECS.seven_day;
const weekly = (used, secsUntilReset) => ({
    used_percentage: used,
    resets_at: NOW + secsUntilReset,
});

test("elapsed percentage is derived from the window, not from history", () => {
    // 2 days left in a 7 day window means 5/7 of it has gone.
    const p = computePace(weekly(71, 172800), WEEK, NOW);
    assert.equal(p.elapsedPct.toFixed(2), "71.43");
});

test("ratio of 1 means usage exactly tracks the budget", () => {
    const p = computePace(weekly(50, WEEK / 2), WEEK, NOW);
    assert.equal(p.ratio.toFixed(3), "1.000");
});

test("projected depletion lands on the reset when perfectly on pace", () => {
    const limit = weekly(50, WEEK / 2);
    const p = computePace(limit, WEEK, NOW);
    assert.equal(p.depletesAt, limit.resets_at);
    assert.equal(p.depletesBeforeReset, false);
});

test("burning fast depletes before the window resets", () => {
    const p = computePace(weekly(90, 172800), WEEK, NOW);
    assert.ok(p.ratio > 1.2, `expected >1.2, got ${p.ratio}`);
    assert.equal(p.depletesBeforeReset, true);
    assert.ok(p.depletesAt < NOW + 172800);
});

test("burning slowly never depletes", () => {
    const p = computePace(weekly(30, 172800), WEEK, NOW);
    assert.ok(p.ratio < 0.5);
    assert.equal(p.depletesBeforeReset, false);
});

test("zero usage yields no projection and no division by zero", () => {
    const p = computePace(weekly(0, 172800), WEEK, NOW);
    assert.equal(p.ratio, 0);
    assert.equal(p.depletesAt, null);
    assert.equal(p.depletesBeforeReset, false);
});

test("safe rate spreads the remaining budget over the remaining days", () => {
    // 40% left, 2 days to go.
    const p = computePace(weekly(60, 172800), WEEK, NOW);
    assert.equal(p.safeRatePerDay.toFixed(2), "20.00");
});

test("a window that has not started yet is not projected", () => {
    assert.equal(computePace(weekly(10, WEEK), WEEK, NOW), null);
});

test("missing or malformed buckets return null", () => {
    assert.equal(computePace(null, WEEK, NOW), null);
    assert.equal(computePace({}, WEEK, NOW), null);
    assert.equal(computePace({ used_percentage: 10 }, WEEK, NOW), null);
    assert.equal(computePace({ resets_at: NOW + 10 }, WEEK, NOW), null);
});

test("levels sit on the documented thresholds", () => {
    assert.equal(paceLevel(0.94), "ok");
    assert.equal(paceLevel(0.95), "warn");
    assert.equal(paceLevel(1.1), "warn");
    assert.equal(paceLevel(1.11), "danger");
});

test("thresholds are configurable", () => {
    assert.equal(paceLevel(1.05, { warn: 1.2, danger: 1.5 }), "ok");
});

test("the five hour window is five hours", () => {
    const p = computePace({ used_percentage: 50, resets_at: NOW + 3600 }, WINDOW_SECS.five_hour, NOW);
    assert.equal(p.elapsedPct.toFixed(2), "80.00");
});
