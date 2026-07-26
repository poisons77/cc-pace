// Cold-start budget check.
//
// The statusline re-renders on activity, so process startup dominates - the render itself is
// microseconds. Node's own boot time (~90 ms on Windows, ~35 ms on Linux) is a floor no Node CLI
// can beat, so the number worth gating on is the OVERHEAD cc-pace adds on top of it. That is the
// part we control, and it stays comparable across machines.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "cc-pace.js");
const input = readFileSync(join(HERE, "fixtures", "on-pace.json"), "utf8");

const RUNS = Number(process.env.BENCH_RUNS || 20);
const OVERHEAD_BUDGET_MS = Number(process.env.BENCH_BUDGET_MS || 30);

function median(fn) {
    const samples = [];
    for (let i = 0; i < RUNS; i++) {
        const t0 = process.hrtime.bigint();
        fn();
        samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)];
}

const boot = median(() => execFileSync(process.execPath, ["-e", "0"], { stdio: "ignore" }));
const total = median(() => execFileSync(process.execPath, [BIN], { input, encoding: "utf8" }));
const overhead = total - boot;

console.log(`runs          ${RUNS}`);
console.log(`node boot     ${boot.toFixed(1)} ms  (floor, not ours)`);
console.log(`cc-pace total ${total.toFixed(1)} ms`);
console.log(`our overhead  ${overhead.toFixed(1)} ms  (budget ${OVERHEAD_BUDGET_MS} ms)`);

if (overhead > OVERHEAD_BUDGET_MS) {
    console.error(`FAIL: overhead ${overhead.toFixed(1)} ms exceeds ${OVERHEAD_BUDGET_MS} ms`);
    process.exit(1);
}
