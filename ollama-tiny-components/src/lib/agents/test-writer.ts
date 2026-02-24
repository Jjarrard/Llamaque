import { callOllama } from "@/lib/ollama";
import { parseTTM, ResultBlock } from "@/lib/protocol";

/**
 * Test Writer Agent — generates React Testing Library tests for a component.
 *
 * Called before code generation (TDD style):
 *   1. Takes project name, description, and list of requirements
 *   2. Produces a Component.test.tsx file using vitest + @testing-library/react
 *   3. Tests are practical and verifiable: renders, has elements, handles interactions
 */

const SYSTEM_PROMPT = `Write tests for a React component using vitest and @testing-library/react.
Rules:
- Import from "vitest" (describe, it, expect) and "@testing-library/react" (render, screen, fireEvent)
- Import the component: import Component from "./Component"
- Use describe/it blocks
- Test that the component renders without crashing
- Test that key UI elements exist (headings, buttons, inputs)
- Test user interactions (click, type) if applicable
- Keep tests simple and practical — no mocking, no complex setup
- 3-5 tests total. Each test checks ONE thing. Fewer good tests beats many bad ones.
- Output ONLY code. No comments in code. No explanations.

Reply:
>>RESULT
status: DONE
filePath: Component.test.tsx
output: |
  import { describe, it, expect } from "vitest";
  import { render, screen, fireEvent } from "@testing-library/react";
  import Component from "./Component";

  describe("Component", () => {
    it("renders without crashing", () => {
      render(<Component />);
    });
  });
>>END`;

export interface TestWriterResult {
  tests: string | null;
  raw: string;
  prompt: string;
  tokens: number;
  durationMs: number;
}

export async function runTestWriter(
  model: string,
  projectName: string,
  projectDescription: string,
  requirements: string[],
): Promise<TestWriterResult> {
  let userMessage = `Project: "${projectName}" — ${projectDescription}\n\n`;
  userMessage += `Requirements:\n`;
  userMessage += requirements.map((r, i) => `${i + 1}. ${r}`).join("\n");
  userMessage += `\n\nWrite 3-5 tests for this React component. Focus on:\n`;
  userMessage += `- Does it render?\n`;
  userMessage += `- Are key UI elements present?\n`;
  userMessage += `- Do interactions work (clicks, inputs)?\n`;

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "qa", // reuse qa role config (temperature 0)
    SYSTEM_PROMPT,
    userMessage,
  );

  const block = parseTTM(text);

  if (block && block.command === "RESULT") {
    const result = block as ResultBlock;
    return { tests: result.output, raw: text, prompt, tokens, durationMs };
  }

  return { tests: null, raw: text, prompt, tokens, durationMs };
}
