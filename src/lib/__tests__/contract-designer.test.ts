/**
 * ContractDesigner agent tests (Item 3).
 *
 * runContractDesigner calls callOllama — mocked here.
 * Tests cover: manifest filtering, snippet extraction, and fallbacks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ollama", () => ({
  callOllama: vi.fn(),
}));

import { runContractDesigner } from "@/lib/agents/contract-designer";
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

function makeManifest(paths: string[]) {
  return paths.map((p) => ({
    path: p,
    description: `${p} component`,
    language: p.split(".").pop() ?? "ts",
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Activation conditions ────────────────────────────────────────────────────

describe("runContractDesigner — activation", () => {
  it("returns null for single TS file (< 2 TS files)", async () => {
    const result = await runContractDesigner(
      "model",
      "My App",
      "A todo list application",
      makeManifest(["App.tsx"]),
    );
    expect(result).toBeNull();
    expect(mockCallOllama).not.toHaveBeenCalled();
  });

  it("returns null for non-TS files only", async () => {
    const result = await runContractDesigner(
      "model",
      "My App",
      "A todo list application",
      makeManifest(["index.html", "styles.css", "script.py"]),
    );
    expect(result).toBeNull();
    expect(mockCallOllama).not.toHaveBeenCalled();
  });

  it("returns null for short description (< 10 chars)", async () => {
    const result = await runContractDesigner(
      "model",
      "App",
      "short",
      makeManifest(["App.tsx", "TodoList.tsx"]),
    );
    expect(result).toBeNull();
    expect(mockCallOllama).not.toHaveBeenCalled();
  });

  it("activates for 2 TSX files with a real description", async () => {
    ollamaReturns("interface Todo { id: number; text: string; }");
    await runContractDesigner(
      "model",
      "Todo App",
      "A todo list application",
      makeManifest(["App.tsx", "TodoList.tsx"]),
    );
    expect(mockCallOllama).toHaveBeenCalledTimes(1);
  });

  it("activates for mixed TS and TSX files (counts both)", async () => {
    ollamaReturns("interface Item { id: number; }");
    await runContractDesigner(
      "model",
      "My App",
      "A project description here",
      makeManifest(["App.tsx", "utils.ts"]),
    );
    expect(mockCallOllama).toHaveBeenCalledTimes(1);
  });
});

// ─── Snippet extraction ───────────────────────────────────────────────────────

describe("runContractDesigner — snippet extraction", () => {
  it("returns type definition lines from model output", async () => {
    ollamaReturns(`interface Todo { id: number; text: string; done: boolean; }
type TodoId = number;
export interface User { name: string; }`);
    const result = await runContractDesigner(
      "model",
      "App",
      "A todo list application",
      makeManifest(["App.tsx", "TodoList.tsx"]),
    );
    expect(result).not.toBeNull();
    expect(result).toContain("interface Todo");
    expect(result).toContain("type TodoId");
    expect(result).toContain("export interface User");
  });

  it("strips non-type lines from model output", async () => {
    ollamaReturns(`Here are the types you need:
interface Todo { id: number; }
export default function foo() {}
const x = 1;
type Status = 'done' | 'pending';`);
    const result = await runContractDesigner(
      "model",
      "App",
      "A todo list application",
      makeManifest(["App.tsx", "TodoList.tsx"]),
    );
    expect(result).not.toContain("Here are");
    expect(result).not.toContain("export default function");
    expect(result).not.toContain("const x");
    expect(result).toContain("interface Todo");
    expect(result).toContain("type Status");
  });

  it("strips markdown code fences", async () => {
    ollamaReturns("```typescript\ninterface Todo { id: number; }\n```");
    const result = await runContractDesigner(
      "model",
      "App",
      "A todo list application",
      makeManifest(["App.tsx", "TodoList.tsx"]),
    );
    expect(result).not.toContain("```");
    expect(result).toContain("interface Todo");
  });

  it("caps at 6 type definitions", async () => {
    ollamaReturns(`interface A { a: string; }
interface B { b: string; }
interface C { c: string; }
interface D { d: string; }
interface E { e: string; }
interface F { f: string; }
interface G { g: string; }
interface H { h: string; }`);
    const result = await runContractDesigner(
      "model",
      "App",
      "A todo list application",
      makeManifest(["App.tsx", "TodoList.tsx"]),
    );
    const lines = result!.split("\n").filter((l) => l.trim());
    expect(lines.length).toBeLessThanOrEqual(6);
  });

  it("returns null when model output has no type lines", async () => {
    ollamaReturns("I cannot determine the types for this project.");
    const result = await runContractDesigner(
      "model",
      "App",
      "A todo list application",
      makeManifest(["App.tsx", "TodoList.tsx"]),
    );
    expect(result).toBeNull();
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe("runContractDesigner — error handling", () => {
  it("returns null when callOllama throws", async () => {
    mockCallOllama.mockRejectedValue(new Error("timeout"));
    const result = await runContractDesigner(
      "model",
      "App",
      "A todo list application",
      makeManifest(["App.tsx", "TodoList.tsx"]),
    );
    expect(result).toBeNull();
  });
});
