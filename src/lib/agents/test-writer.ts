import { callOllama } from "@/lib/ollama";
import { parseTTM, ResultBlock } from "@/lib/protocol";

/**
 * Test Writer Agent — generates tests for code files.
 *
 * Called before code generation (TDD style):
 *   1. Takes project name, description, and list of requirements
 *   2. Produces test files using vitest + @testing-library/react (for TSX)
 *      or vitest alone (for TS/JS)
 *   3. Tests are practical and verifiable
 *
 * Only used for testable file types (tsx, jsx, ts, js).
 */

const TSX_SYSTEM_PROMPT = `Write tests for a React component using vitest and @testing-library/react.
Rules:
- Import from "vitest" (describe, it, expect) and "@testing-library/react" (render, screen, fireEvent)
- Import the component: import Component from "./Component"
- Use describe/it blocks
- Test that the component renders without crashing
- Test that key UI elements exist (headings, buttons, inputs)
- Test that inputs actually work: type into them and verify the value changes
- Test that buttons trigger visible changes (new elements appear, text updates, counts change)
- Test the main user flow end-to-end: fill form → submit → see result
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

const JS_SYSTEM_PROMPT = `Write tests using vitest.
Rules:
- Import from "vitest" (describe, it, expect)
- Import the file under test
- Test key functions and their return values
- Test edge cases (empty input, errors)
- 3-5 tests total. Output ONLY code.

Reply:
>>RESULT
status: DONE
filePath: (testfile)
output: |
  import { describe, it, expect } from "vitest";
  ...
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
  targetFile?: string,
): Promise<TestWriterResult> {
  const ext = targetFile?.split(".").pop()?.toLowerCase() || "tsx";
  const isReact = ext === "tsx" || ext === "jsx";

  let userMessage = `Project: "${projectName}" — ${projectDescription}\n\n`;
  userMessage += `Requirements:\n`;
  userMessage += requirements.map((r, i) => `${i + 1}. ${r}`).join("\n");

  if (isReact) {
    userMessage += `\n\nWrite 3-5 tests for this React component. Focus on:\n`;
    userMessage += `- Does it render?\n`;
    userMessage += `- Are key UI elements present?\n`;
    userMessage += `- Do inputs accept and reflect typed values?\n`;
    userMessage += `- Does the main flow work (fill in → submit → see result)?\n`;
  } else {
    userMessage += `\n\nWrite 3-5 tests for ${targetFile || "the code"}. Focus on:\n`;
    userMessage += `- Do the main functions work correctly?\n`;
    userMessage += `- Are edge cases handled?\n`;
    userMessage += `- Does the core logic produce expected output?\n`;
  }

  const systemPrompt = isReact ? TSX_SYSTEM_PROMPT : JS_SYSTEM_PROMPT;

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "qa",
    systemPrompt,
    userMessage,
  );

  const block = parseTTM(text);

  if (block && block.command === "RESULT") {
    const result = block as ResultBlock;
    return { tests: result.output, raw: text, prompt, tokens, durationMs };
  }

  return { tests: null, raw: text, prompt, tokens, durationMs };
}
