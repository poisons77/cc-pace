process.env.TZ = "UTC";

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    level,
    outlook,
    profile,
    readActivity,
    recordUsage,
    simulate,
    sustainableLevel,
    windowLevel,
    workedHours,
} from "../src/pool.js";

const HOUR = 3600;
const DAY = 86400;
const WEEK = 7 * DAY;
// Midnight UTC, so hour-of-day arithmetic reads directly.
const NOW = 1_800_000_000 - (1_800_000_000 % DAY);
const H = NOW / HOUR;

/** Days of work from `from` to `to` o'clock, ending yesterday. */
const workdays = (days, from, to) => {
    const hours = [];
    for (let d = 1; d <= days; d++) for (let h = from; h < to; h++) hours.push(H - d * 24 + h);
    return hours;
};

test("the pool runs dry when the burn outruns every account's refill, and resumes at the next reset", () => {
    // A real reading: 3.56x against three accounts. One has 1% left until its reset in 12 h, one
    // 92% until 164 h, one never observed. Soonest reset drains first; refills come back at 100%.
    const accounts = [
        { name: "cinzia", used: 99, resets: NOW + 12 * HOUR },
        { name: "nico", used: 8, resets: NOW + 164 * HOUR },
        { name: "poisons", used: null, resets: null },
    ];
    const { runsOutAt, resumesAt } = simulate(accounts, () => (3.56 * 100) / WEEK, WEEK, NOW);
    assert.ok(Math.abs(runsOutAt - (NOW + 138.27 * HOUR)) < 0.1 * HOUR, `${(runsOutAt - NOW) / HOUR} h`);
    assert.equal(resumesAt, NOW + 164 * HOUR);
});

test("a burn the pool can sustain lasts the window", () => {
    const accounts = [
        { name: "a", used: 30, resets: NOW + 2 * DAY },
        { name: "b", used: 10, resets: NOW + 5 * DAY },
    ];
    assert.deepEqual(simulate(accounts, () => (1.5 * 100) / WEEK, WEEK, NOW), { runsOutAt: null, resumesAt: null });
    assert.deepEqual(simulate(accounts, () => 0, WEEK, NOW), { runsOutAt: null, resumesAt: null });
});

test("the ledger counts climbs on one account and window, and nothing across a switch", () => {
    const week = (used, resets = NOW + 3 * DAY) => ({ used_percentage: used, resets_at: resets });
    let ledger = recordUsage(undefined, "nico", week(10), NOW);
    assert.deepEqual(ledger.hours, {}, "a first reading is a baseline");
    ledger = recordUsage(ledger, "nico", week(12), NOW + 1800);
    assert.equal(ledger.hours[H], 2);
    assert.equal(recordUsage(ledger, "nico", week(11), NOW + 1900), ledger, "a stale lower reading changes nothing");

    ledger = recordUsage(ledger, "cinzia", week(98, NOW + DAY), NOW + 2000);
    assert.equal(ledger.hours[H], 2, "a new account is a new baseline, not a 86% burn");
    ledger = recordUsage(ledger, "cinzia", week(99, NOW + DAY), NOW + 2100);
    assert.equal(ledger.hours[H], 3);

    ledger = recordUsage(ledger, "nico", week(12), NOW + 2200);
    ledger = recordUsage(ledger, "nico", week(40), NOW + 2260);
    assert.equal(ledger.hours[H], 3, "a climb too steep to be real is a stale baseline");
});

test("a climb seen across hours is split by the time spent in each", () => {
    let ledger = recordUsage(undefined, "nico", { used_percentage: 10, resets_at: NOW + DAY }, NOW + 1800);
    ledger = recordUsage(ledger, "nico", { used_percentage: 12, resets_at: NOW + DAY }, NOW + 5400);
    assert.deepEqual(ledger.hours, { [H]: 1, [H + 1]: 1 });
});

test("work hours are read from the prompt history incrementally, timestamps only", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-pace-history-"));
    const file = join(dir, "history.jsonl");
    const line = (t, text) => `${JSON.stringify({ display: text, timestamp: t * 1000, project: "x" })}\n`;
    writeFileSync(file, line(NOW - 3 * HOUR, "a") + line(NOW - 3 * HOUR + 60, '"timestamp":1') + line(NOW - HOUR, "b"));

    const first = readActivity(undefined, file, NOW);
    assert.deepEqual(first.hours, [H - 3, H - 1]);
    assert.equal(readActivity(first, file, NOW), first, "an unchanged file is not read again");

    appendFileSync(file, line(NOW + 60, "c") + '{"display":"half a line');
    const next = readActivity(first, file, NOW + 120);
    assert.deepEqual(next.hours, [H - 3, H - 1, H]);
    assert.equal(readActivity(undefined, join(dir, "missing.jsonl"), NOW), undefined);
});

test("the profile is the share of days each hour was worked", () => {
    const p = profile(new Set([...workdays(4, 8, 24), H - 24 + 3]), NOW);
    assert.equal(p[3], 0.25, "one late night in four days");
    assert.equal(p[5], 0);
    assert.equal(p[12], 1);
    assert.equal(profile(new Set(), NOW), null);
});

test("the level weighs the latest hours of work most, and ignores hours before the ledger", () => {
    // Worked 08-16 yesterday at 1%/h, then the last two hours at 4%/h.
    const hours = {};
    for (let h = 8; h < 14; h++) hours[H - 24 + h] = 1;
    hours[H - 24 + 14] = 4;
    hours[H - 24 + 15] = 4;
    const worked = workedHours({ hours: workdays(1, 8, 16) }, { hours });
    const ledger = { since: NOW - 24 * HOUR, hours };
    const lvl = level(ledger, worked, NOW);
    assert.ok(lvl > 2 && lvl < 4, `${lvl}: above the plain 2%/h average, short of the last two hours`);
    assert.equal(level({ since: NOW - 10 * HOUR, hours }, worked, NOW), 4, "only the two hours since the ledger began");
    assert.equal(level({ since: NOW - 9.25 * HOUR, hours }, worked, NOW), null, "an hour and a quarter is a burst, not a pace");
});

test("the hour the ledger started in counts for the part of it the ledger saw", () => {
    // Started 30 s into 14:00 yesterday, then 4%/h for two hours: the first hour is not dropped.
    const hours = { [H - 10]: 4 * (HOUR - 30) / HOUR, [H - 9]: 4 };
    const worked = new Set([H - 10, H - 9]);
    const lvl = level({ since: (H - 10) * HOUR + 30, hours }, worked, (H - 8) * HOUR);
    assert.ok(Math.abs(lvl - 4) < 1e-9, `${lvl}`);
});

test("a young ledger is blended with the window's level instead of replacing it", () => {
    const worked = new Set([H - 2, H - 1]);
    const ledger = { since: (H - 2) * HOUR, hours: { [H - 2]: 1, [H - 1]: 1 } };
    // Two hours of a three-hour trust: two thirds the ledger's 1%/h, a third the window's 4%/h.
    assert.ok(Math.abs(level(ledger, worked, NOW, 4) - 2) < 1e-9);
    const old = { since: (H - 4) * HOUR, hours: { [H - 4]: 1, [H - 3]: 1, [H - 2]: 1, [H - 1]: 1 } };
    assert.equal(level(old, new Set([H - 4, H - 3, H - 2, H - 1]), NOW, 4), 1, "past three hours, the ledger alone");
    assert.equal(level(undefined, worked, NOW, 4), 4, "no ledger yet: the window's level");
    assert.equal(level(ledger, new Set(), NOW, 4), 4, "nothing worked since the ledger: the window's level");
});

test("before the ledger, the level is the window's use over the hours worked in it", () => {
    const worked = new Set([H - 3, H - 2, H - 1]);
    assert.equal(windowLevel({ used_percentage: 12, resets_at: NOW - 4 * HOUR + WEEK }, WEEK, worked, NOW), 4);
    assert.equal(windowLevel({ used_percentage: 12, resets_at: NOW - 30 * 60 + WEEK }, WEEK, worked, NOW), null);
});

test("sleep is counted: a burn that would stop around the clock lasts when nights are off", () => {
    // Two accounts, both resetting in a week, 2%/h of work, 08-24 every day: 32%/day, 224% a week.
    const accounts = [
        { name: "a", used: 0, resets: NOW + WEEK },
        { name: "b", used: 0, resets: NOW + WEEK },
    ];
    const worked = workdays(7, 8, 24);
    const ledger = { since: NOW - 7 * DAY, hours: Object.fromEntries(worked.map((h) => [h, 1.2])) };
    const out = outlook({ accounts, ledger, activity: { hours: worked }, limit: null, windowSecs: WEEK, now: NOW });
    assert.equal(out.rate, 1.2);
    assert.equal(out.workHours, 16);
    assert.equal(out.runsOutAt, null, "16 h a day at 1.2%/h is 134%, under 200%");
    // Around the clock the same 1.2%/h is 202% - over.
    assert.notEqual(simulate(accounts, () => 1.2 / HOUR, WEEK, NOW).runsOutAt, null);
    // The most it sustains is 200% over 112 working hours.
    assert.ok(Math.abs(out.allowed - 200 / 112) <= 0.1, `${out.allowed}`);
});

test("the sustainable level is the edge between lasting and running dry", () => {
    const accounts = [{ name: "a", used: 50, resets: NOW + 3 * DAY }, { name: "b", used: 90, resets: NOW + DAY }];
    const worked = new Set(workdays(7, 9, 18));
    const prof = profile(worked, NOW);
    const edge = sustainableLevel(accounts, prof, worked, WEEK, NOW);
    const at = (lvl) => simulate(accounts, (t) => (lvl * prof[new Date(t * 1000).getUTCHours()]) / HOUR, WEEK, NOW).runsOutAt;
    assert.equal(at(edge), null);
    assert.notEqual(at(edge + 0.1), null);
});
