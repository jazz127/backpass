import assert from "node:assert/strict";

import { foldEvidence } from "../../src/fold.js";
import { gapSource, ledgerGapObservations } from "../../src/gap-ledger.js";
import { corroborationIdentityOf } from "../../src/transcript.js";

export function assertNativeGapContributions(ledger, transcripts, memoryPath = "AGENTS.md") {
  const observations = Object.values(ledger.entries)
    .filter((entry) => entry.memoryPath === memoryPath)
    .flatMap((entry) => Object.values(entry.sessions));
  assert.deepEqual(
    observations.map((observation) => observation.sourceSessionId).sort(),
    transcripts.map((transcript) => transcript.identity || transcript.id).sort(),
  );
  for (const transcript of transcripts) {
    const identity = transcript.identity || transcript.id;
    const observation = observations.find((candidate) => candidate.sourceSessionId === identity);
    assert.deepEqual(observation.sightingIds, [identity]);
    assert.equal(observation.source, gapSource(transcript));
    assert.equal(
      observation.contentDigest,
      transcript.contentSignature || `${transcript.mtimeMs}:${transcript.bytes}`,
    );
  }
  const summary = foldEvidence(transcripts.map((transcript) => ({ status: "ok", transcript })), {
    minGapEvidence: 1,
    gapObservations: ledgerGapObservations(ledger, memoryPath),
  });
  assert.equal(summary.gaps.length, 1);
  assert.equal(summary.gaps[0].sessions, new Set(transcripts.map(corroborationIdentityOf)).size);
}
