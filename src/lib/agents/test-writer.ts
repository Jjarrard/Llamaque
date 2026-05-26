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
- CRITICAL: Your output must begin EXACTLY with the import line below. Do NOT output any React component code, class definitions, or any other code before the imports.
- Import: import { describe, it, expect, vi } from "vitest"
- Import: import { render, screen, fireEvent } from "@testing-library/react"
- Import the component: import Component from "./Component"
- Use ONLY plain vitest assertions: expect(x).toBeTruthy(), expect(x).toBe(y) — do NOT use toBeInTheDocument or any jest-dom matcher
- CRITICAL: If the component takes required props, you MUST pass them in every render() call. Look at the Requirements to infer prop shapes. Example: render(<Card card={{ id: "1", text: "test" }} onDelete={() => {}} />)
- Write EXACTLY 3 tests:
  1. renders without crashing: render(<Component ...requiredProps />) — no assertion needed
  2. key element exists: render then expect(screen.getByRole("button") or getByText(...)).toBeTruthy()
  3. interaction works: READ THE SOURCE CODE first.
     - If there is an <input> element: fireEvent.change(input, {target:{value:'TestItem-Alpha-999'}}), submit, then expect(screen.getByText('TestItem-Alpha-999')).toBeTruthy()
     - If there is NO <input> (only buttons/toggles): use getAllByRole('button')[0] or getByRole('checkbox'), fireEvent.click it, then assert a visible text change
     - NEVER use getByRole('button', { name: /item-label/i }) — button accessible names are the button's OWN text, not the surrounding item's label
- Keep each test body under 6 lines
- Output ONLY test code. Do NOT copy or repeat the source component code. No comments. No explanations.

Reply with EXACTLY this format:
>>RESULT
status: DONE
filePath: Component.test.tsx
output: |
  import { describe, it, expect, vi } from "vitest";
  import { render, screen, fireEvent } from "@testing-library/react";
  import Component from "./Component";

  describe("Component", () => {
    it("renders without crashing", () => {
      render(<Component />);
    });
    it("shows a button", () => {
      render(<Component />);
      expect(screen.getByRole("button")).toBeTruthy();
    });
    it("button click changes output", () => {
      const { getByRole, getByText } = render(<Component />);
      fireEvent.click(getByRole("button"));
      expect(getByText(/\d/)).toBeTruthy();
    });
  });
>>END`;

const JS_SYSTEM_PROMPT = `Write tests for a TypeScript module using vitest.
Rules:
- Import ONLY from "vitest": import { describe, it, expect } from "vitest"
- Import the module under test using THIS EXACT PATH: import * as mod from "./__MODULE__"
  (replace __MODULE__ with the filename WITHOUT extension — e.g. main, utils, calculator)
- Do NOT import from any other file. Do NOT invent helper filenames.
- Do NOT write implementation code — test code ONLY.
- Use ONLY plain vitest assertions: expect(x).toBe(y), expect(x).toBeTruthy(), expect(() => fn()).toThrow()
- Write EXACTLY 3 tests:
  1. module loads: expect(mod).toBeTruthy()
  2. a main function returns the expected type or value
  3. an edge case (zero, empty, or invalid input)
- Keep each test body under 5 lines

Reply with EXACTLY this format:
>>RESULT
status: DONE
filePath: (testfile.test.ts)
output: |
  import { describe, it, expect } from "vitest";
  import * as mod from "./calculator";

  describe("calculator", () => {
    it("module loads", () => {
      expect(mod).toBeTruthy();
    });
    it("calculates tip correctly", () => {
      const result = mod.calculateTip(100, 15);
      expect(typeof result).toBe("number");
    });
    it("handles zero bill", () => {
      expect(mod.calculateTip(0, 15)).toBe(0);
    });
  });
>>END`;

/**
 * Detect if a manifest description implies a leaf (pure display) component.
 * Leaf components receive all data via props — they should be tested differently
 * from stateful container components.
 */
function isLeafComponent(description: string): boolean {
  const d = description.toLowerCase();
  return (
    /\b(single|individual|one |per.item|each item|card item|list item|row|cell|entry|badge|chip|tag|display|show)\b/.test(
      d,
    ) ||
    /\b(button component|renders? (a |an |one |single )|shows? (a |an |one |single ))\b/.test(
      d,
    )
  );
}

/**
 * Strip any component/non-test preamble the model emits before the vitest imports.
 * Tiny models sometimes copy the injected source code before writing the tests.
 */
function cleanTestOutput(code: string): string {
  // Find where the vitest import begins — strip everything before it.
  // Allow optional leading whitespace: YAML block scalars ("output: |") indent
  // lines by 2 spaces, which breaks ^import matching.
  const vitestIdx = code.search(/^[ \t]*import\s+[^'"]*from\s+["']vitest["']/m);
  if (vitestIdx < 0) return code;

  const slice = vitestIdx > 0 ? code.slice(vitestIdx).trim() : code;

  // Strip common leading indent (e.g. 2-space YAML indentation on every line)
  const indent = slice.match(/^([ \t]+)/)?.[1] ?? "";
  if (indent) {
    return slice
      .split("\n")
      .map((l) =>
        l.startsWith(indent) ? l.slice(indent.length) : l.trimStart(),
      )
      .join("\n")
      .trim();
  }
  return slice;
}

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
  exportName?: string,
  fileContent?: string,
  manifestDescription?: string,
): Promise<TestWriterResult> {
  const ext = targetFile?.split(".").pop()?.toLowerCase() || "tsx";
  const isReact = ext === "tsx" || ext === "jsx";

  // Derive test file name from target
  const baseName = (targetFile || "Component").replace(/\.\w+$/, "");
  // Use the real export name if known; fall back to the filename-derived name
  // (e.g. "HabitItem" from "HabitItem.tsx") so the import path is always valid.
  // Never fall back to the generic "Component" string — that file doesn't exist.
  const componentName = exportName || baseName;
  const testExt = isReact ? "tsx" : ext;
  const testFileName = `${baseName}.test.${testExt}`;

  // Personalise the TSX system prompt: replace placeholders in a specific order
  // so the import *path* always uses the filename (baseName) and the JSX identifier
  // and describe-block names use the real export name (componentName).
  // Order matters: fix paths first, then test filename, then bare identifiers.
  const tsxPrompt = isReact
    ? TSX_SYSTEM_PROMPT.replace(/"\.\/Component"/g, `"./${baseName}"`) // import path → filename
        .replace(/Component\.test\.tsx/g, testFileName) // test filename
        .replace(/\bComponent\b/g, componentName) // JSX tags / describe name
    : JS_SYSTEM_PROMPT.replace(/__MODULE__/g, baseName);

  let userMessage = `Project: "${projectName}" — ${projectDescription}\n\n`;
  userMessage += `Requirements:\n`;
  userMessage += requirements.map((r, i) => `${i + 1}. ${r}`).join("\n");

  if (isReact) {
    const leaf = manifestDescription
      ? isLeafComponent(manifestDescription)
      : false;
    if (leaf) {
      userMessage += `\nComponent role: ${manifestDescription}\n`;
      userMessage += `\nThis is a LEAF display component — it receives all data via props, it does NOT manage its own list state.\n`;
      userMessage += `Write 3 tests for \`${componentName}\`. Infer required prop names from the Requirements above.\n`;
      userMessage += `ALL render() calls MUST pass the required props, e.g. render(<${componentName} description="Coffee" amount={5} onDelete={() => {}} />).\n`;
      userMessage += `- Test 1: renders without crashing (pass all required props)\n`;
      userMessage += `- Test 2: the item's NAME or TITLE text appears in the output — use getByText('the-exact-string-you-passed-as-the-name-prop'). Test ONLY the string/label prop, NOT any numeric or computed value like a count, streak, or total.\n`;
      userMessage += `- Test 3: clicking the action button calls the callback prop (e.g. onDelete)\n`;
    } else {
      userMessage += `\n\nWrite EXACTLY 3 tests for the React component exported as \`${componentName}\` from \`./${baseName}\`.\n`;
      userMessage += `READ THE ACTUAL SOURCE CODE provided below before writing any test.\n\n`;
      userMessage += `- Test 1: renders without crashing — render(<${componentName} />) with no props needed for container components\n`;
      userMessage += `- Test 2: a key piece of text is visible — use getByText('exact-string-from-source') where the string is a HARDCODED value that appears in the source code (e.g. a label, heading, or placeholder). NOT a computed/dynamic value.\n`;
      userMessage += `- Test 3: interaction — READ THE SOURCE CODE to pick the right interaction:\n`;
      userMessage += `  • If there is an <input> in the source: fireEvent.change(input, {target:{value:'TestItem-Alpha-999'}}) then submit/click Add, then getByText('TestItem-Alpha-999')\n`;
      userMessage += `  • If there is NO <input> (e.g. only buttons/checkboxes): use getAllByRole('button')[0] or getByRole('checkbox') then fireEvent.click — assert a visible change (e.g. a text change or a new element)\n`;
      userMessage += `CRITICAL rules:\n`;
      userMessage += `- NEVER use getByRole('button', { name: /item-label/i }) — button accessible names are the button's own text, NOT the nearby item label\n`;
      userMessage += `- Find buttons by their ACTUAL TEXT from the source: e.g. getByRole('button', { name: /add/i }) or getByRole('button', { name: /mark as done/i })\n`;
      userMessage += `- When unsure, use getAllByRole('button')[0] — safe and always works if a button exists\n`;
      userMessage += `- Do NOT assert summary counters like getByText(/Total: 1/) — text split across HTML elements always fails\n`;
      userMessage += `- Keep each test body under 6 lines\n`;
    }
  } else {
    userMessage += `\n\nWrite EXACTLY 3 tests for \`./${baseName}\`. Import using: import * as mod from "./${baseName}"\n`;
    userMessage += `Do NOT import from any other path. Do NOT write implementation code.\n`;
    userMessage += `Focus on: does the module load, do main functions return expected types, edge cases.\n`;
  }

  // Inject the actual source code so tests use correct prop names and exports
  if (fileContent && fileContent.trim().length > 50) {
    const snippet = fileContent.split("\n").slice(0, 80).join("\n");
    userMessage += `\n\nACTUAL SOURCE CODE of ${targetFile} (use these exact export names):\n${snippet}`;
  }

  const systemPrompt = isReact
    ? tsxPrompt
    : JS_SYSTEM_PROMPT.replace(/__MODULE__/g, baseName);

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "qa",
    systemPrompt,
    userMessage,
  );

  const block = parseTTM(text);

  if (block && block.command === "RESULT") {
    const result = block as ResultBlock;
    return {
      tests: cleanTestOutput(result.output),
      raw: text,
      prompt,
      tokens,
      durationMs,
    };
  }

  // Fallback: model used >>filename.test.tsx instead of >>RESULT.
  // Extract code from a markdown fence or bare code block.
  const fenceMatch = text.match(
    /```(?:tsx?|jsx?|typescript|javascript)?\s*\n([\s\S]+?)```/i,
  );
  if (fenceMatch) {
    const code = cleanTestOutput(fenceMatch[1].trim());
    if (code.includes("describe(") || code.includes("it(")) {
      return { tests: code, raw: text, prompt, tokens, durationMs };
    }
  }
  // Last resort: if the raw text after the >>filename line looks like a test file, use it
  const afterCommand = text.replace(/^>>[^\n]+\n/, "").trim();
  if (
    afterCommand.includes("describe(") &&
    afterCommand.includes("it(") &&
    afterCommand.length > 50
  ) {
    // Strip trailing >>END if present
    const code = cleanTestOutput(
      afterCommand.replace(/\n?>>END\s*$/, "").trim(),
    );
    return { tests: code, raw: text, prompt, tokens, durationMs };
  }

  return { tests: null, raw: text, prompt, tokens, durationMs };
}
