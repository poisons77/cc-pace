import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "cc-pace.js");
const fixture = (name) => readFileSync(join(HERE, "fixtures", `${name}.json`), "utf8");

function run(args = [], input = "") {
    return execFileSync(process.execPath, [BIN, ...args], {
        input,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1", TZ: "UTC" },
    });
}

test("--version prints the package version", () => {
    const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
    assert.equal(run(["--version"]).trim(), pkg.version);
});

test("--help documents the pace ratio", () => {
    assert.match(run(["--help"]), /Pace ratio is used% divided by elapsed%/);
});

test("--demo renders without stdin", () => {
    assert.match(run(["--demo"]), /Weekly: 71%/);
});

test("--dump round-trips the payload as readable JSON", () => {
    const out = run(["--dump"], fixture("on-pace"));
    assert.equal(JSON.parse(out).rate_limits.seven_day.used_percentage, 71);
});

test("--dump does not swallow input it cannot parse", () => {
    assert.match(run(["--dump"], "not json"), /not json/);
});

test("--json exposes machine-readable metrics", () => {
    const m = JSON.parse(run(["--json"], fixture("over-pace")));
    assert.equal(m.limits.seven_day.pace_level, "danger");
    assert.equal(m.limits.seven_day.depletes_before_reset, true);
});

test("--json strips floating point noise from percentages", () => {
    const payload = JSON.parse(fixture("on-pace"));
    payload.rate_limits.five_hour.used_percentage = 7.000000000000001;
    const m = JSON.parse(run(["--json"], JSON.stringify(payload)));
    assert.equal(m.limits.five_hour.used_percentage, 7);
});

test("NO_COLOR suppresses every escape sequence", () => {
    assert.ok(!run([], fixture("on-pace")).includes(String.fromCharCode(27)));
});

test("--setup prints a pasteable settings snippet", () => {
    assert.equal(JSON.parse(run(["--setup"])).statusLine.command, "npx -y claude-code-pace");
});

test("--config reports the resolved configuration", () => {
    const out = JSON.parse(run(["--config"]));
    assert.ok(out.path.endsWith("config.json"));
    assert.deepEqual(out.config.segments, ["limits", "git"]);
});

test("environment overrides reach the renderer", () => {
    const out = execFileSync(process.execPath, [BIN], {
        input: fixture("on-pace"),
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1", TZ: "UTC", CC_PACE_SEGMENTS: "weekly" },
    });
    assert.equal(out, "Weekly: 71% (2d0h) 0.99x");
});

test("garbage on stdin exits cleanly", () => {
    assert.doesNotThrow(() => run([], "}{"));
});

test("empty stdin exits cleanly", () => {
    assert.doesNotThrow(() => run([], ""));
});
