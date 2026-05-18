import { callOllama } from "@/lib/ollama";
import { parseTTM, EditBlock, NeedsWiderWindowBlock } from "@/lib/protocol";

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
 * Stricter prompt used by the feedback pipeline. The editor is told the
 * exact line range it may touch and may bail with NEEDS_WIDER_WINDOW.
 */
const FEEDBACK_SYSTEM_PROMPT = `You are a surgical code editor.
You are given a numbered window of a file and ONE instruction.
Rules:
- You may replace only lines inside the window. Do not change anything outside.
- Do NOT include line-number prefixes in your replacement text.
- Keep indentation valid. Match surrounding style.
- Do not abbreviate. Never write "/* ... */", "// rest unchanged", or similar.
- Do not edit anything unrelated to the instruction.
- If the change requires lines outside this window, reply with NEEDS_WIDER_WINDOW instead of guessing.

If you can make the edit, reply:
>>EDIT
filePath: "path/to/file.ext"
startLine: <number inside the window>
endLine: <number inside the window, >= startLine>
replace: |
  (new lines, no line numbers, no abbreviations)
>>END

If you cannot make the edit within this window, reply:
>>NEEDS_WIDER_WINDOW
filePath: "path/to/file.ext"
suggestedStartLine: <number>
suggestedEndLine: <number>
reason: <one short sentence>
>>END`;

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

export interface FeedbackEditResult {
  edit: EditBlock | null;
  needsWiderWindow: NeedsWiderWindowBlock | null;
  raw: string;
  prompt: string;
  tokens: number;
  durationMs: number;
}

/**
 * Feedback-tuned editor: stricter prompt, supports NEEDS_WIDER_WINDOW.
 *
 * The caller passes the bounded window (already numbered) plus the line range
 * the model is allowed to touch. The caller is also responsible for refusing
 * any returned edit that strays outside `[allowedStartLine, allowedEndLine]`.
 */
export async function runFeedbackEditor(
  model: string,
  filePath: string,
  instruction: string,
  windowSnippet: string,
  allowedStartLine: number,
  allowedEndLine: number,
  retryEvidence?: string,
): Promise<FeedbackEditResult> {
  let userMessage = `filePath: "${filePath}"
instruction: ${instruction}
allowed line range: ${allowedStartLine}..${allowedEndLine}

file section (with line numbers):
${windowSnippet}`;

  if (retryEvidence) {
    userMessage += `\n\nPREVIOUS ATTEMPT FAILED. Evidence:\n${retryEvidence}\nFix that.`;
  }

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "editor",
    FEEDBACK_SYSTEM_PROMPT,
    userMessage,
  );

  const block = parseTTM(text);

  if (block?.command === "EDIT") {
    return {
      edit: block as EditBlock,
      needsWiderWindow: null,
      raw: text,
      prompt,
      tokens,
      durationMs,
    };
  }

  if (block?.command === "NEEDS_WIDER_WINDOW") {
    return {
      edit: null,
      needsWiderWindow: block as NeedsWiderWindowBlock,
      raw: text,
      prompt,
      tokens,
      durationMs,
    };
  }

  return {
    edit: null,
    needsWiderWindow: null,
    raw: text,
    prompt,
    tokens,
    durationMs,
  };
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
 * Number every line of a file like the Editor sees it.
 * Used when the caller already knows the exact window.
 */
export function numberLines(
  content: string,
  startLine: number,
  endLine: number,
): string {
  const lines = content.split("\n");
  const start = Math.max(1, startLine);
  const end = Math.min(lines.length, endLine);
  const out: string[] = [];
  for (let i = start - 1; i < end; i++) {
    out.push(`${String(i + 1).padStart(6)} | ${lines[i]}`);
  }
  return out.join("\n");
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

/**
 * Strip a leading "  123 | " line-number prefix that a model might have
 * accidentally included in the replacement.
 */
export function stripLineNumberPrefixes(replacement: string): string {
  return replacement
    .split("\n")
    .map((l) => l.replace(/^\s*\d{1,6}\s*\|\s?/, ""))
    .join("\n");
}
