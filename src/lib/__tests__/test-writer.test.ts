/**
 * Test-writer agent unit tests
 *
 * Verifies that:
 * - componentName falls back to the filename-derived name (never "Component")
 * - the generated prompt uses the correct import path
 * - vi is included in the vitest import
 */

import { describe, it, expect, vi } from "vitest";
import { runTestWriter } from "@/lib/agents/test-writer";

vi.mock("@/lib/ollama", () => ({
  callOllama: vi.fn(
    async (
      _model: string,
      _tag: string,
      systemPrompt: string,
      userMessage: string,
    ) => ({
      text: `>>RESULT\nstatus: DONE\nfilePath: HabitItem.test.tsx\noutput: |\n  import { describe, it, expect, vi } from "vitest";\n  import { render, screen } from "@testing-library/react";\n  import HabitItem from "./HabitItem";\n  describe("HabitItem", () => {\n    it("renders", () => { expect(true).toBe(true); });\n  });\n>>END`,
      prompt: systemPrompt + "\n" + userMessage,
      tokens: 10,
      durationMs: 100,
    }),
  ),
}));

describe("runTestWriter", () => {
  it("uses filename as componentName when exportName is undefined", async () => {
    const { callOllama } = await import("@/lib/ollama");
    const mockCallOllama = vi.mocked(callOllama);
    mockCallOllama.mockClear();

    await runTestWriter(
      "test-model",
      "MyProject",
      "A habit tracker",
      ["Render a habit row"],
      "HabitItem.tsx",
      undefined, // no exportName — the fallback should kick in
    );

    const [, , systemPrompt] = mockCallOllama.mock.calls[0];
    // Should use "HabitItem" not the generic "Component"
    expect(systemPrompt).toContain('import HabitItem from "./HabitItem"');
    expect(systemPrompt).not.toContain('import Component from "./Component"');
  });

  it("uses exportName when provided", async () => {
    const { callOllama } = await import("@/lib/ollama");
    const mockCallOllama = vi.mocked(callOllama);
    mockCallOllama.mockClear();

    await runTestWriter(
      "test-model",
      "MyProject",
      "A habit tracker",
      ["Render a habit row"],
      "HabitItem.tsx",
      "HabitTrackerRow", // explicit exportName
    );

    const [, , systemPrompt] = mockCallOllama.mock.calls[0];
    expect(systemPrompt).toContain('import HabitTrackerRow from "./HabitItem"');
  });

  it("includes vi in the vitest import in TSX system prompt", async () => {
    const { callOllama } = await import("@/lib/ollama");
    const mockCallOllama = vi.mocked(callOllama);
    mockCallOllama.mockClear();

    await runTestWriter(
      "test-model",
      "MyProject",
      "A tracker",
      ["Render"],
      "App.tsx",
    );

    const [, , systemPrompt] = mockCallOllama.mock.calls[0];
    // The vitest import line must include vi so vi.fn() works in generated tests
    expect(systemPrompt).toMatch(
      /import\s+\{[^}]*\bvi\b[^}]*\}\s+from\s+["']vitest["']/,
    );
  });

  it("uses filename-derived name for App.tsx when no exportName", async () => {
    const { callOllama } = await import("@/lib/ollama");
    const mockCallOllama = vi.mocked(callOllama);
    mockCallOllama.mockClear();

    await runTestWriter(
      "test-model",
      "MyProject",
      "A tracker",
      ["Manage state"],
      "App.tsx",
      undefined,
    );

    const [, , systemPrompt] = mockCallOllama.mock.calls[0];
    expect(systemPrompt).toContain('import App from "./App"');
    expect(systemPrompt).not.toContain('import Component from "./Component"');
  });
});
