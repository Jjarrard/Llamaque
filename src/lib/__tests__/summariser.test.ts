/**
 * Summariser agent tests (Item 7).
 *
 * runSummariser calls callOllama — mocked here.
 * Tests cover: SUMMARY block parsing, context extraction, and fallbacks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ollama", () => ({
  callOllama: vi.fn(),
}));

import { runSummariser } from "@/lib/agents/summariser";
import { callOllama } from "@/lib/ollama";

const mockCallOllama = vi.mocked(callOllama);

function ollamaReturns(text: string) {
  mockCallOllama.mockResolvedValue({
    text,
    prompt: "p",
    tokens: 20,
    durationMs: 80,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Happy paths ──────────────────────────────────────────────────────────────

describe("runSummariser — happy paths", () => {
  it("returns a SummaryBlock with context when model output is well-formed", async () => {
    ollamaReturns(`>>SUMMARY
context: "TodoList.tsx: exports TodoList; state [todos, setTodos]; handlers handleAdd, handleDelete"
>>END`);
    const result = await runSummariser("model", "TodoList.tsx", "...code...");
    expect(result.block).not.toBeNull();
    expect(result.block!.command).toBe("SUMMARY");
    expect(result.block!.context).toContain("TodoList.tsx");
    expect(result.block!.context).toContain("handleAdd");
  });

  it("returns the raw text and prompt metadata", async () => {
    const rawText = `>>SUMMARY\ncontext: "App.tsx: exports App"\n>>END`;
    ollamaReturns(rawText);
    const result = await runSummariser("model", "App.tsx", "code");
    expect(result.raw).toBe(rawText);
    expect(result.prompt).toBe("p");
    expect(result.tokens).toBe(20);
    expect(result.durationMs).toBe(80);
  });

  it("calls callOllama with the summariser role", async () => {
    ollamaReturns(`>>SUMMARY\ncontext: "x"\n>>END`);
    await runSummariser("qwen:7b", "App.tsx", "code");
    expect(mockCallOllama).toHaveBeenCalledWith(
      "qwen:7b",
      "summariser",
      expect.any(String),
      expect.stringContaining("App.tsx"),
    );
  });

  it("includes the filePath in the user message", async () => {
    ollamaReturns(`>>SUMMARY\ncontext: "x"\n>>END`);
    await runSummariser(
      "model",
      "components/Button.tsx",
      "export default function Button() {}",
    );
    const userMessage = mockCallOllama.mock.calls[0][3];
    expect(userMessage).toContain("components/Button.tsx");
  });

  it("includes the file content in the user message", async () => {
    ollamaReturns(`>>SUMMARY\ncontext: "x"\n>>END`);
    const code = "export const MY_CONST = 42;";
    await runSummariser("model", "consts.ts", code);
    const userMessage = mockCallOllama.mock.calls[0][3];
    expect(userMessage).toContain(code);
  });
});

// ─── Fallback paths ───────────────────────────────────────────────────────────

describe("runSummariser — fallbacks", () => {
  it("returns block: null when model returns no SUMMARY block", async () => {
    ollamaReturns("I cannot summarise this file.");
    const result = await runSummariser("model", "App.tsx", "code");
    expect(result.block).toBeNull();
    expect(result.raw).toBe("I cannot summarise this file.");
  });

  it("returns block: null when model returns a different TTM block", async () => {
    ollamaReturns(`>>PLAN
- step 1
>>END`);
    const result = await runSummariser("model", "App.tsx", "code");
    expect(result.block).toBeNull();
  });

  it("handles body-only SUMMARY (no context: field) via fallback", async () => {
    ollamaReturns(`>>SUMMARY
App.tsx: exports default App; state [count, setCount]
>>END`);
    const result = await runSummariser("model", "App.tsx", "code");
    // parseSummary falls back to using whole body as context
    expect(result.block).not.toBeNull();
    expect(result.block!.context).toContain("App.tsx");
  });
});
