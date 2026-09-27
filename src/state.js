import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { STATE_DIRNAME } from "./config.js";
import { UserError, warn } from "./logger.js";
import { ensureLocalExclude } from "./repo.js";
import { transcriptIdentity } from "./transcript.js";
import { DISTILLER_VERSION } from "./distill.js";

/** The line every command writes to the repo's local git exclude for the state dir. */
export const STATE_EXCLUDE_LINE = `${STATE_DIRNAME}/`;

/**
 * All mutable run state lives in a `.backpass/` directory, kept out of git via the
 * repo's local exclude (`.git/info/exclude`, written idempotently by `ensure()` on every
 * command, so a plain `backpass` run with no prior `init` is excluded too) rather than
 * the tracked `.gitignore`:
 *
 *   scan-cache.json        path+mtime+size -> association verdict (design section 2.2)
 *   evidence/<identity>.json per-transcript tier-1 analysis output (design section 3)
 *   evidence-summary.json  folded evidence (stage 2)
 *   proposal.json          latest parseable tier-2 synthesis; absent if none was produced (stage 3)
 *   rejections.json        edits the human rejected, and the evidence weight behind them
 *   gap-ledger.json        gap observations by gap and session, accumulated across runs (src/gap-ledger.js)
 *   agent-probe-cache.json TTL'd availability/auth verdicts per agent|model (src/agents.js)
 *   prompts/               the exact prompts of the last run, one file per model turn
 *   synthesis/             the staging copy the synthesis agent edits natively (src/workspace.js)
 *   apply/                 the rendered Lavish apply surface
 */
export class State {
  /**
   * @param {string} repoRoot project checkout, or ignored when `options.stateDir` is set
   * @param {{ stateDir?: string, mode?: number, exclude?: boolean, binding?: { kind: string, root: string } | null }} [options]
   */
  constructor(repoRoot, options = {}) {
    this.repoRoot = repoRoot;
    this.root = options.stateDir || path.join(repoRoot, STATE_DIRNAME);
    this.dirMode = options.mode;
    this.binding = options.binding || null;
    this.skipExclude = options.exclude === false;
    this.evidenceDir = path.join(this.root, "evidence");
    this.applyDir = path.join(this.root, "apply");
    this.scanCachePath = path.join(this.root, "scan-cache.json");
    this.summaryPath = path.join(this.root, "evidence-summary.json");
    this.proposalPath = path.join(this.root, "proposal.json");
    this.rejectionsPath = path.join(this.root, "rejections.json");
    this.gapLedgerPath = path.join(this.root, "gap-ledger.json");
    this.probeCachePath = path.join(this.root, "agent-probe-cache.json");
    this.runContextPath = path.join(this.root, "run-context.json");
  }

  /**
   * Creates the state dir and excludes it from git in the same step. The exclude is
   * local-only and fail-soft: a non-git directory is silently left alone. User-scope
   * state is created 0700 and is never git-excluded (it does not live in a checkout).
   */
  ensure() {
    if (this.binding) assertPrivatePath(this.root, { privateLeaf: true });
    fs.mkdirSync(this.root, { recursive: true, ...(this.dirMode ? { mode: this.dirMode } : {}) });
    if (this.binding) assertPrivatePath(this.root, { privateLeaf: true });
    if (this.dirMode) {
      try {
        fs.chmodSync(this.root, this.dirMode);
      } catch (err) {
        throw new UserError(
          `could not secure state directory ${this.root} as mode ${this.dirMode.toString(8)}: ${err.message}`,
        );
      }
      const actualMode = fs.statSync(this.root).mode & 0o777;
      if (actualMode !== this.dirMode) {
        throw new UserError(
          `could not secure state directory ${this.root} as mode ${this.dirMode.toString(8)} (got ${actualMode.toString(8)})`,
        );
      }
    }
    fs.mkdirSync(this.evidenceDir, { recursive: true, mode: this.binding ? 0o700 : undefined });
    fs.mkdirSync(this.applyDir, { recursive: true, mode: this.binding ? 0o700 : undefined });
    if (this.binding) {
      for (const dir of [this.evidenceDir, this.applyDir]) assertPrivatePath(dir, { privateLeaf: true });
      const bindingFile = path.join(this.root, "scope.json");
      if (pathEntryExists(bindingFile)) assertPrivateFile(bindingFile);
      const existing = this.readJsonFile(bindingFile, null);
      if (existing && (existing.kind !== this.binding.kind || existing.root !== this.binding.root)) {
        throw new UserError("--state-dir belongs to a different scope or repository");
      }
      if (!existing && pathEntryExists(bindingFile)) throw new UserError("private state scope binding is invalid");
      if (!existing) this.writeJsonFile(bindingFile, this.binding);
    }
    const relative = path.relative(this.repoRoot, this.root);
    const insideRepo =
      relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    this.exclude =
      this.skipExclude || (this.binding && !insideRepo)
        ? { status: "skipped" }
        : ensureLocalExclude(
            this.repoRoot,
            this.binding ? `${relative.split(path.sep).join("/")}/` : STATE_EXCLUDE_LINE,
          );
    return this;
  }

  readJsonFile(file, fallback) {
    if (!pathEntryExists(file)) return fallback;
    if (this.binding) assertPrivateFile(file);
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      warn(`discarding corrupt state file ${path.relative(process.cwd(), file)}: ${err.message}`);
      return fallback;
    }
  }

  writeJsonFile(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (this.binding && pathEntryExists(file)) assertPrivateFile(file);
    const tmp = this.binding ? `${file}.${crypto.randomBytes(8).toString("hex")}.tmp` : `${file}.tmp`;
    fs.writeFileSync(
      tmp,
      `${JSON.stringify(value, null, 2)}\n`,
      this.binding ? { mode: 0o600, flag: "wx" } : undefined,
    );
    try {
      fs.renameSync(tmp, file);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
  }

  readScanCache() {
    const cache = this.readJsonFile(this.scanCachePath, null);
    return cache && cache.version === 1 ? cache : { version: 1, entries: {} };
  }

  writeScanCache(cache) {
    this.writeJsonFile(this.scanCachePath, cache);
  }

  evidencePath(transcript) {
    const identity = transcript && typeof transcript === "object" ? transcriptIdentity(transcript) : transcript;
    return path.join(this.evidenceDir, `${safeFileName(identity)}.json`);
  }

  readEvidence(transcript) {
    const currentPath = this.evidencePath(transcript);
    const current = this.readJsonFile(currentPath, null);
    if (!transcript || typeof transcript !== "object") return current;

    const identity = transcriptIdentity(transcript);
    const legacyPath = this.evidencePath(transcript.id);
    if (legacyPath === currentPath) return current;
    const legacy = this.readJsonFile(legacyPath, null);
    const legacyMatches = legacy?.transcript && transcriptIdentity(legacy.transcript) === identity;
    if (current) {
      const currentMatches = current.transcript && transcriptIdentity(current.transcript) === identity;
      const migrated = currentMatches ? migrateEvidenceRecord(current, transcript, identity) : current;
      if (migrated !== current) this.writeJsonFile(currentPath, migrated);
      if (legacyMatches) fs.rmSync(legacyPath, { force: true });
      return migrated;
    }
    if (!legacyMatches) return null;

    const migrated = migrateEvidenceRecord(legacy, transcript, identity);
    // Publish the upgraded record atomically before removing the legacy path. If the
    // process stops between these operations, the next read prefers the valid canonical
    // record and merely cleans up the duplicate.
    this.writeJsonFile(currentPath, migrated);
    fs.rmSync(legacyPath, { force: true });
    return migrated;
  }

  writeEvidence(transcript, evidence) {
    this.writeJsonFile(this.evidencePath(transcript), evidence);
  }

  listEvidence() {
    if (!fs.existsSync(this.evidenceDir)) return [];
    const records = fs
      .readdirSync(this.evidenceDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => ({ file, record: this.readJsonFile(path.join(this.evidenceDir, file), null) }))
      .filter(({ record }) => Boolean(record));
    const unique = new Map();
    for (const item of records) {
      const identity = item.record.transcript ? transcriptIdentity(item.record.transcript) : `file:${item.file}`;
      const canonical = item.record.transcript ? path.basename(this.evidencePath(item.record.transcript)) : item.file;
      const existing = unique.get(identity);
      if (!existing || item.file === canonical) unique.set(identity, item);
    }
    return [...unique.values()].map(({ record }) => record);
  }

  readSummary() {
    return this.readJsonFile(this.summaryPath, null);
  }

  writeSummary(summary) {
    this.writeJsonFile(this.summaryPath, summary);
  }

  readProposal() {
    return this.readJsonFile(this.proposalPath, null);
  }

  writeProposal(proposal) {
    this.writeJsonFile(this.proposalPath, proposal);
  }

  clearProposal() {
    fs.rmSync(this.proposalPath, { force: true });
  }

  readRejections() {
    const value = this.readJsonFile(this.rejectionsPath, null);
    return value && value.version === 1 ? value : { version: 1, entries: {} };
  }

  writeRejections(rejections) {
    this.writeJsonFile(this.rejectionsPath, rejections);
  }

  /** Fail-soft: a missing or corrupt ledger starts empty and is rebuilt from this run's evidence. */
  readGapLedger() {
    const value = this.readJsonFile(this.gapLedgerPath, null);
    return value && value.version === 1 && value.entries && typeof value.entries === "object"
      ? value
      : { version: 1, entries: {} };
  }

  writeGapLedger(ledger) {
    this.writeJsonFile(this.gapLedgerPath, ledger);
  }

  readProbeCache() {
    const value = this.readJsonFile(this.probeCachePath, null);
    return value && value.version === 1 ? value : { version: 1, acpxVersion: null, entries: {} };
  }

  writeProbeCache(cache) {
    this.writeJsonFile(this.probeCachePath, cache);
  }

  readRunContext() {
    return this.readJsonFile(this.runContextPath, null);
  }

  writeRunContext(context) {
    this.writeJsonFile(this.runContextPath, context);
  }
}

/**
 * Refuse link traversal on an explicit private state path, including existing parents. The only link
 * followed is a system one (e.g. macOS /tmp, /var): owned by root, in a root-owned directory nobody else
 * can write, and above the first directory this user owns. Checks apply to, and return, the canonical path.
 */
export function assertPrivatePath(target, { privateLeaf = false } = {}) {
  const absolute = path.resolve(target);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  let resolved = path.parse(absolute).root;
  let parent = fs.lstatSync(resolved);
  let userOwned = false;
  const segments = absolute.slice(resolved.length).split(path.sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    const part = path.join(resolved, segment);
    const leaf = index === segments.length - 1;
    let stat;
    try {
      stat = fs.lstatSync(part);
    } catch (error) {
      if (error.code === "ENOENT") return path.join(resolved, ...segments.slice(index));
      throw new UserError(`cannot inspect private state path ${part}: ${error.message}`);
    }
    if (stat.isSymbolicLink() && !leaf && !userOwned && uid !== null && isSystemLink(stat, parent)) {
      resolved = fs.realpathSync(part);
      stat = fs.lstatSync(resolved);
    } else {
      resolved = part;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new UserError(`unsafe private state path ${part}`);
    if (uid !== null && stat.uid === uid) userOwned = true;
    parent = stat;
    if (leaf && uid !== null && stat.uid !== uid) {
      throw new UserError(`private state directory is not owned by this user: ${part}`);
    }
    if (leaf && privateLeaf && stat.mode & 0o077) {
      throw new UserError(`private state directory has unsafe permissions: ${part}`);
    }
  }
  return resolved;
}

function isSystemLink(link, parent) {
  return link.uid === 0 && parent.uid === 0 && !(parent.mode & 0o022);
}

function assertPrivateFile(file) {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
    stat.mode & 0o077
  ) {
    throw new UserError(`unsafe private state file ${file}`);
  }
}

function pathEntryExists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function safeFileName(id) {
  return String(id)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 120);
}

export function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function migrateEvidenceRecord(record, transcript, identity) {
  if (record.transcript?.identity === identity) return record;
  return {
    ...record,
    transcript: { ...record.transcript, identity },
  };
}

export const ANALYSIS_INDEX_VERSION = 5;

/**
 * Cache key for a transcript's analysis. Source revision, evidence policy, distiller,
 * memory surface, route and credential seat all invalidate a previous judgment.
 */
export function evidenceKey(transcript, memoryHash, route = null) {
  const content = transcript.contentSignature || `${transcript.mtimeMs}:${transcript.bytes}`;
  return sha256(
    JSON.stringify({
      version: ANALYSIS_INDEX_VERSION,
      identity: transcriptIdentity(transcript),
      content,
      sourceKind: transcript.sourceKind || "native",
      sourceId: transcript.sourceId || null,
      snapshotDigest: transcript.snapshotDigest || null,
      revision: transcript.revision || null,
      policyDigest: transcript.policyDigest || null,
      policyVersion: transcript.screening?.policyVersion || null,
      parserVersion: transcript.screening?.parserVersion || null,
      evidenceMode: transcript.sourceKind === "external" ? "trace-only" : "native",
      distillerVersion: DISTILLER_VERSION,
      memoryHash,
      route,
    }),
  );
}

/**
 * Only a successful analysis is worth caching. A `failed` entry is retried, and a
 * `skipped` entry is re-derived because the skip decision depends on configuration
 * (`minUserTurns`) rather than on the model - recomputing it costs one local file read.
 */
export function isEvidenceFresh(evidence, transcript, memoryHash, route = null) {
  if (!evidence || evidence.status !== "ok") return false;
  return evidence.key === evidenceKey(transcript, memoryHash, route ?? evidence.route ?? null);
}

/**
 * A rejected edit stays rejected until materially new evidence arrives - the design's
 * replacement for a DEFER button (captain tweak 3). "Materially new" means the edit is
 * backed by strictly more transcripts than when it was turned down.
 */
export function rejectionKey(edit) {
  let body;
  if (Array.isArray(edit.hunks)) {
    const files = new Set(edit.hunks.map((hunk) => hunk.file || edit.file).filter(Boolean));
    body = edit.hunks
      .map((hunk) =>
        files.size > 1
          ? `${hunk.file || edit.file}\u0000${hunk.find}\u0000${hunk.replace}`
          : `${hunk.find}\u0000${hunk.replace}`,
      )
      .join("\u0001");
  } else {
    body = `${edit.find || ""}\u0000${edit.replace || ""}`;
  }
  return sha256([edit.kind, edit.file, body].join(" ")).slice(0, 16);
}

export function isSuppressedByRejection(edit, rejections) {
  const prior = rejections.entries[rejectionKey(edit)];
  if (!prior) return false;
  return (edit.transcripts || 0) <= (prior.transcripts || 0);
}

export function recordRejection(edit, rejections, at = new Date().toISOString(), provenance = null) {
  rejections.entries[rejectionKey(edit)] = {
    kind: edit.kind,
    file: edit.file,
    title: edit.title,
    transcripts: edit.transcripts || 0,
    rejectedAt: at,
    ...(provenance ? { provenance } : {}),
  };
  return rejections;
}
