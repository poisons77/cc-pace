// Which models a session's spend went to, subagents included.
//
// The payload names the main conversation's model only, so a session that burns mostly through
// subagents on another model would be blamed on the wrong one. The transcript records every reply's
// model and token usage, and each subagent writes its own transcript beside it. Pricing those
// tokens gives each model's share of the session's cost - the same split `/usage` shows.
//
// Transcripts grow to many megabytes, so each render reads only what was appended since the last
// one: a byte offset per file is kept in the session's state file. Nothing here may throw.

import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileName } from "./share.js";

const modelsDir = (configFile) => join(dirname(configFile), "models");

// $ per million tokens. Cache writes cost 1.25x input for the 5-minute TTL and 2x for the 1-hour
// one; cache reads have their own price per family. Matched by family so a new version of a
// family is priced without a code change; an unknown family is left out rather than guessed.
const PRICES = {
    fable: { input: 10, output: 50, read: 0.25 },
    mythos: { input: 10, output: 50, read: 0.25 },
    opus: { input: 4, output: 20, read: 0.2 },
    sonnet: { input: 2, output: 10, read: 0.2 },
    haiku: { input: 0.1, output: 0.5, read: 0.01 },
};
const WEB_SEARCH_USD = 0.01;
const RECENT_IDS = 20;              // a reply is written once per content block; dedupe by id
// A transcript seen for the first time is read from this far before its end, and no render reads
// more than this. Real transcripts reach gigabytes; the mix describes the recent spend anyway.
const READ_CAP = 8 * 1024 * 1024;
// A file that has not grown for this long belongs to a finished subagent: it is checked again only
// this often. Checking every file of a session with seventy subagents cost ~12 ms a render.
const SETTLED_SECS = 600;
const STALE_ON_SIGHT_SECS = 3600;

const familyOf = (model) => /^claude-([a-z]+)/.exec(model)?.[1] ?? null;

/** `claude-sonnet-5-5` -> "Sonnet 5.5"; a trailing date snapshot is dropped. */
export function modelName(model) {
    const parts = String(model).replace(/^claude-/, "").split("-").filter((p) => !/^\d{8}$/.test(p));
    if (parts.length === 0) return String(model);
    const [family, ...version] = parts;
    const name = family.charAt(0).toUpperCase() + family.slice(1);
    return version.length ? `${name} ${version.join(".")}` : name;
}

/** What one reply cost, in dollars, or null for a model whose price is unknown. */
export function replyCost(model, usage) {
    const price = PRICES[familyOf(model)];
    if (!price || !usage) return null;
    const write = usage.cache_creation ?? {};
    const split = typeof write.ephemeral_1h_input_tokens === "number" || typeof write.ephemeral_5m_input_tokens === "number";
    const write1h = split ? write.ephemeral_1h_input_tokens ?? 0 : 0;
    const write5m = split ? write.ephemeral_5m_input_tokens ?? 0 : usage.cache_creation_input_tokens ?? 0;
    const tokens =
        (usage.input_tokens ?? 0) * price.input +
        (usage.output_tokens ?? 0) * price.output +
        write5m * price.input * 1.25 +
        write1h * price.input * 2 +
        (usage.cache_read_input_tokens ?? 0) * price.read;
    return tokens / 1e6 + (usage.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD;
}

/**
 * Adds the cost of every new reply in `text` to `costs`, skipping the repeats a reply leaves when
 * it is written once per content block. Returns the ids seen most recently, for the next call.
 */
export function tally(text, costs, recent = []) {
    const seen = [...recent];
    for (const line of text.split("\n")) {
        if (!line.includes('"type":"assistant"')) continue;
        let entry;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        const message = entry?.message;
        const id = message?.id ?? entry?.requestId;
        if (!message?.model || !id || seen.includes(id)) continue;
        seen.push(id);
        const cost = replyCost(message.model, message.usage);
        if (cost !== null) costs[message.model] = (costs[message.model] ?? 0) + cost;
    }
    return seen.slice(-RECENT_IDS);
}

/**
 * Bytes appended to `file` since `offset` (null: never read), at most READ_CAP of them, cut at the
 * last complete line. A first read starts READ_CAP before the end; the partial line it lands in
 * fails to parse and is skipped.
 */
function appended(file, offset, budget, now) {
    const { size, mtimeMs } = statSync(file);
    // Not written for an hour when first seen: spend from before cc-pace was watching, not the
    // recent spend the mix describes. Bookmarked at its end, unread.
    if (offset === null && now - mtimeMs / 1000 > STALE_ON_SIGHT_SECS) return { text: "", offset: size, stale: true };
    const from = offset === null ? Math.max(0, size - READ_CAP) : Math.min(offset, size);
    if (size <= from || budget <= 0) return { text: "", offset: from };
    const fd = openSync(file, "r");
    try {
        const buffer = Buffer.alloc(Math.min(size - from, budget));
        readSync(fd, buffer, 0, buffer.length, from);
        const end = buffer.lastIndexOf(0x0a);
        if (end < 0) return { text: "", offset: from };
        return { text: buffer.subarray(0, end).toString("utf8"), offset: from + end + 1 };
    } finally {
        closeSync(fd);
    }
}

function transcripts(main) {
    const dir = join(main.replace(/\.jsonl$/, ""), "subagents");
    let agents = [];
    try {
        agents = readdirSync(dir).filter((n) => n.endsWith(".jsonl")).map((n) => join(dir, n));
    } catch {
        /* no subagents yet */
    }
    return [main, ...agents];
}

/** Each model's share of the session's spend, largest first: [{ name, share }] with share in %. */
export function mixOf(costs) {
    const total = Object.values(costs).reduce((a, b) => a + b, 0);
    if (total <= 0) return [];
    return Object.entries(costs)
        .map(([model, usd]) => ({ model, name: modelName(model), share: (usd / total) * 100 }))
        .sort((a, b) => b.share - a.share);
}

/**
 * Reads what the session's transcripts gained since the last render and returns the model mix of
 * its whole spend so far, or null.
 */
export function update(configFile, payload, now = Math.floor(Date.now() / 1000)) {
    try {
        const main = payload?.transcript_path;
        const id = payload?.session_id;
        if (typeof main !== "string" || !main || !id) return null;

        const file = join(modelsDir(configFile), fileName(id));
        let state;
        try {
            state = JSON.parse(readFileSync(file, "utf8"));
        } catch {
            state = {};
        }
        const files = state.files ?? {};
        const costs = state.costs ?? {};
        let changed = false;
        // Shared by every file this render: the rest waits for the next one.
        let budget = READ_CAP;

        for (const path of transcripts(main)) {
            const prior = files[path];
            const settled = prior && path !== main && now - prior.grew > SETTLED_SECS;
            if (settled && now - prior.checked < SETTLED_SECS) continue;
            let read;
            try {
                read = appended(path, prior?.offset ?? null, budget, now);
            } catch {
                continue;
            }
            budget -= Buffer.byteLength(read.text);
            const grew = read.offset !== prior?.offset;
            files[path] = {
                offset: read.offset,
                recent: grew ? tally(read.text, costs, prior?.recent) : prior.recent,
                // A file bookmarked unread is already finished: settled from the start.
                grew: read.stale ? 0 : grew ? now : prior.grew,
                checked: now,
            };
            changed = changed || grew || settled;
        }

        if (changed) {
            mkdirSync(modelsDir(configFile), { recursive: true });
            writeFileSync(file, JSON.stringify({ files, costs }));
        }
        return mixOf(costs);
    } catch {
        return null;
    }
}
