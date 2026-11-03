process.env.TZ = "UTC";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { record, recentRate, projectWall, trimImplausible, update } from "../src/burn.js";

const T0 = 1_000_000;
const RESET = T0 + 2 * 86400;
const wk = (u, r = RESET) => ({ seven_day: { used_percentage: u, resets_at: r } });
const historyFile = () => join(mkdtempSync(join(tmpdir(), "cc-pace-")), "burn-history.json");

test("a quiet stretch followed by a hard hour is visible in the recent rate", () => {
    let h = {};
    h = record(h, wk(60.0), T0 - 7200);
    h = record(h, wk(60.2), T0 - 3600);
    h = record(h, wk(66.0), T0 - 1800);
    h = record(h, wk(72.0), T0);

    const rate = recentRate(h.seven_day, T0);
    assert.ok(rate > 0);
    assert.equal(Math.round(rate * 3600 * 10) / 10, 11.8, "≈11.8%/h over the recent stretch");

    const wall = projectWall(wk(72).seven_day, h.seven_day, T0);
    assert.ok(wall.beforeReset, "the wall lands before the window resets");
    assert.equal(Math.round(wall.secondsToWall / 360) / 10, 2.4, "≈2.4h away");

    // The cumulative view for the same moment reads ~1.01x - on budget, wall two days out.
    const elapsedPct = ((7 * 86400 - (RESET - T0)) / (7 * 86400)) * 100;
    assert.equal(Math.round((72 / elapsedPct) * 100) / 100, 1.01);
});

test("a stale reading from an idle session cannot fake a steep slope", () => {
    // rate_limits arrives per session from that session's last API response, so an idle session
    // reports an old, lower number for the same window. Observed live: 8% then 26% 67s apart.
    let h = record({}, wk(8), T0);
    h = record(h, wk(26), T0 + 67);

    assert.equal(h.seven_day.length, 1, "the stale sample is dropped, not averaged in");
    assert.equal(h.seven_day[0].u, 26, "the newer reading is kept");
    assert.equal(recentRate(h.seven_day, T0 + 67), null, "one sample supports no slope");
});

test("history poisoned before the guard existed heals itself on read", () => {
    // Verbatim from ~/.config/cc-pace/burn-history.json: an 8% sample from an idle session, the
    // true 26% sixty-seven seconds later, then a normal 27%. Read whole, the series projects a
    // 64%/h burn and a wall an hour out; only the last leg is real.
    const series = [
        { t: 1786586489, u: 8, r: 1787043600 },
        { t: 1786586556, u: 26, r: 1787043600 },
        { t: 1786587549, u: 27, r: 1787043600 },
    ];
    const now = 1786588189;

    assert.deepEqual(trimImplausible(series), series.slice(1), "the stale head is cut");
    assert.equal(Math.round(recentRate(series, now) * 3600 * 10) / 10, 3.6, "≈3.6%/h, not 64%/h");

    // 3.6%/h would empty the remaining 73% in about 20 hours, but the slope was measured over 17
    // minutes. Projecting it that far assumes the work continues unbroken overnight, so nothing is
    // claimed at all.
    assert.equal(projectWall({ used_percentage: 27, resets_at: 1787043600 }, series, now), null);

    // The next render writes the healed series back, so the poison does not linger.
    const healed = record({ seven_day: series }, wk(27, 1787043600), now);
    assert.equal(healed.seven_day.length, 2);
    assert.equal(healed.seven_day[0].u, 26);
});

test("a slope is not projected further than the stretch it was measured over", () => {
    // 28% used on a weekly window, climbing 4%/h as measured over half an hour. Left unbounded that
    // projects a wall ~18h out and reads as "you are about to lose your quota" at 28% used.
    const series = [
        { t: T0, u: 26, r: RESET },
        { t: T0 + 1800, u: 28, r: RESET },
    ];
    const limit = { used_percentage: 28, resets_at: RESET };
    const now = T0 + 1800;

    assert.equal(Math.round(recentRate(series, now) * 3600), 4, "4%/h is measured correctly");
    assert.equal(projectWall(limit, series, now), null, "but 18h is too far to claim from 30min");

    // Sustained for three hours, the same rate earns the same projection.
    const sustained = [
        { t: T0, u: 16, r: RESET },
        { t: T0 + 3 * 3600, u: 28, r: RESET },
    ];
    const wall = projectWall(limit, sustained, T0 + 3 * 3600);
    assert.equal(Math.round(wall.secondsToWall / 3600), 18);
    assert.equal(wall.measuredOverSecs, 3 * 3600);
});

test("a fast but believable climb is still tracked", () => {
    // 6 points over 30 minutes = 12%/h: high, but nothing like a stale-sample jump.
    let h = record({}, wk(40), T0);
    h = record(h, wk(46), T0 + 1800);
    assert.equal(h.seven_day.length, 2, "kept");
    assert.equal(Math.round(recentRate(h.seven_day, T0 + 1800) * 3600), 12);
});

test("a lower reading in the same window is discarded, not treated as a rollover", () => {
    // An idle session rendering an hour-old 20% must not wipe a history that has reached 90%.
    let h = record({}, wk(85), T0);
    h = record(h, wk(90), T0 + 600);
    h = record(h, wk(20), T0 + 660);
    assert.equal(h.seven_day.length, 2, "history survives the stale reading");
    assert.equal(h.seven_day[1].u, 90, "the stale value is not appended");
});

test("a new window discards the previous one's history", () => {
    let h = record({}, wk(90), T0 - 600);
    h = record(h, wk(2, RESET + 7 * 86400), T0);
    assert.equal(h.seven_day.length, 1);
    assert.equal(h.seven_day[0].u, 2);
});

test("guards that keep the projection quiet rather than wrong", () => {
    const series = (...pairs) => pairs.map(([t, u]) => ({ t, u, r: RESET }));
    assert.equal(recentRate(series([T0 - 3600, 5], [T0, 5]), T0), null, "flat");
    assert.equal(recentRate(series([T0, 5]), T0), null, "single sample");
    assert.equal(recentRate(series([T0 - 60, 5], [T0, 9]), T0), null, "span under 5 minutes");
    assert.equal(
        projectWall({ used_percentage: 100, resets_at: RESET }, series([T0 - 3600, 90], [T0, 100]), T0),
        null,
        "already exhausted",
    );
});

test("identical readings do not dilute the slope", () => {
    let h = record({}, wk(50), T0 - 1200);
    h = record(h, wk(50), T0 - 600);
    h = record(h, wk(50), T0);
    assert.equal(h.seven_day.length, 1);
});

test("the wall segment names the bucket it is about", () => {
    const file = historyFile();
    const limits = (session, week) => ({
        five_hour: { used_percentage: session, resets_at: T0 + 3 * 3600 },
        seven_day: { used_percentage: week, resets_at: RESET },
    });

    assert.equal(update(file, limits(60, 80), T0), null, "one sample supports no slope");
    const seg = update(file, limits(90, 86), T0 + 3600);

    // Both windows project a wall before they reset - the session at 20 minutes, the week at 2h20m.
    // Unlabelled, the only way to tell which one won is to redo the arithmetic.
    assert.equal(seg.key, "five_hour");
    assert.equal(seg.wallAt, T0 + 3600 + 1200);
    assert.match(seg.text, /^Session 20m to 100% \(\d\d:\d\d\)$/);
});

test("a model's window is named after the model, even one cc-pace has never heard of", () => {
    const file = historyFile();
    const haiku = (u) => ({ seven_day_haiku: { used_percentage: u, resets_at: RESET } });

    update(file, haiku(80), T0);
    // Same label the limit segments use, so a new limit type reads alike in both.
    assert.match(update(file, haiku(86), T0 + 3600).text, /^Haiku 2h20m to 100% \(/);
});
