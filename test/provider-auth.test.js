import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PI_PROVIDER_AUTH_MODE,
  ambiguousModelDetail,
  credentialTypeToAuthClass,
  opencodeAuthFilePath,
  parseAuthFileTypes,
  piAuthFilePath,
  providerAuthState,
  providerOf,
  rankCollidingIds,
  readProviderAuthTypes,
} from "../src/provider-auth.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "backpass-provider-auth-"));
}

test("credential types map onto subscription vs api_key and skip unknowns", () => {
  assert.equal(credentialTypeToAuthClass("oauth"), "subscription");
  assert.equal(credentialTypeToAuthClass("oidc"), "subscription");
  assert.equal(credentialTypeToAuthClass("chatgpt"), "subscription");
  assert.equal(credentialTypeToAuthClass("api_key"), "api_key");
  assert.equal(credentialTypeToAuthClass("api"), "api_key");
  assert.equal(credentialTypeToAuthClass("unknown"), null);
  assert.equal(credentialTypeToAuthClass(undefined), null);
});

test("parseAuthFileTypes reads type only and ignores non-objects", () => {
  assert.deepEqual(
    parseAuthFileTypes({
      "openai-codex": { type: "oauth", access: "secret-must-not-be-copied", refresh: "also-secret" },
      openai: { type: "api_key", key: "sk-secret" },
      xai: { type: "mystery" },
      bare: "oauth",
    }),
    { "openai-codex": "subscription", openai: "api_key" },
  );
  assert.deepEqual(parseAuthFileTypes(null), {});
  assert.deepEqual(parseAuthFileTypes([]), {});
});

test("rankCollidingIds prefers the sole subscription provider and refuses the rest", () => {
  const pair = ["openai/gpt-5.6-luna", "openai-codex/gpt-5.6-luna"];
  const ranked = rankCollidingIds(pair, { openai: "api_key", "openai-codex": "subscription" });
  assert.equal(ranked.id, "openai-codex/gpt-5.6-luna");
  if (!("tieBreak" in ranked)) throw new Error("expected a tie-break");
  assert.deepEqual(ranked.tieBreak, { preferred: "openai-codex/gpt-5.6-luna", over: ["openai/gpt-5.6-luna"] });

  const reversed = rankCollidingIds([...pair].reverse(), { openai: "api_key", "openai-codex": "subscription" });
  assert.equal(reversed.id, "openai-codex/gpt-5.6-luna");

  const unrankable = rankCollidingIds(pair, {});
  assert.equal(unrankable.id, null);
  if (!("ambiguous" in unrankable)) throw new Error("expected an unrankable collision");
  assert.deepEqual(unrankable.ambiguous, pair);

  const twoSubs = rankCollidingIds(["a/x", "b/x"], { a: "subscription", b: "subscription" });
  assert.equal(twoSubs.id, null);
  if (!("ambiguous" in twoSubs)) throw new Error("expected an unrankable collision");
  assert.deepEqual(twoSubs.ambiguous, ["a/x", "b/x"]);

  const twoKeys = rankCollidingIds(["a/x", "b/x"], { a: "api_key", b: "api_key" });
  assert.equal(twoKeys.id, null);

  const unknownHalf = rankCollidingIds(["a/x", "b/x"], { a: "subscription" });
  assert.equal(unknownHalf.id, null);

  const nested = rankCollidingIds(["openrouter/vendor/x", "direct/vendor/x"], {
    openrouter: "subscription",
    direct: "api_key",
  });
  assert.equal(nested.id, "openrouter/vendor/x");
});

test("pi auth.json types overlay definitions while unknown providers stay unknown", () => {
  const dir = tmpDir();
  const authFile = path.join(dir, "auth.json");
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      "openai-codex": { type: "oauth", access: "x" },
      xai: { type: "oauth", access: "y" },
    }),
  );
  const types = readProviderAuthTypes("pi", {
    advertised: ["openai/gpt-5.6-luna", "openai-codex/gpt-5.6-luna", "xai/grok-4.6"],
    authFile,
    homedir: dir,
  });
  assert.equal(types["openai-codex"], "subscription");
  assert.equal(types.openai, "api_key", "provider definition");
  assert.equal(types.xai, "subscription", "live dual-auth type from auth.json");
  assert.equal(PI_PROVIDER_AUTH_MODE.openai, "api_key");

  const withoutAuth = readProviderAuthTypes("pi", {
    advertised: ["openai-codex/gpt-5.6-luna", "xai/gpt-5.6-luna"],
    authFile: path.join(dir, "missing.json"),
  });
  assert.equal(withoutAuth["openai-codex"], "subscription");
  assert.equal(withoutAuth.xai, undefined);
  assert.equal(rankCollidingIds(["openai-codex/gpt-5.6-luna", "xai/gpt-5.6-luna"], withoutAuth).id, null);
});

test("pi definitions alone rank openai vs openai-codex without an auth file", () => {
  const types = readProviderAuthTypes("pi", {
    advertised: ["openai/gpt-5.6-luna", "openai-codex/gpt-5.6-luna"],
    authFile: path.join(tmpDir(), "missing.json"),
    homedir: tmpDir(),
  });
  assert.equal(types["openai-codex"], "subscription");
  assert.equal(types.openai, "api_key");
  const ranked = rankCollidingIds(["openai/gpt-5.6-luna", "openai-codex/gpt-5.6-luna"], types);
  assert.equal(ranked.id, "openai-codex/gpt-5.6-luna");
});

test("opencode auth types come from its auth.json, not Pi's openai=api_key definition", () => {
  const dir = tmpDir();
  const authFile = path.join(dir, "auth.json");
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      openai: { type: "oauth", access: "x" },
      anthropic: { type: "api_key", key: "y" },
    }),
  );
  const types = readProviderAuthTypes("opencode", {
    advertised: ["openai/gpt-5.6-luna", "anthropic/gpt-5.6-luna"],
    authFile,
    homedir: dir,
  });
  assert.equal(types.openai, "subscription", "OpenCode files ChatGPT OAuth under openai");
  assert.equal(types.anthropic, "api_key");
  const ranked = rankCollidingIds(["openai/gpt-5.6-luna", "anthropic/gpt-5.6-luna"], types);
  assert.equal(ranked.id, "openai/gpt-5.6-luna");
});

test("credential seat ignores token refreshes and other providers' keys", () => {
  const root = tmpDir();
  const home = path.join(root, "codex");
  fs.mkdirSync(home);
  const authFile = path.join(home, "auth.json");
  const write = (accountId, token) =>
    fs.writeFileSync(
      authFile,
      JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: accountId, access_token: token } }),
    );
  write("acct-a", "first");
  const env = { CODEX_HOME: home, OPENAI_API_KEY: "sk-a" };
  const first = providerAuthState("codex", { env, homedir: root });
  write("acct-a", "refreshed");
  assert.equal(providerAuthState("codex", { env, homedir: root }), first);
  assert.equal(providerAuthState("codex", { env: { ...env, ANTHROPIC_API_KEY: "other" }, homedir: root }), first);
  assert.ok(!first.includes("sk-a"));
  assert.notEqual(providerAuthState("codex", { env: { ...env, OPENAI_API_KEY: "sk-b" }, homedir: root }), first);
  write("acct-b", "refreshed");
  assert.notEqual(providerAuthState("codex", { env, homedir: root }), first);
  assert.notEqual(
    providerAuthState("codex", { env: { ...env, CODEX_HOME: path.join(root, "other") }, homedir: root }),
    first,
  );
});

test("claude credential seat follows its config dir and account", () => {
  const root = tmpDir();
  const seatA = path.join(root, "claude-a");
  fs.mkdirSync(seatA);
  const write = (accountUuid, token) =>
    fs.writeFileSync(
      path.join(seatA, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid, emailAddress: `${accountUuid}@example.com` }, cachedToken: token }),
    );
  write("uuid-a", "one");
  const env = { CLAUDE_CONFIG_DIR: seatA };
  const first = providerAuthState("claude", { env, homedir: root });
  write("uuid-a", "two");
  assert.equal(providerAuthState("claude", { env, homedir: root }), first);
  assert.equal(providerAuthState("claude", { env: { ...env, OPENAI_API_KEY: "other" }, homedir: root }), first);
  write("uuid-b", "two");
  assert.notEqual(providerAuthState("claude", { env, homedir: root }), first);
  assert.notEqual(
    providerAuthState("claude", { env: { CLAUDE_CONFIG_DIR: path.join(root, "claude-b") }, homedir: root }),
    providerAuthState("claude", { env, homedir: root }),
  );
  assert.notEqual(providerAuthState("claude", { env: { ...env, ANTHROPIC_API_KEY: "sk-ant" }, homedir: root }), first);
});

for (const agent of ["pi", "opencode"]) {
  test(`${agent} credential seat hashes only the selected provider's key`, () => {
    const root = tmpDir();
    const env = { PI_CODING_AGENT_DIR: path.join(root, "pi"), XDG_DATA_HOME: path.join(root, "data") };
    const seat = (extra, model) => providerAuthState(agent, { env: { ...env, ...extra }, homedir: root, model });
    const keys = { ANTHROPIC_API_KEY: "ant-a", OPENAI_API_KEY: "oai-a", GEMINI_API_KEY: "gem-a" };
    const first = seat(keys, "anthropic/claude-luna");
    assert.equal(seat({ ...keys, OPENAI_API_KEY: "oai-b", GEMINI_API_KEY: "gem-b" }, "anthropic/claude-luna"), first);
    assert.notEqual(seat({ ...keys, ANTHROPIC_API_KEY: "ant-b" }, "anthropic/claude-luna"), first);

    const noDefault = seat(keys, null);
    assert.equal(seat({ ANTHROPIC_API_KEY: "ant-b", OPENAI_API_KEY: "oai-b" }, null), noDefault);

    if (agent === "pi") {
      fs.mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(env.PI_CODING_AGENT_DIR, "settings.json"),
        JSON.stringify({ defaultProvider: "openai" }),
      );
    } else {
      fs.mkdirSync(path.join(root, ".config", "opencode"), { recursive: true });
      fs.writeFileSync(
        path.join(root, ".config", "opencode", "opencode.json"),
        JSON.stringify({ model: "openai/gpt-5.6-luna" }),
      );
    }
    const byDefault = seat(keys, null);
    assert.equal(seat({ ...keys, ANTHROPIC_API_KEY: "ant-b" }, null), byDefault);
    assert.notEqual(seat({ ...keys, OPENAI_API_KEY: "oai-b" }, null), byDefault);
    assert.equal(seat({ ...keys, ANTHROPIC_API_KEY: "ant-b" }, "gpt-5.6-luna"), byDefault);
  });
}

test("codex, claude, grok, and cursor expose no auth-class map", () => {
  for (const agent of ["codex", "claude", "grok", "cursor"]) {
    assert.deepEqual(readProviderAuthTypes(agent, { advertised: ["gpt-5.6-luna", "openai/gpt-5.6-luna"] }), {});
  }
});

test("auth file path overrides honour PI_CODING_AGENT_DIR and XDG_DATA_HOME", () => {
  assert.equal(
    piAuthFilePath({ env: { PI_CODING_AGENT_DIR: "/tmp/pi-agent" } }),
    path.join("/tmp/pi-agent", "auth.json"),
  );
  assert.equal(
    piAuthFilePath({ env: {}, homedir: "/home/user" }),
    path.join("/home/user", ".pi", "agent", "auth.json"),
  );
  assert.equal(
    opencodeAuthFilePath({ env: { XDG_DATA_HOME: "/tmp/xdg" } }),
    path.join("/tmp/xdg", "opencode", "auth.json"),
  );
  assert.equal(
    opencodeAuthFilePath({ env: {}, homedir: "/home/user" }),
    path.join("/home/user", ".local", "share", "opencode", "auth.json"),
  );
});

test("ambiguousModelDetail names the ids and how to disambiguate", () => {
  const detail = ambiguousModelDetail(["openai/gpt-5.6-luna", "other/gpt-5.6-luna"]);
  assert.match(detail, /openai\/gpt-5.6-luna/);
  assert.match(detail, /other\/gpt-5.6-luna/);
  assert.match(detail, /provider-qualified/);
  assert.equal(providerOf("openai-codex/gpt-5.6-luna"), "openai-codex");
  assert.equal(providerOf("openrouter/vendor/gpt-5.6-luna"), "openrouter");
  assert.equal(providerOf("gpt-5.6-luna"), "");
});
