import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mixOf, modelName, replyCost, tally, update } from "../src/models.js";

test("model ids read as names, with a date snapshot dropped", () => {
    assert.equal(modelName("claude-sonnet-5-5"), "Sonnet 5.5");
    assert.equal(modelName("claude-opus-4-8"), "Opus 4.8");
    assert.equal(modelName("claude-haiku-4-5-20251001"), "Haiku 4.5");
});

test("reply costs match what /usage reported for the same tokens", () => {
    // From a real /usage screen: claude-opus-5-5 at $8.97, claude-haiku-5-5 at $0.0555.
    const opus = replyCost("claude-opus-5-5", {
        input_tokens: 925,
        output_tokens: 99_900,
        cache_read_input_tokens: 17_000_000,
        cache_creation: { ephemeral_1h_input_tokens: 446_700, ephemeral_5m_input_tokens: 0 },
    });
    // /usage rounds the token counts it shows (17.0m, 446.7k), so a cent either way is that.
    assert.ok(Math.abs(opus - 8.97) < 0.02, String(opus));
    const haiku = replyCost("claude-haiku-5-5", {
        input_tokens: 138_600,
        output_tokens: 23_300,
        server_tool_use: { web_search_requests: 3 },
    });
    assert.equal(haiku.toFixed(4), "0.0555");
    assert.equal(replyCost("some-other-model", { input_tokens: 10 }), null, "unknown price, left out");
});

const reply = (id, model, output) =>
    JSON.stringify({ type: "assistant", message: { id, model, usage: { output_tokens: output } } });

test("a reply written once per content block is counted once", () => {
    const costs = {};
    const text = [reply("m1", "claude-opus-5-5", 1e6), reply("m1", "claude-opus-5-5", 1e6), "not json"].join("\n");
    const recent = tally(text, costs);
    assert.equal(costs["claude-opus-5-5"], 20);
    tally(reply("m1", "claude-opus-5-5", 1e6), costs, recent);
    assert.equal(costs["claude-opus-5-5"], 20, "the repeat can straddle two renders");
});

test("the mix is each model's share of the spend, largest first", () => {
    const mix = mixOf({ "claude-opus-5-5": 30, "claude-sonnet-5-5": 10 });
    assert.deepEqual(mix.map((m) => [m.name, m.share]), [["Opus 5.5", 75], ["Sonnet 5.5", 25]]);
    assert.deepEqual(mixOf({}), []);
});

test("update reads the transcript and its subagents incrementally", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-pace-mix-"));
    const configFile = join(dir, "config.json");
    const main = join(dir, "s1.jsonl");
    mkdirSync(join(dir, "s1", "subagents"), { recursive: true });
    const agent = join(dir, "s1", "subagents", "agent-a.jsonl");
    writeFileSync(main, `${reply("m1", "claude-opus-5-5", 1e6)}\n`);
    writeFileSync(agent, `${reply("a1", "claude-sonnet-5-5", 2e6)}\n`);
    const payload = { transcript_path: main, session_id: "s1" };

    const now = Math.floor(Date.now() / 1000);
    assert.deepEqual(update(configFile, payload, now).map((m) => [m.name, m.share]), [["Opus 5.5", 50], ["Sonnet 5.5", 50]]);

    // Only the appended reply is read; a half-written last line waits for the next render.
    appendFileSync(main, `${reply("m2", "claude-opus-5-5", 2e6)}\n{"type":"assistant","mess`);
    assert.deepEqual(update(configFile, payload, now + 5).map((m) => [m.name, m.share]), [["Opus 5.5", 75], ["Sonnet 5.5", 25]]);
});

test("update gives no opinion without a transcript", () => {
    const configFile = join(mkdtempSync(join(tmpdir(), "cc-pace-mix-")), "config.json");
    assert.deepEqual(update(configFile, { transcript_path: join(tmpdir(), "missing.jsonl"), session_id: "x" }), []);
    assert.equal(update(configFile, {}), null);
});
