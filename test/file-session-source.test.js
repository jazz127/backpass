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
import { sanitizeEvidence } from "../src/analyze.js";
import { renderPrompt } from "../src/prompts.js";
import { assertSourceCurrent } from "../src/provenance.js";
import { ATTRIBUTION_VERSION, attributeTranscripts, checkoutRoots, owningFile } from "../src/nested.js";
import { nestedCorpora } from "../src/commands/analyze.js";
import { State } from "../src/state.js";

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

for (const cached of [false, true]) {
  test(`remote external sessions stay root-only with ${cached ? "stale cached" : "fresh"} attribution`, async () => {
    const repo = projectRepo();
    const weight = { path: "apps/api/AGENTS.md", dir: "apps/api" };
    const state = new State(repo.root, { exclude: false }).ensure();
    const transcripts = [];
    for (const [index, remote] of [true, true, false].entries()) {
      const { root } = makeSnapshot((payload, manifest) => {
        manifest.sourceNamespace = `attribution-${index}`;
        payload.sourceId = manifest.sourceNamespace;
        payload.association.cwd = path.join(repo.root, weight.dir);
        payload.association.remotes = repo.remotes;
        if (remote) payload.association.hostAlias = "remote-host";
        payload.events[1].name = "edit";
        payload.events[1].input = { path: "handler.ts" };
      });
      const discovered = await discoverTranscripts({
        repo,
        scope: projectScope(repo),
        config: config(),
        sessionSource: root,
      });
      assert.equal(discovered.transcripts.length, 1);
      const transcript = discovered.transcripts[0];
      assert.equal(transcript.sourceKind, "external");
      assert.equal(transcript.host, null);
      assert.equal(transcript.sourceHostAlias, remote ? "remote-host" : null);
      transcripts.push(transcript);
    }
    const cachePath = path.join(state.root, "nested", "attribution.json");
    if (cached)
      state.writeJsonFile(cachePath, {
        version: ATTRIBUTION_VERSION,
        roots: checkoutRoots(repo),
        entries: Object.fromEntries(
          transcripts.map((transcript) => [
            transcriptIdentity(transcript),
            { content: transcript.contentSignature, paths: ["apps/api/handler.ts"] },
          ]),
        ),
      });
    const attribution = await attributeTranscripts(transcripts, repo, state);
    const remoteIds = transcripts.slice(0, 2).map(transcriptIdentity);
    for (const id of remoteIds) assert.equal(attribution.get(id), null);
    assert.equal(owningFile(remoteIds, [weight], attribution), null);
    assert.deepEqual(attribution.get(transcriptIdentity(transcripts[2])), ["apps/api/handler.ts"]);
    const { corpora } = await nestedCorpora({ repo, config: { state } }, [weight], transcripts);
    assert.deepEqual(corpora[0].transcripts, [transcripts[2]]);
    const saved = state.readJsonFile(cachePath, null);
    for (const id of remoteIds) assert.equal(saved.entries[id], undefined);
  });
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

test("a later approved revision replaces the same session in discovery", async () => {
  const repo = projectRepo();
  const { root, manifest, payload } = makeSnapshot((session) => {
    session.association.cwd = repo.root;
  });
  const before = await discoverTranscripts({ repo, scope: projectScope(repo), config: config(), sessionSource: root });
  const revised = structuredClone(payload);
  revised.revision = "rev-2";
  revised.projectedAt = "2026-01-04T00:00:00Z";
  revised.events[0].text = "A later approved revision.";
  revised.screening.approvedContentDigest = approvedContentDigest(revised);
  const bytes = canonicalize(revised);
  const contentPath = "sessions/sample-session/rev-2.json";
  fs.writeFileSync(path.join(root, contentPath), bytes, { mode: 0o600 });
  manifest.sessions.push({
    sessionId: revised.sessionId,
    revision: revised.revision,
    contentPath,
    byteLength: bytes.length,
    sha256: digest(revised),
  });
  manifest.coverage.published += 1;
  manifest.coverage.considered += 1;
  manifest.snapshotDigest = snapshotDigest(manifest);
  fs.writeFileSync(path.join(root, "manifest.json"), canonicalize(manifest), { mode: 0o600 });

  const after = await discoverTranscripts({ repo, scope: projectScope(repo), config: config(), sessionSource: root });
  assert.equal(after.transcripts.length, 1);
  assert.equal(after.transcripts[0].revision, "rev-2");
  assert.equal(transcriptIdentity(after.transcripts[0]), transcriptIdentity(before.transcripts[0]));
  assert.notEqual(after.transcripts[0].contentSignature, before.transcripts[0].contentSignature);
  assert.equal((await readTranscript(after.transcripts[0])).events[0].text, "A later approved revision.");
});

test("a proposal source binding refuses a changed approved snapshot", () => {
  const { root, manifest } = makeSnapshot();
  const ctx = { sessionSourcePath: root, sessionSource: discoverFileSource(root) };
  assert.doesNotThrow(() => assertSourceCurrent(ctx));
  manifest.createdAt = "2026-01-05T00:00:00Z";
  manifest.snapshotDigest = snapshotDigest(manifest);
  fs.writeFileSync(path.join(root, "manifest.json"), canonicalize(manifest), { mode: 0o600 });
  assert.throws(() => assertSourceCurrent(ctx), /approved session source changed/);
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

test("selected source evidence is anchored only to retained approved event text", async () => {
  const repo = projectRepo();
  const { root } = makeSnapshot((payload) => {
    payload.association.cwd = repo.root;
    payload.events[0].text = "The approved event text is retained exactly.";
    payload.events[1].input = { description: "[redacted]" };
    payload.events[1].omitted = true;
  });
  const result = await discoverTranscripts({ repo, scope: projectScope(repo), config: config(), sessionSource: root });
  const transcript = result.transcripts[0];
  const read = await readTranscript(transcript);
  const rawPath = "/private/transcripts/secret.jsonl";
  const distilled = distill(
    read.events,
    { ...transcript, rawPath, cwd: rawPath },
    { evidencePolicy: read.evidencePolicy },
  );
  const prompt = renderPrompt("analysis-trace-only", {
    MEMORY_PATH: "AGENTS.md",
    INSTRUCTION_INDEX: "[AG-001] Example instruction",
    SKILLS: "(none)",
    OPEN_GAPS: "(none)",
    TRACE: distilled.trace,
  });
  assert.doesNotMatch(distilled.trace, /\/private\/transcripts|raw transcript|Open the raw/);
  assert.doesNotMatch(prompt, /\/private\/transcripts|raw transcript|Open the raw/);

  const item = (quote) => ({ positive: [{ instruction: "AG-001", quote }] });
  const exact = sanitizeEvidence(
    item("The approved event text is retained exactly."),
    null,
    distilled,
    read.evidencePolicy,
  );
  assert.equal(exact.positive.length, 1);
  assert.deepEqual(exact.positive[0].source, {
    sourceId: "sample-source",
    sessionId: "sample-session",
    revision: "rev-1",
    approvedContentDigest: transcript.screening.approvedContentDigest,
    eventId: "e1",
    sourceRefs: ["sv-evidence:a"],
    field: "text",
    quoteSpan: { start: 0, end: 44 },
  });
  for (const usedRawTranscript of [undefined, false, "false"]) {
    const response = { ...item("A sentence the model fabricated outright."), usedRawTranscript };
    const clean = sanitizeEvidence(response, null, distilled, read.evidencePolicy);
    assert.equal(clean.positive.length, 0);
    assert.equal(clean.quotesNotInTrace, 1);
  }
  assert.throws(
    () =>
      sanitizeEvidence(
        { ...item("A sentence the model fabricated outright."), usedRawTranscript: true },
        null,
        distilled,
        read.evidencePolicy,
      ),
    /trace_only_raw_access_reported/,
  );
  assert.throws(
    () => sanitizeEvidence(item("The approved event text is retained exactly."), null, null, read.evidencePolicy),
    /trace_only_trace_missing/,
  );
  assert.equal(
    sanitizeEvidence(item("sample-source/sample-session@rev-1"), null, distilled, read.evidencePolicy).positive.length,
    0,
  );
  assert.equal(sanitizeEvidence(item("[redacted]"), null, distilled, read.evidencePolicy).positive.length, 0);
  assert.equal(sanitizeEvidence(item("redacted"), null, distilled, read.evidencePolicy).positive.length, 0);
  const visiblePlaceholder = distill([{ ...read.events[1], omitted: false }], transcript, {
    evidencePolicy: read.evidencePolicy,
  });
  assert.equal(sanitizeEvidence(item("redacted"), null, visiblePlaceholder, read.evidencePolicy).positive.length, 0);
  const foldedEvent = distill(
    [{ ...read.events[0], text: "The approved\n event text is retained exactly." }],
    transcript,
    {
      evidencePolicy: read.evidencePolicy,
    },
  );
  const folded = sanitizeEvidence(item("approved event text is retained"), null, foldedEvent, read.evidencePolicy);
  const { start, end } = folded.positive[0].source.quoteSpan;
  assert.equal(foldedEvent.retained[0].fields[0].text.slice(start, end), "approved\n event text is retained");
  assert.equal(
    sanitizeEvidence(item("retained exactly. synthetic operation"), null, distilled, read.evidencePolicy).positive
      .length,
    0,
  );
});

test("trace-only anchors exclude generated truncation annotations", async () => {
  const repo = projectRepo();
  const { root } = makeSnapshot((payload) => {
    payload.association.cwd = repo.root;
  });
  const result = await discoverTranscripts({ repo, scope: projectScope(repo), config: config(), sessionSource: root });
  const transcript = result.transcripts[0];
  const read = await readTranscript(transcript);
  const command = `run the retained command ${"a".repeat(200)}`;
  const output = `retained output line ${"b".repeat(300)}`;
  const distilled = distill([{ ...read.events[1], omitted: false, input: { command }, result: output }], transcript, {
    evidencePolicy: read.evidencePolicy,
  });
  const [input, rendered] = distilled.retained[0].fields;
  assert.match(input.text, /\.\.\.$/);
  assert.match(rendered.text, /\.\.\. \(output \d+B, truncated\)$/);
  const item = (quote) => ({ positive: [{ instruction: "AG-001", quote }] });
  const accepts = (quote) => sanitizeEvidence(item(quote), null, distilled, read.evidencePolicy).positive.length;
  assert.equal(accepts("run the retained command"), 1);
  assert.equal(accepts("retained output line"), 1);
  assert.equal(accepts(`${"a".repeat(8)}...`), 0);
  assert.equal(accepts(`${"b".repeat(8)}... (output`), 0);
  assert.equal(accepts(rendered.text.slice(rendered.text.indexOf("(output"))), 0);
  assert.equal(accepts("B, truncated)"), 0);
});

test("trace-only middle omission never offers a source lookup", async () => {
  const repo = projectRepo();
  const { root } = makeSnapshot((payload) => {
    payload.association.cwd = repo.root;
    payload.events = Array.from({ length: 24 }, (_, index) => ({
      eventId: `e${index}`,
      kind: "message",
      role: index % 2 ? "assistant" : "user",
      text: `Approved event ${index} with enough text to exercise the trace budget.`,
      sourceRefs: [`sv-evidence:ref${index}`],
      omitted: false,
      redacted: false,
    }));
  });
  const result = await discoverTranscripts({ repo, scope: projectScope(repo), config: config(), sessionSource: root });
  const read = await readTranscript(result.transcripts[0]);
  const distilled = distill(read.events, result.transcripts[0], {
    evidencePolicy: read.evidencePolicy,
    maxTraceTokens: 100,
  });
  assert.equal(distilled.stats.elided, true);
  assert.match(distilled.trace, /middle of session omitted/);
  assert.doesNotMatch(distilled.trace, /raw transcript|Open the raw|\.jsonl/);
  assert.equal(
    sanitizeEvidence(
      { gaps: [{ proposedInstruction: "Do something.", quote: "middle of session omitted" }] },
      null,
      distilled,
      read.evidencePolicy,
    ).gaps.length,
    0,
  );
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
