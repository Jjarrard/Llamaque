import { callOllama } from "@/lib/ollama";

const SYSTEM_PROMPT = `You are a Code Reviewer. You are given all the files for a project and the original request.
Find bugs, mistakes, and visual/layout issues that need fixing. Focus on:
- Duplicate HTML elements (same form, input, button, or script appearing multiple times)
- Placeholder code like "// Your code here" that was never implemented
- HTML missing closing tags or having broken structure
- CSS with invalid syntax (e.g. "padding: 2: 20px" instead of "padding: 20px")
- CSS rules with missing closing braces
- JS referencing element IDs or classes not in the HTML
- Files that exist but contain no real code
- Unnecessary files that duplicate functionality of other files
- Poor or broken CSS layout (overlapping elements, elements side-by-side that should stack, missing spacing)
- Missing essential CSS (no body/container centering, no font styling, tiny or unreadable text)
- Elements that overflow their container or the viewport
- Forms/inputs without proper width, padding, or alignment
- Missing hover/focus states on interactive elements
- The app not matching what was requested (comparing output to the original request)

For each issue, describe the SPECIFIC fix and which file to change.
If there are no issues, reply: NO_ISSUES

Reply in this EXACT format (one per issue):
- fix: "Description of what to fix" | file: "filename.ext"
- fix: "Description of what to fix" | file: "filename.ext"

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
