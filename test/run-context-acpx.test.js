import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-context-acpx-"));
const fakeAcpx = path.join(dir, "acpx");
const logFile = path.join(dir, "calls.jsonl");
const promptFile = path.join(dir, "prompt.md");
fs.writeFileSync(promptFile, "Synthetic prompt for ACP.\n");
fs.writeFileSync(
  fakeAcpx,
  `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const file = args.indexOf("--file");
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({
  args,
  env: process.env,
  prompt: file < 0 ? null : fs.readFileSync(args[file + 1], "utf8"),
}) + "\\n");
if (args.includes("status")) process.stdout.write(JSON.stringify({ availableModels: [] }));
else if (file >= 0) {
  if (process.env.FAKE_FAIL === "1") process.exit(2);
  process.stdout.write("synthetic answer\\n");
}
`,
);
fs.chmodSync(fakeAcpx, 0o755);
process.env.BACKPASS_ACPX_BIN = fakeAcpx;
const { execOneShot, probeSession, sessionPrompt } = await import("../src/acpx.js");
const { withChildEnvironment } = await import("../src/subprocess.js");

function calls() {
  return fs.existsSync(logFile)
    ? fs
        .readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("restricted probes and prompts omit inherited secrets without changing the caller", async () => {
  const old = { ...process.env };
  Object.assign(process.env, {
    OPENAI_API_KEY: "inherited-provider-key",
    MCP_SERVER_URL: "inherited-mcp",
    CODEX_HOME: "/not-for-child",
    BACKPASS_PLUGIN_ROOT: "/not-for-child/plugins",
  });
  try {
    await withChildEnvironment("restricted", async () => {
      await probeSession({ agent: "codex", sessionName: "probe", cwd: dir });
      const result = await execOneShot({
        agent: "codex",
        promptFile,
        cwd: dir,
        timeoutSeconds: 17,
        promptRetries: 0,
      });
      assert.match(result.text, /synthetic answer/);
    });
    const recorded = calls();
    assert.ok(recorded.length >= 4);
    for (const call of recorded) {
      assert.equal(call.env.OPENAI_API_KEY, undefined);
      assert.equal(call.env.MCP_SERVER_URL, undefined);
      assert.equal(call.env.CODEX_HOME, undefined);
      assert.equal(call.env.BACKPASS_PLUGIN_ROOT, undefined);
    }
    const prompt = recorded.find((call) => call.prompt);
    assert.equal(prompt.prompt, "Synthetic prompt for ACP.\n");
    assert.equal(prompt.args[prompt.args.indexOf("--timeout") + 1], "17");
    assert.equal(prompt.args[prompt.args.indexOf("--prompt-retries") + 1], "0");
    assert.equal(process.env.OPENAI_API_KEY, "inherited-provider-key");
    assert.equal(process.env.MCP_SERVER_URL, "inherited-mcp");
  } finally {
    for (const key of ["OPENAI_API_KEY", "MCP_SERVER_URL", "CODEX_HOME", "BACKPASS_PLUGIN_ROOT"]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
});

test("failed prompt closes its session; a later invocation uses its own flags", async () => {
  await assert.rejects(
    () =>
      withChildEnvironment(
        "restricted",
        () =>
          sessionPrompt({
            agent: "codex",
            sessionName: "failed-turn",
            promptFile,
            cwd: dir,
            timeoutSeconds: 19,
            promptRetries: 2,
          }),
        { FAKE_FAIL: "1" },
      ),
    /prompt failed/,
  );
  const failed = calls().filter((call) => call.args.includes("failed-turn"));
  assert.ok(failed.some((call) => call.args.includes("close")));
  await withChildEnvironment("native", () =>
    execOneShot({ agent: "codex", promptFile, cwd: dir, timeoutSeconds: 23, promptRetries: 1 }),
  );
  const latest = calls().at(-1);
  assert.equal(latest.args[latest.args.indexOf("--timeout") + 1], "23");
  assert.equal(latest.args[latest.args.indexOf("--prompt-retries") + 1], "1");
});
