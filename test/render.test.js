// Pinned before anything reads the clock: the ETA renders in local time, so an unpinned CI
// timezone would make these assertions machine-dependent.
process.env.TZ = "UTC";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { render, metrics, bucketKeys, label } from "../src/render.js";
import { DEFAULTS } from "../src/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(HERE, "fixtures", `${name}.json`), "utf8"));

const plain = (name, config = {}) => {
    const payload = fixture(name);
    return render(payload, { color: false, now: payload._now, config: { ...DEFAULTS, ...config } });
};

test("on-pace renders used, time left and ratio, but no ETA", () => {
    // 71% used against 71.43% elapsed is fractionally under budget, so the window never runs dry.
    assert.equal(plain("on-pace"), "Session: 17% (2h30m) | Weekly: 71% (2d0h) 0.99x");
});

test("over-pace renders an ETA earlier than the reset", () => {
    assert.equal(plain("over-pace"), "Session: 88% (1h0m) | Weekly: 90% (2d0h) 1.26x Fri 21:20");
});

test("under-pace hides the ETA because the window never runs dry", () => {
    assert.equal(plain("under-pace"), "Session: 2% (4h43m) | Weekly: 30% (2d0h) 0.42x");
});

test("eta:always shows the projection even when it is safe", () => {
    assert.match(plain("under-pace", { eta: "always" }), /0\.42x \w{3} \d{2}:\d{2}$/);
});

test("eta:never suppresses the clock entirely", () => {
    assert.equal(plain("over-pace", { eta: "never" }), "Session: 88% (1h0m) | Weekly: 90% (2d0h) 1.26x");
});

test("a payload without rate_limits renders nothing rather than failing", () => {
    assert.equal(plain("no-limits"), "");
});

test("unknown buckets are rendered, not dropped", () => {
    const out = plain("unknown-bucket");
    assert.match(out, /thirty day experimental: 12%/);
});

test("known buckets keep their curated order ahead of unknown ones", () => {
    assert.deepEqual(bucketKeys(fixture("unknown-bucket").rate_limits), [
        "seven_day",
        "thirty_day_experimental",
    ]);
});

test("labels fall back to a humanised key", () => {
    assert.equal(label("seven_day"), "Weekly");
    assert.equal(label("some_new_window"), "some new window");
});

test("segments can be reordered and filtered", () => {
    assert.equal(plain("on-pace", { segments: ["weekly"] }), "Weekly: 71% (2d0h) 0.99x");
});

test("segment aliases resolve to bucket keys", () => {
    assert.equal(plain("on-pace", { segments: ["session"] }), "Session: 17% (2h30m)");
});

test("the separator is configurable", () => {
    assert.match(plain("on-pace", { separator: " // " }), /\) \/\/ Weekly/);
});

test("pace can be applied to any bucket", () => {
    assert.match(plain("on-pace", { paceOn: ["five_hour"] }), /^Session: 17% \(2h30m\) 0\.34x/);
});

test("colour output wraps every segment in escapes and always resets", () => {
    const payload = fixture("on-pace");
    const out = render(payload, { color: true, now: payload._now });
    const esc = String.fromCharCode(27);
    assert.ok(out.includes(esc), "expected ANSI escapes");
    // Every introducer must be a real ESC byte, never a bare "[33m".
    assert.equal(out.match(/\[\d+m/g).length, out.match(new RegExp(`${esc}\\[\\d+m`, "g")).length);
    assert.ok(out.endsWith(`${esc}[0m`), "expected a trailing reset");
});

test("git state is appended when supplied", () => {
    const payload = fixture("on-pace");
    const out = render(payload, {
        color: false,
        now: payload._now,
        git: { branch: "main", dirty: true, untracked: true, ahead: 0, behind: 2 },
    });
    assert.ok(out.endsWith("main [*+↓2]"), out);
});

test("a clean tree reads as clean", () => {
    const payload = fixture("on-pace");
    const out = render(payload, {
        color: false,
        now: payload._now,
        git: { branch: "main", dirty: false, untracked: false, ahead: 0, behind: 0 },
    });
    assert.ok(out.endsWith("main [clean]"), out);
});

test("ascii mode avoids the arrow glyphs", () => {
    const payload = fixture("on-pace");
    const out = render(payload, {
        color: false,
        now: payload._now,
        config: { ...DEFAULTS, ascii: true },
        git: { branch: "main", dirty: false, untracked: false, ahead: 1, behind: 2 },
    });
    assert.ok(out.endsWith("main [v2^1]"), out);
});

test("metrics expose the numbers behind the line", () => {
    const payload = fixture("on-pace");
    const m = metrics(payload, { now: payload._now });
    assert.equal(m.limits.seven_day.pace_ratio, 0.994);
    assert.equal(m.limits.seven_day.pace_level, "warn");
    assert.equal(m.limits.seven_day.depletes_before_reset, false);
    assert.equal(m.limits.seven_day.safe_rate_percent_per_day, 14.5);
    assert.equal(m.limits.five_hour.elapsed_percentage, 50);
});

test("render never throws on garbage input", () => {
    for (const bad of [null, undefined, {}, { rate_limits: null }, { rate_limits: { x: 1 } }]) {
        assert.doesNotThrow(() => render(bad, { color: false, now: 1800000000 }));
    }
});
