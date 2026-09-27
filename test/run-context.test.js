import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { checkProposalRunContext, checkRunContext, inputInventory } from "../src/run-context.js";
import { State } from "../src/state.js";
import { overridesFrom } from "../src/cli.js";
import { loadConfig } from "../src/config.js";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "backpass.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-run-context-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture(name, { restricted = false, source = null } = {}) {
  const repoRoot = path.join(root, name);
  const stateDir = path.join(root, `${name}-state`);
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# Rules\n\n- Check tests.\n");
  fs.writeFileSync(path.join(repoRoot, "CLAUDE.md"), "@AGENTS.md\n");
  const skillDir = path.join(repoRoot, ".agents", "skills", "database");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: database\ndescription: Check schema.\n---\n\nRead schema.\n",
  );
  const state = new State(repoRoot, {
    stateDir,
    mode: 0o700,
    exclude: false,
    binding: { kind: "project", root: repoRoot },
  }).ensure();
  const ctx = {
    repo: { root: repoRoot, realRoot: repoRoot },
    scope: { kind: "project", root: repoRoot },
    config: { state, memoryFiles: ["AGENTS.md", "CLAUDE.md"], skillsDir: ".agents/skills", skillsDirs: [] },
    flags: { "state-dir": stateDir, ...(restricted ? { "child-env": "restricted" } : {}) },
    sessionSource: source,
    sessionSourcePath: null,
  };
  return { ctx, repoRoot, stateDir, state };
}

const corpus = [{ harness: "codex", nativeId: "one", path: "one.jsonl", mtimeMs: 1, bytes: 10 }];

test("explicit state paths keep run contexts and proposals separate", () => {
  const a = fixture("a");
  const b = fixture("b");
  const pinned = checkRunContext(a.ctx, corpus, { start: true });
  assert.equal(a.state.readRunContext().inputMemoryDigest, pinned.inputMemoryDigest);
  assert.equal(b.state.readRunContext(), null);
  assert.throws(() => checkRunContext(b.ctx, corpus), /no frozen run context/);
  a.state.writeProposal({ edits: [] });
  assert.equal(b.state.readProposal(), null);
  assert.throws(
    () => new State(b.repoRoot, { stateDir: a.stateDir, binding: { kind: "project", root: b.repoRoot } }).ensure(),
    /different scope or repository/,
  );
});

test("snapshot, selected corpus, memory, and skill bytes remain pinned", () => {
  const { ctx, repoRoot } = fixture("pin", { source: { sourceId: "source", snapshotDigest: "first" } });
  checkRunContext(ctx, corpus, { start: true });
  checkRunContext(ctx, corpus);
  assert.throws(() => checkRunContext(ctx, [{ ...corpus[0], bytes: 11 }]), /selectedCorpusDigest/);
  ctx.sessionSource.snapshotDigest = "second";
  assert.throws(() => checkRunContext(ctx, corpus), /source/);
  ctx.sessionSource.snapshotDigest = "first";
  fs.appendFileSync(path.join(repoRoot, "AGENTS.md"), "- Keep logs.\n");
  assert.throws(() => checkRunContext(ctx, corpus), /inputMemoryDigest/);
  checkRunContext(ctx, corpus, { start: true });
  fs.appendFileSync(path.join(repoRoot, ".agents/skills/database/SKILL.md"), "More schema.\n");
  assert.throws(() => checkRunContext(ctx, corpus), /inputMemoryDigest/);
});

test("inventory records exact bytes and pointer target; restricted mode refuses an unapproved pointer", () => {
  const { ctx, repoRoot } = fixture("pointer", { restricted: true });
  const inventory = inputInventory(ctx);
  const pointer = inventory.entries.find((entry) => entry.path === "CLAUDE.md");
  assert.equal(pointer.pointerTarget, path.join(repoRoot, "AGENTS.md"));
  assert.equal(pointer.bytes, Buffer.byteLength("@AGENTS.md\n"));
  assert.match(pointer.digest, /^sha256:[a-f0-9]{64}$/);
  fs.writeFileSync(path.join(repoRoot, "CLAUDE.md"), "@private.md\n");
  assert.throws(() => inputInventory(ctx), /unapproved memory pointer/);
});

test("apply validation rejects a changed inventory and a replaced scan", () => {
  const { ctx, repoRoot } = fixture("apply");
  const pinned = checkRunContext(ctx, corpus, { start: true });
  const proposal = { provenance: { source: { kind: "native" }, runContext: pinned } };
  checkProposalRunContext(ctx, proposal);
  fs.appendFileSync(path.join(repoRoot, "AGENTS.md"), "- New rule.\n");
  assert.throws(() => checkProposalRunContext(ctx, proposal), /proposal is stale/);
});

test("private state path refuses links and permissive existing directories", () => {
  const { repoRoot } = fixture("unsafe");
  const target = path.join(root, "unsafe-target");
  fs.mkdirSync(target, { mode: 0o700 });
  const link = path.join(root, "unsafe-link");
  fs.symlinkSync(target, link);
  assert.throws(
    () => new State(repoRoot, { stateDir: link, mode: 0o700, binding: { kind: "project", root: repoRoot } }).ensure(),
    /unsafe private state path/,
  );
  fs.chmodSync(target, 0o755);
  assert.throws(
    () => new State(repoRoot, { stateDir: target, mode: 0o700, binding: { kind: "project", root: repoRoot } }).ensure(),
    /unsafe permissions/,
  );
});

test("timeout and prompt retry flags override config for one invocation", () => {
  const { repoRoot } = fixture("flags");
  const configFile = path.join(repoRoot, ".backpassrc.json");
  const body = '{"timeoutSeconds": 80, "promptRetries": 3}\n';
  fs.writeFileSync(configFile, body);
  const one = loadConfig(repoRoot, overridesFrom({ timeout: "12", "prompt-retries": "0" }));
  const next = loadConfig(repoRoot, overridesFrom({}));
  assert.equal(one.timeoutSeconds, 12);
  assert.equal(one.promptRetries, 0);
  assert.equal(next.timeoutSeconds, 80);
  assert.equal(next.promptRetries, 3);
  assert.equal(fs.readFileSync(configFile, "utf8"), body);
});

test("CLI scan, analyze, status, and propose use the same frozen private state", () => {
  const { repoRoot, stateDir } = fixture("cli");
  const git = spawnSync("git", ["init", "-q", repoRoot]);
  assert.equal(git.status, 0, git.stderr.toString());
  const env = { ...process.env, CODEX_HOME: path.join(repoRoot, "empty-codex-home") };
  const invoke = (command, extras = []) =>
    spawnSync(
      process.execPath,
      [cli, command, "--state-dir", stateDir, "--harness", "codex", "--host", "none", "--since", "all", ...extras],
      { cwd: repoRoot, env, encoding: "utf8" },
    );
  const scan = invoke("scan", ["--json"]);
  assert.equal(scan.status, 0, scan.stderr);
  assert.equal(JSON.parse(scan.stdout).runContext.source.kind, "native");
  const status = invoke("status", ["--json"]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).runContextCurrent, true);
  const analyze = invoke("analyze");
  assert.equal(analyze.status, 0, analyze.stderr);
  fs.appendFileSync(path.join(repoRoot, "AGENTS.md"), "- Changed after scan.\n");
  assert.match(invoke("analyze").stderr, /frozen run context changed/);
  assert.match(invoke("propose").stderr, /frozen run context changed/);
  fs.writeFileSync(path.join(repoRoot, "CLAUDE.md"), "@private.md\n");
  assert.match(invoke("scan", ["--child-env", "restricted"]).stderr, /unapproved memory pointer/);
});
