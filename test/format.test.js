// Pinned before anything reads the clock: `clock` renders in local time, so an unpinned CI
// timezone would make these assertions machine-dependent.
process.env.TZ = "UTC";

import { test } from "node:test";
import assert from "node:assert/strict";

import { clock, duration } from "../src/format.js";

// Wednesday 2026-08-12, 14:00 UTC.
const NOW = Math.floor(Date.UTC(2026, 7, 12, 14, 0, 0) / 1000);
const at = (dayOffset, hh, mm) => Math.floor(Date.UTC(2026, 7, 12 + dayOffset, hh, mm, 0) / 1000);

test("dates within a day either side read as relative words", () => {
    assert.equal(clock(at(0, 18, 39), NOW), "today 18:39");
    assert.equal(clock(at(1, 4, 15), NOW), "tomorrow 04:15");
    assert.equal(clock(at(-1, 23, 5), NOW), "yesterday 23:05");
});

test("further out falls back to the weekday", () => {
    assert.equal(clock(at(2, 9, 0), NOW), "Fri 09:00");
    assert.equal(clock(at(4, 9, 0), NOW), "Sun 09:00");
    assert.equal(clock(at(6, 9, 0), NOW), "Tue 09:00");
});

test("a week or more away carries the day of the month, so it never reads as today", () => {
    assert.equal(clock(at(7, 13, 15), NOW), "Wed 19 13:15");
    assert.equal(clock(at(-7, 9, 0), NOW), "Wed 5 09:00");
});

test("the boundary is the calendar date, not 24 elapsed hours", () => {
    // 11 hours ahead, but past midnight: that is tomorrow, not today.
    assert.equal(clock(at(1, 1, 0), NOW), "tomorrow 01:00");
    // 13 hours earlier and still the same date.
    assert.equal(clock(at(0, 1, 0), NOW), "today 01:00");
});

test("duration stays compact", () => {
    assert.equal(duration(0), "now");
    assert.equal(duration(59), "0m");
    assert.equal(duration(3600), "1h0m");
    assert.equal(duration(180000), "2d2h");
});
