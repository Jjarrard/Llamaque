import { callOllama } from "@/lib/ollama";

const SYSTEM_PROMPT = `You are a Code Reviewer. You are given a React TSX component and the original request.
Find bugs, mistakes, and visual/layout issues that need fixing. Focus on:
- Duplicate JSX elements (same form, input, button appearing multiple times)
- Placeholder code like "// Your code here" that was never implemented
- Broken JSX structure (unclosed tags, wrong nesting)
- Missing or invalid inline styles (e.g. incorrect style object syntax)
- Event handlers not wired up or referencing wrong state
- Missing default export or incorrect component structure
- Poor layout from inline styles (overlapping elements, missing spacing, no centering)
- Missing essential styling (no container centering, no font styling, tiny text)
- Elements that overflow their container or the viewport
- Forms/inputs without proper width, padding, or alignment
- Missing hover/focus interactivity (use state + onMouseEnter/onMouseLeave)
- The component not matching what was requested
- Unused state variables or missing useState hooks

For each issue, describe the SPECIFIC fix.
If there are no issues, reply: NO_ISSUES

Reply in this EXACT format (one per issue):
- fix: "Description of what to fix" | file: "Component.tsx"
- fix: "Description of what to fix" | file: "Component.tsx"

List real bugs AND visual/layout problems.`;

export interface BugFix {
  description: string;
  filePath: string;
}

export interface ImproverResult {
  fixes: BugFix[];
  raw: string;
  prompt: string;
  tokens: number;
  durationMs: number;
}

export async function runImprover(
  model: string,
  userRequest: string,
  files: { path: string; content: string }[],
): Promise<ImproverResult> {
  const fileList = files
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join("\n\n");

  const userMessage = `Original request: "${userRequest}"

Project files:
${fileList}

List any bugs or issues to fix:`;

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "improver",
    SYSTEM_PROMPT,
    userMessage,
    { numPredict: 800 },
  );

  // Check for NO_ISSUES
  if (text.includes("NO_ISSUES")) {
    return { fixes: [], raw: text, prompt, tokens, durationMs };
  }

  // Parse fix lines
  const fixes: BugFix[] = [];
  const lines = text.split("\n");

  for (const line of lines) {
    const match = line.match(/^-\s*fix:\s*"([^"]+)"\s*\|\s*file:\s*"([^"]+)"/i);
    if (match) {
      fixes.push({
        description: match[1].trim(),
        filePath: match[2].trim(),
      });
    }
  }

  return { fixes, raw: text, prompt, tokens, durationMs };
}
