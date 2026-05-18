import { callOllama } from "@/lib/ollama";
import { parseTTM, BreakdownBlock } from "@/lib/protocol";

const SYSTEM_PROMPT = `Break the project into 2-3 epics. Each epic = one distinct user interaction.
Think about what the user actually DOES:
- What is the main thing they see and do?
- Are there genuinely separate, non-overlapping interactions?
MERGE overlapping flows into one epic. A simple app (counter, toggle, form) needs only 2 epics.
Do NOT mention files or technology. Describe WHAT the user experiences.
CRITICAL: Only describe features explicitly mentioned in the project description. Do NOT invent features, add functionality, or expand scope beyond what was asked.

Reply:
>>BREAKDOWN
- task: "user flow description"
- task: "user flow description"
>>END`;

export async function runProjectManager(
  model: string,
  projectName: string,
  projectDescription: string,
): Promise<{
  block: BreakdownBlock | null;
  raw: string;
  prompt: string;
  tokens: number;
  durationMs: number;
}> {
  const userMessage = `Project: ${projectName}\nDescription: ${projectDescription}`;

  const { text, prompt, tokens, durationMs } = await callOllama(
    model,
    "project-manager",
    SYSTEM_PROMPT,
    userMessage,
  );

  const block = parseTTM(text);

  if (block && block.command === "BREAKDOWN") {
    return {
      block: block as BreakdownBlock,
      raw: text,
      prompt,
      tokens,
      durationMs,
    };
  }

  return { block: null, raw: text, prompt, tokens, durationMs };
}
