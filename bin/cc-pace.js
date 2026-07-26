#!/usr/bin/env node
// cc-pace - Claude Code statusline: usage limits, burn pace, depletion ETA.
//
// Reads the statusline JSON on stdin and writes a single line on stdout. It must never crash and
// never hang: any failure degrades to a shorter line, or to nothing at all.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { render, metrics } from "../src/render.js";
import { loadConfig, configPath } from "../src/config.js";
import { colorEnabled } from "../src/colors.js";
import { readGit } from "../src/git.js";

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
  Weekly:  71% (2d1h) 1.00x Tue 16:26   used%, time left, burn pace, projected 100%
  main [*+]                          git branch and working-tree state

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

function main() {
    const argv = process.argv.slice(2);
    const has = (flag) => argv.includes(flag);

    if (has("-h") || has("--help")) return void process.stdout.write(`${HELP}\n`);
    if (has("-v") || has("--version")) return void process.stdout.write(`${PKG.version}\n`);

    if (has("--setup")) {
        const snippet = {
            statusLine: { type: "command", command: "npx -y claude-code-pace" },
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

    const cwd = payload.workspace?.current_dir || payload.cwd || payload.workspace?.project_dir;
    const git = config.segments.includes("git") && cwd ? readGit(cwd) : null;

    process.stdout.write(
        render(payload, {
            color: colorEnabled({ noColorFlag: has("--no-color") }),
            config,
            git,
            now,
        }),
    );
}

try {
    main();
} catch {
    // A statusline that throws is worse than a statusline that is briefly empty.
    process.stdout.write("");
}
