import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const bin = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-isolation-bin-"));
const log = path.join(bin, "calls.jsonl");
fs.writeFileSync(path.join(bin, "pi"), "#!" + process.execPath + "\nprocess.exit(0);\n");
fs.chmodSync(path.join(bin, "pi"), 0o755);
fs.writeFileSync(
  path.join(bin, "acpx"),
  "#!" +
    process.execPath +
    "\n" +
    [
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      'if (args.includes("config") && args.includes("show")) { process.stdout.write(\'{"agents":{}}\\n\'); process.exit(0); }',
      'if (args.includes("sessions") && args.includes("new") && process.env.FAKE_NO_SESSIONS === "1") { process.stderr.write("unsupported\\n"); process.exit(2); }',
      'const at = args.indexOf("--file");',
      'if (at >= 0) { fs.appendFileSync(process.env.FAKE_ACPX_LOG, JSON.stringify({ args, prompt: fs.readFileSync(args[at + 1], "utf8") }) + "\\n"); process.stdout.write(\'{"positive":[],"negative":[],"gaps":[],"merges":[]}\\n\'); }',
    ].join("\n") +
    "\n",
);
fs.chmodSync(path.join(bin, "acpx"), 0o755);
process.env.BACKPASS_ACPX_BIN = path.join(bin, "acpx");
process.env.FAKE_ACPX_LOG = log;
process.env.PATH = bin + path.delimiter + process.env.PATH;

const { analyzeTranscripts } = await import("../src/analyze.js");
const { consolidateGapLedger } = await import("../src/consolidate.js");
const { bind } = await import("../src/sources/file.js");
const { State, evidenceKey } = await import("../src/state.js");
const { resolveMemoryFiles } = await import("../src/memory.js");
const { filterGapLedger, recordGapObservations, renderOpenGapIndex } = await import("../src/gap-ledger.js");
const { AgentResolver } = await import("../src/agents.js");
const { foldForRun } = await import("../src/commands/propose.js");
const { transcriptIdentity } = await import("../src/transcript.js");

function recordedCalls() {
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function setup(pick, unsupported = false) {
  fs.rmSync(log, { force: true });
  if (unsupported) process.env.FAKE_NO_SESSIONS = "1";
  else delete process.env.FAKE_NO_SESSIONS;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-isolation-repo-"));
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Memory\n\n- Check the sample.\n");
  const memoryFile = resolveMemoryFiles(root, ["AGENTS.md"]).primary;
  const state = new State(root).ensure();
  const transcript = {
    sourceKind: "external",
    sourceId: "source-a",
    sessionId: "session-a",
    revision: "rev-1",
    snapshotDigest: "snapshot-a",
    policyDigest: "policy-a",
    contentSignature: "content-a",
    screening: { policyVersion: "1", parserVersion: "1" },
    identity: "source-a-session-a",
    id: "source-a-session-a",
    harness: "claude",
    interaction: "interactive",
    startedAt: Date.parse("2026-08-01T00:00:00Z"),
    mtimeMs: 1,
    bytes: 100,
  };
  bind(transcript, {
    events: [
      { kind: "message", role: "user", text: "Check the sample.", eventId: "e1", sourceRefs: ["sv-evidence:a"] },
      ...["I checked the sample.", "I read the result.", "I compared the result.", "I finished the review."].map(
        (text, index) => ({
          kind: "message",
          role: "assistant",
          text,
          eventId: "e" + (index + 2),
          sourceRefs: ["sv-evidence:b"],
        }),
      ),
    ],
    model: null,
  });
  const config = {
    state,
    jobs: 1,
    discovery: { minUserTurns: 1 },
    timeoutSeconds: 10,
    promptRetries: 2,
    agents: { resolve: async () => pick, withFallthrough: async (_role, fn) => fn(pick) },
  };
  return { root, memoryFile, transcript, state, config };
}

for (const scenario of [
  { name: "one-shot", pick: { agent: "claude", model: null, effort: null } },
  { name: "named", pick: { agent: "claude", model: null, effort: "high" } },
  { name: "fallback", pick: { agent: "pi", model: null, effort: "medium" }, unsupported: true },
]) {
  test("trace-only analysis denies tools on " + scenario.name, async () => {
    const h = setup(scenario.pick, scenario.unsupported);
    const result = await analyzeTranscripts({
      transcripts: [h.transcript],
      memoryFile: h.memoryFile,
      config: h.config,
      repo: { root: h.root },
      memoryHash: "memory-a",
    });
    assert.equal(result.analyzed, 1);
    const calls = recordedCalls();
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes("--deny-all"));
    assert.ok(!calls[0].args.includes("--approve-reads"));
    assert.equal(calls[0].args[calls[0].args.indexOf("--non-interactive-permissions") + 1], "deny");
    assert.equal(calls[0].args[calls[0].args.indexOf("--prompt-retries") + 1], "2");
    assert.match(calls[0].prompt, /Check the sample/);
    if (scenario.unsupported) assert.ok(calls[0].args.includes("exec"));
  });
}

for (const scenario of [
  { name: "one-shot", pick: { agent: "claude", model: null, effort: null } },
  { name: "named", pick: { agent: "claude", model: null, effort: "high" } },
  { name: "fallback", pick: { agent: "pi", model: null, effort: "medium" }, unsupported: true },
])
  test("trace-only consolidation denies tools on " + scenario.name, async () => {
    const h = setup(scenario.pick, scenario.unsupported);
    const ledger = {
      version: 1,
      entries: {
        a: {
          id: "a",
          memoryPath: "AGENTS.md",
          proposedInstruction: "Keep gap A",
          sessions: { x: { mistake: "approved" } },
        },
        b: {
          id: "b",
          memoryPath: "AGENTS.md",
          proposedInstruction: "Keep gap B",
          sessions: { y: { mistake: "approved" } },
        },
      },
    };
    const result = await consolidateGapLedger({
      ledger,
      memoryPath: "AGENTS.md",
      config: h.config,
      repo: { root: h.root },
      traceOnly: true,
    });
    assert.equal(result.merged, 0);
    const [call] = recordedCalls();
    assert.ok(call.args.includes("--deny-all"));
    assert.ok(!call.args.includes("--approve-reads"));
    assert.match(call.prompt, /Keep gap A/);
    if (scenario.unsupported) assert.ok(call.args.includes("exec"));
  });

test("cache and probe keys change with provenance and route", () => {
  const h = setup({ agent: "claude", model: null, effort: null });
  const base = h.transcript;
  const route = { agent: "codex", model: "luna", effort: "medium", seat: "seat-a" };
  const key = evidenceKey(base, "memory-a", route);
  for (const changed of [
    [{ ...base, sourceId: "source-b", identity: "source-b-session-a" }, "memory-a", route],
    [{ ...base, revision: "rev-2" }, "memory-a", route],
    [{ ...base, snapshotDigest: "snapshot-b" }, "memory-a", route],
    [{ ...base, policyDigest: "policy-b" }, "memory-a", route],
    [{ ...base, screening: { ...base.screening, policyVersion: "2" } }, "memory-a", route],
    [{ ...base, screening: { ...base.screening, parserVersion: "2" } }, "memory-a", route],
    [base, "memory-b", route],
    [base, "memory-a", { ...route, model: "sol" }],
    [base, "memory-a", { ...route, effort: "high" }],
    [base, "memory-a", { ...route, seat: "seat-b" }],
  ])
    assert.notEqual(evidenceKey(...changed), key);
  let seat = "seat-a";
  const resolver = new AgentResolver(
    {
      analysis: { effort: "medium" },
      synthesis: {},
      sourceFingerprint: "source-a",
      memoryFingerprint: "memory-a",
      enforceEvidenceRoute: true,
    },
    { providerAuthState: () => seat },
  );
  const candidate = { agent: "codex", model: "luna" };
  const probeKey = resolver.probeKey(candidate);
  seat = "seat-b";
  assert.notEqual(resolver.probeKey(candidate), probeKey);
  seat = "seat-a";
  resolver.config.sourceFingerprint = "source-b";
  assert.notEqual(resolver.probeKey(candidate), probeKey);
  resolver.config.sourceFingerprint = "source-a";
  resolver.config.analysis.effort = "high";
  assert.notEqual(resolver.probeKey(candidate), probeKey);
  resolver.config.analysis.effort = "medium";
  resolver.config.memoryFingerprint = "memory-b";
  assert.notEqual(resolver.probeKey(candidate), probeKey);
});

test("foreign and superseded gap text never enters the open-gap index or count", () => {
  const h = setup({ agent: "claude", model: null, effort: null });
  const transcript = h.transcript;
  const record = {
    status: "ok",
    transcript,
    memoryPath: "AGENTS.md",
    memoryHash: "memory-a",
    key: evidenceKey(transcript, "memory-a"),
    gaps: [
      {
        proposedInstruction: "Current approved gap",
        mistake: "current",
        quote: "I checked the sample.",
        recurrenceRisk: "high",
      },
    ],
  };
  const ledger = {
    version: 1,
    entries: {
      native: {
        id: "native",
        memoryPath: "AGENTS.md",
        proposedInstruction: "Native secret gap",
        sessions: { native: { sourceKind: "native", phrasings: ["Native secret gap"] } },
      },
      revoked: {
        id: "revoked",
        memoryPath: "AGENTS.md",
        proposedInstruction: "Revoked old gap",
        sessions: {
          [transcript.identity]: {
            sourceKind: "external",
            sourceId: "source-a",
            revision: "rev-0",
            evidenceKey: "old",
            phrasings: ["Revoked old gap"],
          },
        },
      },
    },
  };
  filterGapLedger(ledger, [record], [transcript]);
  assert.equal(renderOpenGapIndex(ledger, "AGENTS.md"), "(none yet)");
  recordGapObservations(ledger, [record]);
  const revised = { ...transcript, revision: "rev-2" };
  const next = { ...record, transcript: revised, key: evidenceKey(revised, "memory-a") };
  filterGapLedger(ledger, [next], [revised]);
  recordGapObservations(ledger, [next]);
  assert.equal(Object.values(ledger.entries).flatMap((entry) => Object.keys(entry.sessions)).length, 1);
});

test("consolidation prompt excludes native and revoked ledger observations", async () => {
  const h = setup({ agent: "claude", model: null, effort: null });
  const transcript = h.transcript;
  const nativeSighting = {
    sourceKind: "native",
    firstObservedAt: new Date().toISOString(),
    phrasings: ["Native secret gap"],
  };
  h.state.writeGapLedger({
    version: 1,
    entries: {
      foreign: {
        id: "foreign",
        memoryPath: "AGENTS.md",
        proposedInstruction: "Native secret gap",
        sessions: { native: nativeSighting },
      },
      revoked: {
        id: "revoked",
        memoryPath: "AGENTS.md",
        proposedInstruction: "Revoked old gap",
        sessions: {
          [transcript.identity]: {
            sourceKind: "external",
            sourceId: transcript.sourceId,
            revision: "rev-0",
            evidenceKey: "old",
            phrasings: ["Revoked old gap"],
          },
        },
      },
    },
  });
  h.state.writeEvidence(transcript, {
    status: "ok",
    transcript,
    memoryPath: "AGENTS.md",
    memoryHash: "memory-a",
    key: evidenceKey(transcript, "memory-a"),
    positive: [],
    negative: [],
    gaps: ["Bind publication attestation to its exact commit.", "Keep credential seats isolated per run."].map(
      (proposedInstruction) => ({
        proposedInstruction,
        mistake: "current mistake",
        quote: "I checked the sample.",
        recurrenceRisk: "high",
      }),
    ),
  });
  await foldForRun(
    {
      config: { ...h.config, minGapEvidence: 2, gapLedgerMaxAge: "90d" },
      repo: { root: h.root },
      sessionSource: { sourceId: transcript.sourceId },
    },
    h.memoryFile,
    "memory-a",
    [],
    [transcript],
  );
  const prompt = recordedCalls().at(-1).prompt;
  assert.match(prompt, /Bind publication attestation/);
  assert.doesNotMatch(prompt, /Native secret gap|Revoked old gap/);
  assert.deepEqual(h.state.readGapLedger().entries.foreign.sessions, { native: nativeSighting });
});

test("a grown native session keeps its unmentioned sighting on disk but out of prompts", async () => {
  const h = setup({ agent: "claude", model: null, effort: null });
  const grown = {
    harness: "claude",
    id: "native-a",
    nativeId: "native-a",
    interaction: "interactive",
    mtimeMs: 2,
    bytes: 200,
  };
  const identity = (grown.identity = transcriptIdentity(grown));
  const staleSighting = {
    sourceKind: "native",
    contentDigest: "1:100",
    firstObservedAt: new Date().toISOString(),
    phrasings: ["Stale grown gap"],
  };
  h.state.writeGapLedger({
    version: 1,
    entries: {
      stale: {
        id: "stale",
        memoryPath: "AGENTS.md",
        proposedInstruction: "Stale grown gap",
        sessions: { [identity]: staleSighting },
      },
    },
  });
  h.state.writeEvidence(grown, {
    status: "ok",
    transcript: grown,
    memoryPath: "AGENTS.md",
    memoryHash: "memory-a",
    key: evidenceKey(grown, "memory-a"),
    positive: [],
    negative: [],
    gaps: ["Bind publication attestation to its exact commit.", "Keep credential seats isolated per run."].map(
      (proposedInstruction) => ({
        proposedInstruction,
        mistake: "current mistake",
        quote: "I checked the sample.",
        recurrenceRisk: "high",
      }),
    ),
  });
  await foldForRun(
    { config: { ...h.config, minGapEvidence: 2, gapLedgerMaxAge: "90d" }, repo: { root: h.root } },
    h.memoryFile,
    "memory-a",
    [],
    [grown],
  );
  const prompt = recordedCalls().at(-1).prompt;
  assert.match(prompt, /Bind publication attestation/);
  assert.doesNotMatch(prompt, /Stale grown gap/);
  assert.deepEqual(h.state.readGapLedger().entries.stale.sessions, { [identity]: staleSighting });
});
