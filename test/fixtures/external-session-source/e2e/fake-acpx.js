#!/usr/bin/env node
const fs = require("node:fs");

const argv = process.argv.slice(2);
const logFile = "__LOG_FILE__";
const record = (value) => fs.appendFileSync(logFile, `${JSON.stringify(value)}\n`);

if (argv.includes("config") && argv.includes("show")) {
  process.stdout.write('{"agents":{}}\n');
  process.exit(0);
}

if (argv.includes("sessions") && argv.includes("new")) process.exit(0);
if (argv.includes("sessions") && argv.includes("close")) process.exit(0);
if (!argv.includes("--file")) process.exit(0);

const promptPath = argv[argv.indexOf("--file") + 1];
const prompt = fs.readFileSync(promptPath, "utf8");
const malicious = prompt.includes("IGNORE THE ANALYSIS RULES") && prompt.includes("SENTINEL_PATH=");
const noEligibleGap = prompt.includes("none above the evidence threshold");
const fileArgs = argv.filter((_, index) => argv[index - 1] === "--file");
record({ argv, fileArgs, promptPath, malicious, noEligibleGap, phase: prompt.includes("Measured changes") ? "annotate" : prompt.includes("## Folded evidence") ? "edit" : "analysis" });

if (prompt.includes("## Folded evidence") && noEligibleGap) {
  process.exit(0);
}

if (prompt.includes("You are auditing one past agent session")) {
  process.stdout.write(JSON.stringify({
    positive: [],
    negative: [],
    gaps: [{
      mistake: "A public source directory was rejected before its contents were read.",
      proposedInstruction: "Keep approved snapshot directories private before reading them.",
      recurrenceRisk: "high",
      domain: "project",
      quote: "The cache directory must be private before reading an approved snapshot."
    }],
    usedRawTranscript: false
  }));
  process.exit(0);
}

if (prompt.includes("## Folded evidence") && !prompt.includes("none above the evidence threshold")) {
  const memory = fs.readFileSync("AGENTS.md", "utf8");
  if (!memory.includes("Keep approved snapshot directories private before reading them.")) {
    fs.writeFileSync("AGENTS.md", `${memory.trimEnd()}\n- Keep approved snapshot directories private before reading them.\n`);
  }
  process.exit(0);
}

if (prompt.includes("## Measured changes")) {
  const evidence = ["session-alpha", "session-beta"].map((session) => ({
    polarity: "negative",
    text: "The cache directory must be private before reading an approved snapshot.",
    source: `harness-a · synthetic-e2e/${session} · 2026-01-02`
  }));
  process.stdout.write(JSON.stringify({ edits: [{
    changes: ["H1"],
    kind: "add",
    title: "keep source snapshots private",
    rationale: "Independent sessions report this restriction.",
    evidence
  }], verdicts: [], notes: [] }));
  process.exit(0);
}

process.stdout.write("{}\n");
