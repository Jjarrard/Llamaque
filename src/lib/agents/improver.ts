import { callOllama } from "@/lib/ollama";

const SYSTEM_PROMPT = `Find bugs and quality issues in these project files.
Check: broken logic, placeholder code, missing error handling,
inconsistent data, structural problems, incomplete implementations.
If none, reply: NO_ISSUES

Reply (one per issue):
- fix: "what to fix" | file: "filename.ext"`;

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
