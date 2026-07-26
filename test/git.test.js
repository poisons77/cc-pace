import { test } from "node:test";
import assert from "node:assert/strict";

import { parsePorcelain, stateFlags } from "../src/git.js";

const CLEAN = `# branch.oid abc123
# branch.head main
# branch.upstream origin/main
# branch.ab +0 -0
`;

test("a clean tree reports no state", () => {
    const g = parsePorcelain(CLEAN);
    assert.deepEqual(g, { branch: "main", dirty: false, untracked: false, ahead: 0, behind: 0 });
    assert.equal(stateFlags(g), "");
});

test("modified tracked files mark the tree dirty", () => {
    const g = parsePorcelain(`${CLEAN}1 .M N... 100644 100644 100644 aaa bbb src/app.js\n`);
    assert.equal(g.dirty, true);
    assert.equal(stateFlags(g), "*");
});

test("renames and unmerged entries also count as dirty", () => {
    assert.equal(parsePorcelain(`${CLEAN}2 R. N... 100644 100644 100644 aaa bbb R100 new\told\n`).dirty, true);
    assert.equal(parsePorcelain(`${CLEAN}u UU N... 100644 100644 100644 100644 a b c conflict.js\n`).dirty, true);
});

test("untracked files are tracked separately from dirty ones", () => {
    const g = parsePorcelain(`${CLEAN}? notes.md\n`);
    assert.equal(g.dirty, false);
    assert.equal(g.untracked, true);
    assert.equal(stateFlags(g), "+");
});

test("divergence from upstream is read from branch.ab", () => {
    const g = parsePorcelain(`# branch.head dev\n# branch.ab +3 -2\n`);
    assert.equal(g.ahead, 3);
    assert.equal(g.behind, 2);
    assert.equal(stateFlags(g), "↓2↑3");
    assert.equal(stateFlags(g, { ascii: true }), "v2^3");
});

test("a detached head has no branch name", () => {
    assert.equal(parsePorcelain(`# branch.oid abc\n# branch.head (detached)\n`).branch, "(detached)");
});

test("a repository with no commits and no upstream still parses", () => {
    const g = parsePorcelain(`# branch.oid (initial)\n# branch.head main\n`);
    assert.deepEqual(g, { branch: "main", dirty: false, untracked: false, ahead: 0, behind: 0 });
});

test("empty output degrades instead of throwing", () => {
    assert.doesNotThrow(() => parsePorcelain(""));
});

test("all flags combine in a stable order", () => {
    const g = { branch: "main", dirty: true, untracked: true, ahead: 1, behind: 2 };
    assert.equal(stateFlags(g), "*+↓2↑1");
});
