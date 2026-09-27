/** Validation of canonical external-session-source/v1 bytes; this module performs no file I/O. */
import { createHash } from "node:crypto";

const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_SESSION_BYTES = 2_097_152;
const MAX_STRING_CHARS = 65_536;
const MAX_LABEL_CHARS = 256;
const MAX_PATH_BYTES = 512;
const MAX_MEMBERS = 10_000;
const MAX_NESTING = 32;
const SHA256 = /^[0-9a-f]{64}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SOURCE_REF = /^sv-evidence:[A-Za-z0-9_-]{1,128}$/;
const CONTENT_PATH = /^sessions\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const UTC_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$/;

class ValidationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new ValidationError(code);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalarCompare(a, b) {
  const aa = Array.from(a, (character) => character.codePointAt(0));
  const bb = Array.from(b, (character) => character.codePointAt(0));
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
    if (aa[i] !== bb[i]) return aa[i] - bb[i];
  }
  return aa.length - bb.length;
}

function walk(value, depth = 0, keyOrder) {
  if ((Array.isArray(value) || record(value)) && depth >= MAX_NESTING) fail("size_limit");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) fail("number_invalid");
    return;
  }
  if (typeof value === "string") {
    if (Array.from(value).length > MAX_STRING_CHARS) fail("size_limit");
    for (const character of value) {
      const point = character.codePointAt(0);
      if (point >= 0xd800 && point <= 0xdfff) fail("unicode_invalid");
    }
    if (value.normalize("NFC") !== value) fail("unicode_invalid");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_MEMBERS) fail("size_limit");
    for (const item of value) walk(item, depth + 1, keyOrder);
    return;
  }
  if (record(value)) {
    const keys = keyOrder?.get(value) ?? Object.keys(value);
    if (keys.length > MAX_MEMBERS) fail("size_limit");
    for (const key of keys) {
      walk(key, depth + 1, keyOrder);
      walk(value[key], depth + 1, keyOrder);
    }
    return;
  }
  fail("type_invalid");
}

function serialize(value) {
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value)
      .sort(scalarCompare)
      .map((key) => `${JSON.stringify(key)}:${serialize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalize(value) {
  walk(value);
  return Buffer.from(serialize(value), "utf8");
}

export function digest(value) {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function snapshotDigest(manifest) {
  const content = { ...manifest };
  delete content.snapshotDigest;
  return digest(content);
}

export function approvedContentDigest(session) {
  const screening = { ...session.screening };
  delete screening.approvedContentDigest;
  return digest({ ...session, screening });
}

function rawNesting(bytes) {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (quoted) {
      if (byte === 0x5c) i++;
      else if (byte === 0x22) quoted = false;
    } else if (byte === 0x22) quoted = true;
    else if (byte === 0x5b || byte === 0x7b) {
      if (++depth > MAX_NESTING) fail("size_limit");
    } else if (byte === 0x5d || byte === 0x7d) depth--;
  }
}

// JSON.parse checks syntax first. This second pass retains document key order and
// inspects number tokens and duplicate keys that JSON.parse otherwise erases.
function readTokens(source) {
  let offset = 0;
  let duplicate = false;
  let badNumber = false;
  const keyOrder = new WeakMap();
  const space = () => {
    while (/\s/.test(source[offset] ?? "")) offset++;
  };
  const string = () => {
    const start = offset++;
    while (offset < source.length) {
      if (source[offset] === "\\") offset += 2;
      else if (source[offset++] === '"') break;
    }
    return JSON.parse(source.slice(start, offset));
  };
  const value = () => {
    space();
    if (source[offset] === '"') return string();
    if (source[offset] === "{") {
      offset++;
      const object = Object.create(null);
      const keys = [];
      const seen = new Set();
      space();
      while (source[offset] !== "}") {
        const key = string();
        if (seen.has(key)) duplicate = true;
        else keys.push(key);
        seen.add(key);
        space();
        offset++;
        object[key] = value();
        space();
        if (source[offset] !== ",") break;
        offset++;
        space();
      }
      offset++;
      keyOrder.set(object, keys);
      return object;
    }
    if (source[offset] === "[") {
      offset++;
      const array = [];
      space();
      while (source[offset] !== "]") {
        array.push(value());
        space();
        if (source[offset] !== ",") break;
        offset++;
      }
      offset++;
      return array;
    }
    const start = offset;
    while (offset < source.length && !/[\s,\]}]/.test(source[offset])) offset++;
    const token = source.slice(start, offset);
    if (token === "null") return null;
    if (token === "true") return true;
    if (token === "false") return false;
    if (/[.eE-]/.test(token) || !Number.isSafeInteger(Number(token))) badNumber = true;
    return Number(token);
  };
  const parsed = value();
  return { parsed, keyOrder, duplicate, badNumber };
}

function parse(raw, limit) {
  if (!(raw instanceof Uint8Array)) fail("type_invalid");
  if (raw.byteLength > limit) fail("size_limit");
  rawNesting(raw);
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    JSON.parse(source);
  } catch {
    fail("json_invalid");
  }
  const { parsed, keyOrder, duplicate, badNumber } = readTokens(source);
  if (duplicate) fail("json_duplicate_key");
  if (badNumber) fail("number_invalid");
  if (!record(parsed)) fail("type_invalid");
  walk(parsed, 0, keyOrder);
  if (!Buffer.from(raw).equals(Buffer.from(serialize(parsed), "utf8"))) fail("noncanonical_json");
  return parsed;
}

function object(value, required, optional = []) {
  if (!record(value)) fail("type_invalid");
  for (const key of required) if (!Object.hasOwn(value, key)) fail("field_missing");
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail("field_unknown");
  return value;
}

function version(value) {
  if (!Object.hasOwn(value, "schema") || !Object.hasOwn(value, "version")) fail("field_missing");
  if (value.schema !== "external-session-source" || value.version !== 1) fail("version_unknown");
}

/** @param {any} value @param {{label?: boolean, pattern?: RegExp}} [options] */
function string(value, { label = false, pattern } = {}) {
  if (typeof value !== "string") fail("type_invalid");
  if (label && Array.from(value).length > MAX_LABEL_CHARS) fail("size_limit");
  if (pattern && !pattern.test(value)) fail("value_invalid");
  return value;
}

function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("type_invalid");
}

function time(value) {
  if (typeof value !== "string" || !UTC_TIME.test(value) || value.startsWith("0000")) fail("time_invalid");
  const milliseconds = Date.parse(value);
  const expected = value.replace(/(?:\.([0-9]{1,3}))?Z$/, (_, fraction) => `.${(fraction ?? "").padEnd(3, "0")}Z`);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== expected) fail("time_invalid");
  return milliseconds;
}

function opaque(value) {
  return string(value, { pattern: OPAQUE });
}

function stringList(value, sourceRefs = false) {
  if (!Array.isArray(value)) fail("type_invalid");
  for (const item of value) string(item, { label: true, pattern: sourceRefs ? SOURCE_REF : undefined });
}

function contentPath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..") ||
    value.split("/")[0].includes(":") ||
    !CONTENT_PATH.test(value)
  ) {
    fail("path_invalid");
  }
  return value;
}

function validateSessionObject(value) {
  version(value);
  object(
    value,
    [
      "schema",
      "version",
      "sourceId",
      "sessionId",
      "revision",
      "originHarness",
      "evidencePolicy",
      "capturedAt",
      "projectedAt",
      "timeBasis",
      "association",
      "display",
      "context",
      "events",
      "screening",
    ],
    ["nativeSessionId", "startedAt", "endedAt"],
  );
  if (value.evidencePolicy !== "trace-only") fail("evidence_policy_unknown");
  for (const key of ["sourceId", "sessionId", "revision", "originHarness"]) opaque(value[key]);
  if (Object.hasOwn(value, "nativeSessionId")) string(value.nativeSessionId, { label: true });
  const times = {};
  for (const key of ["capturedAt", "projectedAt", "startedAt", "endedAt"]) {
    if (Object.hasOwn(value, key)) times[key] = time(value[key]);
  }
  if (!["transcript", "capture-fallback", "unknown"].includes(value.timeBasis)) fail("value_invalid");
  if (value.timeBasis !== "unknown" && !Object.hasOwn(value, "startedAt")) fail("field_missing");
  if (value.timeBasis === "unknown" && Object.hasOwn(value, "startedAt")) fail("time_invalid");
  if (value.timeBasis === "capture-fallback" && times.startedAt !== times.capturedAt) fail("time_invalid");
  if (Object.hasOwn(times, "endedAt") && Object.hasOwn(times, "startedAt") && times.endedAt < times.startedAt)
    fail("time_invalid");
  const association = object(
    value.association,
    ["basis", "remotes", "gitFacts"],
    ["hostAlias", "cwd", "gitRoot", "projectAlias", "worktreeAlias"],
  );
  if (!["recorded", "mapped", "unknown"].includes(association.basis)) fail("value_invalid");
  for (const key of ["hostAlias", "cwd", "gitRoot", "projectAlias", "worktreeAlias"]) {
    if (Object.hasOwn(association, key)) string(association[key], { label: key !== "cwd" && key !== "gitRoot" });
  }
  stringList(association.remotes);
  if (!Array.isArray(association.gitFacts)) fail("type_invalid");
  for (const fact of association.gitFacts) {
    object(fact, ["kind", "value", "basis", "observedAt"]);
    if (!["git-root", "remote", "branch"].includes(fact.kind) || !["recorded", "supplemental"].includes(fact.basis))
      fail("value_invalid");
    string(fact.value);
    time(fact.observedAt);
  }
  const display = object(value.display, ["project", "worktree"]);
  for (const key of ["project", "worktree"]) string(display[key], { label: true });
  const context = object(
    value.context,
    ["interactionClass", "signals", "selfGenerated", "parserQualityFlags"],
    ["model", "title", "branch"],
  );
  if (!["interactive", "autonomous", "unknown"].includes(context.interactionClass)) fail("value_invalid");
  if (typeof context.selfGenerated !== "boolean") fail("type_invalid");
  for (const key of ["model", "title", "branch"])
    if (Object.hasOwn(context, key)) string(context[key], { label: true });
  stringList(context.signals);
  stringList(context.parserQualityFlags);
  if (!Array.isArray(value.events)) fail("type_invalid");
  const ids = new Set();
  for (const event of value.events) {
    if (!record(event)) fail("type_invalid");
    const common = ["eventId", "kind", "sourceRefs", "redacted", "omitted"];
    if (event.kind === "message") {
      object(event, [...common, "role", "text"], ["at"]);
      if (!["user", "assistant"].includes(event.role)) fail("value_invalid");
      string(event.text);
    } else if (event.kind === "tool") {
      object(event, [...common, "name", "input", "result", "status"], ["at"]);
      string(event.name, { label: true });
      if (!["completed", "failed", "missing"].includes(event.status)) fail("value_invalid");
      if (event.result !== null) string(event.result);
      if (event.status === "missing" && event.result !== null) fail("value_invalid");
      if (record(event.input)) {
        for (const [key, item] of Object.entries(event.input)) {
          if (!["command", "path", "description"].includes(key)) fail("field_unknown");
          string(item);
        }
      } else string(event.input);
    } else fail("event_kind_unknown");
    const id = opaque(event.eventId);
    if (ids.has(id)) fail("event_id_duplicate");
    ids.add(id);
    stringList(event.sourceRefs, true);
    if (!event.sourceRefs.length) fail("value_invalid");
    for (const flag of ["redacted", "omitted"]) if (typeof event[flag] !== "boolean") fail("type_invalid");
    if (Object.hasOwn(event, "at")) time(event.at);
  }
  const screening = object(value.screening, [
    "policyVersion",
    "parserVersion",
    "categoryCounts",
    "withheldEvents",
    "reviewStatus",
    "approvedContentDigest",
  ]);
  string(screening.policyVersion, { label: true });
  string(screening.parserVersion, { label: true });
  if (screening.reviewStatus !== "approved") fail("review_not_approved");
  if (!record(screening.categoryCounts)) fail("type_invalid");
  for (const [key, count] of Object.entries(screening.categoryCounts)) {
    opaque(key);
    integer(count);
  }
  integer(screening.withheldEvents);
  if (screening.approvedContentDigest !== approvedContentDigest(value)) fail("content_digest_mismatch");
}

function validateManifestObject(value) {
  version(value);
  object(value, [
    "schema",
    "version",
    "producerVersion",
    "sourceNamespace",
    "sourceKind",
    "capabilities",
    "policyDigest",
    "snapshotDigest",
    "createdAt",
    "approvalReceiptDigest",
    "sessions",
    "coverage",
  ]);
  string(value.producerVersion, { label: true });
  opaque(value.sourceNamespace);
  if (value.sourceKind !== "external") fail("value_invalid");
  if (!record(value.capabilities)) fail("type_invalid");
  if (!Object.hasOwn(value.capabilities, "evidencePolicy")) fail("evidence_policy_missing");
  const capabilities = object(value.capabilities, ["evidencePolicy", "eventKinds", "rawEvidenceAccess"]);
  if (capabilities.evidencePolicy !== "trace-only") fail("evidence_policy_unknown");
  if (
    !Array.isArray(capabilities.eventKinds) ||
    capabilities.eventKinds.length !== 2 ||
    capabilities.eventKinds[0] !== "message" ||
    capabilities.eventKinds[1] !== "tool" ||
    capabilities.rawEvidenceAccess !== false
  )
    fail("capability_invalid");
  for (const key of ["policyDigest", "snapshotDigest", "approvalReceiptDigest"])
    string(value[key], { pattern: SHA256 });
  time(value.createdAt);
  if (!Array.isArray(value.sessions)) fail("type_invalid");
  if (value.sessions.length > MAX_MEMBERS) fail("size_limit");
  const paths = new Set();
  const identities = new Set();
  for (const entry of value.sessions) {
    object(entry, ["sessionId", "revision", "contentPath", "byteLength", "sha256"]);
    const identity = `${opaque(entry.sessionId)}\0${opaque(entry.revision)}`;
    const path = contentPath(entry.contentPath);
    if (paths.has(path) || identities.has(identity)) fail("entry_duplicate");
    paths.add(path);
    identities.add(identity);
    integer(entry.byteLength);
    if (entry.byteLength > MAX_SESSION_BYTES) fail("size_limit");
    string(entry.sha256, { pattern: SHA256 });
  }
  const coverage = object(value.coverage, ["considered", "published", "withheld", "reasons"]);
  for (const key of ["considered", "published", "withheld"]) integer(coverage[key]);
  if (!record(coverage.reasons)) fail("type_invalid");
  for (const [key, count] of Object.entries(coverage.reasons)) {
    opaque(key);
    integer(count);
  }
  if (
    coverage.considered !== coverage.published + coverage.withheld ||
    coverage.published !== value.sessions.length ||
    Object.values(coverage.reasons).reduce((sum, count) => sum + count, 0) !== coverage.withheld
  )
    fail("coverage_invalid");
  if (value.snapshotDigest !== snapshotDigest(value)) fail("snapshot_digest_mismatch");
}

function session(raw) {
  const value = parse(raw, MAX_SESSION_BYTES);
  version(value);
  if (!Object.hasOwn(value, "evidencePolicy")) fail("evidence_policy_missing");
  validateSessionObject(value);
  return value;
}

function result(action) {
  try {
    action();
    return { ok: true, code: "ok" };
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false, code: error.code };
    throw error;
  }
}

export function validateSession(raw) {
  return result(() => session(raw));
}

export function validateManifest(raw, contents) {
  return result(() => {
    const manifest = parse(raw, MAX_MANIFEST_BYTES);
    validateManifestObject(manifest);
    for (const entry of manifest.sessions) {
      const present =
        contents instanceof Map ? contents.has(entry.contentPath) : Object.hasOwn(contents, entry.contentPath);
      if (!present) fail("content_missing");
      const bytes = contents instanceof Map ? contents.get(entry.contentPath) : contents[entry.contentPath];
      const payload = session(bytes);
      if (
        payload.sourceId !== manifest.sourceNamespace ||
        payload.sessionId !== entry.sessionId ||
        payload.revision !== entry.revision
      )
        fail("identity_mismatch");
      if (bytes.byteLength !== entry.byteLength) fail("length_mismatch");
      if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) fail("digest_mismatch");
    }
  });
}
