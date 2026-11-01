// Git segment. One `git status --porcelain=v2 --branch` spawn yields branch, upstream divergence,
// dirty tracked files and untracked files - four separate git invocations collapsed into one,
// which matters because the statusline re-renders constantly.

import { execFileSync } from "node:child_process";

/**
 * @param {string} stdout Output of `git status --porcelain=v2 --branch`.
 * @returns {{branch:string, dirty:boolean, untracked:boolean, ahead:number, behind:number}}
 */
export function parsePorcelain(stdout) {
    const out = { branch: "(detached)", dirty: false, untracked: false, ahead: 0, behind: 0 };

    for (const line of stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) {
            const head = line.slice("# branch.head ".length).trim();
            if (head && head !== "(detached)") out.branch = head;
        } else if (line.startsWith("# branch.ab ")) {
            const m = line.match(/\+(\d+)\s+-(\d+)/);
            if (m) {
                out.ahead = Number(m[1]);
                out.behind = Number(m[2]);
            }
        } else if (line.startsWith("? ")) {
            out.untracked = true;
        } else if (/^[12u] /.test(line)) {
            out.dirty = true;
        }
    }
    return out;
}

/**
 * @returns {string} e.g. "*+" or "*↓2" - empty string means a clean tree in sync with upstream.
 */
export function stateFlags({ dirty, untracked, ahead, behind }, { ascii = false } = {}) {
    let flags = "";
    if (dirty) flags += "*";
    if (untracked) flags += "+";
    if (behind > 0) flags += `${ascii ? "v" : "↓"}${behind}`;
    if (ahead > 0) flags += `${ascii ? "^" : "↑"}${ahead}`;
    return flags;
}

/**
 * Reads git state for `cwd`. Returns null when cwd is not a work tree or git is unavailable -
 * the statusline must never fail because of git.
 */
export function readGit(cwd, { timeout = 400 } = {}) {
    try {
        // --no-optional-locks: a plain `git status` may refresh the index and take index.lock,
        // colliding with git commands Claude Code runs in the same repo at the same moment.
        const stdout = execFileSync("git", ["--no-optional-locks", "status", "--porcelain=v2", "--branch"], {
            cwd,
            timeout,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
        });
        return parsePorcelain(stdout);
    } catch {
        return null;
    }
}
