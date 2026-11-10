import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapStuck, stampPath, REAP_EVERY_MS } from "../src/reap.js";

const T0 = 1800000000000;

function sandbox() {
    return join(mkdtempSync(join(tmpdir(), "cc-pace-reap-")), "config.json");
}

function counting() {
    const calls = { n: 0 };
    return { calls, launch: () => calls.n++ };
}

test("the first render on Windows starts a sweep and stamps its time", () => {
    const file = sandbox();
    const { calls, launch } = counting();
    assert.equal(reapStuck(file, { now: T0, platform: "win32", launch }), true);
    assert.equal(calls.n, 1);
    assert.deepEqual(JSON.parse(readFileSync(stampPath(file), "utf8")), { at: T0 });
});

test("a sweep runs at most once an hour", () => {
    const file = sandbox();
    const { calls, launch } = counting();
    reapStuck(file, { now: T0, platform: "win32", launch });
    assert.equal(reapStuck(file, { now: T0 + REAP_EVERY_MS - 1, platform: "win32", launch }), false);
    assert.equal(reapStuck(file, { now: T0 + REAP_EVERY_MS, platform: "win32", launch }), true);
    assert.equal(calls.n, 2);
});

test("other platforms never sweep: their bash does not start children paused", () => {
    const { calls, launch } = counting();
    assert.equal(reapStuck(sandbox(), { now: T0, platform: "linux", launch }), false);
    assert.equal(calls.n, 0);
});

test("a corrupt stamp counts as no sweep yet", () => {
    const file = sandbox();
    writeFileSync(stampPath(file), "{ not json");
    const { calls, launch } = counting();
    assert.equal(reapStuck(file, { now: T0, platform: "win32", launch }), true);
    assert.equal(calls.n, 1);
});

test("a launch that throws is swallowed, and the stamp still holds it off for an hour", () => {
    const file = sandbox();
    const boom = () => {
        throw new Error("no powershell");
    };
    assert.equal(reapStuck(file, { now: T0, platform: "win32", launch: boom }), false);
    const { calls, launch } = counting();
    assert.equal(reapStuck(file, { now: T0 + 1000, platform: "win32", launch }), false);
    assert.equal(calls.n, 0);
});
