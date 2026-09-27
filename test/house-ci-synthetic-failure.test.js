import test from "node:test";
import assert from "node:assert/strict";

test("synthetic House CI failure probe", () => {
  assert.equal("intentionally failing", "corrected");
});
