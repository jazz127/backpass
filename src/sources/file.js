/** A selected v1 snapshot is validated once, then its approved bytes are pinned for the run. */
import fs from "node:fs";
import path from "node:path";

import { parseManifest, validateManifest } from "./external-session-source.js";

const MANIFEST_LIMIT = 1_048_576;
const SESSION_LIMIT = 2_097_152;
const SNAPSHOT_LIMIT = 512 * 1_048_576;
const records = new WeakMap();
const snapshots = new WeakSet();

export class SessionSourceError extends Error {
  constructor(code, detail = "") {
    super(`session source ${code}${detail ? `: ${detail}` : ""}`);
    this.name = "SessionSourceError";
    this.code = code;
  }
}

function reject(code, detail) {
  throw new SessionSourceError(code, detail);
}

function currentUid() {
  if (typeof process.getuid !== "function") reject("ownership_unsupported");
  return process.getuid();
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function checkedStat(target, kind) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    reject("path_unreadable", `${target}: ${error.code || error.message}`);
  }
  if (stat.isSymbolicLink() || (kind === "directory" ? !stat.isDirectory() : !stat.isFile())) {
    reject("path_unsafe", target);
  }
  if (stat.uid !== currentUid()) reject("owner_invalid", target);
  if (stat.mode & 0o077) reject("mode_unsafe", target);
  if (kind === "file" && stat.nlink !== 1) reject("link_unsafe", target);
  return stat;
}

function readChecked(file, limit) {
  const before = checkedStat(file, "file");
  if (before.size > limit) reject("size_limit", file);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.uid !== currentUid() || opened.nlink !== 1 || opened.mode & 0o077) {
      reject("path_unsafe", file);
    }
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      reject("source_changed", file);
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) reject("source_changed", file);
      offset += count;
    }
    if (fs.fstatSync(fd).size !== opened.size) reject("source_changed", file);
    const after = fs.lstatSync(file);
    if (after.dev !== opened.dev || after.ino !== opened.ino) reject("source_changed", file);
    return bytes;
  } catch (error) {
    if (error instanceof SessionSourceError) throw error;
    reject("path_unreadable", `${file}: ${error.code || error.message}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Discover all sessions, validating the complete snapshot before returning any descriptor. */
export function discover(snapshot) {
  let selected;
  let selectedStat;
  try {
    selected = fs.realpathSync(path.resolve(snapshot));
    selectedStat = fs.lstatSync(selected);
  } catch (error) {
    reject("path_unreadable", `${path.resolve(snapshot)}: ${error.code || error.message}`);
  }
  const root = selectedStat.isDirectory() ? selected : path.dirname(selected);
  const manifestPath = selectedStat.isDirectory() ? path.join(selected, "manifest.json") : selected;
  if (path.basename(manifestPath) !== "manifest.json") reject("path_invalid", selected);
  checkedStat(root, "directory");
  const manifestBytes = readChecked(manifestPath, MANIFEST_LIMIT);
  let manifest;
  try {
    manifest = parseManifest(manifestBytes);
  } catch (error) {
    reject(error.code || "manifest_invalid", error.message);
  }

  const contents = new Map();
  let totalBytes = manifestBytes.length;
  for (const entry of manifest.sessions) {
    const components = entry.contentPath.split("/");
    let parent = root;
    for (const component of components.slice(0, -1)) {
      parent = path.join(parent, component);
      checkedStat(parent, "directory");
    }
    const file = path.join(parent, components.at(-1));
    const bytes = readChecked(file, SESSION_LIMIT);
    totalBytes += bytes.length;
    if (totalBytes > SNAPSHOT_LIMIT) reject("size_limit", "snapshot");
    contents.set(entry.contentPath, bytes);
  }
  const validation = validateManifest(manifestBytes, contents);
  if (!validation.ok) reject(validation.code);

  const descriptors = manifest.sessions.map((entry) => {
    const payload = JSON.parse(contents.get(entry.contentPath).toString("utf8"));
    return {
      sourceKind: "external",
      sourceId: manifest.sourceNamespace,
      sessionId: payload.sessionId,
      revision: payload.revision,
      projectedAt: Date.parse(payload.projectedAt),
      originHarness: payload.originHarness,
      nativeSessionId: payload.nativeSessionId || null,
      startedAt: payload.startedAt ? Date.parse(payload.startedAt) : null,
      mtimeMs: payload.startedAt ? Date.parse(payload.startedAt) : Date.parse(payload.capturedAt),
      timeBasis: payload.timeBasis,
      bytes: entry.byteLength,
      contentSignature: entry.sha256,
      association: payload.association,
      title: payload.context.title || null,
      gitBranch: payload.context.branch || null,
      model: payload.context.model || null,
      interactionClass: payload.context.interactionClass,
      interactionSignals: payload.context.signals,
      selfGenerated: payload.context.selfGenerated,
      display: payload.display,
      screening: payload.screening,
      events: payload.events,
    };
  });
  const latestBySession = new Map();
  for (const descriptor of descriptors) {
    const prior = latestBySession.get(descriptor.sessionId);
    if (prior && prior.projectedAt === descriptor.projectedAt) reject("revision_ambiguous", descriptor.sessionId);
    if (!prior || prior.projectedAt < descriptor.projectedAt) latestBySession.set(descriptor.sessionId, descriptor);
  }
  const snapshotRecord = {
    kind: "external",
    sourceId: manifest.sourceNamespace,
    snapshotDigest: manifest.snapshotDigest,
    policyDigest: manifest.policyDigest,
    coverage: manifest.coverage,
    descriptors: [...latestBySession.values()],
  };
  snapshots.add(snapshotRecord);
  return freeze(snapshotRecord);
}

export function assertValidatedSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !snapshots.has(snapshot)) reject("snapshot_unvalidated");
  return snapshot;
}

export function bind(transcript, descriptor) {
  records.set(transcript, { events: descriptor.events, model: descriptor.model });
}

/** Read only bytes pinned by discover; never reopen a producer path. */
export function read(transcript) {
  const record = records.get(transcript);
  if (!record) reject("descriptor_invalid");
  return { events: record.events, model: record.model, rawPath: null, evidencePolicy: "trace-only" };
}
