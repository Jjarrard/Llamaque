import { callOllama } from "@/lib/ollama";
import { parseTTM, ResultBlock } from "@/lib/protocol";

/**
 * Developer agent — writes or edits a single file.
 *
 * Adapts its system prompt based on the target file's extension/type.
 * The pipeline builds the full userMessage (including context, requirements,
 * QA feedback, etc.) — this function provides the appropriate system prompt
 * and forwards to Ollama.
 */

/**
 * Classify a file's role from its manifest description so we can show
 * the right scaffold. Small models pattern-match scaffolds — the shape
 * of the example IS the instruction.
 */
function detectRole(description: string): "leaf" | "root" | "generic" {
  const d = description.toLowerCase();
  // Leaf: renders one item, receives everything via props
  if (
    /\b(single|individual|one |per.item|each item|card item|list item|row|cell|entry|badge|chip|tag)\b/.test(
      d,
    ) ||
    /\b(button component|icon component|display component|renders? (a |an |one |single )|shows? (a |an |one |single ))\b/.test(
      d,
    )
  )
    return "leaf";
  // Root / container: owns state, imports and wires children
  if (
    /\b(main|app|root|layout|page|container|board|manages|holds state|composes|coordinates|orchestrat|all (card|column|item|tab)|state for|wires?)\b/.test(
      d,
    )
  )
    return "root";
  return "generic";
}

/** Generate a system prompt appropriate for the given file type */
function getSystemPrompt(
  filePath: string,
  manifestDescription?: string,
): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";

  switch (ext) {
    case "tsx":
    case "jsx": {
      const role = manifestDescription
        ? detectRole(manifestDescription)
        : "generic";

      // Derive the component function name from the file path.
      // e.g. KanbanColumn.tsx → KanbanColumn, app.tsx → App
      const baseName =
        filePath
          .split("/")
          .pop()
          ?.replace(/\.\w+$/, "") ?? "Component";
      const componentName =
        baseName.charAt(0).toUpperCase() + baseName.slice(1);

      // Leaf: receives data/callbacks as props, renders one thing
      const leafScaffold = `\`\`\`tsx
import React from "react";

interface Props {
  // TODO: define what data and callbacks this component receives
}

export default function ${componentName}({}: Props) {
  // TODO: local event handlers that call callbacks from props

  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      {/* TODO: render using props — do NOT manage shared/list state here */}
    </div>
  );
}
\`\`\``;

      // Root/container: owns state, imports and renders children
      const rootScaffold = `\`\`\`tsx
import React, { useState } from "react";
// TODO: import ChildComponent from "./ChildComponent";

export default function ${componentName}() {
  // TODO: useState for each piece of application state
  // TODO: event handlers that update state and are passed down as callbacks

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      {/* TODO: render child components, passing state + callbacks as props */}
    </div>
  );
}
\`\`\``;

      // Generic: stateful standalone component
      const genericScaffold = `\`\`\`tsx
import React, { useState } from "react";

export default function ${componentName}() {
  // TODO: declare useState hooks for every piece of state
  // TODO: declare event handler functions that update state

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      {/* TODO: render inputs (controlled: value + onChange) */}
      {/* TODO: render buttons that call the event handlers */}
      {/* TODO: render the live output / results */}
    </div>
  );
}
\`\`\``;

      const scaffold =
        role === "leaf"
          ? leafScaffold
          : role === "root"
            ? rootScaffold
            : genericScaffold;

      return `You are filling in a React component scaffold. Replace every TODO comment with working code. Keep the rest of the structure.

Scaffold to fill in:
${scaffold}

Hard rules:
- Keep the function name \`${componentName}\` — do NOT rename it.
- Inline styles ONLY: style={{ }}. No CSS imports.
- ALL inputs MUST be controlled: value={state} + onChange={handler}.
- Every event handler must do real work. NEVER use alert() or console.log() as the main action.
- For TIMERS: use useEffect + setInterval/setTimeout + useRef for the interval ID. Cleanup in return.
- Only import from "react" or sibling files ("./Foo"). No npm packages.
- If SIBLING FILES are listed in the user message, import from them — do NOT re-implement their logic.
- NEVER declare the same variable name more than once in the same scope. Derived display values (e.g. minutes, seconds) belong ONLY in the JSX return, not as hoisted consts above it.
- Output ONLY code. No prose.

Reply with EITHER format (both are accepted):

Format A (preferred for code-only output):
\`\`\`tsx
(complete component code, no TODOs left)
\`\`\`

Format B (TTM block):
>>RESULT
status: DONE
filePath: ${filePath}
output: |
  (complete component code, no TODOs left)
>>END`;
    }

    case "ts":
      return `Write complete, working TypeScript code. Rules:
- Use proper TypeScript types and interfaces
- Export functions and types that other files may need
- Handle errors properly
- If the prompt lists "FILES YOU MUST IMPORT FROM", import and use those modules — do NOT reimplement their logic.
- Output ONLY code. No explanations.

Reply:
>>RESULT
status: DONE
filePath: ${filePath}
output: |
  (complete TypeScript code)
>>END`;

    case "js":
      return `Write complete, working JavaScript code. Rules:
- Use modern ES6+ syntax (const, let, arrow functions, destructuring)
- Export functions that other files may need
- Handle errors properly
- Output ONLY code. No explanations.

Reply:
>>RESULT
status: DONE
filePath: ${filePath}
output: |
  (complete JavaScript code)
>>END`;

    case "py":
      return `Write complete, working Python code. Rules:
- Use Python 3.10+ syntax
- Include proper imports at the top
- Use type hints where helpful
- Handle errors with try/except where appropriate
- Use if __name__ == "__main__": for scripts
- Output ONLY code. No explanations.

Reply:
>>RESULT
status: DONE
filePath: ${filePath}
output: |
  (complete Python code)
>>END`;

    case "html":
    case "htm":
      return `Write a complete HTML page. Rules:
- Include <!DOCTYPE html>, <html>, <head>, <body>
- Include <meta charset="UTF-8"> and viewport meta
- Inline CSS in a <style> tag (no external stylesheets)
- Inline JavaScript in a <script> tag (no external scripts)
- Must be a complete, working page — not a fragment
- Output ONLY HTML. No explanations.

Reply:
>>RESULT
status: DONE
filePath: ${filePath}
output: |
  <!DOCTYPE html>
  <html lang="en">
  ...
  </html>
>>END`;

    case "css":
      return `Write complete CSS. Rules:
- Use modern CSS (flexbox, grid, custom properties)
- Mobile-friendly: use relative units and media queries
- Output ONLY CSS. No explanations.

Reply:
>>RESULT
status: DONE
filePath: ${filePath}
output: |
  (complete CSS)
>>END`;

    case "md":
    case "markdown":
      return `Write a complete, well-structured Markdown document. Rules:
- Use proper Markdown formatting: headings (#), lists, bold, code blocks
- Organize with clear sections and subsections
- Be thorough and specific — no placeholder text
- Include concrete details, examples, and actionable content
- Output ONLY Markdown. No meta-commentary.

Reply:
>>RESULT
status: DONE
filePath: ${filePath}
output: |
  # Title
  ...
>>END`;

    case "json":
      return `Write valid JSON. Rules:
- Must be valid, parseable JSON
- Use proper indentation (2 spaces)
- Output ONLY JSON. No explanations.

Reply:
>>RESULT
status: DONE
filePath: ${filePath}
output: |
  {
    ...
  }
>>END`;

    case "yaml":
    case "yml":
      return `Write valid YAML. Rules:
- Must be valid, parseable YAML
- Use proper indentation (2 spaces)
- Output ONLY YAML. No explanations.

Reply:
>>RESULT
status: DONE
filePath: ${filePath}
output: |
  (complete YAML)
>>END`;

    default:
      return `Write a complete, working file. Rules:
- Output must be the complete file contents
- No placeholder code or TODO comments
- Every feature must actually work
- Output ONLY the file contents. No explanations.

Reply:
>>RESULT
status: DONE
filePath: ${filePath}
output: |
  (complete file)
>>END`;
  }
}

/**
 * Get file-type-specific rules to inject into the execute prompt.
 * These are concise reminders appended to the userMessage in the pipeline.
 */
export function getFileTypeRules(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";

  switch (ext) {
    case "tsx":
    case "jsx":
      return 'Rules: Inline styles (React style objects). Export default function component. Only import from "react" or sibling files ("./Foo") — do NOT import npm packages.\nIf EXPORTS AVAILABLE FROM SIBLING FILES are listed above, import and use those components instead of re-implementing them.\nEvery handler must do real work (NEVER use alert() or console.log() as the action). Every input must be controlled (value + onChange). Show visual feedback after user actions.';

    case "html":
    case "htm":
      return "Rules: Complete HTML page with inline CSS and JS. Must include DOCTYPE, html, head, body tags.";

    case "py":
      return "Rules: Complete Python 3.10+ code with proper imports and error handling.";

    case "ts":
    case "js":
      return "Rules: Modern ES6+ syntax. Export needed functions. Handle errors properly.";

    case "md":
    case "markdown":
      return "Rules: Well-structured Markdown with clear headings, sections, and concrete details. No placeholder text.";

    case "css":
      return "Rules: Modern CSS with flexbox/grid. Mobile-friendly.";

    case "json":
      return "Rules: Valid, parseable JSON with proper indentation.";

    default:
      return "Rules: Complete, working file with no placeholder code.";
  }
}

/**
 * Check if a file type supports TDD (automated testing).
 */
export function supportsTDD(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return ["tsx", "jsx", "ts", "js"].includes(ext);
}

/**
 * Run the Developer agent.
 */
export async function runDeveloper(
  model: string,
  userMessage: string,
  filePath?: string,
  manifestDescription?: string,
): Promise<{
  block: ResultBlock | null;
  raw: string;
  prompt: string;
  tokens: number;
  durationMs: number;
}> {
  const systemPrompt = getSystemPrompt(
    filePath || "output.txt",
    manifestDescription,
  );
  const fp = filePath || "output.txt";

  // Strong prefill: commit the model to the RESULT block structure so it can't
  // skip straight to raw code output (a common failure with Gemma 4 / Qwen3).
  const prefill = `>>RESULT\nstatus: DONE\nfilePath: ${fp}\noutput: |\n  `;

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "developer",
    systemPrompt,
    userMessage,
    { prefill },
  );

  const block = parseTTM(text);

  if (block && block.command === "RESULT") {
    return {
      block: block as ResultBlock,
      raw: text,
      prompt,
      tokens,
      durationMs,
    };
  }

  return { block: null, raw: text, prompt, tokens, durationMs };
}

/**
 * Patch-mode developer: emits Aider-style SEARCH/REPLACE blocks instead of
 * rewriting the whole file. Used for incremental edits (steps 2..N) where
 * a capable model would otherwise restructure the entire file each step.
 *
 * Returns the raw response text — the caller parses blocks via parsePatch()
 * and applies them via applyPatch().
 */
const PATCH_SYSTEM_PROMPT = `You are a surgical code editor. You will be given the CURRENT file (with line numbers for reference) and ONE feature to add.

Your job: produce the MINIMUM diff to add that feature. Do NOT rewrite the file. Do NOT restructure. Do NOT rename anything that already exists.

Output EXACTLY ONE SEARCH/REPLACE block per reply. You will be re-prompted to add more blocks if the feature still needs work. Smaller, focused diffs are easier to verify.

Format the block EXACTLY:

<<<<<<< SEARCH
(exact existing lines from the file, verbatim, INCLUDING indentation, with NO line numbers)
=======
(replacement lines — same indentation style)
>>>>>>> REPLACE

If the feature is ALREADY fully implemented in the current file, reply with just the single word:
DONE

Rules:
- The SEARCH section must be COPIED EXACTLY from the current file. Same whitespace, same indentation, same quotes.
- Do NOT include the line number prefix (e.g. "  42 | ") in SEARCH or REPLACE — those are only for your reference.
- SEARCH must be UNIQUE in the file. Include 1-2 lines of surrounding context if a fragment is not unique on its own.
- Keep SEARCH small (3-10 lines).
- For a brand-new function or import that doesn't replace anything, use an EMPTY SEARCH (just two newlines between the markers) and put the new code in REPLACE — it will be appended.
- Do NOT include unchanged code that you aren't modifying.
- Do NOT abbreviate. NEVER write "// ... rest unchanged" or "/* existing code */".
- Output ONLY the single SEARCH/REPLACE block (or the word DONE). No prose, no explanations, no fenced wrappers.

Example — adding a pause toggle to a timer component (one block per turn):

<<<<<<< SEARCH
  const [seconds, setSeconds] = useState(0);
=======
  const [seconds, setSeconds] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
>>>>>>> REPLACE`;

export async function runDeveloperPatch(
  model: string,
  filePath: string,
  numberedFile: string,
  featureInstruction: string,
  projectName: string,
  projectDescription: string,
  extraNote?: string,
): Promise<{
  raw: string;
  prompt: string;
  tokens: number;
  durationMs: number;
}> {
  const noteBlock = extraNote
    ? `\n\nNOTE FROM PREVIOUS TURN:\n${extraNote}\n`
    : "";
  const userMessage = `Project: ${projectName} — ${projectDescription}

CURRENT ${filePath} (line numbers are FOR YOUR REFERENCE ONLY — do not include them in SEARCH/REPLACE):
${numberedFile}
${noteBlock}
ADD this feature with the MINIMUM diff. Do NOT rewrite the file. Do NOT rename existing variables or handlers:
- ${featureInstruction}

Reply with ONE SEARCH/REPLACE block (or the word DONE if already complete). Nothing else.`;

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "developer",
    PATCH_SYSTEM_PROMPT,
    userMessage,
  );

  return { raw: text, prompt, tokens, durationMs };
}
