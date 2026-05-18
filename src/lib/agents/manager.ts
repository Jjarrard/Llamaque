import { callOllama } from "@/lib/ollama";
import { parseTTM, BreakdownBlock, ReadyBlock } from "@/lib/protocol";

/**
 * Manager agent — breaks epics into 2-3 specific tasks.
 *
 * In the 2-depth architecture, Manager is only called at depth 1 (Epic → Feature).
 * Depth-2 tasks are automatically marked READY by the pipeline.
 * Tasks target files from the project's file manifest.
 */
const SYSTEM_PROMPT = `Break this epic into 1-2 specific, actionable task titles.
Use 2 tasks only if there are genuinely 2 non-overlapping deliverables. Use 1 task for simple or already-specific epics.
Each task must be a SHORT ACTION PHRASE (5-12 words) naming a concrete deliverable: a component, function, state variable, event handler, or style rule.
Do NOT include prose like "What exactly to build:" or "Expected output:" — just the task title itself.
Do NOT copy the example tasks below — write tasks that match the actual epic.
CRITICAL: Only create tasks for what the epic explicitly describes. Do NOT add features or scope not mentioned.
You MUST reply with >>BREAKDOWN.

Example (for a different project):
>>BREAKDOWN
- task: "Add submit button with form validation handler"
- task: "Render user list with name and email columns"
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
