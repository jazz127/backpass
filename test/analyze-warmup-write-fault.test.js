import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-warmup-fault-bin-"));
const fakeAcpx = path.join(binDir, "acpx");
const fakePi = path.join(binDir, "pi");
fs.writeFileSync(fakePi, `#!${process.execPath}\nprocess.exit(0);\n`);
fs.chmodSync(fakePi, 0o755);
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
fs.writeFileSync(
  fakeAcpx,
  `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv.includes("config")) {
  process.stdout.write('{"agents":{}}\\n');
} else if (argv.includes("sessions")) {
  process.stdout.write('fake-session\\n');
} else if (argv.includes("--file")) {
  const agent = argv.includes("pi") ? "pi" : "claude";
  const prompt = fs.readFileSync(argv[argv.indexOf("--file") + 1], "utf8");
  const id = /Do the (\\S+) work\\./.exec(prompt)[1];
  const log = (event) => fs.appendFileSync(process.env.WARMUP_CALL_LOG, JSON.stringify({ agent, id, event }) + "\\n");
  log("start");
  setTimeout(() => {
    log("end");
    if (agent === "pi") {
      process.stderr.write("[acpx] error: RUNTIME AUTH_REQUIRED Authentication required\\n");
      process.exit(1);
    }
    process.stdout.write('{"positive":[],"negative":[],"gaps":[]}\\n');
  }, 300);
}
`,
);
fs.chmodSync(fakeAcpx, 0o755);
process.env.BACKPASS_ACPX_BIN = fakeAcpx;

const { analyzeTranscripts } = await import("../src/analyze.js");
const { State } = await import("../src/state.js");
const { AgentResolver } = await import("../src/agents.js");
const { loadConfig } = await import("../src/config.js");

function writeSession(root, id) {
  const file = path.join(root, `${id}.jsonl`);
  const entries = [
    { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: root },
    { type: "message", message: { role: "user", content: `Do the ${id} work.` } },
    { type: "message", message: { role: "assistant", content: "Working on it." } },
    { type: "message", message: { role: "user", content: "Now run the tests too." } },
    { type: "message", message: { role: "assistant", content: "Tests pass." } },
  ];
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return file;
}

for (const fault of ["evidence", "prompt", "fallthrough"]) {
  test(`Claude warm-up survives ${fault} failures and then permits fan-out`, async (t) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-warmup-fault-")));
    const callLog = path.join(dir, "calls.jsonl");
    process.env.WARMUP_CALL_LOG = callLog;
    const transcripts = ["t1", "t2", "t3", "t4", "t5"].map((id) => ({
      harness: "pi",
      id: `pi-${id}`,
      nativeId: id,
      path: writeSession(dir, id),
      mtimeMs: Date.now(),
      bytes: 200,
    }));
    class FaultingState extends State {
      writeEvidence(transcript, evidence) {
        if (fault === "evidence" && evidence.status === "ok" && transcript.nativeId === "t1") {
          throw new Error("ENOSPC: evidence write failed");
        }
        return super.writeEvidence(transcript, evidence);
      }
    }
    const state = new FaultingState(dir, { exclude: false }).ensure();
    if (fault === "prompt") {
      const write = fs.writeFileSync;
      t.mock.method(fs, "writeFileSync", (file, data, options) => {
        if (String(file).includes(`${path.sep}prompts${path.sep}`) && String(data).includes("Do the t1 work.")) {
          throw new Error("ENOSPC: prompt write failed");
        }
        return write(file, data, options);
      });
    }
    const config = { ...loadConfig(dir), state, jobs: 4 };
    if (fault === "fallthrough") {
      config.ladders.analysis = [
        { model: "pi-test", agents: ["pi"] },
        { model: "claude-test", agents: ["claude"] },
      ];
      config.enforceEvidenceRoute = true;
      config.agents = new AgentResolver(config, {
        probeCandidate: async ({ model }) => ({ verdict: "ok", resolvedModel: model }),
        acpxVersion: async () => "0.13.0",
        providerAuthState: () => "test-seat",
      });
    } else {
      const pick = { agent: "claude" };
      config.agents = { resolve: async () => pick, withFallthrough: async (_role, fn) => fn(pick) };
    }
    const summary = await analyzeTranscripts({
      transcripts,
      memoryFile: { path: "AGENTS.md", units: [] },
      memoryHash: "test-memory",
      repo: { root: dir },
      config,
    });
    assert.equal(summary.failed, fault === "fallthrough" ? 0 : 1);
    assert.equal(summary.analyzed, fault === "fallthrough" ? 5 : 4);
    const records = state.listEvidence();
    if (fault !== "fallthrough") {
      assert.equal(records.find((record) => record.transcript.id === "pi-t1").status, "failed");
    } else {
      assert.ok(records.every((record) => record.route.agent === "claude"));
    }
    const events = fs
      .readFileSync(callLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const claude = events.filter((event) => event.agent === "claude");
    assert.equal(claude[0].event, "start");
    assert.deepEqual(claude[1], { ...claude[0], event: "end" });
    assert.equal(claude.filter((event) => event.event === "start").length, fault === "prompt" ? 4 : 5);
    const remaining = claude.slice(2);
    assert.ok(remaining.findIndex((event) => event.event === "end") > 1, "calls after warm-up must overlap");
    if (fault === "fallthrough") assert.ok(events.some((event) => event.agent === "pi" && event.event === "end"));
  });
}
