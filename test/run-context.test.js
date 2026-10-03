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
import { resolveScope } from "../src/scope.js";

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

test("named nested memory bytes remain pinned through propose and apply", () => {
  const { ctx, repoRoot } = fixture("nested-pin", { restricted: true });
  const nestedPath = "apps/api/AGENTS.md";
  ctx.config.nestedMemoryFiles = [nestedPath];
  fs.mkdirSync(path.join(repoRoot, "apps/api"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, nestedPath), "# API rules\n\n- Check contracts.\n");
  const pinned = checkRunContext(ctx, corpus, { start: true });
  const proposal = { provenance: { source: { kind: "native" }, runContext: pinned } };
  checkProposalRunContext(ctx, proposal);
  fs.appendFileSync(path.join(repoRoot, nestedPath), "- Check timeouts.\n");
  assert.throws(() => checkRunContext(ctx, corpus), /inputMemoryDigest/);
  assert.throws(() => checkProposalRunContext(ctx, proposal), /proposal is stale/);
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

test("private state path under the platform temp dir is accepted", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-tmp-repo-"));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-tmp-state-"));
  try {
    const state = new State(repoRoot, {
      stateDir: path.join(parent, "x"),
      mode: 0o700,
      exclude: false,
      binding: { kind: "project", root: repoRoot },
    }).ensure();
    assert.equal(state.readRunContext(), null);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("private state path refuses a user-owned ancestor link", () => {
  const { repoRoot } = fixture("ancestor");
  const target = path.join(root, "ancestor-target");
  fs.mkdirSync(target, { mode: 0o700 });
  const link = path.join(root, "ancestor-link");
  fs.symlinkSync(target, link);
  assert.throws(
    () =>
      new State(repoRoot, {
        stateDir: path.join(link, "state"),
        mode: 0o700,
        binding: { kind: "project", root: repoRoot },
      }).ensure(),
    /unsafe private state path/,
  );
});

test("private state path follows a root-owned system ancestor link", { skip: !process.getuid }, (t) => {
  const { repoRoot } = fixture("system");
  const base = fs.realpathSync(fs.mkdtempSync(path.join(root, "system-")));
  const target = path.join(base, "real");
  fs.mkdirSync(target, { mode: 0o700 });
  const link = path.join(base, "link");
  fs.symlinkSync(target, link);
  const make = () =>
    new State(repoRoot, {
      stateDir: path.join(link, "state"),
      mode: 0o700,
      exclude: false,
      binding: { kind: "project", root: repoRoot },
    }).ensure();
  const lstat = fs.lstatSync;
  const rootOwned = (parentMode) =>
    t.mock.method(fs, "lstatSync", (file, ...rest) => {
      const stat = lstat(file, ...rest);
      if (file !== link && file !== base && !base.startsWith(`${file}${path.sep}`)) return stat;
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
        uid: 0,
        mode: file === base ? (stat.mode & ~0o7777) | parentMode : stat.mode,
      });
    });
  const writable = rootOwned(0o777);
  assert.throws(make, /unsafe private state path/);
  writable.mock.restore();
  const locked = rootOwned(0o755);
  make();
  locked.mock.restore();
  assert.ok(fs.statSync(path.join(target, "state", "scope.json")).isFile());
});

test("state dir containment is judged on the canonical path behind a system link", { skip: !process.getuid }, (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(root, "alias-")));
  const repoRoot = path.join(base, "real", "proj");
  fs.mkdirSync(repoRoot, { recursive: true, mode: 0o700 });
  const link = path.join(base, "link");
  fs.symlinkSync(path.join(base, "real"), link);
  const lstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (file, ...rest) => {
    const stat = lstat(file, ...rest);
    if (file !== link && file !== base && !base.startsWith(`${file}${path.sep}`)) return stat;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
      uid: 0,
      mode: file === base ? (stat.mode & ~0o7777) | 0o755 : stat.mode,
    });
  });
  const repo = { root: repoRoot, realRoot: repoRoot, name: "proj", worktrees: [repoRoot], remotes: [] };
  const scopeFor = (stateDir) =>
    resolveScope(repoRoot, { scope: "project", "state-dir": stateDir }, loadConfig(repoRoot), repo);
  assert.equal(scopeFor(path.join(link, "proj", ".bp")).stateDir, path.join(repoRoot, ".bp"));
  assert.throws(() => scopeFor(path.join(link, "proj", ".git", "bp")), /Git internals/);
  assert.throws(() => scopeFor(path.join(link, "proj")), /dedicated private directory/);
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
