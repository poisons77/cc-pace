import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decide, display, readForecast, watchedBuckets, runRotation } from "../src/rotation.js";

// The engine reads Claude Code's prompt history for the work pattern; never this machine's.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cc-pace-claude-"));

const NOW = 1_000_000;
const H5 = NOW + 3600;
const WK = NOW + 4 * 86400;

const rule = {
    primary: "A",
    fallback: "B",
    buckets: { five_hour: 95, seven_day: 99 },
    returnGraceSeconds: 60,
};

const limits = (h5, wk) => ({
    five_hour: { used_percentage: h5, resets_at: H5 },
    seven_day: { used_percentage: wk, resets_at: WK },
});

const onPrimary = (l, now = NOW) => decide({ limits: l, rule, active: "A", state: {}, now });

test("watched buckets accept every config shape", () => {
    assert.deepEqual(watchedBuckets(rule), [
        { key: "five_hour", at: 95 },
        { key: "seven_day", at: 99 },
    ]);
    assert.deepEqual(watchedBuckets({ buckets: ["five_hour"], at: 90 }), [
        { key: "five_hour", at: 90 },
    ]);
    assert.deepEqual(watchedBuckets({ bucket: "seven_day", at: 80 }), [
        { key: "seven_day", at: 80 },
    ]);
    assert.deepEqual(watchedBuckets({}), [{ key: "five_hour", at: 95 }]);
});

test("each window uses its own threshold", () => {
    assert.equal(onPrimary(limits(20, 95)), null, "weekly at 95 is under its 99 bar");
    assert.equal(onPrimary(limits(20, 98)), null);
    assert.deepEqual(onPrimary(limits(20, 99)).because, ["seven_day"]);
    assert.equal(onPrimary(limits(94, 50)), null);
    assert.deepEqual(onPrimary(limits(95, 50)).because, ["five_hour"]);
});

test("the block runs until the latest exhausted window frees", () => {
    // Only the 5-hour is over its bar, so the return waits hours, not days.
    assert.equal(onPrimary(limits(95, 96)).primaryResetsAt, H5);
    // Both over: the weekly holds the return for days.
    assert.equal(onPrimary(limits(96, 99)).primaryResetsAt, WK);
});

test("a payload from before the rollover is ignored, not acted on", () => {
    const stale = { five_hour: { used_percentage: 99, resets_at: NOW - 10 } };
    assert.equal(decide({ limits: stale, rule, active: "A", state: {}, now: NOW }), null);
});

test("the return is time-based and ignores the fallback's own usage", () => {
    const state = { primaryResetsAt: WK };
    const busy = limits(99, 99);
    assert.equal(decide({ limits: busy, rule, active: "B", state, now: WK - 1 }), null);
    assert.equal(decide({ limits: busy, rule, active: "B", state, now: WK + 30 }), null, "inside grace");
    assert.deepEqual(decide({ limits: busy, rule, active: "B", state, now: WK + 61 }), {
        action: "to-primary",
        target: "A",
        primaryResetsAt: null,
    });
});

test("unknown or missing identity does nothing", () => {
    assert.equal(decide({ limits: limits(99, 99), rule, active: "someone", state: {}, now: NOW }), null);
    assert.equal(decide({ limits: limits(99, 99), rule, active: null, state: {}, now: NOW }), null);
});

test("status text avoids glyphs missing from common terminal fonts", () => {
    const switching = display(rule, { phase: "switching", target: "B", firedAt: NOW }, NOW + 1, {
        active: "A",
    });
    assert.equal(switching, "→ switching to B");
    assert.ok(!switching.includes("⟳"), "U+27F3 renders as tofu in Cascadia/Consolas");
    assert.equal(display(rule, { primaryResetsAt: WK }, NOW, { active: "B" }), "↩ A in 4d0h");
    assert.equal(
        display(rule, { primaryResetsAt: WK, fallbackExhausted: true }, NOW, { active: "B" }),
        "! both limited · A in 4d0h",
    );
    assert.equal(
        display({ ...rule, ascii: true }, { primaryResetsAt: WK }, NOW, { active: "B" }),
        "<- A in 4d0h",
    );
});

test("a full cycle repeats, so no state is spent after one rotation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-pace-rot-"));
    const configFile = join(dir, "config.json");
    const store = join(dir, "store");
    const log = join(dir, "calls.log");
    const fake = join(dir, "fake.js");

    writeFileSync(
        fake,
        `const fs=require('node:fs');const a=process.argv.slice(2);` +
            `fs.appendFileSync(${JSON.stringify(log)},a.join(' ')+'\\n');` +
            `if(a[0]==='use')fs.writeFileSync(${JSON.stringify(join(store, "rotation-state.json"))},JSON.stringify({active:a[1]}));`,
    );
    const cycleRule = { ...rule, store, command: `node ${fake}` };
    writeFileSync(configFile, JSON.stringify({ rotation: cycleRule }));
    mkdirSync(store, { recursive: true });
    const setActive = (n) => writeFileSync(join(store, "rotation-state.json"), JSON.stringify({ active: n }));

    // The switch runs in a detached process, so wait for it to publish rather than guessing a
    // delay: node's startup cost varies enough that a fixed sleep makes this flaky.
    const landed = async (name) => {
        for (let i = 0; i < 60; i++) {
            try {
                const seen = JSON.parse(readFileSync(join(store, "rotation-state.json"), "utf8")).active;
                if (seen === name) return;
            } catch {
                /* not written yet */
            }
            await new Promise((r) => setTimeout(r, 50));
        }
        assert.fail(`switch to ${name} never landed`);
    };

    setActive("A");
    assert.equal(runRotation(limits(96, 50), cycleRule, configFile, NOW), "to-fallback");
    await landed("B");
    assert.equal(runRotation(limits(3, 3), cycleRule, configFile, H5 + 61), "to-primary");
    await landed("A");

    // Second cycle on a fresh window: the first rotation must not have consumed anything.
    const later = H5 + 200;
    const nextWindow = {
        five_hour: { used_percentage: 97, resets_at: later + 3600 },
        seven_day: { used_percentage: 50, resets_at: WK },
    };
    assert.equal(runRotation(nextWindow, cycleRule, configFile, later), "to-fallback");
    await landed("B");

    assert.ok(existsSync(log));
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["use B", "use A", "use B"]);
});

test("a window near its reset is drained to the later bar, not fled at the earlier one", () => {
    const lateRule = {
        ...rule,
        buckets: { seven_day: { at: 95, lateAt: 99, lateWithinSecs: 129_600 } },
    };
    assert.deepEqual(watchedBuckets(lateRule), [
        { key: "seven_day", at: 95, lateAt: 99, lateWithinSecs: 129_600 },
    ]);

    const weekly = (used, resetsIn) => ({
        seven_day: { used_percentage: used, resets_at: NOW + resetsIn },
    });
    const at = (l) => decide({ limits: l, rule: lateRule, active: "A", state: {}, now: NOW });

    // Four days out: percent left behind is unavailable for days, so 96 is already enough to move.
    assert.deepEqual(at(weekly(96, 4 * 86400)).because, ["seven_day"]);
    assert.equal(at(weekly(94, 4 * 86400)), null);

    // Inside 36 hours the refill is close, so the same 96 is worth spending rather than fleeing.
    assert.equal(at(weekly(96, 30 * 3600)), null);
    assert.deepEqual(at(weekly(99, 30 * 3600)).because, ["seven_day"]);
});

test("a switch too recent to be described by the payload decides nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-pace-settle-"));
    const configFile = join(dir, "config.json");
    const store = join(dir, "store");
    const log = join(dir, "calls.log");
    const fake = join(dir, "fake.js");

    writeFileSync(fake, `require('node:fs').appendFileSync(${JSON.stringify(log)},'fired\\n');`);
    const settleRule = { ...rule, store, command: `node ${fake}` };
    writeFileSync(configFile, JSON.stringify({ rotation: settleRule }));
    mkdirSync(store, { recursive: true });

    // Standing on A, holding B's exhausted numbers - the shape that used to bounce the pair.
    const publish = (switchedAt) =>
        writeFileSync(
            join(store, "rotation-state.json"),
            JSON.stringify({ active: "A", switchedAt }),
        );

    publish(NOW - 5);
    assert.equal(runRotation(limits(96, 50), settleRule, configFile, NOW), null);
    assert.equal(existsSync(log), false, "nothing may spawn while the payload is stale");

    // Once the payload has caught up, the same reading is trusted again.
    publish(NOW - 600);
    assert.equal(runRotation(limits(96, 50), settleRule, configFile, NOW), "to-fallback");
});

test("standing on the primary answers a pending return", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-pace-clear-"));
    const configFile = join(dir, "config.json");
    const store = join(dir, "store");
    const stateFile = join(dir, "rotation-state.json");
    mkdirSync(store, { recursive: true });

    const clearRule = { ...rule, store };
    writeFileSync(configFile, JSON.stringify({ rotation: clearRule }));
    writeFileSync(join(store, "rotation-state.json"), JSON.stringify({ active: "A", switchedAt: 0 }));
    // A return owed from an earlier flight, left behind because the account came back by hand.
    writeFileSync(stateFile, JSON.stringify({ phase: "idle", primaryResetsAt: WK }));

    assert.equal(runRotation(limits(3, 3), clearRule, configFile, NOW), null);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).primaryResetsAt, null);
});

// Mirrors COOLDOWN_SECS in the engine: past it, an unlanded switch is judged rather than awaited.
const COOLDOWN = 45;

const peerRule = {
    accounts: ["A", "B"],
    buckets: { five_hour: 95, seven_day: { at: 95, lateAt: 99, lateWithinSecs: 129_600 } },
};

test("peers of equal worth leave a spent account for a free one", () => {
    const on = (who, l, state = {}) => decide({ limits: l, rule: peerRule, active: who, state, now: NOW });

    assert.equal(on("A", limits(50, 50)), null, "nothing to flee");

    // Either side can be the one that empties: there is no privileged account.
    const fromA = on("A", limits(96, 50));
    assert.equal(fromA.target, "B");
    assert.equal(fromA.action, "to-peer");
    const fromB = on("B", limits(96, 50));
    assert.equal(fromB.target, "A");

});

test("a peer is not switched into while what was seen of it is still spent", () => {
    // Outliving B's window, so the second reading is still live rather than pre-rollover.
    const spent = { five_hour: { used_percentage: 96, resets_at: NOW + 7200 } };
    const state = { seen: { B: { at: NOW - 60, buckets: { five_hour: { used: 98, resets: NOW + 3600 } } } } };
    assert.equal(
        decide({ limits: spent, rule: peerRule, active: "A", state, now: NOW }),
        null,
        "B was last seen spent and its window has not rolled, so there is nowhere to go",
    );
    // Past B's reset the stale utilization stops counting: the window has refilled.
    const after = decide({ limits: spent, rule: peerRule, active: "A", state, now: NOW + 3601 });
    assert.equal(after.target, "B");
});

test("an unseen peer is assumed usable rather than assumed spent", () => {
    const hit = decide({ limits: limits(96, 50), rule: peerRule, active: "A", state: {}, now: NOW });
    assert.equal(hit.target, "B", "never observed must not strand you on a spent account");
});

test("the peer with the most room is chosen", () => {
    const rested = { accounts: ["A", "B", "C"], buckets: { five_hour: 95 } };
    const state = {
        seen: {
            B: { at: NOW, buckets: { five_hour: { used: 80, resets: NOW + 3600 } } },
            C: { at: NOW, buckets: { five_hour: { used: 20, resets: NOW + 3600 } } },
        },
    };
    const hit = decide({ limits: limits(96, 50), rule: rested, active: "A", state, now: NOW });
    assert.equal(hit.target, "C", "C has the most left, so the switch lasts longest");
});

test("the ledger records the active account and never a settling payload", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-pace-seen-"));
    const configFile = join(dir, "config.json");
    const stateFile = join(dir, "rotation-state.json");
    const store = join(dir, "store");
    mkdirSync(store, { recursive: true });

    const rule = { ...peerRule, store, command: "node -e 0" };
    writeFileSync(configFile, JSON.stringify({ rotation: rule }));

    // Freshly switched: these numbers still describe the account just left.
    writeFileSync(join(store, "rotation-state.json"), JSON.stringify({ active: "B", switchedAt: NOW - 5 }));
    runRotation(limits(96, 50), rule, configFile, NOW);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).seen, undefined, "no filing while settling");

    // Settled: the same reading is now B's own.
    writeFileSync(join(store, "rotation-state.json"), JSON.stringify({ active: "B", switchedAt: NOW - 600 }));
    runRotation(limits(40, 50), rule, configFile, NOW);
    const seen = JSON.parse(readFileSync(stateFile, "utf8")).seen;
    assert.equal(seen.B.buckets.five_hour.used, 40);
    assert.equal(seen.B.buckets.seven_day.used, 50);
});

test("nowhere free to go is stated, not counted down to a switch", () => {
    const held = { held: { name: "B", at: NOW + 7200 } };
    assert.equal(display(peerRule, held, NOW, { active: "A" }), "! all limited · B in 2h0m");
});

test("a switch that never lands is recorded as failed, not as done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-pace-fail-"));
    const configFile = join(dir, "config.json");
    const stateFile = join(dir, "rotation-state.json");
    const store = join(dir, "store");
    mkdirSync(store, { recursive: true });

    // A command that publishes nothing: the target never becomes active.
    const deadRule = { ...peerRule, store, command: "node -e 0" };
    writeFileSync(configFile, JSON.stringify({ rotation: deadRule }));
    writeFileSync(join(store, "rotation-state.json"), JSON.stringify({ active: "A", switchedAt: 0 }));

    assert.equal(runRotation(limits(96, 50), deadRule, configFile, NOW), "to-peer");

    // Past the cooldown with A still active: the move did not happen.
    assert.equal(runRotation(limits(96, 50), deadRule, configFile, NOW + COOLDOWN + 1), null);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.lastAction, null, "a failed switch must not leave a receipt");
    assert.equal(state.failed.target, "B");
    assert.match(state.display, /switch to B failed/);
});

test("a target that did not answer is left alone before it is tried again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-pace-retry-"));
    const configFile = join(dir, "config.json");
    const store = join(dir, "store");
    const log = join(dir, "calls.log");
    const fake = join(dir, "fake.js");
    mkdirSync(store, { recursive: true });

    writeFileSync(fake, `require('node:fs').appendFileSync(${JSON.stringify(log)},'fired\\n');`);
    const deadRule = { ...peerRule, store, command: `node ${fake}` };
    writeFileSync(configFile, JSON.stringify({ rotation: deadRule }));
    writeFileSync(join(store, "rotation-state.json"), JSON.stringify({ active: "A", switchedAt: 0 }));

    const spent = { five_hour: { used_percentage: 96, resets_at: NOW + 86400 } };
    assert.equal(runRotation(spent, deadRule, configFile, NOW), "to-peer");
    assert.equal(runRotation(spent, deadRule, configFile, NOW + COOLDOWN + 1), null, "marked failed");

    // Every render in the backoff would otherwise spawn again.
    assert.equal(runRotation(spent, deadRule, configFile, NOW + COOLDOWN + 2), null);
    assert.equal(runRotation(spent, deadRule, configFile, NOW + COOLDOWN + 60), null);

    // Once the backoff expires the target is worth trying again.
    assert.equal(runRotation(spent, deadRule, configFile, NOW + COOLDOWN + 400), "to-peer");
});

test("every decision that changed something leaves a line to read afterwards", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-pace-log-"));
    const configFile = join(dir, "config.json");
    const store = join(dir, "store");
    const stateFile = join(store, "rotation-state.json");
    const fake = join(dir, "fake.js");
    mkdirSync(store, { recursive: true });

    writeFileSync(
        fake,
        `const fs=require('node:fs');const a=process.argv.slice(2);` +
            `if(a[0]==='use')fs.writeFileSync(${JSON.stringify(stateFile)},JSON.stringify({active:a[1],switchedAt:0}));`,
    );
    const logRule = { ...peerRule, store, command: `node ${fake}` };
    writeFileSync(configFile, JSON.stringify({ rotation: logRule }));
    writeFileSync(stateFile, JSON.stringify({ active: "A", switchedAt: 0 }));

    assert.equal(runRotation(limits(96, 50), logRule, configFile, NOW), "to-peer");
    for (let i = 0; i < 60; i++) {
        try {
            if (JSON.parse(readFileSync(stateFile, "utf8")).active === "B") break;
        } catch {
            /* caught mid-write by the detached switch */
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    runRotation(limits(3, 3), logRule, configFile, NOW + COOLDOWN + 1);

    const lines = readFileSync(join(dir, "rotate.log"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /fire action=to-peer from=A target=B because=five_hour read=five_hour:96%/);
    assert.match(lines[1], /land target=B active=B/);
});

const WEEK = 7 * 86400;

test("a login about to stop refreshing is never switched into", () => {
    const logins = { B: NOW + 1800, C: null };
    const three = { accounts: ["A", "B", "C"], buckets: { five_hour: 95 } };
    const hit = decide({ limits: limits(96, 50), rule: three, active: "A", state: {}, now: NOW, logins });
    assert.equal(hit.target, "C", "B dies within the hour; C's expiry is unknown, which is allowed");

    const onlyB = decide({ limits: limits(96, 50), rule: peerRule, active: "A", state: {}, now: NOW, logins });
    assert.equal(onlyB, null, "nowhere else to go");

    // The hour is fixed, the same red line cc-account draws: just past it, B is usable again.
    const later = decide({ limits: limits(96, 50), rule: peerRule, active: "A", state: {}, now: NOW, logins: { B: NOW + 3600 } });
    assert.equal(later.target, "B");
});

test("primary and fallback respect a dead login on either side", () => {
    assert.equal(decide({ limits: limits(96, 50), rule, active: "A", state: {}, now: NOW, logins: { B: NOW } }), null);
    const back = { limits: limits(3, 3), rule, active: "B", state: { primaryResetsAt: WK }, now: WK + 61 };
    assert.equal(decide({ ...back, logins: { A: WK } }), null);
    assert.equal(decide(back).target, "A");
});

test("peers are drained in the order their weekly reset would waste quota", () => {
    // B: 60% used, resets in 2 h - 98% of its week elapsed, 38 points about to be lost.
    // C: 40% used, resets in 6 days - 14% elapsed, nothing at risk yet, though it has more room.
    const weekly = { accounts: ["A", "B", "C"], buckets: { seven_day: 95 } };
    const state = {
        seen: {
            B: { at: NOW, buckets: { seven_day: { used: 60, resets: NOW + 7200 } } },
            C: { at: NOW, buckets: { seven_day: { used: 40, resets: NOW + 6 * 86400 } } },
        },
    };
    const spent = { seven_day: { used_percentage: 96, resets_at: NOW + 86400 } };
    assert.equal(decide({ limits: spent, rule: weekly, active: "A", state, now: NOW }).target, "B");
});

test("the ranking is published for cc-account, best first, and kept through a switch", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-pace-rank-"));
    const configFile = join(dir, "config.json");
    const stateFile = join(dir, "rotation-state.json");
    const store = join(dir, "store");
    mkdirSync(store, { recursive: true });

    const weekly = { accounts: ["A", "B", "C"], buckets: { seven_day: 95 }, store, command: "node -e 0", log: false };
    writeFileSync(join(store, "rotation-state.json"), JSON.stringify({ active: "A", switchedAt: 0, logins: { C: NOW } }));
    // B's week rolled over a day ago: it has refilled and counts as unused.
    writeFileSync(
        stateFile,
        JSON.stringify({ seen: { B: { at: NOW - WEEK, buckets: { seven_day: { used: 90, resets: NOW - 86400 } } } } }),
    );

    runRotation({ seven_day: { used_percentage: 40, resets_at: NOW + 3 * 86400 } }, weekly, configFile, NOW);
    const { ranking } = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(ranking.at, NOW);
    assert.deepEqual(ranking.accounts, [
        { name: "A", eligible: true, reason: null, room: 55, spare: 17, freeAt: null },
        { name: "B", eligible: true, reason: null, room: 95, spare: 14, freeAt: null },
        { name: "C", eligible: false, reason: "login", room: 100, spare: null, freeAt: null },
    ]);

    // An unchanged ranking is not rewritten until it is old enough to look abandoned.
    runRotation({ seven_day: { used_percentage: 40, resets_at: NOW + 3 * 86400 } }, weekly, configFile, NOW + 60);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).ranking.at, NOW);
    runRotation({ seven_day: { used_percentage: 40, resets_at: NOW + 3 * 86400 } }, weekly, configFile, NOW + 600);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).ranking.at, NOW + 600);

    // Spent: the switch fires, and the ranking rides along with the in-flight state.
    assert.equal(runRotation({ seven_day: { used_percentage: 96, resets_at: NOW + 3 * 86400 } }, weekly, configFile, NOW + 700), "to-peer");
    const flying = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(flying.phase, "switching");
    assert.ok(Array.isArray(flying.ranking.accounts));
});

test("a session idle since a switch, still holding another account's numbers, is not taken as the active one's", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-pace-foreign-"));
    const configFile = join(dir, "config.json");
    const stateFile = join(dir, "rotation-state.json");
    const store = join(dir, "store");
    mkdirSync(store, { recursive: true });

    const weekly = { accounts: ["A", "B", "C"], buckets: { seven_day: 95 }, store, command: "node -e 0", log: false };
    writeFileSync(join(store, "rotation-state.json"), JSON.stringify({ active: "A", switchedAt: 0 }));
    // B was left at 95% days ago, its week ending in twenty minutes; A is mid-week at 90%.
    const seen = {
        A: { at: NOW - 3600, buckets: { seven_day: { used: 90, resets: NOW + 4 * 86400 } } },
        B: { at: NOW - 5 * 86400, buckets: { seven_day: { used: 95, resets: NOW + 1200 } } },
    };
    writeFileSync(stateFile, JSON.stringify({ seen }));

    // The idle session renders B's last payload, a point higher from a turn that ended after the move.
    const stale = { seven_day: { used_percentage: 96, resets_at: NOW + 1200 } };
    assert.equal(runRotation(stale, weekly, configFile, NOW), null, "A is not spent: no switch");
    assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")).seen, seen, "A keeps its own reading");

    // Once B's window has refilled, A must still not rank as a fresh week ahead of C.
    const later = NOW + 1300;
    const spent = { seven_day: { used_percentage: 96, resets_at: NOW + 4 * 86400 } };
    assert.equal(runRotation(spent, weekly, configFile, later), "to-peer");
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).target, "B", "B's week has refilled; A's has not");
});

test("a lower reading of a window already saved is a stale payload, and the saved one stands", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-pace-climb-"));
    const configFile = join(dir, "config.json");
    const stateFile = join(dir, "rotation-state.json");
    const store = join(dir, "store");
    mkdirSync(store, { recursive: true });

    const weekly = { accounts: ["A", "B"], buckets: { seven_day: 95 }, store, command: "node -e 0", log: false };
    writeFileSync(join(store, "rotation-state.json"), JSON.stringify({ active: "A", switchedAt: 0 }));
    const resets = NOW + 3 * 86400;
    const reading = (used) => ({ seven_day: { used_percentage: used, resets_at: resets } });
    const saved = () => JSON.parse(readFileSync(stateFile, "utf8")).seen.A.buckets.seven_day;

    runRotation(reading(80), weekly, configFile, NOW);
    runRotation(reading(70), weekly, configFile, NOW + 60);
    assert.deepEqual(saved(), { used: 80, resets });
    runRotation(reading(85), weekly, configFile, NOW + 120);
    assert.deepEqual(saved(), { used: 85, resets });

    // A window already gone describes nothing now, and is not filed over the live one.
    runRotation({ seven_day: { used_percentage: 10, resets_at: NOW } }, weekly, configFile, NOW + 180);
    assert.deepEqual(saved(), { used: 85, resets });
});

/** A temporary engine home: config, published identity, and a reader for the engine's own state. */
function engineHome(prefix, extra = {}) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const configFile = join(dir, "config.json");
    const stateFile = join(dir, "rotation-state.json");
    const store = join(dir, "store");
    mkdirSync(store, { recursive: true });
    const rule = { accounts: ["A", "B", "C"], buckets: { seven_day: 95 }, store, command: "node -e 0", log: false, ...extra };
    writeFileSync(configFile, JSON.stringify({ rotation: rule }));
    return {
        rule,
        configFile,
        stateFile,
        publish: (active, switchedAt = 0) => writeFileSync(join(store, "rotation-state.json"), JSON.stringify({ active, switchedAt })),
        state: () => JSON.parse(readFileSync(stateFile, "utf8")),
    };
}

test("an account already spent on landing stops rotation and asks, until a person picks", () => {
    const home = engineHome("cc-pace-ask-spent-");
    // The switch to B has just landed, and the first trusted reading of B is over its bar.
    writeFileSync(home.stateFile, JSON.stringify({ phase: "switching", target: "B", action: "to-peer", firedAt: NOW - 600 }));
    home.publish("B", NOW - 600);
    const spent = { seven_day: { used_percentage: 99, resets_at: NOW + 2 * 86400 } };

    assert.equal(runRotation(spent, home.rule, home.configFile, NOW), null, "C has room, but rotation stops");
    assert.deepEqual(home.state().ask, { reason: "spent", on: "B", name: "B", used: 99, at: NOW });
    assert.equal(home.state().display, "! B already at 99% · pick an account");

    assert.equal(runRotation(spent, home.rule, home.configFile, NOW + 60), null, "still waiting");
    assert.equal(home.state().ask.at, NOW, "the same question, not a new one");

    // A manual pick of C is the answer: on C, the question is gone.
    home.publish("C", NOW + 100);
    runRotation({ seven_day: { used_percentage: 10, resets_at: NOW + 5 * 86400 } }, home.rule, home.configFile, NOW + 300);
    assert.equal(home.state().ask, null);
});

test("an account landed on with room is checked once and rotation carries on", () => {
    const home = engineHome("cc-pace-ask-fine-");
    // Left A at 96%; B has never been read.
    const seen = { A: { at: NOW - 600, buckets: { seven_day: { used: 96, resets: NOW + 86400 } } } };
    writeFileSync(home.stateFile, JSON.stringify({ phase: "switching", target: "B", action: "to-peer", firedAt: NOW - 600, seen }));
    home.publish("B", NOW - 600);

    // An idle session still shows A: that is not B already spent, and the check waits for B's own reading.
    runRotation({ seven_day: { used_percentage: 96, resets_at: NOW + 86400 } }, home.rule, home.configFile, NOW - 1);
    assert.equal(home.state().ask, undefined);
    assert.equal(home.state().verify, "B");

    runRotation({ seven_day: { used_percentage: 20, resets_at: NOW + 2 * 86400 } }, home.rule, home.configFile, NOW);
    assert.equal(home.state().ask, null);
    assert.equal(home.state().verify, null, "the check is spent on the first reading");

    // Later spent the ordinary way: the move happens without asking.
    const spent = { seven_day: { used_percentage: 96, resets_at: NOW + 2 * 86400 } };
    assert.equal(runRotation(spent, home.rule, home.configFile, NOW + 600), "to-peer");
});

test("with askIfUnreadSecs, a target read too long ago, or never, is asked about instead of switched into", () => {
    const home = engineHome("cc-pace-ask-unread-", { askIfUnreadSecs: 86400 });
    home.publish("A");
    const seen = {
        B: { at: NOW - 3 * 86400, buckets: { seven_day: { used: 50, resets: NOW + 3 * 86400 } } },
        C: { at: NOW - 3 * 86400, buckets: { seven_day: { used: 99, resets: NOW + 3 * 86400 } } },
    };
    writeFileSync(home.stateFile, JSON.stringify({ seen }));
    const spent = { seven_day: { used_percentage: 96, resets_at: NOW + 4 * 86400 } };

    assert.equal(runRotation(spent, home.rule, home.configFile, NOW), null);
    assert.deepEqual(home.state().ask, { reason: "unread", on: "A", name: "B", readAt: NOW - 3 * 86400, at: NOW });
    assert.equal(home.state().display, "! B last read 3d0h ago · switch?");

    // Read within the day: switched into without asking.
    writeFileSync(home.stateFile, JSON.stringify({ seen: { ...seen, B: { ...seen.B, at: NOW - 3600 } } }));
    assert.equal(runRotation(spent, home.rule, home.configFile, NOW), "to-peer");

    // Never read at all is the oldest reading there is.
    const never = engineHome("cc-pace-ask-never-", { accounts: ["A", "B"], askIfUnreadSecs: 86400 });
    never.publish("A");
    assert.equal(runRotation(spent, never.rule, never.configFile, NOW), null);
    assert.equal(never.state().display, "! B never read · switch?");
});

test("a spent account says when it frees: the latest reset among the windows holding it", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-pace-free-"));
    const configFile = join(dir, "config.json");
    const stateFile = join(dir, "rotation-state.json");
    const store = join(dir, "store");
    mkdirSync(store, { recursive: true });

    const both = { accounts: ["A", "B"], buckets: { five_hour: 95, seven_day: 95 }, store, command: "node -e 0", log: false };
    writeFileSync(join(store, "rotation-state.json"), JSON.stringify({ active: "A", switchedAt: 0 }));
    // B is over both bars: the 5-hour clears in an hour, the week in two days - it needs both.
    writeFileSync(
        stateFile,
        JSON.stringify({
            seen: {
                B: { at: NOW, buckets: { five_hour: { used: 99, resets: NOW + 3600 }, seven_day: { used: 97, resets: NOW + 2 * 86400 } } },
            },
        }),
    );

    runRotation(limits(10, 10), both, configFile, NOW);
    const b = JSON.parse(readFileSync(stateFile, "utf8")).ranking.accounts.find((a) => a.name === "B");
    assert.equal(b.reason, "spent");
    assert.equal(b.freeAt, NOW + 2 * 86400);
});

test("the forecast is published beside the ranking, without a login about to stop", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-pace-forecast-"));
    const configFile = join(dir, "config.json");
    const stateFile = join(dir, "rotation-state.json");
    const store = join(dir, "store");
    mkdirSync(store, { recursive: true });

    const weekly = { accounts: ["A", "B", "C"], buckets: { seven_day: 99 }, store, command: "node -e 0", log: false };
    writeFileSync(join(store, "rotation-state.json"), JSON.stringify({ active: "A", switchedAt: 0, logins: { C: NOW } }));
    writeFileSync(stateFile, JSON.stringify({ seen: { B: { at: NOW, buckets: { seven_day: { used: 50, resets: NOW + 2 * 86400 } } } } }));

    // Four days into A's week at 80%: 1.40x of one account's pace.
    const live = { seven_day: { used_percentage: 80, resets_at: NOW + 3 * 86400 } };
    runRotation(live, weekly, configFile, NOW);
    const forecast = readForecast(configFile);
    assert.equal(forecast.window, "seven_day");
    assert.equal(forecast.burn, 1.4);
    assert.equal(forecast.sustainable, 2, "C's login stops within the hour");
    assert.deepEqual(forecast.accounts, [
        { name: "A", used: 80, resets: NOW + 3 * 86400 },
        { name: "B", used: 50, resets: NOW + 2 * 86400 },
    ]);
    assert.deepEqual(forecast.unknown, []);
    assert.equal(forecast.runsOutAt, null, "1.40x against 2.0x lasts");
});

test("a burn that hits the wall before the next render forces the switch early", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-pace-ahead-"));
    const configFile = join(dir, "config.json");
    const store = join(dir, "store");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "rotation-state.json"), JSON.stringify({ active: "A", switchedAt: 0 }));

    // 80% -> 88% over twenty minutes: 12 points left, gone in thirty minutes.
    const resets = NOW + 3 * 3600;
    writeFileSync(
        join(dir, "burn-history.json"),
        JSON.stringify({ five_hour: [{ t: NOW - 1200, u: 80, r: resets }, { t: NOW, u: 88, r: resets }] }),
    );
    const l = { five_hour: { used_percentage: 88, resets_at: resets } };
    const base = { ...peerRule, store, command: "node -e 0" };

    assert.equal(runRotation(l, base, configFile, NOW), null, "off by default");
    assert.equal(runRotation(l, { ...base, switchAheadSecs: 900 }, configFile, NOW), null, "wall still 30 min out");
    assert.equal(runRotation(l, { ...base, switchAheadSecs: 1800 }, configFile, NOW), "to-peer");
    assert.match(readFileSync(join(dir, "rotate.log"), "utf8"), /read=five_hour:88%~burn/);
});

test("a receipt names where you are, not where it put you", () => {
    const state = { lastAction: "to-fallback", completedAt: NOW };
    assert.equal(display(rule, state, NOW + 10, { active: "B" }), "✓ on B");
    // Switched back by hand inside the two minutes: the receipt is no longer true.
    assert.equal(display(rule, state, NOW + 10, { active: "A" }), null);
});
