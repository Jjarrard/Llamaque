import { callOllama } from "@/lib/ollama";
import { parseTTM, EditBlock } from "@/lib/protocol";

const SYSTEM_PROMPT = `You are an Editor. You are given a file section with a problem description.
Fix ONLY the problematic lines. Reply with:
>>EDIT
filePath: "path/to/file.js"
startLine: 12
endLine: 14
replace: |
  (corrected lines here)
>>END
Do not rewrite the whole file. Fix only what's broken.`;

/**
 * Run the Editor agent on a specific section of a file.
 * The system provides ~20 lines of context with line numbers.
 */
export async function runEditor(
  model: string,
  filePath: string,
  problemDescription: string,
  fileSection: string,
): Promise<{
  block: EditBlock | null;
  raw: string;
  prompt: string;
  tokens: number;
  durationMs: number;
}> {
  const userMessage = `filePath: "${filePath}"
problem: ${problemDescription}
file section:
${fileSection}`;

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "editor",
    SYSTEM_PROMPT,
    userMessage,
  );

  const block = parseTTM(text);

  if (block && block.command === "EDIT") {
    return { block: block as EditBlock, raw: text, prompt, tokens, durationMs };
  }

  return { block: null, raw: text, prompt, tokens, durationMs };
}

/**
 * Format file content with line numbers for the Editor.
 * Extracts a window of ~20 lines around the target area.
 */
export function extractFileWindow(
  content: string,
  targetLine: number,
  windowSize: number = 10,
): { section: string; startLine: number; endLine: number } {
  const lines = content.split("\n");
  const start = Math.max(0, targetLine - windowSize);
  const end = Math.min(lines.length, targetLine + windowSize);

  const numbered = lines
    .slice(start, end)
    .map((line, i) => {
      const lineNum = start + i + 1;
      return `${String(lineNum).padStart(6)} | ${line}`;
    })
    .join("\n");

  return { section: numbered, startLine: start + 1, endLine: end };
}

/**
 * Apply a surgical edit to file content.
 * Replaces lines startLine..endLine (1-indexed, inclusive) with the replacement text.
 */
export function applyEdit(
  content: string,
  startLine: number,
  endLine: number,
  replacement: string,
): string {
  const lines = content.split("\n");
  const before = lines.slice(0, startLine - 1);
  const after = lines.slice(endLine);
  const replaceLines = replacement.split("\n");

  return [...before, ...replaceLines, ...after].join("\n");
}
