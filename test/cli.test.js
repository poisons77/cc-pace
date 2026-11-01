import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "cc-pace.js");
const fixture = (name) => readFileSync(join(HERE, "fixtures", `${name}.json`), "utf8");

// Every run gets its own config directory. The CLI writes burn history and runs the rotation
// engine beside the config file, so a test against the real one would overwrite the user's history
// and could switch their account.
function sandbox(config) {
    const dir = mkdtempSync(join(tmpdir(), "cc-pace-test-"));
    const file = join(dir, "config.json");
    if (config !== undefined) writeFileSync(file, typeof config === "string" ? config : JSON.stringify(config));
    return { dir, file };
}

function run(args = [], input = "", { env = {}, config } = {}) {
    const { file } = sandbox(config);
    return execFileSync(process.execPath, [BIN, ...args], {
        input,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1", TZ: "UTC", CC_PACE_CONFIG: file, ...env },
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
    assert.deepEqual(out.config.segments, ["limits", "share", "memory", "burn", "rotation", "git"]);
});

test("environment overrides reach the renderer", () => {
    const out = run([], fixture("on-pace"), { env: { CC_PACE_SEGMENTS: "weekly" } });
    assert.equal(out, "Weekly: 71% (2d0h) 0.99x");
});

// A weekly window climbing 10 points in half an hour: the window average looks fine, the recent
// rate reaches 100% in two hours.
const RESETS_AT = 1800000000 + 3 * 86400;
function weeklyAt(now, used) {
    return JSON.stringify({ _now: now, rate_limits: { seven_day: { used_percentage: used, resets_at: RESETS_AT } } });
}

test("the burn warning comes from history the CLI records across renders", () => {
    const { dir, file } = sandbox();
    const env = { ...process.env, NO_COLOR: "1", TZ: "UTC", CC_PACE_CONFIG: file, CC_PACE_SEGMENTS: "burn" };
    const at = (now, used) => execFileSync(process.execPath, [BIN], { input: weeklyAt(now, used), encoding: "utf8", env });

    const t0 = 1800000000;
    assert.equal(at(t0, 50), "", "one sample carries no rate");
    assert.equal(at(t0 + 1800, 60), "Weekly 2h0m to 100% (10:30)");
    assert.ok(existsSync(join(dir, "burn-history.json")));
});

test("the rotation segment shows what the engine last published", () => {
    const { dir, file } = sandbox({
        segments: ["rotation"],
        rotation: { accounts: ["work", "personal"], buckets: { five_hour: 95 }, store: "nowhere", log: false },
    });
    writeFileSync(join(dir, "rotation-state.json"), JSON.stringify({ display: "→ switching to work" }));
    const out = execFileSync(process.execPath, [BIN], {
        input: weeklyAt(1800000000, 10),
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1", CC_PACE_CONFIG: file },
    });
    assert.equal(out, "→ switching to work");
});

test("each session sees its own share of the burn, and the shares add up to 100%", () => {
    const { dir, file } = sandbox();
    const env = { ...process.env, NO_COLOR: "1", CC_PACE_CONFIG: file, CC_PACE_SEGMENTS: "share" };
    const at = (id, now, cost) =>
        execFileSync(process.execPath, [BIN], {
            input: JSON.stringify({ _now: now, session_id: id, cost: { total_cost_usd: cost } }),
            encoding: "utf8",
            env,
        });

    const t0 = 1800000000;
    at("alpha", t0, 1);
    assert.equal(at("beta", t0, 5), "", "alpha has spent nothing yet, so there is nothing to compare");
    at("alpha", t0 + 600, 4); // alpha: +3
    assert.equal(at("beta", t0 + 600, 6), "This chat: 25% of burn"); // beta: +1 of 4
    assert.equal(at("alpha", t0 + 600, 4), "This chat: 75% of burn");
    assert.ok(existsSync(join(dir, "sessions", "alpha.json")));
});

test("rotation switched off from the menu renders and decides nothing", () => {
    const { dir, file } = sandbox({
        segments: ["rotation"],
        rotation: { enabled: false, accounts: ["work", "personal"], buckets: { five_hour: 95 }, store: "nowhere", log: false },
    });
    writeFileSync(join(dir, "rotation-state.json"), JSON.stringify({ display: "→ switching to work" }));
    const out = execFileSync(process.execPath, [BIN], {
        input: weeklyAt(1800000000, 10),
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1", CC_PACE_CONFIG: file },
    });
    assert.equal(out, "");
});

test("--demo leaves no history behind", () => {
    const { dir, file } = sandbox();
    execFileSync(process.execPath, [BIN, "--demo"], { encoding: "utf8", env: { ...process.env, CC_PACE_CONFIG: file } });
    assert.ok(!existsSync(join(dir, "burn-history.json")));
});

test("a broken config file is flagged on the line, not ignored silently", () => {
    assert.match(run([], fixture("on-pace"), { config: "{ not json" }), /\| ! config$/);
    assert.match(run([], fixture("on-pace"), { config: { segments: "weekly" } }), /! config$/);
});

test("garbage on stdin exits cleanly", () => {
    assert.doesNotThrow(() => run([], "}{"));
});

test("empty stdin exits cleanly", () => {
    assert.doesNotThrow(() => run([], ""));
});
