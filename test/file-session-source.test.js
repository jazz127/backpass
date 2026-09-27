import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { associate, associateRemote } from "../src/discovery/association.js";
import { discoverTranscripts, readTranscript } from "../src/discovery/index.js";
import { associateUserRemote, passesProjectFilter } from "../src/scope.js";
import { transcriptIdentity } from "../src/transcript.js";
import { SELF_SESSION_SENTINEL } from "../src/sentinel.js";
import { approvedContentDigest, canonicalize, digest, snapshotDigest } from "../src/sources/external-session-source.js";
import { discover as discoverFileSource, SessionSourceError } from "../src/sources/file.js";
import { distill } from "../src/distill.js";
import { classifyInteraction } from "../src/interaction.js";

const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "external-session-source",
  "v1",
  "cases",
  "valid-basic",
);
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "backpass.js");

function privateDir(parent, name) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
}

/** @param {(payload: any, manifest: any) => void} [change] */
function makeSnapshot(change = () => {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-file-source-"));
  fs.chmodSync(temp, 0o700);
  const root = privateDir(temp, "snapshot");
  const sessions = privateDir(root, "sessions");
  const sessionDir = privateDir(sessions, "sample-session");
  const manifest = JSON.parse(fs.readFileSync(path.join(fixtures, "manifest.json"), "utf8"));
  const payload = JSON.parse(fs.readFileSync(path.join(fixtures, "payload.json"), "utf8"));
  change(payload, manifest);
  payload.screening.approvedContentDigest = approvedContentDigest(payload);
  const payloadBytes = canonicalize(payload);
  manifest.sessions[0].byteLength = payloadBytes.length;
  manifest.sessions[0].sha256 = digest(payload);
  manifest.snapshotDigest = snapshotDigest(manifest);
  fs.writeFileSync(path.join(sessionDir, "rev-1.json"), payloadBytes, { mode: 0o600 });
  fs.writeFileSync(path.join(root, "manifest.json"), canonicalize(manifest), { mode: 0o600 });
  return { temp, root, manifest, payload };
}

function projectRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-source-project-"));
  return {
    root,
    realRoot: root,
    name: "project",
    worktrees: [root],
    siblingWorktrees: [],
    remotes: ["github.com/acme/project"],
  };
}

function projectScope(repo) {
  const stamp = (association) => {
    if (association) Object.assign(association, { project: repo.root, projectRoot: repo.root });
    return association;
  };
  return {
    kind: "project",
    associate: (descriptor) => stamp(associate(descriptor, repo)),
    associateRemote: (descriptor, options) => stamp(associateRemote(descriptor, repo, options)),
  };
}

function config(overrides = {}) {
  return {
    discovery: {
      since: "all",
      harnesses: ["codex"],
      worktreeGlobs: [],
      includeProjects: [],
      excludeProjects: [],
      ...overrides,
    },
  };
}

test("golden source scans and reads with origin harness, project, interaction, and stable identity", async () => {
  const repo = projectRepo();
  const { temp, root } = makeSnapshot((payload) => {
    payload.originHarness = "codex";
    payload.nativeSessionId = "native-123";
    payload.association.cwd = path.join(repo.root, "src");
    payload.context.interactionClass = "autonomous";
  });
  const calls = { enumerate: 0, sshFetch: 0 };
  const options = {
    repo,
    scope: projectScope(repo),
    config: config(),
    sessionSource: root,
    enumerateNative: () => {
      calls.enumerate++;
      throw new Error("native enumeration called");
    },
    collectHostsFn: () => {
      calls.sshFetch++;
      throw new Error("SSH fetch called");
    },
  };
  const result = await discoverTranscripts(options);
  assert.deepEqual(calls, { enumerate: 0, sshFetch: 0 });
  assert.equal(result.transcripts.length, 1);
  const [session] = result.transcripts;
  assert.equal(session.sourceKind, "external");
  assert.equal(session.sourceId, "sample-source");
  assert.equal(session.harness, "codex");
  assert.equal(session.nativeId, "native-123");
  assert.equal(session.project, repo.root);
  assert.equal(session.association.tier, 1);
  assert.equal(session.interaction, "non-interactive");
  assert.equal(session.path, null);
  assert.equal(session.host, null);
  assert.equal(session.remote, null);
  const read = await readTranscript(session);
  assert.equal(read.rawPath, null);
  assert.equal(read.evidencePolicy, "trace-only");
  assert.deepEqual(
    read.events.map((event) => event.kind),
    ["message", "tool"],
  );
  const identity = transcriptIdentity(session);
  const moved = path.join(temp, "renamed-snapshot");
  fs.renameSync(root, moved);
  const again = await discoverTranscripts({ ...options, sessionSource: path.join(moved, "manifest.json") });
  assert.equal(transcriptIdentity(again.transcripts[0]), identity);
});

test("a source origin harness does not need a native adapter", async () => {
  const repo = projectRepo();
  const { root } = makeSnapshot((payload) => {
    payload.association.cwd = repo.root;
  });
  const result = await discoverTranscripts({ repo, scope: projectScope(repo), config: config(), sessionSource: root });
  assert.equal(result.transcripts[0].harness, "harness-a");
  assert.equal(result.transcripts[0].interaction, "interactive");
  assert.deepEqual(
    (await readTranscript(result.transcripts[0])).events.map((event) => event.eventId),
    ["e1", "e2"],
  );
});

test("a selected snapshot behind a symlinked parent directory is canonicalized and read", async () => {
  const repo = projectRepo();
  const { temp, root } = makeSnapshot((payload) => {
    payload.association.cwd = repo.root;
  });
  const alias = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-source-alias-"));
  const linkedParent = path.join(alias, "linked");
  fs.symlinkSync(temp, linkedParent, "dir");
  const result = await discoverTranscripts({
    repo,
    scope: projectScope(repo),
    config: config(),
    sessionSource: path.join(linkedParent, path.basename(root)),
  });
  assert.equal(result.transcripts.length, 1);
  assert.equal(result.transcripts[0].project, repo.root);
});

test("an unknown interaction class falls back to cwd classification", async () => {
  const repo = projectRepo();
  const { root } = makeSnapshot((payload) => {
    payload.association.cwd = path.join(repo.root, ".no-mistakes", "worktrees", "run");
    payload.context.interactionClass = "unknown";
  });
  const result = await discoverTranscripts({ repo, scope: projectScope(repo), config: config(), sessionSource: root });
  assert.equal(result.transcripts.length, 1);
  assert.equal(result.transcripts[0].interaction, "non-interactive");
  assert.equal(classifyInteraction(result.transcripts[0]), "non-interactive");
});

test("a trace-only session's distilled trace never points at a raw transcript", async () => {
  const repo = projectRepo();
  const { root } = makeSnapshot((payload) => {
    payload.association.cwd = repo.root;
  });
  const result = await discoverTranscripts({ repo, scope: projectScope(repo), config: config(), sessionSource: root });
  const read = await readTranscript(result.transcripts[0]);
  const meta = { ...result.transcripts[0], rawPath: read.rawPath };
  const { trace } = distill(read.events, meta);
  assert.doesNotMatch(trace, /raw transcript/);
  const long = distill(read.events, meta, { maxTraceTokens: 5 });
  assert.equal(long.stats.elided, true);
  assert.doesNotMatch(long.trace, /raw transcript/);
});

test("a projected self session is excluded even when its marker was missed", async () => {
  const repo = projectRepo();
  const { root } = makeSnapshot((payload) => {
    payload.association.cwd = repo.root;
    payload.events[0].text = `${SELF_SESSION_SENTINEL}\nAnalyze this memory.`;
  });
  const result = await discoverTranscripts({ repo, scope: projectScope(repo), config: config(), sessionSource: root });
  assert.equal(result.transcripts.length, 0);
  assert.equal(result.perHarness["harness-a"].self, 1);
});

test("a malformed selected source fails by name without native or SSH fallback", async () => {
  const repo = projectRepo();
  const { root } = makeSnapshot((payload) => {
    payload.association.cwd = repo.root;
  });
  const sessionPath = path.join(root, "sessions", "sample-session", "rev-1.json");
  const payload = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  payload.events[0].text = "Check the samples.";
  payload.screening.approvedContentDigest = approvedContentDigest(payload);
  fs.writeFileSync(sessionPath, canonicalize(payload));
  const calls = { enumerate: 0, sshFetch: 0 };
  await assert.rejects(
    discoverTranscripts({
      repo,
      scope: projectScope(repo),
      config: config(),
      sessionSource: root,
      enumerateNative: () => {
        calls.enumerate++;
      },
      collectHostsFn: () => {
        calls.sshFetch++;
      },
    }),
    (error) => error instanceof SessionSourceError && error.code === "length_mismatch",
  );
  assert.deepEqual(calls, { enumerate: 0, sshFetch: 0 });
});

test("discovery refuses an unvalidated in-memory source handle", async () => {
  const repo = projectRepo();
  await assert.rejects(
    discoverTranscripts({ repo, scope: projectScope(repo), config: config(), sessionSource: { descriptors: [] } }),
    (error) => error instanceof SessionSourceError && error.code === "snapshot_unvalidated",
  );
});

test("remote paths never become local live paths; strict and user filters use recorded remotes", async () => {
  const repo = projectRepo();
  const { root } = makeSnapshot((payload) => {
    payload.originHarness = "claude";
    payload.association.hostAlias = "other-host";
    payload.association.cwd = repo.root;
    payload.association.gitRoot = repo.root;
    payload.association.remotes = [];
  });
  const base = { repo, scope: projectScope(repo), config: config(), sessionSource: root };
  const loose = await discoverTranscripts(base);
  assert.equal(loose.transcripts.length, 0, "an existing foreign path is not treated as a local path");
  const strict = await discoverTranscripts({ ...base, strict: true });
  assert.equal(strict.transcripts.length, 0);

  const snapshot = makeSnapshot((payload) => {
    payload.originHarness = "claude";
    payload.association.hostAlias = "other-host";
    payload.association.cwd = "/gone/worktree/project";
    payload.association.remotes = ["https://github.com/acme/project.git"];
  });
  const remote = await discoverTranscripts({ ...base, strict: true, sessionSource: snapshot.root });
  assert.equal(remote.transcripts[0].association.tier, 2);
  assert.equal(remote.transcripts[0].host, null);

  const userScope = {
    kind: "user",
    associateRemote: (descriptor, options) => associateUserRemote(descriptor, { ...options, strict: true }),
  };
  const userConfig = config({ includeProjects: ["github.com/acme/project"] });
  const user = await discoverTranscripts({
    ...base,
    scope: userScope,
    config: userConfig,
    strict: true,
    sessionSource: snapshot.root,
  });
  assert.equal(user.transcripts[0].project, "github.com/acme/project");
  assert.equal(passesProjectFilter(user.transcripts[0], userConfig), true);
  const filtered = await discoverTranscripts({
    ...base,
    scope: userScope,
    config: config({ includeProjects: ["github.com/other/*"] }),
    strict: true,
    sessionSource: snapshot.root,
  });
  assert.equal(filtered.transcripts.length, 0);

  const dead = makeSnapshot((payload) => {
    payload.association.cwd = "/gone/worktree/project";
  });
  const deadLoose = await discoverTranscripts({ ...base, sessionSource: dead.root });
  assert.equal(deadLoose.transcripts[0].association.tier, 3);
  const deadStrict = await discoverTranscripts({ ...base, strict: true, sessionSource: dead.root });
  assert.equal(deadStrict.transcripts.length, 0);
});

test("CLI scan and status accept a selected snapshot without changing native defaults", () => {
  const repo = projectRepo();
  const { root } = makeSnapshot((payload) => {
    payload.association.cwd = repo.root;
  });
  fs.writeFileSync(path.join(repo.root, "AGENTS.md"), "# Instructions\n");
  assert.equal(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo.root }).status, 0);
  const scan = spawnSync(process.execPath, [cli, "scan", "--session-source", root, "--since", "all", "--json"], {
    cwd: repo.root,
    encoding: "utf8",
  });
  assert.equal(scan.status, 0, scan.stderr);
  const output = JSON.parse(scan.stdout);
  assert.equal(output.transcripts.length, 1);
  assert.equal(output.transcripts[0].harness, "harness-a");
  const status = spawnSync(process.execPath, [cli, "status", "--session-source", root, "--json"], {
    cwd: repo.root,
    encoding: "utf8",
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).sessionSource.sourceId, "sample-source");
  const unsupported = spawnSync(
    process.execPath,
    [cli, "scan", "--session-source", root, "--session-source-mode", "mixed"],
    {
      cwd: repo.root,
      encoding: "utf8",
    },
  );
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /only exclusive is supported/);
});

test("selected source rejects links and all four discovery commands report malformed source", () => {
  const { root } = makeSnapshot();
  const payloadPath = path.join(root, "sessions", "sample-session", "rev-1.json");
  const linked = path.join(root, "sessions", "sample-session", "linked.json");
  fs.linkSync(payloadPath, linked);
  assert.throws(
    () => discoverFileSource(root),
    (error) => error instanceof SessionSourceError && error.code === "link_unsafe",
  );
  fs.unlinkSync(linked);
  fs.unlinkSync(payloadPath);
  fs.symlinkSync(path.join(root, "manifest.json"), payloadPath);
  assert.throws(
    () => discoverFileSource(root),
    (error) => error instanceof SessionSourceError && error.code === "path_unsafe",
  );

  const repo = projectRepo();
  fs.writeFileSync(path.join(repo.root, "AGENTS.md"), "# Instructions\n");
  const git = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo.root });
  assert.equal(git.status, 0);
  for (const command of ["scan", "analyze", "propose", "status"]) {
    const result = spawnSync(process.execPath, [cli, command, "--session-source", root, "--since", "all", "--json"], {
      cwd: repo.root,
      encoding: "utf8",
    });
    assert.equal(result.status, 1, `${command}: ${result.stderr}`);
    assert.match(result.stderr, /SessionSourceError: session source path_unsafe/);
  }
});

test("selected source rejects traversal and a public snapshot directory", () => {
  const traversing = makeSnapshot((payload, manifest) => {
    manifest.sessions[0].contentPath = "../outside.json";
  });
  assert.throws(
    () => discoverFileSource(traversing.root),
    (error) => error instanceof SessionSourceError && error.code === "path_invalid",
  );
  const publicSource = makeSnapshot();
  fs.chmodSync(publicSource.root, 0o755);
  assert.throws(
    () => discoverFileSource(publicSource.root),
    (error) => error instanceof SessionSourceError && error.code === "mode_unsafe",
  );
});
