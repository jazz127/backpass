import fs from "node:fs";
import path from "node:path";

import { extractJson, runModelCall, usageRecord } from "./acpx.js";
import { distill } from "./distill.js";
import { classifyInteraction } from "./interaction.js";
import { readTranscript } from "./discovery/index.js";
import { instructionUnits, renderInstructionIndex } from "./memory.js";
import { renderSkillIndexForAnalysis } from "./skills.js";
import { renderPrompt } from "./prompts.js";
import { renderOpenGapIndex } from "./gap-ledger.js";
import { evidenceKey, isEvidenceFresh, safeFileName } from "./state.js";
import { emitProgress } from "./progress.js";
import { UserError, color, info, warn } from "./logger.js";
import { transcriptIdentity } from "./transcript.js";

/**
 * Stage 1 of the pipeline (design section 3): one cheap model call per transcript,
 * fanned out over a small worker pool.
 *
 * Everything expensive is cached. Evidence is keyed to the transcript's content
 * signature AND the memory-surface hash it was judged against, so re-running after a
 * memory-file or skill-description change correctly re-analyzes against the new weights
 * while an unchanged surface is free.
 */

const MIN_ASSISTANT_TURNS = 4;
const MIN_TOOL_CALLS = 3;

let callCounter = 0;
const seenNotes = new Set();

/** The same adapter limitation would repeat once per transcript; say it once per run. */
function noteOnce(note) {
  if (seenNotes.has(note)) return;
  seenNotes.add(note);
  warn(note);
}

/** Negative evidence carries one of these classes; anything else is dropped as unjudged. */
export const NEGATIVE_CLASSES = ["harm", "non-compliance", "irrelevant"];

/** Whitespace-insensitive form used to check a quote against the trace it claims to come from. */
function foldSpace(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

/** Fold whitespace while keeping UTF-16 offsets into the rendered event field. */
function quoteSpans(text, quote) {
  const chars = [];
  const starts = [];
  const ends = [];
  for (let i = 0; i < text.length;) {
    if (/\s/.test(text[i])) {
      const start = i;
      while (i < text.length && /\s/.test(text[i])) i++;
      if (chars.length && i < text.length) {
        chars.push(" ");
        starts.push(start);
        ends.push(i);
      }
    } else {
      chars.push(text[i]);
      starts.push(i);
      ends.push(i + 1);
      i++;
    }
  }
  const folded = chars.join("");
  const needle = foldSpace(quote);
  const spans = [];
  for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + 1)) {
    spans.push({ start: starts[at], end: ends[at + needle.length - 1] });
  }
  return spans;
}

function overlapsPlaceholder(text, span) {
  for (const match of text.matchAll(/\[redacted(?::[A-Z_]+)?\]|\[\.\.\.[^\]]*\]/g)) {
    if (span.start < match.index + match[0].length && span.end > match.index) return true;
  }
  return false;
}

function traceOnlyAnchor(item, trace) {
  const quote = item.quote.trim();
  if (quote.length > 600) return null;
  const substantive = quote.replace(/\[redacted(?::[A-Z_]+)?\]|\[\.\.\.[^\]]*\]/g, "").trim();
  if (substantive.length < 8) return null;
  for (const event of trace.retained) {
    if (!event.quoteable) continue;
    for (const field of event.fields) {
      for (const span of quoteSpans(field.text, quote)) {
        if (!overlapsPlaceholder(field.text, span))
          return {
            ...trace.source,
            eventId: event.eventId,
            sourceRefs: event.sourceRefs,
            field: field.field,
            quoteSpan: span,
          };
      }
    }
  }
  return null;
}

/**
 * Evidence items without a verbatim quote are dropped - the rubric's central rule.
 *
 * For native sessions, a quote must appear in the trace unless the model reports that
 * it opened the raw transcript. Only the literal boolean opts out. Trace-only sessions
 * require a quote in one retained event field regardless of the model's answer, and a
 * true raw-access report fails the response by name.
 *
 * `quotesNotInTrace` counts what the trace check rejected, so a run whose analysis model
 * paraphrases everything reads as that rather than as a clean repo.
 */
export function sanitizeEvidence(parsed, memoryFile = null, trace = null, evidencePolicy = null) {
  const traceOnly = evidencePolicy === "trace-only";
  if (traceOnly && (!trace || typeof trace.trace !== "string" || !Array.isArray(trace.retained))) {
    throw new Error("trace_only_trace_missing");
  }
  if (traceOnly && parsed?.usedRawTranscript === true) throw new Error("trace_only_raw_access_reported");
  const clean = {
    positive: [],
    negative: [],
    gaps: [],
    usedRawTranscript: parsed?.usedRawTranscript === true,
    quotesNotInTrace: 0,
  };
  if (!parsed || typeof parsed !== "object") return clean;

  const validInstructions = memoryFile ? new Set(instructionUnits(memoryFile).map((unit) => unit.id)) : null;
  const foldedTrace = typeof trace === "string" && !clean.usedRawTranscript ? foldSpace(trace) : null;
  const hasQuote = (item) => {
    if (typeof item?.quote !== "string" || item.quote.trim().length < 8) return false;
    if (traceOnly) {
      const anchor = traceOnlyAnchor(item, trace);
      if (anchor) return anchor;
      clean.quotesNotInTrace += 1;
      return false;
    }
    if (foldedTrace === null || foldedTrace.includes(foldSpace(item.quote))) return true;
    clean.quotesNotInTrace += 1;
    return false;
  };

  for (const key of ["positive", "negative"]) {
    for (const item of Array.isArray(parsed[key]) ? parsed[key] : []) {
      const anchor = hasQuote(item);
      if (!anchor || typeof item.instruction !== "string") continue;
      const instruction = item.instruction.trim();
      if (validInstructions && !validInstructions.has(instruction)) continue;
      const entry = {
        instruction,
        moment: String(item.moment ?? "").slice(0, 80),
        effect: String(item.effect ?? "").slice(0, 400),
        quote: item.quote.trim().slice(0, 600),
      };
      if (traceOnly) entry.source = anchor;
      // The class is what keeps "the agent skipped the rule" from being read as "the
      // rule caused harm" downstream. Only an explicit judged value is kept; records
      // from before the field existed simply carry none, and none never counts as harm.
      if (key === "negative" && NEGATIVE_CLASSES.includes(item.class)) entry.class = item.class;
      clean[key].push(entry);
    }
  }

  for (const item of Array.isArray(parsed.gaps) ? parsed.gaps : []) {
    const anchor = hasQuote(item);
    if (!anchor || typeof item.proposedInstruction !== "string") continue;
    const gap = {
      mistake: String(item.mistake ?? "").slice(0, 400),
      proposedInstruction: item.proposedInstruction.trim().slice(0, 400),
      recurrenceRisk: ["high", "medium", "low"].includes(item.recurrenceRisk) ? item.recurrenceRisk : "medium",
      quote: item.quote.trim().slice(0, 600),
      domain: item.domain === "orchestration" ? "orchestration" : "project",
    };
    if (traceOnly) gap.source = anchor;
    if (typeof item.matchesGap === "string" && /^[0-9a-f]{16}$/.test(item.matchesGap.trim())) {
      gap.matchesGap = item.matchesGap.trim();
    }
    // A failed trigger: an existing skill's content would have prevented the mistake,
    // but the skill was not in play. Kept as a judged citation so the fold can count
    // failed triggers per skill; an absent or empty value simply means "no skill covers
    // this" and records nothing.
    if (typeof item.coveredBySkill === "string" && item.coveredBySkill.trim()) {
      gap.coveredBySkill = item.coveredBySkill.trim().slice(0, 120);
    }
    clean.gaps.push(gap);
  }

  return clean;
}

/**
 * Human-facing label for a transcript in progress output. Never a raw session ID: a
 * transcript with no title falls back to its session date/time, then to "(untitled)".
 */
export function transcriptLabel(transcript) {
  if (transcript.title) return transcript.title;
  const at = Number(transcript.startedAt);
  if (Number.isFinite(at) && at > 0) {
    const d = new Date(at);
    const pad = (n) => String(n).padStart(2, "0");
    return `session ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return "(untitled)";
}

function promptPathFor(state, transcript) {
  return path.join(state.applyDir, "..", "prompts", `${safeFileName(transcriptIdentity(transcript))}.md`);
}

async function analyzeOne({
  transcript,
  memoryFile,
  config,
  repo,
  modelCwd = null,
  slot = 0,
  openGapIndex = "(none yet)",
  skillIndex = "(this repo has no skills)",
}) {
  const raw = await readTranscript(transcript);
  const distilled = distill(
    raw.events,
    {
      ...transcript,
      model: raw.model,
      rawPath: raw.rawPath,
    },
    { evidencePolicy: raw.evidencePolicy },
  );

  emitProgress("analyze:lane", {
    slot,
    harness: transcript.harness,
    id: transcript.nativeId,
    title: transcriptLabel(transcript),
    phase: "model",
    // Measure the input distill actually consumed, not `transcript.bytes`: that is a
    // discovery stat() size, which is a directory or 0 for several harnesses.
    rawBytes: Buffer.byteLength(JSON.stringify(raw.events), "utf8"),
    distilledBytes: Buffer.byteLength(distilled.trace, "utf8"),
  });

  // Triviality filter. `minUserTurns` is the knob, but a session is only truly trivial
  // when the agent barely did anything either: an autonomous run has exactly one user
  // turn (the brief) followed by hundreds of agent turns, and it carries plenty of
  // signal. Skipping those would discard most of a real corpus.
  const { userTurns, assistantTurns, toolCalls } = distilled.stats;
  if (userTurns < config.discovery.minUserTurns && assistantTurns < MIN_ASSISTANT_TURNS && toolCalls < MIN_TOOL_CALLS) {
    return {
      status: "skipped",
      reason: `trivial session (${userTurns} user turn(s), ${assistantTurns} agent turn(s), ${toolCalls} tool call(s))`,
      distilled,
    };
  }

  const prompt = renderPrompt(raw.evidencePolicy === "trace-only" ? "analysis-trace-only" : "analysis", {
    MEMORY_PATH: raw.evidencePolicy === "trace-only" ? path.basename(memoryFile.path) : memoryFile.path,
    INSTRUCTION_INDEX: renderInstructionIndex(memoryFile),
    SKILLS: skillIndex,
    OPEN_GAPS: openGapIndex,
    TRACE: distilled.trace,
  });

  const promptFile = promptPathFor(config.state, transcript);
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, prompt);

  let ranWith = null;
  const result = await config.agents.withFallthrough("analysis", async (pick) => {
    ranWith = pick.agent;
    const call = {
      agent: pick.agent,
      model: pick.model,
      promptFile,
      cwd: modelCwd || repo.root,
      timeoutSeconds: config.timeoutSeconds,
      promptRetries: config.promptRetries,
    };
    // Route effortful calls through a fresh per-transcript session so each harness's
    // invocation-scoped overlay or safe fallback is applied; otherwise one-shot is cheaper.
    return runModelCall(call, pick, {
      sessionName: () => `backpass-analysis-${process.pid}-${slot}-${++callCounter}`,
    });
  });
  for (const note of result.notes || []) noteOnce(note);

  const parsed = extractJson(result.text);
  if (!parsed) {
    throw new Error("analysis returned no parseable JSON");
  }

  return {
    status: "ok",
    evidence: sanitizeEvidence(
      parsed,
      memoryFile,
      raw.evidencePolicy === "trace-only" ? distilled : distilled.trace,
      raw.evidencePolicy,
    ),
    usage: usageRecord(ranWith, result),
    distilled,
  };
}

/**
 * Bounded-concurrency worker pool - the design's `--jobs N` fan-out.
 * The worker also receives its runner slot so the progress view can show one
 * lane per job.
 */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async (_, slot) => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index, slot);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function analyzeTranscripts({
  transcripts,
  memoryFile,
  skills = [],
  config,
  repo,
  modelCwd = null,
  memoryHash,
  force = false,
  prefetch = null,
}) {
  const state = config.state;
  const pending = [];
  const summary = {
    total: transcripts.length,
    cached: 0,
    analyzed: 0,
    skipped: 0,
    failed: 0,
    usage: [],
    staleMemoryHash: 0,
    quotesNotInTrace: 0,
  };
  const priorHashes = new Set();
  const transcriptMetadata = (transcript) => ({
    ...(transcript.sourceKind === "external"
      ? {
          sourceKind: transcript.sourceKind,
          sourceId: transcript.sourceId,
          sessionId: transcript.sessionId,
          revision: transcript.revision,
          sourceHostAlias: transcript.sourceHostAlias,
        }
      : {}),
    harness: transcript.harness,
    id: transcript.id,
    identity: transcriptIdentity(transcript),
    path: transcript.path,
    mtimeMs: transcript.mtimeMs,
    bytes: transcript.bytes,
    startedAt: transcript.startedAt,
    association: transcript.association,
    interaction: classifyInteraction(transcript),
    cwd: transcript.cwd || null,
    project: transcript.project || null,
    projectRoot: transcript.projectRoot || null,
    host: transcript.host || null,
  });

  for (const transcript of transcripts) {
    const existing = state.readEvidence(transcript);
    if (!force && isEvidenceFresh(existing, transcript, memoryHash)) {
      const updatedTranscript = { ...existing.transcript, ...transcriptMetadata(transcript) };
      if (JSON.stringify(existing.transcript) !== JSON.stringify(updatedTranscript)) {
        state.writeEvidence(transcript, { ...existing, transcript: updatedTranscript });
      }
      summary.cached += 1;
      continue;
    }
    // Distinguish "no prior evidence" from "prior evidence exists, but it was judged
    // against a memory surface that no longer matches" - a re-analysis here, not a miss.
    if (existing?.status === "ok" && existing.memoryHash && existing.memoryHash !== memoryHash) {
      summary.staleMemoryHash += 1;
      priorHashes.add(existing.memoryHash);
    }
    pending.push(transcript);
  }

  if (summary.staleMemoryHash) {
    info(
      `${color.yellow("·")} ${summary.staleMemoryHash} transcript(s) have evidence from a previous ` +
        `memory surface (${[...priorHashes].join(", ")} -> ${memoryHash}); that evidence is stale, not ` +
        `missing, and reuse resumes once this pass re-judges it against the current memory file and skill descriptions`,
    );
  }

  // Remote sessions have no content here yet. Fetch exactly the pending ones, before the
  // pool, so a cached or skipped transcript never costs an ssh call - and so an
  // unreachable host fails one transcript at a time rather than mid-fan-out.
  if (prefetch) await prefetch(pending);

  if (!pending.length) {
    emitProgress("analyze:start", { pending: 0, cached: summary.cached, total: transcripts.length, jobs: config.jobs });
    emitProgress("analyze:done", summary);
    return summary;
  }

  // Resolve (and, on the first run, probe) before the fan-out so the pick is announced once.
  const pick = await config.agents.resolve("analysis");
  emitProgress("analyze:start", {
    pending: pending.length,
    cached: summary.cached,
    total: transcripts.length,
    jobs: config.jobs,
    agent: pick.agent,
    model: pick.model,
  });

  info(
    `${color.cyan("·")} analyzing ${pending.length} transcript(s) with ${pick.agent}` +
      `${pick.model ? ` (${pick.model})` : ""}${pick.effort ? ` effort=${pick.effort}` : ""} at jobs=${config.jobs}`,
  );

  // Rendered once per run: the ledger's open gaps, so each analysis can cite an existing
  // gap id instead of coining a paraphrase of it (`matchesGap` in the reply schema), and
  // the skill index, so a mistake an existing skill's content covers is reported as a
  // failed trigger (`coveredBySkill`) instead of a brand-new gap.
  const openGapIndex = renderOpenGapIndex(state.readGapLedger(), memoryFile.path);
  const skillIndex = renderSkillIndexForAnalysis(
    modelCwd && path.resolve(modelCwd) !== path.resolve(repo.root)
      ? skills.map((skill) => ({
          ...skill,
          path: path.isAbsolute(skill.path) ? skill.path : path.join(repo.root, skill.path),
        }))
      : skills,
  );

  let done = 0;
  const evidenceTotals = { positive: 0, negative: 0, gaps: 0 };
  await pool(pending, config.jobs, async (transcript, _index, slot) => {
    const base = {
      transcript: transcriptMetadata(transcript),
      memoryHash,
      memoryPath: memoryFile.path,
      key: evidenceKey(transcript, memoryHash),
      analyzedAt: new Date().toISOString(),
    };

    emitProgress("analyze:lane", {
      slot,
      harness: transcript.harness,
      id: transcript.nativeId,
      title: transcriptLabel(transcript),
      phase: "distill",
    });

    try {
      const result = await analyzeOne({
        transcript,
        memoryFile,
        config,
        repo,
        modelCwd,
        slot,
        openGapIndex,
        skillIndex,
      });
      if (result.status === "skipped") {
        summary.skipped += 1;
        state.writeEvidence(transcript, { ...base, status: "skipped", reason: result.reason });
      } else {
        summary.analyzed += 1;
        summary.usage.push(result.usage);
        state.writeEvidence(transcript, {
          ...base,
          status: "ok",
          stats: result.distilled.stats,
          ...result.evidence,
        });
        evidenceTotals.positive += result.evidence.positive.length;
        evidenceTotals.negative += result.evidence.negative.length;
        evidenceTotals.gaps += result.evidence.gaps.length;
        summary.quotesNotInTrace += result.evidence.quotesNotInTrace;
        emitProgress("analyze:evidence", { ...evidenceTotals });
      }
    } catch (err) {
      if (err instanceof UserError) throw err;
      // Per-transcript fail-soft: recorded, listed by `backpass status`, retried next run.
      summary.failed += 1;
      warn(`${transcript.harness} ${transcriptLabel(transcript)}: ${err.message}`);
      state.writeEvidence(transcript, { ...base, status: "failed", error: err.message });
    } finally {
      done += 1;
      emitProgress("analyze:tick", {
        slot,
        done,
        ok: summary.analyzed,
        skipped: summary.skipped,
        failed: summary.failed,
      });
      if (done % 10 === 0 || done === pending.length) {
        info(`${color.dim(`  ${done}/${pending.length} analyzed`)}`);
      }
    }
  });

  if (summary.quotesNotInTrace) {
    warn(
      `${summary.quotesNotInTrace} quote(s) were discarded because they do not appear in the ` +
        `distilled trace they claim to come from; a model that paraphrases instead of copying ` +
        `produces fewer findings, not cleaner ones - consider a stronger analysis model`,
    );
  }

  emitProgress("analyze:done", summary);
  return summary;
}
