import { callOllama } from "@/lib/ollama";

const SYSTEM_PROMPT = `Find ONE bug or issue in this project output. Most important issue only.
Check: broken logic, incomplete implementations, placeholder code,
missing error handling, inconsistent data, structural problems.
If it looks correct, reply: NO_ISSUES

Reply:
>>ISSUE
file: (filename)
line: (approximate line number where the issue is)
problem: (what is wrong)
fix: (how to fix it)
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
        file: fileMatch[1].trim().replace(/['"]/, ""),
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
