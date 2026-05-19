import { callOllama } from "@/lib/ollama";

const SYSTEM_PROMPT = `Find ONE bug in this file. Most critical issue only.
Check: broken logic, missing feature, placeholder code (TODO/FIXME), 
undefined variable reference, wrong prop name, import that doesn't exist.
If the file looks correct, reply: NO_ISSUES

Reply:
>>ISSUE
file: (filename)
line: (approximate line number)
problem: (what is wrong — one sentence)
fix: (how to fix it — one sentence)
>>END`;

export interface SingleIssue {
  file: string;
  line?: number;
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

/**
 * Inspect a SINGLE file for bugs. Sending one file at a time keeps the
 * prompt small enough for 3-4B models to actually reason about the code
 * rather than hallucinating issues from an overloaded context window.
 *
 * testFailure: if a vitest run just failed, pass the first error message
 * so QA can focus on the actual broken assertion instead of guessing.
 */
export async function runIterativeQA(
  model: string,
  projectName: string,
  projectDescription: string,
  files: { path: string; content: string }[],
  previousFixes?: string[],
  testFailure?: string,
  focusFileIndex?: number,
): Promise<IterativeQAResult> {
  // Focus on one file per call. Rotate via focusFileIndex so each round
  // examines a different file, covering the whole project over several rounds.
  const idx = (focusFileIndex ?? 0) % files.length;
  const focusFile = files[idx];

  let userMessage = `Project: "${projectName}: ${projectDescription}"\n\n`;

  if (testFailure) {
    userMessage += `TEST FAILURE (focus on this):\n${testFailure.slice(0, 400)}\n\n`;
  }

  userMessage += `--- ${focusFile.path} ---\n${focusFile.content.slice(0, 4000)}\n\n`;

  if (previousFixes && previousFixes.length > 0) {
    userMessage += `Already fixed (do NOT report these again):\n`;
    userMessage += previousFixes
      .slice(-5)
      .map((f, i) => `${i + 1}. ${f}`)
      .join("\n");
    userMessage += "\n\n";
  }

  userMessage +=
    "Find ONE bug in this file (or reply NO_ISSUES if it looks correct):";

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "qa",
    SYSTEM_PROMPT,
    userMessage,
  );

  // Check for no issues
  if (text.includes("NO_ISSUES")) {
    return { issue: null, raw: text, prompt, tokens, durationMs };
  }

  // Parse the issue
  const fileMatch = text.match(/file:\s*(.+)/i);
  const problemMatch = text.match(/problem:\s*(.+)/i);
  const fixMatch = text.match(/fix:\s*(.+)/i);

  const lineMatch = text.match(/line:\s*(\d+)/i);

  if (fileMatch && problemMatch && fixMatch) {
    return {
      issue: {
        file: fileMatch[1].trim().replace(/['"]/g, ""),
        line: lineMatch ? parseInt(lineMatch[1], 10) : undefined,
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
