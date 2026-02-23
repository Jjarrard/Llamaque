import { callOllama } from "@/lib/ollama";
import { parseTTM, BreakdownBlock, ReadyBlock } from "@/lib/protocol";

/**
 * Manager agent — breaks epics into 2-3 file-targeted features.
 *
 * In the new 2-depth architecture, Manager is only called at depth 1 (Epic → Feature).
 * Depth-2 tasks are automatically marked READY by the pipeline.
 */
const SYSTEM_PROMPT = `You are a Task Manager. The project has exactly 3 files: index.html, script.js, style.css.

Break this epic into 2-3 features. Each feature targets ONE specific file.
End each feature description with "in index.html", "in script.js", or "in style.css".

Rules:
- Features must directly relate to the epic — do NOT add unrelated features
- Each feature should describe a concrete coding task, not a vague goal
- Keep features focused: one file per feature
- You MUST reply with >>BREAKDOWN — never use >>READY for an epic

Reply EXACTLY:
>>BREAKDOWN
- task: "[specific work for this epic] in index.html"
- task: "[specific work for this epic] in style.css"
- task: "[specific work for this epic] in script.js"
>>END`;

export async function runManager(
  model: string,
  taskDescription: string,
  context?: string,
): Promise<{
  block: BreakdownBlock | ReadyBlock | null;
  raw: string;
  prompt: string;
  tokens: number;
  durationMs: number;
}> {
  let userMessage = `task: ${taskDescription}`;
  if (context) {
    userMessage += `\n${context}`;
  }

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "manager",
    SYSTEM_PROMPT,
    userMessage,
  );

  const block = parseTTM(text);

  if (block && (block.command === "BREAKDOWN" || block.command === "READY")) {
    return {
      block: block as BreakdownBlock | ReadyBlock,
      raw: text,
      prompt,
      tokens,
      durationMs,
    };
  }

  return { block: null, raw: text, prompt, tokens, durationMs };
}
