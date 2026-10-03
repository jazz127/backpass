import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { UserError } from "./logger.js";
import { pointerImportPath, resolveMemoryFiles } from "./memory.js";
import { resolveNestedMemoryFiles } from "./nested.js";
import { selectedCorpusDigest, assertSourceCurrent } from "./provenance.js";
import { loadProjectSkills, resolveOverflowTarget } from "./skills.js";
import { userClaudeSkillsDir } from "./config.js";

function digest(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function within(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/** Exact prompt-input bytes and resolved pointer targets for review and freshness checks. */
export function inputInventory(ctx) {
  const { repo, scope, config } = ctx;
  const userScope = scope?.kind === "user";
  const resolved = resolveMemoryFiles(repo.root, config.memoryFiles, { allowExternal: userScope });
  const overflow = resolveOverflowTarget(repo.root, config.skillsDir, {
    claudeSkillsDir: userScope ? userClaudeSkillsDir() : undefined,
    allowExternal: userScope,
  });
  const skills = loadProjectSkills(repo.root, overflow.dir, config.skillsDirs || [], { exact: userScope });
  const nestedFiles = resolveNestedMemoryFiles(repo.root, config);
  const memoryFiles = [
    ...resolved.all,
    ...nestedFiles.flatMap((weight) => [weight.file, ...weight.separate]).filter(Boolean),
  ];
  const primaryTargets = new Set(
    [resolved.primary, ...nestedFiles.map((weight) => weight.file)]
      .filter(Boolean)
      .map((file) => fs.realpathSync(file.absolute)),
  );
  const approvedMemory = new Set(memoryFiles.map((file) => path.resolve(file.absolute)));
  const entries = [];
  const add = (kind, logicalPath, absolute, pointerTarget = null) => {
    const target = fs.realpathSync(absolute);
    if (ctx.flags["child-env"] === "restricted" && !userScope && !within(repo.realRoot, target)) {
      throw new UserError(`unapproved ${kind} target: ${logicalPath}`);
    }
    const bytes = fs.readFileSync(absolute);
    entries.push({ kind, path: logicalPath, target, bytes: bytes.length, digest: digest(bytes), pointerTarget });
  };
  for (const file of memoryFiles) {
    const pointerTarget = pointerImportPath(file.text, { fromDir: path.dirname(file.absolute) });
    if (ctx.flags["child-env"] === "restricted" && pointerTarget) {
      if (!approvedMemory.has(path.resolve(pointerTarget)) || !fs.existsSync(pointerTarget)) {
        throw new UserError(`unapproved memory pointer: ${file.path} -> ${pointerTarget}`);
      }
      if (!primaryTargets.has(fs.realpathSync(pointerTarget))) {
        throw new UserError(`unapproved memory pointer: ${file.path} -> ${pointerTarget}`);
      }
    }
    add("memory", file.path, file.absolute, pointerTarget);
  }
  for (const skill of skills) {
    const absolute = path.isAbsolute(skill.path) ? skill.path : path.join(repo.root, skill.path);
    add("skill", skill.path, absolute);
  }
  entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path));
  return { digest: digest(Buffer.from(JSON.stringify(entries))), entries };
}

/** An explicit state directory pins one scan's source, selected corpus, and inputs. */
export function checkRunContext(ctx, transcripts, { start = false } = {}) {
  if (!ctx.flags["state-dir"]) return null;
  assertSourceCurrent(ctx);
  const inventory = inputInventory(ctx);
  const current = {
    version: 1,
    scope: { kind: ctx.scope.kind, root: fs.realpathSync(ctx.scope.root) },
    source: ctx.sessionSource
      ? { kind: "external", sourceId: ctx.sessionSource.sourceId, snapshotDigest: ctx.sessionSource.snapshotDigest }
      : { kind: "native" },
    selectedCorpusDigest: selectedCorpusDigest(transcripts),
    inputMemoryDigest: inventory.digest,
    inventory: inventory.entries,
  };
  if (start) {
    ctx.config.state.writeRunContext(current);
    return current;
  }
  const pinned = ctx.config.state.readRunContext();
  if (!pinned) throw new UserError("no frozen run context in --state-dir", "run scan with the same --state-dir first");
  for (const key of ["scope", "source", "selectedCorpusDigest", "inputMemoryDigest"]) {
    if (JSON.stringify(pinned[key]) !== JSON.stringify(current[key])) {
      throw new UserError(`the frozen run context changed (${key})`, "run scan again to start a new run");
    }
  }
  return pinned;
}

export function checkProposalRunContext(ctx, proposal) {
  const expected = proposal.provenance?.runContext;
  if (!expected) {
    if (ctx.flags["state-dir"]) throw new UserError("this proposal has no frozen run context");
    return;
  }
  if (!ctx.flags["state-dir"]) throw new UserError("this proposal requires its --state-dir");
  const pinned = ctx.config.state.readRunContext();
  if (
    !pinned ||
    pinned.scope?.kind !== ctx.scope.kind ||
    pinned.scope?.root !== fs.realpathSync(ctx.scope.root) ||
    JSON.stringify(pinned.source) !== JSON.stringify(proposal.provenance.source) ||
    pinned.selectedCorpusDigest !== expected.selectedCorpusDigest ||
    pinned.inputMemoryDigest !== expected.inputMemoryDigest ||
    inputInventory(ctx).digest !== expected.inputMemoryDigest
  ) {
    throw new UserError("the frozen run context changed; proposal is stale");
  }
  assertSourceCurrent(ctx, proposal.provenance);
}
