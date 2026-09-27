import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  approvedContentDigest,
  canonicalize,
  digest,
  snapshotDigest,
  validateManifest,
  validateSession,
} from "../src/sources/external-session-source.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "external-session-source", "v1");
const index = JSON.parse(fs.readFileSync(path.join(fixtures, "index.json"), "utf8"));

for (const fixture of index.cases) {
  test(`external session source v1: ${fixture.name}`, () => {
    const manifestBytes = fs.readFileSync(path.join(fixtures, fixture.manifest));
    const payloadBytes = fs.readFileSync(path.join(fixtures, fixture.payload));
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const contents = new Map([[manifest.sessions[0].contentPath, payloadBytes]]);
    assert.deepEqual(validateManifest(manifestBytes, contents), { ok: fixture.valid, code: fixture.reason });

    if (fixture.valid) {
      const payload = JSON.parse(payloadBytes.toString("utf8"));
      assert.deepEqual(validateSession(payloadBytes), { ok: true, code: "ok" });
      assert.deepEqual(canonicalize(payload), payloadBytes);
      assert.equal(digest(payload), fixture.payloadDigest);
      assert.equal(manifest.sessions[0].sha256, fixture.payloadDigest);
      assert.equal(approvedContentDigest(payload), payload.screening.approvedContentDigest);
      assert.equal(snapshotDigest(manifest), manifest.snapshotDigest);
    }
  });
}

test("parsing rejects duplicate keys before numbers and noncanonical bytes", () => {
  assert.deepEqual(validateSession(Buffer.from('{"x":1.0,"x":2}')), { ok: false, code: "json_duplicate_key" });
  assert.deepEqual(validateSession(Buffer.from('{"x":1.0}')), { ok: false, code: "number_invalid" });
  assert.deepEqual(validateSession(Buffer.from('{ "x":1}')), { ok: false, code: "noncanonical_json" });
});

test("canonicalization sorts integer-like keys by Unicode scalar value", () => {
  assert.equal(canonicalize({ 10: 1, 2: 2, "😀": 3, "\ue000": 4 }).toString("utf8"), '{"10":1,"2":2,"":4,"😀":3}');
});
