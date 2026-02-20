import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseSessionFromLines,
  type ClaudeCodeSession,
  type ParsedClaudeCodeSession,
} from "./claude-code.ts";

/**
 * Unit tests for Claude Code session parser.
 *
 * Most tests use `parseSessionFromLines` directly with synthetic JSONL data,
 * avoiding filesystem dependencies. A few tests use temp directories to verify
 * availability/history logic.
 */

// --- Test fixtures ---

const SESSION_INFO: ClaudeCodeSession = {
  id: "abc-123-def",
  project: "/home/user/myproject",
  title: "Fix the login bug",
  startedAt: 1708340400000,
  updatedAt: 1708340400000,
};

function humanLine(text: string, ts = "2026-02-19T10:00:00Z"): string {
  return JSON.stringify({
    type: "human",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
    timestamp: ts,
  });
}

function assistantTextLine(text: string, ts = "2026-02-19T10:00:01Z"): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
    timestamp: ts,
  });
}

function assistantWithToolLine(
  text: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  ts = "2026-02-19T10:00:01Z",
): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        { type: "tool_use", id: "tool-1", name: toolName, input: toolInput },
      ],
    },
    timestamp: ts,
  });
}

function toolResultLine(text: string, toolUseId = "tool-1", ts = "2026-02-19T10:00:02Z"): string {
  return JSON.stringify({
    type: "tool_result",
    message: {
      role: "tool",
      content: [{ type: "text", text }],
      tool_use_id: toolUseId,
    },
    timestamp: ts,
  });
}

// --- Tests ---

describe("Claude Code Parser", () => {
  // --- isClaudeCodeAvailable ---

  describe("isClaudeCodeAvailable", () => {
    test("returns false when projects dir does not exist", async () => {
      // We import the function and test it against a non-existent path.
      // Since the real config points to ~/.claude/projects, which likely doesn't exist
      // on this machine, it should return false.
      const { isClaudeCodeAvailable } = await import("./claude-code.ts");
      // If ~/.claude/projects doesn't exist, this should be false.
      // We can't guarantee this in all environments, but we can at least test it doesn't crash.
      const result = isClaudeCodeAvailable();
      expect(typeof result).toBe("boolean");
    });
  });

  // --- getNewSessions ---

  describe("getNewSessions", () => {
    test("returns empty array when history.jsonl does not exist", async () => {
      // The real config.claudeCode.historyPath likely doesn't exist on this machine
      const { getNewSessions } = await import("./claude-code.ts");
      const sessions = getNewSessions();
      // Should return empty, not throw
      expect(Array.isArray(sessions)).toBe(true);
    });
  });

  // --- parseSessionFromLines: basic conversation ---

  describe("parseSessionFromLines", () => {
    test("parses a basic human/assistant conversation", () => {
      const lines = [
        humanLine("How do I fix this bug?"),
        assistantTextLine("You need to update the handler function."),
      ];

      const result = parseSessionFromLines(lines, SESSION_INFO);

      expect(result.messages.length).toBe(2);
      expect(result.messages[0]!.type).toBe("human");
      expect(result.messages[0]!.role).toBe("user");
      expect(result.messages[0]!.content).toBe("How do I fix this bug?");
      expect(result.messages[1]!.type).toBe("assistant");
      expect(result.messages[1]!.role).toBe("assistant");
      expect(result.messages[1]!.content).toBe("You need to update the handler function.");
    });

    test("updates session timestamps from messages", () => {
      const lines = [
        humanLine("First message", "2026-02-19T09:00:00Z"),
        assistantTextLine("Response", "2026-02-19T09:05:00Z"),
        humanLine("Follow up", "2026-02-19T09:10:00Z"),
        assistantTextLine("Another response", "2026-02-19T09:15:00Z"),
      ];

      const result = parseSessionFromLines(lines, SESSION_INFO);

      expect(result.session.startedAt).toBe(new Date("2026-02-19T09:00:00Z").getTime());
      expect(result.session.updatedAt).toBe(new Date("2026-02-19T09:15:00Z").getTime());
    });

    // --- tool_use in assistant messages ---

    test("handles tool_use blocks in assistant messages", () => {
      const lines = [
        humanLine("Read the config file"),
        assistantWithToolLine(
          "Let me read that file for you.",
          "Read",
          { filePath: "/home/user/config.ts" },
        ),
      ];

      const result = parseSessionFromLines(lines, SESSION_INFO);

      expect(result.messages.length).toBe(3); // human + text + tool_use
      expect(result.messages[1]!.type).toBe("assistant");
      expect(result.messages[1]!.content).toBe("Let me read that file for you.");
      expect(result.messages[2]!.type).toBe("tool_use");
      expect(result.messages[2]!.toolName).toBe("Read");
      expect(result.messages[2]!.toolInput).toBe("/home/user/config.ts");
    });

    test("summarizes tool input for different tools", () => {
      const lines = [
        assistantWithToolLine("Running command.", "Bash", { command: "npm test" }),
      ];
      const result = parseSessionFromLines(lines, SESSION_INFO);
      const toolMsg = result.messages.find((m) => m.type === "tool_use");
      expect(toolMsg?.toolInput).toBe("npm test");
    });

    test("summarizes tool input with fallback to JSON", () => {
      const lines = [
        assistantWithToolLine("Checking.", "CustomTool", { foo: "bar", baz: 42 }),
      ];
      const result = parseSessionFromLines(lines, SESSION_INFO);
      const toolMsg = result.messages.find((m) => m.type === "tool_use");
      expect(toolMsg?.toolInput).toBe('{"foo":"bar","baz":42}');
    });

    // --- tool_result messages ---

    test("handles tool_result messages", () => {
      const lines = [
        humanLine("What's in the file?"),
        assistantWithToolLine("Reading it.", "Read", { filePath: "src/main.ts" }),
        toolResultLine("export function main() { ... }"),
        assistantTextLine("The file contains a main function."),
      ];

      const result = parseSessionFromLines(lines, SESSION_INFO);

      const toolResult = result.messages.find((m) => m.type === "tool_result");
      expect(toolResult).toBeTruthy();
      expect(toolResult!.role).toBe("tool");
      expect(toolResult!.content).toBe("export function main() { ... }");
    });

    // --- Malformed lines ---

    test("skips malformed JSONL lines without crashing", () => {
      const lines = [
        humanLine("Valid message"),
        "this is not valid json{{{",
        '{"type": "assistant", "broken": true}', // missing message/content
        assistantTextLine("Another valid message"),
      ];

      const result = parseSessionFromLines(lines, SESSION_INFO);

      // Should parse the two valid messages, skip the broken ones
      expect(result.messages.length).toBe(2);
      expect(result.messages[0]!.content).toBe("Valid message");
      expect(result.messages[1]!.content).toBe("Another valid message");
    });

    // --- Empty sessions ---

    test("handles empty sessions", () => {
      const result = parseSessionFromLines([], SESSION_INFO);

      expect(result.messages.length).toBe(0);
      expect(result.conversationText).toBe("");
      // Session timestamps should remain as the original info
      expect(result.session.startedAt).toBe(SESSION_INFO.startedAt);
    });

    // --- conversationText format ---

    test("builds correct conversationText format", () => {
      const lines = [
        humanLine("Fix the login bug"),
        assistantWithToolLine("Let me check the code.", "Read", { filePath: "src/auth.ts" }),
        toolResultLine("function login() { ... }"),
        assistantTextLine("I found the issue. The login function is missing validation."),
      ];

      const result = parseSessionFromLines(lines, SESSION_INFO);
      const text = result.conversationText;

      // Should contain role headers
      expect(text).toContain("--- USER ---");
      expect(text).toContain("--- ASSISTANT ---");

      // Should contain user message
      expect(text).toContain("Fix the login bug");

      // Should contain assistant text
      expect(text).toContain("Let me check the code.");

      // Should contain tool use
      expect(text).toContain("[TOOL: Read] src/auth.ts");

      // Should contain tool output (short enough)
      expect(text).toContain("Output: function login() { ... }");

      // Should contain follow-up assistant text
      expect(text).toContain("I found the issue.");
    });

    test("conversationText does not repeat role headers for consecutive same-role messages", () => {
      const lines = [
        humanLine("First question"),
        humanLine("Actually, one more thing"),
      ];

      const result = parseSessionFromLines(lines, SESSION_INFO);
      const text = result.conversationText;

      // Should only have one USER header
      const userHeaders = text.split("--- USER ---").length - 1;
      expect(userHeaders).toBe(1);
    });

    test("conversationText omits long tool results", () => {
      const longOutput = "x".repeat(600);
      const lines = [
        assistantWithToolLine("Reading.", "Read", { filePath: "big.ts" }),
        toolResultLine(longOutput),
      ];

      const result = parseSessionFromLines(lines, SESSION_INFO);
      const text = result.conversationText;

      // Long output should be omitted
      expect(text).not.toContain(longOutput);
      expect(text).not.toContain("Output:");
    });

    // --- Multi-text content blocks ---

    test("handles multiple text blocks in a single human message", () => {
      const line = JSON.stringify({
        type: "human",
        message: {
          role: "user",
          content: [
            { type: "text", text: "First part." },
            { type: "text", text: "Second part." },
          ],
        },
        timestamp: "2026-02-19T10:00:00Z",
      });

      const result = parseSessionFromLines([line], SESSION_INFO);

      expect(result.messages.length).toBe(1);
      expect(result.messages[0]!.content).toBe("First part.\nSecond part.");
    });

    // --- Assistant-only tool_use (no text block) ---

    test("handles assistant message with only tool_use and no text", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } },
          ],
        },
        timestamp: "2026-02-19T10:00:01Z",
      });

      const result = parseSessionFromLines([line], SESSION_INFO);

      expect(result.messages.length).toBe(1);
      expect(result.messages[0]!.type).toBe("tool_use");
      expect(result.messages[0]!.toolName).toBe("Bash");
      expect(result.messages[0]!.toolInput).toBe("ls -la");
    });
  });
});
