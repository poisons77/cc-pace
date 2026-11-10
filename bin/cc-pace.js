#!/usr/bin/env node
// cc-pace - Claude Code statusline: usage limits, burn pace, depletion ETA.
//
// Reads the statusline JSON on stdin and writes a single line on stdout. It must never crash and
// never hang: any failure degrades to a shorter line, or to nothing at all.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { render, metrics, segmentNames } from "../src/render.js";
import { loadConfig, configPath } from "../src/config.js";
import { colorEnabled } from "../src/colors.js";
import { readGit } from "../src/git.js";
import { runThresholdHook } from "../src/threshold.js";
import { historyPath, update as updateBurn } from "../src/burn.js";
import { update as updateShare } from "../src/share.js";
import { update as updateMix } from "../src/models.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

const HELP = `cc-pace ${PKG.version} - Claude Code statusline with burn pace

USAGE
  cc-pace [options]            reads statusline JSON on stdin

OPTIONS
  --demo         render the bundled sample payload (no stdin needed)
  --dump         pretty-print the raw statusline JSON and exit
  --json         print computed metrics as JSON instead of a status line
  --no-color     disable ANSI colour (NO_COLOR is honoured too)
  --setup        print the settings.json snippet to paste into Claude Code
  --config       print the resolved config and its file path
  -h, --help     show this help
  -v, --version  show version

SEGMENTS
  Session: 12% (4h37m)               5-hour rolling window
  Week:    71% (2d1h) 1.00x Tue 16:26   used%, time left, burn pace, projected 100%
  Pool: 35% ↓22% stop Fri 17:45 -37h   this session's share of the last hour's spend; with
                                     rotation, ↑ push / ↓ slow down, and when all accounts run dry
  Cache: 42% cold in 12m (270k)      how full this conversation is (what /compact clears), and
                                     a warning before a large prompt cache expires
  Week 1h7m to 100% (22:13)      the last hour's rate hits the wall before the reset
  main [*+]                          git branch and working-tree state
  (chain)                            the output of another statusline, set with "chain" in config

  Pace ratio is used% divided by elapsed%. 1.00x means exactly on budget;
  above 1 means the window runs dry before it resets.

Requires Claude Code >= 2.1.80 for rate_limits in the statusline payload.
Not affiliated with Anthropic.`;

function readStdin() {
    try {
        return readFileSync(0, "utf8");
    } catch {
        return "";
    }
}

function parse(raw) {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function main() {
    const argv = process.argv.slice(2);
    const has = (flag) => argv.includes(flag);

    if (has("-h") || has("--help")) return void process.stdout.write(`${HELP}\n`);
    if (has("-v") || has("--version")) return void process.stdout.write(`${PKG.version}\n`);

    if (has("--setup")) {
        const snippet = {
            // refreshInterval redraws the line while the session is idle, which is when the
            // cache warning and the countdowns matter.
            statusLine: { type: "command", command: "npx -y claude-code-pace", refreshInterval: 60 },
        };
        process.stdout.write(`${JSON.stringify(snippet, null, 2)}\n`);
        return;
    }

    const config = loadConfig();

    if (has("--config")) {
        process.stdout.write(`${JSON.stringify({ path: configPath(), config }, null, 2)}\n`);
        return;
    }

    const raw = has("--demo")
        ? readFileSync(join(HERE, "..", "src", "demo.json"), "utf8")
        : readStdin();

    if (has("--dump")) {
        const parsed = parse(raw);
        process.stdout.write(parsed ? `${JSON.stringify(parsed, null, 2)}\n` : `${raw}\n`);
        return;
    }

    const payload = parse(raw) || {};
    // Fixtures pin `_now` so --demo and the snapshot tests render deterministically.
    const now = typeof payload._now === "number" ? payload._now : undefined;

    if (has("--json")) {
        process.stdout.write(`${JSON.stringify(metrics(payload, { config, now }), null, 2)}\n`);
        return;
    }

    // Started first, so the other statusline runs while cc-pace does its own work. Imported only when
    // configured; --demo has no real payload to hand it.
    const chained =
        config.chain && !has("--demo")
            ? import("../src/chain.js").then(({ runChain }) => runChain(config.chain, raw, { timeoutMs: config.chainTimeoutMs }))
            : Promise.resolve([]);

    const cwd = payload.workspace?.current_dir || payload.cwd || payload.workspace?.project_dir;
    const shown = segmentNames(config.segments);
    const git = shown.includes("git") && cwd ? readGit(cwd) : null;

    // --demo carries a fixture payload: it must neither write history nor trigger real switches.
    const live = !has("--demo") && payload.rate_limits && typeof payload.rate_limits === "object";
    const file = configPath();

    // Recorded and read in one step, so the warning describes this render rather than the last.
    const burn = live && shown.includes("burn")
        ? updateBurn(historyPath(file), payload.rate_limits, now)
        : null;

    // --demo excluded, as above. Unlike the limits, a session's cost exists without a subscription.
    const share = !has("--demo") && shown.includes("pool") ? updateShare(file, payload, now) : null;
    // Kept current every render, so the shares are ready the moment a ratio turns red.
    const mix = !has("--demo") && config.modelMix ? updateMix(file, payload) : null;

    // Loaded only when configured: most installs never rotate, and should not pay for the import.
    // `enabled: false` keeps the user's accounts and thresholds while switching the engine off.
    const rotating = live && config.rotation && config.rotation.enabled !== false;
    const rotation = rotating ? await import("../src/rotation.js") : null;
    const rotationText = rotation && shown.includes("rotation") ? rotation.readDisplay(file) : null;
    const pool = rotation && shown.includes("pool") ? rotation.readForecast(file) : null;
    const chain = await chained.catch(() => []);

    const written = new Promise((resolve) =>
        process.stdout.write(
            render(payload, {
                color: colorEnabled({ noColorFlag: has("--no-color") }),
                config,
                git,
                now,
                notes: { burn, rotation: rotationText, share, mix, pool, chain },
            }),
            resolve,
        ),
    );

    // After the line is written, so neither can delay the render. Any switch is spawned detached.
    if (live && config.onThreshold) runThresholdHook(payload.rate_limits, config.onThreshold, file);
    if (rotation) rotation.runRotation(payload.rate_limits, config.rotation, file, now);
    // Real processes, real clock: a fixture payload (pinned `_now`) or --demo must not sweep them.
    // Imported only where it can run: the stuck copies exist only on Windows.
    if (config.reapStuck && process.platform === "win32" && !has("--demo") && now === undefined) {
        (await import("../src/reap.js")).reapStuck(file);
    }

    // A chained command that outlived its timeout can leave a grandchild holding the process open:
    // on Windows, killing the shell does not kill what the shell started. Once the line is out,
    // nothing else is owed.
    if (config.chain) {
        await written;
        process.exit(0);
    }
}

main().catch(() => {
    // A statusline that throws is worse than a statusline that is briefly empty.
    process.stdout.write("");
});
