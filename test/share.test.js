import { test } from "node:test";
import assert from "node:assert/strict";

import { record, shareOf, spent } from "../src/share.js";

const NOW = 1800000000;

test("spent counts from the last reading before the hour, so a long session is not undercounted", () => {
    const samples = [
        { t: NOW - 5000, c: 1 },
        { t: NOW - 4000, c: 2 },
        { t: NOW - 600, c: 5 },
        { t: NOW, c: 6 },
    ];
    assert.equal(spent(samples, NOW), 4, "6 now, 2 at the last reading before the window");
});

test("a session that started within the hour counts from its first reading", () => {
    assert.equal(spent([{ t: NOW - 600, c: 1 }, { t: NOW, c: 3 }], NOW), 2);
    assert.equal(spent([{ t: NOW, c: 3 }], NOW), 0, "one reading is no spend");
    assert.equal(spent([{ t: NOW - 7200, c: 3 }], NOW), 0, "silent for the whole hour");
});

test("record appends only when the cost moved, and keeps one reading before the window", () => {
    const one = record([], 1, NOW - 4000);
    assert.equal(record(one, 1, NOW - 3900), one, "an unchanged cost adds nothing");
    const kept = record(record(record(one, 2, NOW - 3800), 3, NOW - 100), 4, NOW);
    assert.deepEqual(kept.map((s) => s.c), [2, 3, 4], "1 is older than the baseline 2 and dropped");
});

test("the share is this session's part of everything burned, and absent when alone", () => {
    assert.equal(shareOf(1, [3]), 25);
    assert.equal(shareOf(3, [1, 0]), 75, "idle sessions do not count");
    assert.equal(shareOf(2, []), null, "alone, a session is trivially all of its own burn");
    assert.equal(shareOf(0, [0]), null);
});
