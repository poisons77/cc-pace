import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runChain } from "../src/chain.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cc-pace.js");
const dir = mkdtempSync(join(tmpdir(), "cc-pace-chain-"));

/** A statusline command that runs `body` with the payload as `input`; quoted for both cmd.exe and sh. */
function command(name, body) {
    const file = join(dir, `${name}.mjs`);
    writeFileSync(file, `let input = ""; process.stdin.on("data", (d) => (input += d)).on("end", () => { ${body} });`);
    return `"${process.execPath}" "${file}"`;
}

const echoModel = command("model", `process.stdout.write("model " + JSON.parse(input).model.display_name + "\\n\\nsecond\\n");`);

test("the chained command gets the payload and its non-blank lines come back", async () => {
    assert.deepEqual(await runChain(echoModel, JSON.stringify({ model: { display_name: "Fable" } })), ["model Fable", "second"]);
});

test("a failing, hanging, missing or recursive command gives nothing", async () => {
    assert.deepEqual(await runChain(command("fail", "process.stdout.write('x'); process.exit(2);"), "{}"), []);
    assert.deepEqual(await runChain(command("hang", "setTimeout(() => {}, 60000);"), "{}", { timeoutMs: 300 }), []);
    assert.deepEqual(await runChain("cc-pace-no-such-command-anywhere", "{}"), []);
    assert.deepEqual(await runChain(echoModel, "{}", { env: { ...process.env, CC_PACE_CHAINED: "1" } }), []);
    assert.deepEqual(await runChain(null, "{}"), []);
});

test("the CLI joins the chained statusline at the end of its own line", () => {
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ segments: ["weekly", "chain"], chain: echoModel }));
    const payload = {
        _now: 1800000000,
        model: { display_name: "Fable" },
        rate_limits: { seven_day: { used_percentage: 71, resets_at: 1800000000 + 2 * 86400 } },
    };
    const out = execFileSync(process.execPath, [BIN], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1", TZ: "UTC", CC_PACE_CONFIG: config, CLAUDE_CONFIG_DIR: dir },
    });
    assert.equal(out, "Weekly: 71% (2d0h) 0.99x | model Fable | second");
});
