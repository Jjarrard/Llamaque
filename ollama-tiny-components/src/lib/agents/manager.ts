import { callOllama } from "@/lib/ollama";
import { parseTTM, BreakdownBlock, ReadyBlock } from "@/lib/protocol";

/**
 * Manager agent — breaks epics into 2-3 component features.
 *
 * In the new 2-depth architecture, Manager is only called at depth 1 (Epic → Feature).
 * Depth-2 tasks are automatically marked READY by the pipeline.
 * All features target the single Component.tsx file.
 */
const SYSTEM_PROMPT = `You are a Task Manager. The project outputs a single React TSX component file (Component.tsx) with inline styles.

Break this epic into 2-3 features for the Component.tsx file.
Each feature should describe a concrete coding task for the React component.

Rules:
- Features must directly relate to the epic — do NOT add unrelated features
- Each feature should describe a concrete coding task, not a vague goal
- All features target Component.tsx (the only output file)
- Think in terms of React: state, event handlers, JSX structure, inline styles
- You MUST reply with >>BREAKDOWN — never use >>READY for an epic

Reply EXACTLY:
>>BREAKDOWN
- task: "[specific React component work for this epic]"
- task: "[specific React component work for this epic]"
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
