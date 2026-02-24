import { callOllama } from "@/lib/ollama";
import { parseTTM, BreakdownBlock } from "@/lib/protocol";

const SYSTEM_PROMPT = `Break the project into 3-5 epics. Each epic = one core feature a user would use.
Do NOT mention files or technology. Just describe WHAT it needs to do.

Reply:
>>BREAKDOWN
- task: "feature description"
- task: "feature description"
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
