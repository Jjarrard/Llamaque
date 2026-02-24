import { callOllama } from "@/lib/ollama";
import { parseTTM, BreakdownBlock } from "@/lib/protocol";

const SYSTEM_PROMPT = `Break the project into 3-5 epics. Each epic = one user flow or screen.
Think about what the user actually DOES step by step:
- What do they see first? What do they click? What happens after?
- Include: input/creation flow, display/results, feedback/responses
Do NOT mention files or technology. Describe WHAT the user experiences.

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
