import { callOllama } from "@/lib/ollama";
import { parseTTM, BreakdownBlock, ReadyBlock } from "@/lib/protocol";

/**
 * Manager agent — breaks epics into 2-3 component features.
 *
 * In the new 2-depth architecture, Manager is only called at depth 1 (Epic → Feature).
 * Depth-2 tasks are automatically marked READY by the pipeline.
 * All features target the single Component.tsx file.
 */
const SYSTEM_PROMPT = `Break this epic into 2-3 coding tasks for a React component (Component.tsx).
Each task = specific React work: state, event handler, UI element, or styles.
You MUST reply with >>BREAKDOWN.

Reply:
>>BREAKDOWN
- task: "specific coding task"
- task: "specific coding task"
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
