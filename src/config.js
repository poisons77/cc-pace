// Config resolution: built-in defaults <- config file <- environment.
// Zero-config is the supported default; the file is only read when it exists.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULTS = {
    // "limits" expands to every rate-limit bucket the payload actually carries.
    segments: ["limits", "git"],
    separator: " | ",
    // Which buckets get the pace ratio + ETA appended.
    paceOn: ["seven_day"],
    // "when-early" only shows the depletion clock if it lands before the window resets.
    eta: "when-early",
    warn: 0.95,
    danger: 1.1,
    // Percentage thresholds that tint the raw used% figure.
    usedWarn: 50,
    usedDanger: 80,
    ascii: false,
};

export function configPath(env = process.env) {
    if (env.CC_PACE_CONFIG) return env.CC_PACE_CONFIG;
    return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cc-pace", "config.json");
}

function fromEnv(env) {
    const out = {};
    if (env.CC_PACE_SEGMENTS) out.segments = env.CC_PACE_SEGMENTS.split(",").map((s) => s.trim());
    if (env.CC_PACE_SEPARATOR) out.separator = env.CC_PACE_SEPARATOR;
    if (env.CC_PACE_ETA) out.eta = env.CC_PACE_ETA;
    if (env.CC_PACE_ASCII === "1") out.ascii = true;
    return out;
}

/**
 * Never throws: a broken config file degrades to defaults rather than blanking the statusline.
 */
export function loadConfig(env = process.env) {
    let file = {};
    const path = configPath(env);
    try {
        if (existsSync(path)) file = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        file = {};
    }
    return { ...DEFAULTS, ...file, ...fromEnv(env) };
}
