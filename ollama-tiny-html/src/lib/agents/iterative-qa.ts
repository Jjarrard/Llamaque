import { callOllama } from "@/lib/ollama";

const SYSTEM_PROMPT = `You are a QA tester inspecting a web app file. Find exactly ONE bug, mistake, or quality issue.

Look for (in priority order):
1. Elements in the wrong place (e.g. list inside a form, buttons outside the main container)
2. Missing functionality that was requested but not implemented
3. Broken HTML structure (unclosed tags, wrong nesting)
4. CSS not styling elements that exist in the HTML (missing selectors)
5. CSS layout problems (no centering, no spacing, elements overlapping)
6. JS referencing IDs or classes that don't exist in the HTML
7. Missing hover/focus states on interactive elements
8. Placeholder code that was never implemented

Report ONLY ONE issue — the most important one.
If the file looks correct and complete, reply: NO_ISSUES

Reply in this EXACT format:
>>ISSUE
file: (filename)
problem: (one sentence describing the specific problem)
fix: (one sentence describing exactly what to change)
>>END`;

export interface SingleIssue {
  file: string;
  problem: string;
  fix: string;
}

export interface IterativeQAResult {
  issue: SingleIssue | null;
  raw: string;
  prompt: string;
  tokens: number;
  durationMs: number;
}

export async function runIterativeQA(
  model: string,
  projectName: string,
  projectDescription: string,
  files: { path: string; content: string }[],
  previousFixes?: string[],
): Promise<IterativeQAResult> {
  const fileList = files
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join("\n\n");

  let userMessage = `Project: "${projectName}: ${projectDescription}"\n\n${fileList}\n\n`;

  if (previousFixes && previousFixes.length > 0) {
    userMessage += `Already fixed in this pass (do NOT report these again):\n`;
    userMessage += previousFixes.map((f, i) => `${i + 1}. ${f}`).join("\n");
    userMessage += "\n\n";
  }

  userMessage +=
    "Find ONE bug or issue (or reply NO_ISSUES if everything looks good):";

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "qa",
    SYSTEM_PROMPT,
    userMessage,
    { numPredict: 200 },
  );

  // Check for no issues
  if (text.includes("NO_ISSUES")) {
    return { issue: null, raw: text, prompt, tokens, durationMs };
  }

  // Parse the issue
  const fileMatch = text.match(/file:\s*(.+)/i);
  const problemMatch = text.match(/problem:\s*(.+)/i);
  const fixMatch = text.match(/fix:\s*(.+)/i);

  if (fileMatch && problemMatch && fixMatch) {
    return {
      issue: {
        file: fileMatch[1].trim().replace(/['"]/g, ""),
        problem: problemMatch[1].trim(),
        fix: fixMatch[1].trim(),
      },
      raw: text,
      prompt,
      tokens,
      durationMs,
    };
  }

  // If we got a response but couldn't parse it, try to extract something useful
  // Look for any line that describes a problem
  const lines = text.split("\n").filter((l) => l.trim().length > 10);
  if (lines.length > 0) {
    // Can't parse structured response — treat as no parseable issue
    return { issue: null, raw: text, prompt, tokens, durationMs };
  }

  return { issue: null, raw: text, prompt, tokens, durationMs };
}
