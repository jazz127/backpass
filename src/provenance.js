import { discover as discoverFileSource } from "./sources/file.js";
import { providerAuthState } from "./provider-auth.js";
import { sha256 } from "./state.js";
import { transcriptIdentity } from "./transcript.js";
import { UserError } from "./logger.js";

export function routeForPick(config, pick) {
  if (!config.enforceEvidenceRoute) return null;
  return {
    agent: pick.agent,
    model: pick.model || null,
    effort: pick.effort || null,
    seat:
      config.agents.credentialFingerprint?.({ agent: pick.agent, model: pick.model }) ||
      providerAuthState(pick.agent, { model: pick.model }),
  };
}

export async function analysisRoute(config) {
  if (!config.enforceEvidenceRoute) return null;
  return routeForPick(config, await config.agents.resolve("analysis"));
}

export function selectedCorpusDigest(transcripts) {
  return sha256(
    JSON.stringify(
      transcripts
        .map((transcript) => [
          transcriptIdentity(transcript),
          transcript.revision || null,
          transcript.contentSignature || `${transcript.mtimeMs}:${transcript.bytes}`,
        ])
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

export function proposalProvenance(ctx, transcripts, memoryHash, route) {
  return {
    source: ctx.sessionSource
      ? { kind: "external", sourceId: ctx.sessionSource.sourceId, snapshotDigest: ctx.sessionSource.snapshotDigest }
      : { kind: "native" },
    selectedCorpusDigest: selectedCorpusDigest(transcripts),
    inputMemoryHash: memoryHash,
    routeProfile: {
      analysis: route,
      synthesis: ctx.config.synthesis,
      autoAgent: ctx.config.autoAgent,
      ladders: ctx.config.ladders,
    },
  };
}

export function assertSourceCurrent(ctx, expected = null) {
  if (expected?.source.kind === "external" && !ctx.sessionSourcePath) {
    throw new UserError(
      "this proposal requires its approved session source",
      "pass --session-source with the same snapshot",
    );
  }
  if (!ctx.sessionSourcePath) return;
  const latest = discoverFileSource(ctx.sessionSourcePath);
  const source = expected?.source || ctx.sessionSource;
  if (latest.sourceId !== source.sourceId || latest.snapshotDigest !== source.snapshotDigest) {
    throw new UserError("the approved session source changed; proposal is stale", "run analyze and propose again");
  }
}
