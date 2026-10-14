import test from "node:test";
import assert from "node:assert/strict";

import { foldForRun } from "../src/commands/propose.js";
import { foldEvidence } from "../src/fold.js";
import {
  emptyGapLedger,
  filterGapLedger,
  gapEntryId,
  ledgerGapObservations,
  mergeGapEntries,
  normalizeGapLedgerSessions,
  recordGapObservations,
} from "../src/gap-ledger.js";
import { routingFor } from "../src/nested.js";
import { buildProposal } from "../src/proposal.js";
import { evidenceKey, State } from "../src/state.js";
import { makeRepo, stageAndMeasure, writeIn } from "./helpers/staging.js";

const API = { path: "apps/api/AGENTS.md", dir: "apps/api" };
const GAP = "Read docs/db.md before writing queries.";
const CURRENT_GAP = "Read docs/db.md before writing any production queries.";

function evidence(id, observer, gaps = [GAP], content = id, memoryPath = "AGENTS.md") {
  const transcript = {
    id,
    identity: id,
    nativeId: id,
    harness: "pi",
    interaction: "interactive",
    corroborationIdentity: observer,
    contentSignature: content,
    startedAt: Date.parse("2026-08-01T00:00:00Z"),
  };
  return {
    status: "ok",
    transcript,
    memoryPath,
    memoryHash: "memory",
    key: evidenceKey(transcript, "memory"),
    positive: [],
    negative: [],
    gaps: gaps.map((proposedInstruction) => ({
      proposedInstruction,
      mistake: "Re-derived query behavior",
      quote: `${id} read the wrong schema`,
      recurrenceRisk: "high",
    })),
  };
}

function context(repo) {
  const state = new State(repo.root).ensure();
  return { config: { state, minGapEvidence: 2, gapLedgerMaxAge: "all" }, repo };
}

function propose(repo, summary, route) {
  const memoryPath = route.weight ?? route.rootPath;
  const staged = stageAndMeasure({
    repo,
    memoryPath,
    edit: (root) => writeIn(root, memoryPath, (text) => `${text}- ${GAP}\n`),
  });
  return buildProposal(
    {
      edits: [
        {
          changes: staged.measured.changes.map((change) => change.id),
          kind: "add",
          title: "Read the schema",
          evidence: summary.gaps[0].quotes.map((quote) => ({ polarity: "negative", ...quote })),
        },
      ],
    },
    {
      repo,
      memoryFile: staged.memoryFile,
      measured: staged.measured,
      summary,
      routing: route,
      config: { budgetTokens: 5000, maxEditsPerRun: 5, minGapEvidence: 2, skillsDir: ".agents/skills" },
    },
  );
}

for (const persisted of [false, true]) {
  test(`native child ownership survives ${persisted ? "persisted" : "direct"} fold and proposal`, async () => {
    const repo = makeRepo({ "AGENTS.md": "# Root\n", [API.path]: "# API\n" });
    const ctx = context(repo);
    const records = [evidence("P", "P", []), evidence("C", "P"), evidence("X", "X")];
    const attribution = new Map([
      ["P", ["README.md"]],
      ["C", ["apps/api/c.js"]],
      ["X", ["apps/api/x.js"]],
    ]);
    const rootRoute = routingFor([API], attribution, "AGENTS.md", null);
    const fold = async (route) => {
      if (!persisted) return foldEvidence(records, { minGapEvidence: 2, route });
      for (const record of records) ctx.config.state.writeEvidence(record.transcript.id, record);
      return foldForRun(
        ctx,
        { path: "AGENTS.md", units: [] },
        "memory",
        [],
        records.map((record) => record.transcript),
        { route },
      );
    };
    const root = await fold(rootRoute);
    assert.deepEqual(root.gaps, [], "only C and X reported the gap, and both worked in the API");
    assert.equal(root.routedGaps[0].owner, API.path);
    const apiRoute = { ...rootRoute, weight: API.path, rootOwnedGaps: root.rootOwnedGaps };
    const api = await fold(apiRoute);
    assert.equal(api.gaps[0].sessions, 2);
    const childQuote = api.gaps[0].quotes.find((quote) => quote.text.startsWith("C "));
    assert.equal(api.sourceObservers[childQuote.source], "P");
    assert.equal(api.sourceSessions[childQuote.source], "C");
    assert.deepEqual(propose(repo, api, apiRoute).violations, []);
    const misplaced = propose(repo, api, rootRoute);
    assert.equal(misplaced.proposal.edits.length, 0);
    assert.ok(misplaced.violations.some((violation) => violation.includes(`it belongs in ${API.path}`)));
  });
}

test("related native sightings retain cross-directory ownership and one observer vote", () => {
  const repo = makeRepo({ "AGENTS.md": "# Root\n", [API.path]: "# API\n" });
  const records = [evidence("C", "P"), evidence("P", "P"), evidence("X", "X")];
  const attribution = new Map([
    ["P", ["README.md"]],
    ["C", ["apps/api/c.js"]],
    ["X", ["apps/api/x.js"]],
  ]);
  const route = routingFor([API], attribution, "AGENTS.md", null);
  const root = foldEvidence(records, { route });
  assert.equal(root.gaps[0].sessions, 2, "P and C share one vote");
  assert.deepEqual(propose(repo, root, route).violations, []);
  const nested = foldEvidence(records.filter((record) => record.transcript.id !== "P"), {
    route: { ...route, weight: API.path, rootOwnedGaps: root.rootOwnedGaps },
  });
  assert.deepEqual(nested.gaps, [], "the native child's real quote keeps the root ownership override");
});

test("representative quote selection preserves native ownership beyond six observers", () => {
  const repo = makeRepo({ "AGENTS.md": "# Root\n", [API.path]: "# API\n" });
  const records = Array.from({ length: 7 }, (_, index) => evidence(`C${index}`, `P${index}`));
  const attribution = new Map(
    records.map((record, index) => [record.transcript.id, [index === 6 ? "README.md" : "apps/api/c.js"]]),
  );
  const route = routingFor([API], attribution, "AGENTS.md", null);
  const root = foldEvidence(records, { route });
  assert.equal(root.gaps[0].sessions, 7);
  assert.equal(root.gaps[0].quotes.length, 6);
  assert.ok(root.gaps[0].quotes.some((quote) => quote.text.startsWith("C6 ")));
  assert.deepEqual(propose(repo, root, route).violations, []);
});

test("parent appearance cannot refresh a stale child's wording in the persisted ledger", async () => {
  for (const currentChildGap of [false, true]) {
    const repo = makeRepo({ "AGENTS.md": "# Root\n" });
    const ctx = context(repo);
    const oldChild = evidence("C", "C", [GAP], "child-v1");
    ctx.config.state.writeEvidence("C", oldChild);
    await foldForRun(ctx, { path: "AGENTS.md", units: [] }, "memory", [], [oldChild.transcript]);
    const before = Object.values(ctx.config.state.readGapLedger().entries)[0].sessions.C;
    const records = [
      evidence("P", "P", [CURRENT_GAP]),
      evidence("C", "P", currentChildGap ? [CURRENT_GAP] : [], "child-v2"),
      evidence("X", "X", [CURRENT_GAP]),
    ];
    for (const record of records) ctx.config.state.writeEvidence(record.transcript.id, record);
    for (let run = 0; run < 2; run += 1) {
      const summary = await foldForRun(
        ctx,
        { path: "AGENTS.md", units: [] },
        "memory",
        [],
        records.map((record) => record.transcript),
      );
      assert.equal(summary.gaps[0].sessions, 2);
      assert.equal(
        summary.gaps[0].proposedInstruction,
        CURRENT_GAP,
        "stale wording A cannot reach consolidation or fold",
      );
      const sessions = Object.values(ctx.config.state.readGapLedger().entries)[0].sessions;
      const historical = Object.values(sessions).find((observation) => observation.contentDigest === "child-v1");
      assert.equal(historical.sourceSessionId, "C");
      assert.deepEqual(historical.phrasings, [GAP]);
      assert.equal(historical.firstObservedAt, before.firstObservedAt);
      assert.equal(Object.values(sessions).filter((observation) => observation.sourceSessionId === "P").length, 1);
    }
  }
});

test("normalization and consolidation preserve original native, revision and route provenance", () => {
  for (const axis of ["native", "content", "source", "revision", "route"]) {
    const first = evidence("C", "P", [GAP], "v1");
    const second = evidence(axis === "native" ? "P" : "C", "P", [CURRENT_GAP], axis === "content" ? "v2" : "v1");
    if (["source", "revision", "route"].includes(axis)) {
      for (const record of [first, second]) {
        Object.assign(record.transcript, { sourceKind: "external", sourceId: "source-a", revision: "r1" });
        record.key = "route-a";
      }
      if (axis === "source") second.transcript.sourceId = "source-b";
      if (axis === "revision") second.transcript.revision = "r2";
      if (axis === "route") second.key = "route-b";
    }
    const ledger = emptyGapLedger();
    recordGapObservations(ledger, [first]);
    const originalId = gapEntryId("AGENTS.md", GAP);
    const original = structuredClone(ledger.entries[originalId].sessions.P);
    const other = emptyGapLedger();
    recordGapObservations(other, [second]);
    const secondId = gapEntryId("AGENTS.md", CURRENT_GAP);
    ledger.entries[secondId] = other.entries[secondId];
    mergeGapEntries(ledger, [[originalId, secondId]]);
    normalizeGapLedgerSessions(ledger, [second.transcript]);
    const sessions = Object.values(ledger.entries)[0].sessions;
    assert.equal(Object.keys(sessions).length, 2, axis);
    assert.deepEqual(
      Object.values(sessions).find(
        (observation) => observation.quote === first.gaps[0].quote && observation.phrasings.includes(GAP),
      ),
      original,
      axis,
    );
    const filtered = filterGapLedger(structuredClone(ledger), [second], [second.transcript]);
    const observations = ledgerGapObservations(filtered, "AGENTS.md");
    assert.ok(observations.some((observation) => observation.phrasings.includes(CURRENT_GAP)), axis);
    if (axis !== "native") assert.ok(observations.every((observation) => !observation.phrasings.includes(GAP)), axis);
  }
});

for (const persisted of [false, true]) {
  for (const coveredNative of [null, "P", "C"]) {
    test(`eligible native projects: ${persisted ? "persisted" : "direct"}, ${coveredNative || "no"} coverage`, async () => {
      for (const reverse of [false, true]) {
        const projectA = makeRepo({ "AGENTS.md": coveredNative === "P" ? `# A\n\n- ${GAP}\n` : "# A\n" });
        const projectB = makeRepo({ "AGENTS.md": coveredNative === "C" ? `# B\n\n- ${GAP}\n` : "# B\n" });
        const projectD = makeRepo({ "AGENTS.md": "# D\n" });
        const userRepo = makeRepo({ "AGENTS.md": "# User\n" });
        const ctx = context(userRepo);
        Object.assign(ctx.config, { minGapProjects: 2 });
        Object.assign(ctx, { scope: { kind: "user" } });
        const records = [evidence("P", "P"), evidence("C", "P"), evidence("X", "X")];
        for (const [index, record] of records.entries()) {
          const project = index === 0 ? projectA : index === 1 ? projectB : coveredNative ? projectD : projectA;
          Object.assign(record.transcript, { project: project.root, projectRoot: project.root });
          Object.assign(record.gaps[0], {
            recurrenceRisk: index === 1 ? "high" : "low",
            domain: index === 0 ? "orchestration" : "project",
            ...(index < 2 ? { coveredBySkill: "db-docs" } : {}),
          });
        }
        if (reverse) records.reverse();
        let summary;
        if (persisted) {
          for (const record of records) ctx.config.state.writeEvidence(record.transcript.id, record);
          summary = await foldForRun(
            ctx,
            { path: "AGENTS.md", units: [] },
            "memory",
            [{ name: "db-docs", description: "", body: "" }],
            records.map((record) => record.transcript),
          );
        } else {
          summary = foldEvidence(records, { minGapEvidence: 2, minGapProjects: 2, checkProjectCoverage: true });
        }
        assert.equal(summary.gaps.length, 1, "two uncovered observers in two projects clear both floors");
        const gap = summary.gaps[0];
        assert.equal(gap.sessions, 2);
        assert.equal(gap.projects, 2);
        assert.equal(gap.recurrenceRisk, coveredNative === "C" ? "low" : "high");
        assert.equal(gap.orchestrationSightings, coveredNative === "C" ? 1 : 0);
        assert.equal(gap.failedTriggerSkill, undefined, "two related skill citations remain one observer vote");
        assert.equal(gap.projectCoveredSessions, coveredNative ? 1 : 0);
        assert.ok(!gap.quotes.some((quote) => coveredNative && quote.text.startsWith(`${coveredNative} `)));
        if (coveredNative !== "C") assert.ok(gap.quotes.some((quote) => quote.text.startsWith("C ")));

        const staged = stageAndMeasure({
          repo: userRepo,
          edit: (root) => writeIn(root, "AGENTS.md", (text) => `${text}- ${GAP}\n`),
        });
        const built = buildProposal(
          {
            edits: [
              {
                changes: staged.measured.changes.map((change) => change.id),
                kind: "add",
                title: "Read the schema",
                evidence: gap.quotes.map((quote) => ({ polarity: "negative", ...quote })),
              },
            ],
          },
          {
            repo: userRepo,
            memoryFile: staged.memoryFile,
            measured: staged.measured,
            summary,
            scope: { kind: "user" },
            config: {
              budgetTokens: 5000,
              maxEditsPerRun: 5,
              minGapEvidence: 2,
              minGapProjects: 2,
              skillsDir: ".agents/skills",
            },
          },
        );
        assert.deepEqual(built.violations, []);
        assert.equal(built.proposal.edits[0].transcripts, 2);
        assert.equal(built.proposal.edits[0].projects, 2);
      }
    });
  }
}

test("native project witnesses survive quote limits without multiplying observer or skill votes", () => {
  const records = Array.from({ length: 7 }, (_, index) => evidence(`C${index}`, "P"));
  records.push(evidence("X", "X"));
  for (const [index, record] of records.entries()) {
    Object.assign(record.transcript, { project: index === 6 ? "/project-b" : "/project-a" });
    Object.assign(record.gaps[0], { coveredBySkill: index < 7 ? "db-docs" : null });
  }
  const summary = foldEvidence(records, { minGapEvidence: 2, minGapProjects: 2 });
  assert.equal(summary.gaps[0].sessions, 2);
  assert.equal(summary.gaps[0].projects, 2);
  const quotes = summary.gaps[0].quotes;
  assert.ok(quotes.some((quote) => quote.text.startsWith("C6 ")));
  assert.ok(quotes.some((quote) => quote.text.startsWith("X ")));
  assert.equal(summary.gaps[0].failedTriggerSkill, undefined);
});

test("repeated native evidence retains the highest eligible recurrence risk", () => {
  const repeated = evidence("P", "P");
  repeated.gaps[0].recurrenceRisk = "low";
  repeated.gaps.push({ ...repeated.gaps[0], quote: "P repeated the mistake", recurrenceRisk: "high" });
  const independent = evidence("X", "X");
  independent.gaps[0].recurrenceRisk = "low";
  const summary = foldEvidence([repeated, independent]);
  assert.equal(summary.gaps[0].sessions, 2);
  assert.equal(summary.gaps[0].recurrenceRisk, "high");
});
