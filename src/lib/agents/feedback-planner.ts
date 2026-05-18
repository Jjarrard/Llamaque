import { callOllama } from "@/lib/ollama";

/**
 * Feedback Planner — given user feedback + file manifest, decides which
 * files need editing and what specifically to change in each.
 *
 * Designed for small models: tiny system prompt, line-based parseable output,
 * no JSON, no thinking blocks.
 */

const SYSTEM_PROMPT = `Decide which files need editing to satisfy the user's feedback.
Reply with one line per file change. Use this exact format:

FILE: path/to/file.ext
CHANGE: specific instruction (one line)

Repeat the FILE/CHANGE pair for each file. Only list files that actually need changes.
If no files need changing, reply with the single word: NO_CHANGES`;

export interface FeedbackEdit {
  filePath: string;
  instruction: string;
}

export interface FeedbackPlanResult {
  edits: FeedbackEdit[];
  raw: string;
  prompt: string;
  tokens: number;
  durationMs: number;
}

export async function runFeedbackPlanner(
  model: string,
  projectDescription: string,
  feedback: string,
  files: { path: string; description?: string; preview?: string }[],
): Promise<FeedbackPlanResult> {
  const fileList = files
    .map((f) => {
      let entry = `- ${f.path}`;
      if (f.description) entry += ` (${f.description})`;
      if (f.preview) entry += `\n${f.preview}`;
      return entry;
    })
    .join("\n");

  const userMessage = `Project: ${projectDescription}

Files in this project:
${fileList}

User feedback: "${feedback}"

Which files need changing, and what should change in each? Use FILE:/CHANGE: format.`;

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "planner",
    SYSTEM_PROMPT,
    userMessage,
    { numPredict: 500 },
  );

  if (/^\s*NO_CHANGES\s*$/im.test(text)) {
    return { edits: [], raw: text, prompt, tokens, durationMs };
  }

  const edits: FeedbackEdit[] = [];
  const lines = text.split("\n");
  let pendingFile: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Match FILE: path  (allow optional bullet/leading dash, optional quotes)
    const fileMatch = line.match(
      /^(?:[-*]\s*)?file\s*:\s*["'`]?([^"'`\n|]+?)["'`]?\s*$/i,
    );
    if (fileMatch) {
      pendingFile = fileMatch[1].trim();
      continue;
    }

    // Match CHANGE: instruction
    const changeMatch = line.match(
      /^(?:[-*]\s*)?change\s*:\s*["'`]?(.+?)["'`]?\s*$/i,
    );
    if (changeMatch && pendingFile) {
      edits.push({
        filePath: pendingFile,
        instruction: changeMatch[1].trim(),
      });
      pendingFile = null;
      continue;
    }

    // Legacy single-line format:  - file: "X" | change: "Y"
    const inlineMatch = line.match(
      /file\s*:\s*["'`]?([^"'`|]+?)["'`]?\s*\|\s*change\s*:\s*["'`]?(.+?)["'`]?\s*$/i,
    );
    if (inlineMatch) {
      edits.push({
        filePath: inlineMatch[1].trim(),
        instruction: inlineMatch[2].trim(),
      });
    }
  }

  return { edits, raw: text, prompt, tokens, durationMs };
}
