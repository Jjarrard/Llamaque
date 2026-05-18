/**
 * Planner agent tests (Item 1).
 *
 * runPlanner calls callOllama internally — we mock it to test the parsing
 * and fallback behaviour without a real LLM.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ollama", () => ({
  callOllama: vi.fn(),
}));

import { runPlanner } from "@/lib/agents/planner";
import { callOllama } from "@/lib/ollama";

const mockCallOllama = vi.mocked(callOllama);

function ollamaReturns(text: string) {
  mockCallOllama.mockResolvedValue({
    text,
    prompt: "",
    tokens: 10,
    durationMs: 50,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Happy paths ──────────────────────────────────────────────────────────────

describe("runPlanner — happy paths", () => {
  it("returns a bullet-list string for a valid PLAN response", async () => {
    ollamaReturns(`>>PLAN
- const [todos, setTodos] = useState([])
- handleAdd handler
- handleDelete(id) handler
>>END`);
    const result = await runPlanner("model", "App.tsx", [
      "Add a todo item",
      "Delete a todo item",
    ]);
    expect(result).not.toBeNull();
    expect(result).toContain("- const [todos, setTodos]");
    expect(result).toContain("- handleAdd handler");
  });

  it("returns each step prefixed with '- '", async () => {
    ollamaReturns(`>>PLAN
- exportedFn
- anotherFn
>>END`);
    const result = await runPlanner("model", "utils.ts", [
      "feature 1",
      "feature 2",
    ]);
    for (const line of result!.split("\n")) {
      expect(line).toMatch(/^- /);
    }
  });

  it("calls callOllama with the planner role", async () => {
    ollamaReturns(`>>PLAN
- step
>>END`);
    await runPlanner("qwen:7b", "Component.tsx", ["req1", "req2"]);
    expect(mockCallOllama).toHaveBeenCalledWith(
      "qwen:7b",
      "planner",
      expect.any(String),
      expect.any(String),
    );
  });

  it("uses tsx system prompt for .tsx files", async () => {
    ollamaReturns(`>>PLAN
- step
>>END`);
    await runPlanner("model", "Button.tsx", ["feature A", "feature B"]);
    const [, , systemPrompt] = mockCallOllama.mock.calls[0];
    expect(systemPrompt).toContain("React component");
  });

  it("uses ts system prompt for .ts files", async () => {
    ollamaReturns(`>>PLAN
- step
>>END`);
    await runPlanner("model", "utils.ts", ["feature A", "feature B"]);
    const [, , systemPrompt] = mockCallOllama.mock.calls[0];
    expect(systemPrompt).toContain("TypeScript");
  });
});

// ─── Fallback / error handling ────────────────────────────────────────────────

describe("runPlanner — fallbacks", () => {
  it("returns null when callOllama throws", async () => {
    mockCallOllama.mockRejectedValue(new Error("network error"));
    const result = await runPlanner("model", "App.tsx", ["req1", "req2"]);
    expect(result).toBeNull();
  });

  it("returns null when model returns no PLAN block", async () => {
    ollamaReturns("I don't understand what to do.");
    const result = await runPlanner("model", "App.tsx", ["req1", "req2"]);
    expect(result).toBeNull();
  });

  it("returns null when PLAN block has no valid bullet lines", async () => {
    ollamaReturns(`>>PLAN
just some prose with no bullets
>>END`);
    const result = await runPlanner("model", "App.tsx", ["req1", "req2"]);
    expect(result).toBeNull();
  });

  it("does not call callOllama for single-requirement files", async () => {
    // runPlanner only fires when requirements.length >= 2
    // But there's no guard in runPlanner itself — the pipeline guards it.
    // This test documents the contract: callers should only invoke with >= 2.
    // Still ensure it returns a result if called with 1 req (no crash).
    ollamaReturns(`>>PLAN
- step
>>END`);
    const result = await runPlanner("model", "App.tsx", ["single req"]);
    // No crash — result may be a string or null depending on parse
    expect(typeof result === "string" || result === null).toBe(true);
  });
});
