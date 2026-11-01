// Config resolution: built-in defaults <- config file <- environment.
// Zero-config is the supported default; the file is only read when it exists.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULTS = {
    // "limits" expands to every rate-limit bucket the payload actually carries. "burn" is the
    // recent-rate warning (src/burn.js), "rotation" the account-switch status (src/rotation.js);
    // both render nothing until they have something to say.
    segments: ["limits", "share", "memory", "burn", "rotation", "git"],
    separator: " | ",
    // Windows limited to one model (Opus, Sonnet, Fable, any added later) are hidden from "limits";
    // the account-wide windows are the ones that stop work. Name one in `segments` to show only it.
    showModelWindows: false,
    // Which buckets get the pace ratio + ETA appended.
    paceOn: ["seven_day"],
    // "when-early" only shows the depletion clock if it lands before the window resets.
    eta: "when-early",
    // Minimum share of a window that must have elapsed before its pace ratio and ETA are shown.
    // Below this the denominator is near zero and the numbers are noise (see src/pace.js).
    minElapsedPct: 2,
    warn: 0.95,
    danger: 1.1,
    // Percentage thresholds that tint the raw used% figure.
    usedWarn: 50,
    usedDanger: 80,
    // Memory: how full this conversation's context window is - what /compact clears. Higher than the
    // usage thresholds: a conversation fills and compacts within a session, so half full is routine.
    memoryWarn: 70,
    memoryDanger: 85,
    // Render a window or the memory only when it needs attention: at or over pace, or past its
    // warn threshold.
    hideCalm: false,
    ascii: false,
    // Optional {bucket, at, run}: runs a command once per window when used% crosses `at`.
    // See src/threshold.js.
    onThreshold: null,
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

const isStringList = (value) => Array.isArray(value) && value.every((s) => typeof s === "string");

/**
 * Never throws: a broken config file degrades to defaults rather than blanking the statusline.
 * `configError` is set when that happened, so the line can say why the settings do nothing.
 */
export function loadConfig(env = process.env) {
    let file = {};
    let configError = false;
    const path = configPath(env);
    try {
        if (existsSync(path)) file = JSON.parse(readFileSync(path, "utf8"));
        if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("not an object");
    } catch {
        file = {};
        configError = true;
    }
    const config = { ...DEFAULTS, ...file, ...fromEnv(env) };
    for (const key of ["segments", "paceOn"]) {
        if (!isStringList(config[key])) {
            config[key] = DEFAULTS[key];
            configError = true;
        }
    }
    return configError ? { ...config, configError } : config;
}
