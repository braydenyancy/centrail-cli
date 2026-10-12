import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanClaudeCodeLogs, scanCodexLogs, scanCopilotLogs, scanPiLogs, scanGeminiLogs, SCANNERS } from "@centrail/parsers";
import type { Config } from "./config.js";
import { consentedCapabilities, toWireEvent, wireBranch, wireRepoRef } from "./wire.js";

// Real log files go through the real parsers and the outbound allowlist. Foreign
// paths are data, not directories to create on the test host. CI also runs this
// suite natively on Linux, macOS and Windows, under Node 20 and 24.
const paths = [
  ["Linux", "/home/PRIVATE_PERSON/Private Client/秘密"],
  ["macOS", "/Users/PRIVATE_PERSON/Library/Application Support/Private Client"],
  ["Windows drive", String.raw`C:\Users\PRIVATE_PERSON\Private Client\秘密`],
  ["Windows UNC", String.raw`\\PRIVATE_HOST\Users\PRIVATE_PERSON\Private Client`],
  ["WSL", "/mnt/c/Users/PRIVATE_PERSON/Private Client"],
] as const;
const formats = ["claude-code", "claude-subagent", "claude-fallback", "codex", "codex-cumulative", "copilot-cli", "copilot-resumed"] as const;
type Format = typeof formats[number];
const privateData = {
  prompt: "PRIVATE_PROMPT: explain my medical invoice",
  response: "PRIVATE_RESPONSE: confidential answer",
  code: "PRIVATE_CODE: const customer = 'confidential'",
  diff: "PRIVATE_DIFF: + confidential change",
  email: "PRIVATE_EMAIL@example.invalid",
  credential: "PRIVATE_PROVIDER_CREDENTIAL",
  host: "PRIVATE_HOST",
  version: "PRIVATE_CLIENT_VERSION",
};
const at = "2026-06-01T12:00:00.000Z";
const install = "fc2aee07-3b90-46ce-97de-0517f3931f4f";
const repo = { key: "github.com/allowed-org/allowed-repo", label: "allowed-repo", source: "remote" as const, root: "a".repeat(40) };
const config: Config = {
  installId: install, mode: "all", allowRepos: [], denyRepos: [], surfaces: {},
  scopeDecidedAt: at, pendingBackfill: false, hideRepoNames: false,
  hideBranchNames: false, pluginAnswer: null,
};
const scratch: string[] = [];
afterEach(async () => { await Promise.all(scratch.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

async function readFixture(format: Format, cwd: string) {
  const base = await mkdtemp(join(tmpdir(), "centrail-privacy-"));
  scratch.push(base);
  const filePath = `${cwd}/PRIVATE_FILE.ts`;
  const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 30, cache_creation_input_tokens: 40, cache_creation: { ephemeral_5m_input_tokens: 15, ephemeral_1h_input_tokens: 25 } };
  let file: string;
  let lines: unknown[];
  if (format.startsWith("claude")) {
    file = format === "claude-subagent"
      ? join(base, "project", "session", "subagents", "agent-test.jsonl")
      : join(base, "project", "session.jsonl");
    lines = [
      { type: "user", message: { role: "user", content: privateData.prompt } },
      { type: "assistant", requestId: "req-safe", timestamp: at, cwd,
        sessionId: "session-safe", gitBranch: "allowed-branch", version: privateData.version,
        entrypoint: "PRIVATE_ENTRYPOINT", account: privateData, isSidechain: format === "claude-subagent",
        message: { id: "message-safe", role: "assistant", model: "claude-opus-4-8",
          content: [
            { type: "text", text: privateData.response },
            { type: "thinking", thinking: "PRIVATE_REASONING", signature: "PRIVATE_SIGNATURE" },
            { type: "tool_use", id: "tool-safe", name: "Write", input: { file_path: filePath, content: privateData.code } },
          ],
          usage: { ...usage, speed: "fast", server_tool_use: { web_search_requests: 2 },
            ...(format === "claude-fallback" ? { iterations: [
              { ...usage, type: "message", model: "claude-opus-4-8" },
              { ...usage, type: "fallback_message", model: "claude-sonnet-4-6" },
              { ...usage, type: "advisor_message", model: "claude-opus-4-8" },
            ] } : {}),
          },
        },
      },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-safe", content: privateData.diff }] } },
    ];
  } else if (format.startsWith("codex")) {
    file = join(base, "2026", "06", "01", "rollout.jsonl");
    const tokens = { input_tokens: 170, cached_input_tokens: 30, cache_write_input_tokens: 40, output_tokens: 50 };
    lines = [
      { type: "session_meta", timestamp: at, payload: { id: "session-safe", cwd, git: { branch: "allowed-branch" }, cli_version: privateData.version, account: privateData } },
      { type: "turn_context", timestamp: at, payload: { turn_id: "turn-safe", cwd, model: "gpt-5.6-sol" } },
      { type: "event_msg", timestamp: at, payload: { type: "user_message", message: privateData.prompt } },
      { type: "response_item", timestamp: at, payload: { type: "message", content: [{ type: "output_text", text: privateData.response }] } },
      { type: "response_item", timestamp: at, payload: { type: "reasoning", summary: [{ type: "summary_text", text: "PRIVATE_REASONING" }], encrypted_content: "PRIVATE_ENCRYPTED_CONTENT" } },
      { type: "response_item", timestamp: at, payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: `cat "${filePath}"`, env: { PROVIDER_KEY: privateData.credential } }) } },
      { type: "response_item", timestamp: at, payload: { type: "function_call", name: "apply_patch", arguments: `*** Begin Patch\n*** Add File: ${filePath}\n+${privateData.code}\n*** End Patch` } },
      { type: "response_item", timestamp: at, payload: { type: "function_call_output", output: privateData.diff } },
      { type: "event_msg", timestamp: at, payload: { type: "token_count", info: { total_token_usage: tokens, ...(format === "codex" ? { last_token_usage: tokens } : {}) } } },
    ];
  } else {
    file = join(base, "session-safe", "events.jsonl");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(join(dirname(file), "workspace.yaml"), `id: session-safe\ncwd: '${cwd}'\nbranch: allowed-branch\ncreated_at: ${at}\nemail: ${privateData.email}\n`);
    const shutdown = { type: "session.shutdown", timestamp: at, data: { ...privateData, modelMetrics: { "gpt-5.6-sol": { usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 30, cacheWriteTokens: 40 } } } } };
    lines = [
      { type: "user.message", data: { content: privateData.prompt } },
      { type: "assistant.message", data: { content: privateData.response } },
      { type: "tool.execution_start", data: { arguments: { path: filePath, content: privateData.code }, output: privateData.diff } },
      shutdown,
      ...(format === "copilot-resumed" ? [{ ...shutdown, timestamp: "2026-06-01T13:00:00.000Z" }] : []),
    ];
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\r\n") + "\r\n");
  const scan = format.startsWith("claude") ? scanClaudeCodeLogs : format.startsWith("codex") ? scanCodexLogs : scanCopilotLogs;
  return scan({ basePath: base });
}

describe("real harness logs → outbound privacy contract", () => {
  it("requires a fixture when a new scanner is registered", () => {
    expect(SCANNERS.map((s) => s.surface).sort()).toEqual(["claude-code", "codex", "copilot-cli", "gemini-cli", "pi"]);
  });

  for (const format of formats) for (const [os, cwd] of paths) {
    it(`${format}, ${os}: preserves usage while excluding raw content and local identity in every consent mode`, async () => {
      const events = await readFixture(format, cwd);
      expect(events).toHaveLength(format === "claude-fallback" ? 3 : format === "copilot-resumed" ? 2 : 1);
      for (const e of events) {
        expect(e.metadata.cwd).toBe(cwd); // prove a sensitive value actually reached the local event
        expect(e).toMatchObject({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 30, cacheCreationTokens: 40 });
        // Future parser additions must not silently expand uploads, even nested additions.
        Object.assign(e, { raw: privateData, account: privateData });
        Object.assign(e.metadata, { ...privateData, repo: { ...repo, localPath: cwd, credentials: privateData.credential }, placement: "files", origin: { host: privateData.host, platform: "PRIVATE_PLATFORM", clientVersion: privateData.version } });
        for (const mode of ["legacy-server", "unanswered", "consented", "hidden"] as const) {
          const cfg = { ...config, scopeDecidedAt: mode === "unanswered" ? null : at, hideRepoNames: mode === "hidden", hideBranchNames: mode === "hidden" };
          const caps = consentedCapabilities({ fields: new Set(mode === "legacy-server" ? [] : ["repo", "usage-extras", "match", "patch-id"]) }, cfg);
          const wire = toWireEvent(e, caps, cfg, install);
          const expected: Record<string, unknown> = {
            externalId: e.externalId, model: e.model, inputTokens: 100, outputTokens: 50,
            cacheReadTokens: 30, cacheCreationTokens: 40,
            ...(format.startsWith("claude") ? {} : { cacheWriteTokens: 40 }),
            cacheCreation5mTokens: format.startsWith("claude") ? 15 : 0,
            cacheCreation1hTokens: format.startsWith("claude") ? 25 : 0,
            occurredAt: e.occurredAt.toISOString(),
          };
          if (mode === "consented" || mode === "hidden") {
            if (format.startsWith("claude")) Object.assign(expected, { speed: "fast", webSearchRequests: 2 });
            expected.metadata = {
              origin: { machineId: install }, sessionId: "session-safe", placement: "files",
              ...(mode === "hidden"
                ? { repo: { key: expect.stringMatching(/^hidden:[0-9a-f]{16}$/), label: "", source: "remote" } }
                : { repo, gitBranch: "allowed-branch" }),
            };
          }
          expect(wire, mode).toEqual(expected);
          const json = JSON.stringify(wire);
          expect(json, mode).not.toContain("PRIVATE_");
          if (mode === "hidden") {
            expect(json).not.toContain("allowed-");
            expect(json).not.toContain(repo.root);
            expect(wireRepoRef(repo, cfg, install)).toEqual({ name: wire.metadata!.repo!.key, key: wire.metadata!.repo!.key });
            expect(wireBranch("allowed-branch", cfg)).toBeNull();
          }
        }
      }
    });
  }
});

describe("new harness source files retain session grouping without content uploads", () => {
  for (const surface of ["pi", "gemini-cli"] as const) for (const [os, cwd] of paths) {
    it(`${surface}, ${os}: explicit identity survives and sensitive fields do not`, async () => {
      const root = await mkdtemp(join(tmpdir(), "centrail-new-privacy-"));
      scratch.push(root);
      const records = surface === "pi"
        ? [{ type: "session", id: "session-safe", cwd, ...privateData },
          { type: "message", id: "message-safe", timestamp: at, message: {
            role: "assistant", provider: "openai-codex", model: "gpt-5", content: privateData.response,
            usage: { input: 100, output: 50, cacheRead: 30, cacheWrite: 0 }, ...privateData,
          } }]
        : [{ sessionId: "session-safe", projectHash: "opaque", directories: [cwd], ...privateData },
          { type: "gemini", id: "message-safe", timestamp: at, model: "gemini-2.5-pro", ...privateData,
            tokens: { input: 130, output: 40, thoughts: 10, cached: 30, tool: 0, total: 180 } }];
      await writeFile(join(root, "session-fixture.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
      const [event] = await (surface === "pi" ? scanPiLogs : scanGeminiLogs)({ basePath: root });
      expect(event).toMatchObject({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 30 });
      for (const mode of ["legacy-server", "unanswered", "consented", "hidden"] as const) {
        const cfg = { ...config, scopeDecidedAt: mode === "unanswered" ? null : at, hideRepoNames: mode === "hidden", hideBranchNames: mode === "hidden" };
        const caps = consentedCapabilities({ fields: new Set(mode === "legacy-server" ? [] : ["repo", "billing-route"]), surfaces: new Set([surface]) }, cfg);
        const wire = toWireEvent(event, caps, cfg, install, surface);
        expect(JSON.stringify(wire)).not.toContain("PRIVATE_");
        if (mode === "consented" || mode === "hidden") {
          expect(wire.metadata?.sessionId).toBe(`${surface === "pi" ? "pi" : "gemini"}:session-safe`);
          expect(wire.billingProvider).toBe(surface === "pi" ? "openai-codex" : "unknown");
        } else {
          expect(wire).not.toHaveProperty("metadata");
          expect(wire).not.toHaveProperty("billingProvider");
        }
      }
    });
  }
});
